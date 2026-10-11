// The process flow diagram and the analytics numbers, checked against real
// flowsheet data from the default world (a fixture cut from its world JSON).

import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/flowsheetSites.json';
import type { Snapshot } from '../engine/snapshot';
import type { WorldSpec } from '../engine/world';
import { blueRamp } from './charts/palette';
import {
  STRAIGHT, buildFlowsheet, edgePath, fmtHours, fmtTph, labelWidth, streamLabel, tankLive, unitLive,
  type FlowTankNode, type FlowUnitNode, type Flowsheet,
} from './flowsheet';
import {
  flowLines, headline, plantRows, sampleTick, since, toSeries, unitRows, weightedSum, withNow, type Histories,
} from './siteSeries';

const world = { ...(fixture as unknown as WorldSpec), pipelines: [] } as WorldSpec;
const siteOf = (key: string) => world.sites.findIndex((s) => s.key === key);
const sheetOf = (key: string) => buildFlowsheet(world, siteOf(key)) as Flowsheet;
const unit = (sheet: Flowsheet, key: string) =>
  sheet.nodes.find((n): n is FlowUnitNode => n.kind === 'unit' && n.unit.key === key) as FlowUnitNode;
const tank = (sheet: Flowsheet, material: string, role?: string) =>
  sheet.nodes.find((n): n is FlowTankNode => n.kind === 'tank' && n.material === material && (role === undefined || n.role === role)) as FlowTankNode;

/** A snapshot with every process at `rate`, every unit fully online, every tank at `fill`. */
function snapAt(rate: number, fill = 0.7, tick = 400): Snapshot {
  const nProc = 64;
  const nUnits = 128;
  const nTanks = world.tanks.length;
  const tanks = new Float32Array(4 * nTanks);
  for (let t = 0; t < nTanks; t++) tanks[4 * t] = fill;
  return {
    version: 2, tick: BigInt(tick), nTanks, nProc, nUnits, nSites: 22, nVeh: 0, nPipes: 0, nEdges: 0, nMats: 0,
    tanks, procRate: new Float32Array(nProc).fill(rate), procStatus: new Uint8Array(nProc),
    unitTrains: new Uint8Array(nUnits).fill(8), siteStatus: new Uint8Array(22), siteUrgency: new Float32Array(22),
    vehPos: new Float32Array(0), vehStatus: new Uint8Array(0), vehOrder: new Uint32Array(0),
    pipeFlow: new Float32Array(0), edgeOpen: new Uint8Array(0), prices: new Float32Array(0),
  } as Snapshot;
}

