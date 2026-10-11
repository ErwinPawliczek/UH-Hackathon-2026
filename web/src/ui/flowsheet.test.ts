// The process flow diagram and the analytics numbers, checked against real
// flowsheet data from the default world (a fixture cut from its world JSON).

import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/flowsheetSites.json';
import type { Snapshot } from '../engine/snapshot';
import type { WorldSpec } from '../engine/world';
import {
  buildFlowsheet, edgePath, fmtHours, fmtTph, labelWidth, streamLabel, tankLive, unitLive,
  type FlowTankNode, type FlowUnitNode, type Flowsheet,
} from './flowsheet';
import {
  headline, plantRows, sampleTick, since, toSeries, unitRows, weightedSum, withNow, type Histories,
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
    expect(edgePath({ x1: 300, y1: 40, x2: 100, y2: 60, recycle: true }, 200)).toContain('L110 218');
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

  it('draws connectors as left-to-right curves, level beside their label', () => {
    expect(edgePath({ x1: 10, y1: 20, x2: 110, y2: 60 })).toBe('M10 20C60 20 60 60 110 60');
    // a label at the source end: the line runs level for its length, then bends
    expect(edgePath({ x1: 10, y1: 20, x2: 210, y2: 60, run: 60, labelAt: 'from' })).toBe('M10 20L70 20C140 20 140 60 210 60');
    // a label at the target end: the bend comes first, then the level run into the unit
    expect(edgePath({ x1: 10, y1: 20, x2: 210, y2: 60, run: 60, labelAt: 'to' })).toBe('M10 20C80 20 80 60 150 60L210 60');
    // never so long a run that nothing is left for the bend
    expect(edgePath({ x1: 0, y1: 0, x2: 60, y2: 30, run: 500, labelAt: 'from' })).toBe('M0 0L36 0C48 0 48 30 60 30');
  });

  it('leaves room in every gap for the labels written there', () => {
    const s = sheetOf('REFINERY');
    for (const e of s.edges) {
      if (e.recycle) continue;
      expect(e.x2 - e.x1).toBeGreaterThanOrEqual(Math.min(150, labelWidth(e.key, e.tph) + 44) - 1e-6);
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
