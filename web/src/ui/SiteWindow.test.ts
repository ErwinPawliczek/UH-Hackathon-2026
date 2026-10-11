// The site window's header line: the plant's state in words.

import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/flowsheetSites.json';
import type { Snapshot } from '../engine/snapshot';
import type { WorldSpec } from '../engine/world';
import { buildFlowsheet, type FlowUnitNode } from './flowsheet';
import { hasBothFlows, scrollToFirstAlarm, stateWords } from './SiteWindow';

const world = { ...(fixture as unknown as WorldSpec), pipelines: [] } as WorldSpec;
const siteIdx = world.sites.findIndex((s) => s.key === 'REFINERY');
const sheet = buildFlowsheet(world, siteIdx);
const procOf = (unitKey: string) =>
  (sheet?.nodes.find((n) => n.kind === 'unit' && n.unit.key === unitKey) as FlowUnitNode);

function snap(rate = 1): Snapshot {
  return {
    version: 2, tick: 400n, nTanks: world.tanks.length, nProc: 64, nUnits: 128, nSites: 22, nVeh: 0, nPipes: 0, nEdges: 0, nMats: 0,
    tanks: new Float32Array(4 * world.tanks.length).fill(0.6), procRate: new Float32Array(64).fill(rate),
    procStatus: new Uint8Array(64), unitTrains: new Uint8Array(128).fill(8), siteStatus: new Uint8Array(22),
    siteUrgency: new Float32Array(22), vehPos: new Float32Array(0), vehStatus: new Uint8Array(0), vehOrder: new Uint32Array(0),
    pipeFlow: new Float32Array(0), edgeOpen: new Uint8Array(0), prices: new Float32Array(0),
  } as Snapshot;
}

describe('stateWords', () => {
  it('reports the rate when everything runs', () => {
    expect(stateWords(sheet, world, snap(0.97), siteIdx)).toEqual({ text: 'Running at 97% of design', alarm: false });
  });

  it('names the processes that are shut down, and counts units with trains down', () => {
    const s = snap();
    s.procStatus[procOf('RF-CDU').procIndex] = 2;
    s.unitTrains[procOf('RF-DHT').unitIndex] = 1; // one of its two trains
    expect(stateWords(sheet, world, s, siteIdx)).toEqual({
      text: 'Shut down: Crude distillation · 1 unit with trains down', alarm: true,
    });
  });

  it('says when a process is restarting or holding at minimum', () => {
    const s = snap();
    s.procStatus[procOf('RF-FCC').procIndex] = 3;
    expect(stateWords(sheet, world, s, siteIdx).text).toBe('Restarting: Fluid catalytic cracking');
    const h = snap();
    h.procStatus[procOf('RF-DHT').procIndex] = 1;
    expect(stateWords(sheet, world, h, siteIdx)).toEqual({ text: 'Holding at minimum rate: Diesel hydrotreating', alarm: false });
  });
});

describe('scrollToFirstAlarm', () => {
  it('centres the first unit that is down, within what can be scrolled', () => {
    if (sheet === null) throw new Error('fixture has no refinery flowsheet');
    expect(scrollToFirstAlarm(sheet, snap(), 600)).toBeNull(); // nothing down: start at the feed end
    const s = snap();
    const fcc = procOf('RF-FCC');
    s.unitTrains[fcc.unitIndex] = 0;
    const left = scrollToFirstAlarm(sheet, s, 600) as number;
    expect(left).toBeGreaterThan(0);
    // the unit's middle is at the middle of the view
    expect(left + 300).toBeCloseTo(fcc.x + fcc.w / 2, 6);
    // the first unit down wins when several are, and the scroll never runs past either end
    const cdu = procOf('RF-CDU');
    s.procStatus[cdu.procIndex] = 2;
    expect(cdu.x).toBeLessThan(fcc.x); // the CDU is further left, so it is the one shown
    expect(scrollToFirstAlarm(sheet, s, 600)).toBeCloseTo(Math.max(0, cdu.x + cdu.w / 2 - 300), 6);
    expect(scrollToFirstAlarm(sheet, s, 5000)).toBe(0); // a view wider than the diagram does not scroll
  });
});

describe('hasBothFlows', () => {
  it("is true for a plant, and false for a customer or a source, which have one flow chart", () => {
    const sheetOf = (key: string) => buildFlowsheet(world, world.sites.findIndex((x) => x.key === key));
    for (const key of ['REFINERY', 'CRACKER_FLEX', 'CHLOR_ALKALI']) expect(hasBothFlows(sheetOf(key)!)).toBe(true);
    for (const key of ['FUEL_DEPOT', 'OIL_FIELD']) expect(hasBothFlows(sheetOf(key)!)).toBe(false);
  });
});

describe('a limited site', () => {
  it("says what a shock has cut, and to how much", () => {
    const s = snap(0.5);
    s.siteStatus[siteIdx] = 5;
    expect(stateWords(sheet, world, s, siteIdx)).toEqual({ text: 'Output cut to 50%', alarm: false });
    const depot = world.sites.findIndex((x) => x.key === 'FUEL_DEPOT');
    const d = snap(0.4);
    d.siteStatus[depot] = 5;
    expect(stateWords(buildFlowsheet(world, depot), world, d, depot).text).toBe('Demand cut to 40%');
  });
});