describe('buildFlowsheet', () => {
  it('chains the chlor-alkali units through their internal streams', () => {
    const s = sheetOf('CHLOR_ALKALI');
    const names = (id: string) => s.edges.filter((e) => e.from === id).map((e) => `${e.key}>${e.to}`).sort();
    const brine = unit(s, 'CA-BRINE');
    const cell = unit(s, 'CA-CELL');
    const cl2 = unit(s, 'CA-CL2');
    const evap = unit(s, 'CA-EVAP');
    expect(names(brine.id)).toEqual([`brine>${cell.id}`]);
    expect(names(cell.id)).toEqual([`catholyte>${evap.id}`, `wet_cl2>${cl2.id}`]);
    // the numbers on the streams, at design
    const edge = (key: string) => s.edges.find((e) => e.key === key);
    expect(edge('SALT')?.tph).toBeCloseTo(30.81, 1);
    expect(edge('brine')?.tph).toBeCloseTo(40.3, 1);
    expect(edge('wet_cl2')?.tph).toBeCloseTo(18.69, 1);
    expect(edge('CHLORINE')?.tph).toBeCloseTo(18.69, 1);
    expect(edge('CAUSTIC')?.tph).toBeCloseTo(21.09, 1);
    // utilities are notes, not streams
    expect(s.edges.some((e) => e.key === 'WATER' || e.key === 'FUEL_GAS')).toBe(false);
    expect(brine.notes.map((n) => n.key)).toContain('WATER');
    expect(cell.notes.find((n) => n.key === 'power')?.value).toBeCloseTo(44.87, 1);
    expect(evap.notes.find((n) => n.key === 'heat')?.value).toBeCloseTo(14.96, 1);
  });

  it('reads left to right: every stream runs from a column to a later one', () => {
    for (const key of ['CHLOR_ALKALI', 'REFINERY', 'CRACKER_FLEX', 'VINYLS', 'STYRENICS', 'FUEL_DEPOT', 'OIL_FIELD']) {
      const s = sheetOf(key);
      const layer = new Map(s.nodes.map((n) => [n.id, n.layer]));
      for (const e of s.edges) {
        if (e.recycle) continue; // a recycle runs back against the flow, by definition
        expect(layer.get(e.to) as number).toBeGreaterThan(layer.get(e.from) as number);
        expect(e.x2).toBeGreaterThan(e.x1);
      }
    }
  });

  it('marks a recycle loop inside a process and lays the rest out around it', () => {
    const found = ['CHLOR_ALKALI', 'REFINERY', 'CRACKER_FLEX', 'VINYLS', 'STYRENICS', 'FUEL_DEPOT', 'OIL_FIELD']
      .flatMap((key) => sheetOf(key).edges.filter((e) => e.recycle).map((e) => `${key}:${e.key}`));
    expect(found).toMatchInlineSnapshot(`
      [
        "VINYLS:edc",
      ]
    `);
    // out level, under the blocks, back in level
    expect(edgePath({ x1: 300, y1: 40, x2: 100, y2: 60, recycle: true }, 200))
      .toBe('M300 40L314 40C348 40 348 218 302 218L98 218C52 218 52 60 86 60L100 60');
  });

  it('draws the refinery as one connected diagram through its shared tanks', () => {
    const s = sheetOf('REFINERY');
    expect(s.nodes.filter((n) => n.kind === 'unit').map((n) => (n as FlowUnitNode).unit.key).sort()).toEqual(
      ['RF-BTX', 'RF-CCR', 'RF-CDU', 'RF-DHT', 'RF-FCC', 'RF-FRAC', 'RF-NHT', 'RF-VDU'],
    );
    expect(s.nodes.filter((n) => n.kind === 'tank')).toHaveLength(13);
    // heavy naphtha, gasoil and VGO sit between the processes that make and use them
    for (const [material, maker, user] of [['HEAVY_NAPHTHA', 'RF-CDU', 'RF-NHT'], ['GASOIL', 'RF-CDU', 'RF-DHT'], ['VGO', 'RF-VDU', 'RF-FCC']]) {
      const t = tank(s, material);
      expect(t.role).toBe('mid');
      expect(s.edges.some((e) => e.from === unit(s, maker).id && e.to === t.id)).toBe(true);
      expect(s.edges.some((e) => e.from === t.id && e.to === unit(s, user).id)).toBe(true);
    }
    // connected: every block is reachable from the crude tank, ignoring direction
    const near = new Map<string, string[]>();
    for (const e of s.edges) {
      near.set(e.from, [...(near.get(e.from) ?? []), e.to]);
      near.set(e.to, [...(near.get(e.to) ?? []), e.from]);
    }
    const seen = new Set<string>();
    const todo = [tank(s, 'CRUDE').id];
    while (todo.length > 0) {
      const at = todo.pop() as string;
      if (seen.has(at)) continue;
      seen.add(at);
      todo.push(...(near.get(at) ?? []));
    }
    expect(seen.size).toBe(s.nodes.length);
  });

  it('shows a tank a process both draws from and returns to at both ends', () => {
    const s = sheetOf('CRACKER_FLEX');
    const lpg = s.nodes.filter((n): n is FlowTankNode => n.kind === 'tank' && n.material === 'LPG');
    expect(lpg.map((t) => t.role).sort()).toEqual(['feed', 'product']);
    expect(lpg[0].tank).toBe(lpg[1].tank);
    expect(tank(s, 'LPG', 'feed').layer).toBeLessThan(tank(s, 'LPG', 'product').layer);
  });

  it('gives no two blocks the same place and keeps everything inside the canvas', () => {
    for (const key of ['REFINERY', 'CRACKER_FLEX', 'VINYLS', 'FUEL_DEPOT']) {
      const s = sheetOf(key);
      for (const a of s.nodes) {
        expect(a.x).toBeGreaterThanOrEqual(0);
        expect(a.y).toBeGreaterThanOrEqual(0);
        expect(a.x + a.w).toBeLessThanOrEqual(s.width);
        expect(a.y + a.h).toBeLessThanOrEqual(s.height);
        for (const b of s.nodes) {
          if (a === b) continue;
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart).toBe(true);
        }
      }
    }
  });

  it('knows which feed tanks are bought in by vehicle rather than piped', () => {
    // the fixture carries no pipelines, so add the refinery's two crude lines back
    const refinery = siteOf('REFINERY');
    const piped: WorldSpec = { ...world, pipelines: [{ fromSite: 0, toSite: refinery, material: 'CRUDE', capTph: 400, points: [] }] };
    expect(tank(buildFlowsheet(piped, refinery) as Flowsheet, 'CRUDE').buys).toBe(false);
    const chlor = sheetOf('CHLOR_ALKALI');
    expect(tank(chlor, 'SALT').buys).toBe(true); // salt comes by barge
    expect(tank(chlor, 'CAUSTIC').buys).toBe(false); // a product is not bought
    expect(tank(chlor, 'SALT').h).toBeGreaterThan(tank(chlor, 'CAUSTIC').h); // room for its link
  });

  it('draws customers and sources as one block per process, and nothing for a world without flowsheet data', () => {
    const depot = sheetOf('FUEL_DEPOT');
    expect(depot.nodes.filter((n) => n.kind === 'unit')).toHaveLength(4);
    expect(depot.nodes.filter((n) => n.kind === 'tank').every((t) => (t as FlowTankNode).role === 'feed')).toBe(true);
    const field = sheetOf('OIL_FIELD');
    expect(field.nodes.map((n) => n.kind).sort()).toEqual(['tank', 'unit']);
    const bare: WorldSpec = { ...world, sites: world.sites.map((s) => ({ ...s, processes: s.processes.map((p) => ({ key: p.key, name: p.name, designRateTph: p.designRateTph, units: [] })) })) };
    expect(buildFlowsheet(bare, 0)).toBeNull();
  });

  it('draws connectors that are level at both ends, so an arrowhead is never at an angle', () => {
    // 14 px level out of the source, the bend, 14 px level into the target
    expect(edgePath({ x1: 10, y1: 20, x2: 110, y2: 60 })).toBe('M10 20L24 20C60 20 60 60 96 60L110 60');
    // a label at the source end: the line runs level for the label's length, then bends
    expect(edgePath({ x1: 10, y1: 20, x2: 210, y2: 60, run: 60, labelAt: 'from' })).toBe('M10 20L70 20C133 20 133 60 196 60L210 60');
    // a label at the target end: the bend comes first, then the level run into the unit
    expect(edgePath({ x1: 10, y1: 20, x2: 210, y2: 60, run: 60, labelAt: 'to' })).toBe('M10 20L24 20C87 20 87 60 150 60L210 60');
    // a label too long for its gap gives way; the level stretch into the target does not
    expect(edgePath({ x1: 0, y1: 0, x2: 60, y2: 30, run: 500, labelAt: 'from' })).toBe('M0 0L30 0C42 0 34 30 46 30L60 30');
  });

  it('ends every stream of every site with a level stretch into its target and starts it with one', () => {
    for (const key of ['CHLOR_ALKALI', 'REFINERY', 'CRACKER_FLEX', 'VINYLS', 'STYRENICS', 'FUEL_DEPOT', 'OIL_FIELD']) {
      const s = sheetOf(key);
      const under = Math.max(...s.nodes.map((n) => n.y + n.h));
      for (const e of s.edges) {
        const d = edgePath(e, under);
        // starts: M x1 y1 L a y1 with a at least 14 px on
        const start = /^M(-?[\d.]+) (-?[\d.]+)L(-?[\d.]+) (-?[\d.]+)/.exec(d);
        expect(start).not.toBeNull();
        expect(Number(start![4])).toBe(Number(start![2]));
        expect(Number(start![3]) - Number(start![1])).toBeGreaterThanOrEqual(STRAIGHT - 1e-6);
        // ends: … bx y2 L x2 y2 with the same y and at least 14 px of run
        const end = /(-?[\d.]+) (-?[\d.]+)L(-?[\d.]+) (-?[\d.]+)$/.exec(d);
        expect(end).not.toBeNull();
        expect(Number(end![2])).toBe(Number(end![4]));
        expect(Number(end![3]) - Number(end![1])).toBeGreaterThanOrEqual(STRAIGHT - 1e-6);
        expect(Number(end![3])).toBe(e.x2);
      }
    }
  });

  it('routes a stream that skips columns through a lane of its own, clear of every block', () => {
    const s = sheetOf('REFINERY');
    const layer = new Map(s.nodes.map((n) => [n.id, n.layer]));
    let long = 0;
    for (const e of s.edges) {
      const span = (layer.get(e.to) as number) - (layer.get(e.from) as number);
      expect(e.via).toHaveLength(Math.max(0, span - 1)); // one lane per column passed
      for (const v of e.via) {
        long += 1;
        expect(v.x1).toBeGreaterThan(v.x0);
        // no block of that column sits at the lane's height
        for (const n of s.nodes) {
          const sameColumn = n.x < v.x1 && n.x + n.w > v.x0;
          if (sameColumn) expect(v.y < n.y || v.y > n.y + n.h).toBe(true);
        }
      }
      // and the lanes read left to right between the two ends
      const xs = [e.x1, ...e.via.flatMap((v) => [v.x0, v.x1]), e.x2];
      expect([...xs].sort((p, q) => p - q)).toEqual(xs);
    }
    expect(long).toBeGreaterThan(5); // LPG, fuel oil, diesel… all cross several columns
    // a path through a lane is level across the column and curved in the gaps
    expect(edgePath({ x1: 0, y1: 10, x2: 300, y2: 50, via: [{ x0: 100, x1: 200, y: 80 }] }))
      .toBe('M0 10L14 10C57 10 57 80 100 80L200 80C243 80 243 50 286 50L300 50');
  });

  it('leaves room in every gap for the labels written there', () => {
    const s = sheetOf('REFINERY');
    for (const e of s.edges) {
      if (e.recycle) continue;
      // the gap the label sits in: from its unit to the next thing on the line
      const room = e.labelAt === 'from' ? (e.via[0]?.x0 ?? e.x2) - e.x1 : e.x2 - (e.via[e.via.length - 1]?.x1 ?? e.x1);
      expect(room).toBeGreaterThanOrEqual(Math.min(150, labelWidth(e.key, e.tph) + 44) - 1e-6);
    }
  });
});

