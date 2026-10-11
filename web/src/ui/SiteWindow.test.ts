// The site window's header line: the plant's state in words.

import { describe, expect, it } from 'vitest';
import fixture from './__fixtures__/flowsheetSites.json';
import type { Snapshot } from '../engine/snapshot';
import type { WorldSpec } from '../engine/world';
import { buildFlowsheet, type FlowUnitNode } from './flowsheet';
import { stateWords } from './SiteWindow';

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