describe('live values on the diagram', () => {
  it('scales a unit by its process rate and measures load against the trains online', () => {
    const s = sheetOf('CHLOR_ALKALI');
    const cell = unit(s, 'CA-CELL');
    const snap = snapAt(0.5);
    const live = unitLive(snap, cell);
    expect(live.trains).toBe(6);
    expect(live.trainsOnline).toBe(6);
    expect(live.inletTph).toBeCloseTo(40.3 * 0.5, 1);
    expect(live.capacityTph).toBeCloseTo(44.33, 1); // 6 × 7.389
    expect(live.load).toBeCloseTo((40.3 * 0.5) / 44.33, 2);
    expect(live.alarm).toBe(false);
    snap.unitTrains[cell.unitIndex] = 4; // two trains down
    const hurt = unitLive(snap, cell);
    expect(hurt.alarm).toBe(true);
    expect(hurt.capacityTph).toBeCloseTo(4 * 7.389, 1);
    snap.unitTrains[cell.unitIndex] = 6;
    snap.procStatus[cell.procIndex] = 2; // process shut down
    expect(unitLive(snap, cell).alarm).toBe(true);
  });

  it('gives a tank its cover on the feed side and its room on the product side', () => {
    const s = sheetOf('CHLOR_ALKALI');
    const snap = snapAt(1, 0.5);
    const salt = tank(s, 'SALT');
    const cap = world.tanks[salt.tank].capacityT;
    const live = tankLive(world, snap, salt);
    expect(live.outTph).toBeCloseTo(30.81, 1);
    expect(live.coverH).toBeCloseTo((0.5 * cap) / 30.81, 0);
    expect(live.roomH).toBeNull(); // nothing on this site fills the salt tank
    const caustic = tank(s, 'CAUSTIC');
    const room = tankLive(world, snap, caustic);
    expect(room.inTph).toBeCloseTo(21.09, 1);
    expect(room.roomH).toBeCloseTo((0.5 * world.tanks[caustic.tank].capacityT) / 21.09, 0);
    expect(room.coverH).toBeNull();
  });

  it('formats names, flows and times for labels', () => {
    expect(streamLabel('HEAVY_NAPHTHA')).toBe('Heavy naphtha');
    expect(streamLabel('LPG')).toBe('LPG');
    expect(streamLabel('wet_cl2')).toBe('wet cl2');
    expect(fmtTph(40.31)).toBe('40.3');
    expect(fmtTph(321.4)).toBe('321');
    expect(fmtHours(5.4)).toBe('5 h');
    expect(fmtHours(76.8)).toBe('3.2 d');
    expect(fmtHours(null)).toBe('—');
  });
});

describe('hourly histories', () => {
  it('places samples on whole hours ending at the latest one', () => {
    // fetched at tick 114 with 28 samples: the last is tick 112, the first tick 4
    expect(sampleTick(27, 28, 114)).toBe(112);
    expect(sampleTick(0, 28, 114)).toBe(4);
    expect(toSeries({ values: [1, 0.5], fetchedTick: 9 })).toEqual({ ticks: [4, 8], values: [1, 0.5] });
    expect(toSeries(undefined)).toEqual({ ticks: [], values: [] });
  });

  it('adds the live point, drops an abandoned future, and windows by tick', () => {
    const s = { ticks: [4, 8, 12, 16], values: [1, 2, 3, 4] };
    expect(withNow(s, 18, 9)).toEqual({ ticks: [4, 8, 12, 16, 18], values: [1, 2, 3, 4, 9] });
    expect(withNow(s, 10, 9)).toEqual({ ticks: [4, 8, 10], values: [1, 2, 9] }); // after going back to tick 10
    expect(since(s, 9)).toEqual({ ticks: [12, 16], values: [3, 4] });
    expect(since(s, 99)).toEqual({ ticks: [], values: [] });
  });

  it('sums weighted series point by point', () => {
    const a = { ticks: [4, 8], values: [1, 0.5] };
    const b = { ticks: [4, 8], values: [1, 1] };
    expect(weightedSum([{ series: a, weight: 10 }, { series: b, weight: 4 }])).toEqual({ ticks: [4, 8], values: [14, 9] });
    expect(weightedSum([{ series: a, weight: 10 }, { series: { ticks: [], values: [] }, weight: 4 }]).ticks).toEqual([]);
  });
});

describe('analytics rows', () => {
  const s = sheetOf('REFINERY');
  const procs = [...new Set(s.nodes.filter((n) => n.kind === 'unit').map((n) => (n as FlowUnitNode).procIndex))];
  const cdu = unit(s, 'RF-CDU').procIndex;
  const fcc = unit(s, 'RF-FCC').procIndex;
  // two hours of history: everything at design, then crude distillation at half
  const hist: Histories = new Map(procs.map((p) => [`p${p}`, { values: [1, p === cdu ? 0.5 : 1], fetchedTick: 8 }]));
  const snap = snapAt(1, 0.7, 10);

  it('sums each material over the processes that make it: rate x design t/h', () => {
    const rows = plantRows(s, world, snap, hist, streamLabel);
    const crude = rows.find((r) => r.id.startsWith('in-') && r.label === 'Crude oil');
    expect(crude?.design).toBeCloseTo(321.43, 1);
    expect(crude?.series.values.slice(0, 2).map((v) => Math.round(v))).toEqual([321, 161]);
    // LPG comes from distillation (6.43), reforming (3.34) and the FCC (8.84)
    const lpg = rows.find((r) => r.id.startsWith('out-') && r.label === 'LPG');
    expect(lpg?.design).toBeCloseTo(6.43 + 3.34 + 8.84, 1);
    expect(lpg?.series.values[1]).toBeCloseTo(6.43 * 0.5 + 3.34 + 8.84, 1);
    expect(lpg?.series.ticks).toEqual([4, 8, 10]); // the two samples, then now
    expect(lpg?.now).toBeCloseTo(18.61, 1);
    // intermediates are neither an input nor an output of the plant, but their tanks are listed
    expect(rows.some((r) => (r.group === 'in' || r.group === 'out') && r.label === 'Vacuum gasoil')).toBe(false);
    expect(rows.filter((r) => r.group === 'level')).toHaveLength(13);
    expect(rows.find((r) => r.id === `level-${tank(s, 'VGO').tank}`)?.now).toBeCloseTo(70, 3);
  });

  it("draws every output as its own shade of blue, the largest darkest, under a heavier black sum", () => {
    const out = plantRows(s, world, snap, hist, streamLabel).filter((r) => r.group === 'out');
    expect(out).toHaveLength(9);
    const lines = flowLines(out, 'Sum of all outputs');
    expect(lines).toHaveLength(10);
    const [sum, ...parts] = lines;
    expect(sum).toMatchObject({ label: 'Sum of all outputs', color: '#0a0a0a', width: 3, sum: true });
    expect(parts.every((l) => l.width === 2 && !l.sum)).toBe(true);
    // ordered by design flow, shaded dark to light in that order
    const designs = parts.map((l) => l.design);
    expect(designs).toEqual([...designs].sort((a, b) => b - a));
    expect(parts.map((l) => l.color)).toEqual([...blueRamp(9)].reverse());
    expect(parts[0].color).toBe(blueRamp(9)[8]);
    expect(parts[8].color).toBe(blueRamp(9)[0]);
    // the sum is the sum: at design, with distillation at half, and right now
    expect(sum.series.ticks).toEqual([4, 8, 10]);
    sum.series.values.forEach((v, i) => {
      expect(v).toBeCloseTo(parts.reduce((acc, l) => acc + l.series.values[i], 0), 6);
    });
    expect(sum.series.values[1]).toBeLessThan(sum.series.values[0]);
    expect(sum.now).toBeCloseTo(out.reduce((acc, r) => acc + r.now, 0), 6);
    expect(sum.design).toBeCloseTo(designs.reduce((acc, v) => acc + v, 0), 6);
    // colours go by design flow, not by how the plant runs today
    const slow = flowLines(plantRows(s, world, snapAt(0.3, 0.7, 10), hist, streamLabel).filter((r) => r.group === 'out'), 'Sum of all outputs');
    expect(slow.map((l) => [l.label, l.color])).toEqual(lines.map((l) => [l.label, l.color]));
  });

  it("gives a single chemical no sum line, and a customer or a source only the side it has", () => {
    const rows = plantRows(s, world, snap, hist, streamLabel);
    const into = flowLines(rows.filter((r) => r.group === 'in'), 'Sum of all inputs');
    expect(into.map((l) => l.label)).toEqual(['Crude oil']); // one input: it is its own total
    expect(into[0].sum).toBe(false);
    expect(into[0].color).toBe(blueRamp(1)[0]);
    expect(flowLines([], 'Sum of all inputs')).toEqual([]);

    const flex = sheetOf('CRACKER_FLEX');
    const flexRows = plantRows(flex, world, snapAt(1, 0.7, 10), new Map(), streamLabel);
    expect(flowLines(flexRows.filter((r) => r.group === 'in'), 'Sum of all inputs')).toHaveLength(3 + 1);
    expect(flowLines(flexRows.filter((r) => r.group === 'out'), 'Sum of all outputs')).toHaveLength(6 + 1);

    const chlor = plantRows(sheetOf('CHLOR_ALKALI'), world, snapAt(1, 0.7, 10), new Map(), streamLabel);
    expect(flowLines(chlor.filter((r) => r.group === 'in'), 'Sum of all inputs')).toHaveLength(1);
    expect(flowLines(chlor.filter((r) => r.group === 'out'), 'Sum of all outputs')).toHaveLength(2 + 1);

    const depot = plantRows(sheetOf('FUEL_DEPOT'), world, snapAt(1, 0.7, 10), new Map(), streamLabel);
    expect(depot.filter((r) => r.group === 'out')).toHaveLength(0);
    expect(depot.filter((r) => r.group === 'in').length).toBeGreaterThan(0);
    const field = plantRows(sheetOf('OIL_FIELD'), world, snapAt(1, 0.7, 10), new Map(), streamLabel);
    expect(field.filter((r) => r.group === 'in')).toHaveLength(0);
    expect(field.filter((r) => r.group === 'out').length).toBeGreaterThan(0);
  });

  it('gives each unit its throughput: process rate x everything it takes in', () => {
    const rows = unitRows(s, snap, hist);
    expect(rows).toHaveLength(8);
    const frac = rows.find((r) => r.label === 'RF-FRAC');
    expect(frac?.design).toBeCloseTo(76.34, 1);
    expect(frac?.now).toBeCloseTo(76.34, 1);
    const cduRow = rows.find((r) => r.label === 'RF-CDU');
    expect(cduRow?.series.values.slice(0, 2).map((v) => Math.round(v))).toEqual([321, 161]);
    expect(cduRow?.capacity).toBeGreaterThan(321);
    expect(fcc).not.toBe(cdu);
  });

  it('reports throughput, the tightest feed cover and the tightest product room', () => {
    const h = headline(s, world, snapAt(0.5, 0.7));
    expect(h.throughput).toBeCloseTo(0.5, 6);
    expect(h.feedTank).toBe('CRUDE');
    const cap = world.tanks[tank(s, 'CRUDE').tank].capacityT;
    expect(h.feedCoverH).toBeCloseTo((0.7 * cap) / (321.43 * 0.5), 0);
    expect(h.productRoomH).toBeGreaterThan(0);
    expect(h.productTank).not.toBeNull();
    // a customer has feed cover but makes nothing
    const depot = headline(sheetOf('FUEL_DEPOT'), world, snapAt(1));
    expect(depot.feedCoverH).toBeGreaterThan(0);
    expect(depot.productRoomH).toBeNull();
  });
});
