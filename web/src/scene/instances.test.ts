// The instanced vehicle layer: class meshes, cargo colours, the wet stretch
// of a lane. (How vehicles move between snapshots is vehicleMotion.test.ts.)
// The fixture builds a lean typed snapshot the same way the codec does.

import { describe, expect, it } from 'vitest';
import type * as THREE from 'three';
import type { Snapshot } from '../engine/snapshot';
import { stubWorld, type WorldSpec } from '../engine/world';
import { buildVehicleLayer, classMode, liveCargo, vehicleGeometry, vehicleParts, waterSpan } from './instances';
import { VEHICLE_CLASSES, type VehicleClassKey } from '../engine/world';

/** Lean v2-shaped snapshot with nVeh vehicles; movement arrays optional. */
function makeSnap(nVeh: number, opts?: { route?: number[]; progress?: number[] }): Snapshot {
  const f32 = (n: number) => new Float32Array(n);
  const u8 = (n: number) => new Uint8Array(n);
  const u32 = (n: number) => new Uint32Array(n);
  const snap = {
    version: 2,
    tick: 40n,
    nTanks: 1, nProc: 1, nUnits: 1, nSites: 1, nVeh, nPipes: 1, nEdges: 1, nMats: 1,
    tanks: f32(4), procRate: f32(1), procStatus: u8(1), unitTrains: u8(1),
    siteStatus: u8(1), siteUrgency: f32(1),
    vehPos: f32(5 * nVeh), vehStatus: u8(2 * nVeh), vehOrder: u32(nVeh),
    pipeFlow: f32(1), edgeOpen: u8(1), prices: f32(1),
  } as unknown as Snapshot;
  if (opts?.route !== undefined) snap.vehRoute = Uint32Array.from(opts.route);
  if (opts?.progress !== undefined) snap.vehProgress = Float32Array.from(opts.progress);
  return snap;
}

const world: WorldSpec = stubWorld(42);

describe('vehicle layer', () => {
  it('maps instance slots to vehicles when a class is split across the fleet list', () => {
    // An engine fleet lists vehicles home by home, so classes interleave.
    const mixed: WorldSpec = {
      ...world,
      vehicles: [
        { cls: 'TRUCK_TANK', cargo: 'NAPHTHA' },
        { cls: 'BARGE_TANK', cargo: 'NAPHTHA' },
        { cls: 'TRUCK_TANK', cargo: 'NAPHTHA' },
        { cls: 'SHIP_GAS', cargo: 'LPG' },
        { cls: 'TRUCK_TANK', cargo: 'NAPHTHA' },
      ],
    };
    const layer = buildVehicleLayer(mixed);
    expect(layer.members).toEqual([[0, 2, 4], [1], [3]]);
    expect(layer.meshes.map((m) => m.count)).toEqual([3, 1, 1]);
  });
});

describe('liveCargo', () => {
  it('reads the cargo on board from the snapshot and null when empty', () => {
    const snap = makeSnap(2);
    snap.vehStatus[1] = 255; // vehicle 0: empty
    snap.vehStatus[3] = 2; // vehicle 1: material index 2
    const engineWorld: WorldSpec = { ...world, materials: ['CRUDE', 'HEAVY_NAPHTHA', 'BENZENE'] };
    expect(liveCargo(engineWorld, snap, 0)).toBeNull();
    expect(liveCargo(engineWorld, snap, 1)).toBe('BENZENE');
    // without an engine material list the snapshot indexes the traded-material table
    expect(liveCargo(world, snap, 1)).toBe('SALT');
  });
});

describe('waterSpan', () => {
  // water is everything east of x = 10
  const isWater = (x: number) => x > 10;

  it('finds the wet stretch of a lane that starts on land', () => {
    const span = waterSpan([[0, 0], [30, 0]], isWater);
    expect(span).not.toBeNull();
    expect(span!.length).toBeCloseTo(30, 6);
    expect(span!.s0).toBeGreaterThan(10);
    expect(span!.s0).toBeLessThanOrEqual(11);
    expect(span!.s1).toBeCloseTo(30, 6);
  });

  it('measures along a bent lane and reports none when it never touches water', () => {
    const bent = waterSpan([[20, 0], [20, 10], [0, 10]], isWater);
    expect(bent!.s0).toBeCloseTo(0, 6);
    expect(bent!.s1).toBeGreaterThanOrEqual(19);
    expect(bent!.s1).toBeLessThan(20);
    expect(waterSpan([[0, 0], [5, 5]], isWater)).toBeNull();
  });
});

describe('vehicle classes', () => {
  it('maps classes to their transport mode', () => {
    expect(classMode('TRUCK_PRESS')).toBe('road');
    expect(classMode('BARGE_DRY')).toBe('river');
    expect(classMode('SHIP_GAS')).toBe('sea');
  });

  it('gives every class its own silhouette, with tones for the instance colour to tint', () => {
    const counts = new Set<number>();
    for (const cls of Object.keys(VEHICLE_CLASSES) as VehicleClassKey[]) {
      const geo = vehicleGeometry(cls);
      expect(geo.getAttribute('color').count).toBe(geo.getAttribute('position').count);
      geo.computeBoundingBox();
      expect(geo.boundingBox!.min.y).toBeGreaterThan(-1e-3); // sits on the surface
      counts.add(geo.getAttribute('position').count * 1000 + Math.round(geo.boundingBox!.max.y * 100));
    }
    expect(counts.size).toBe(Object.keys(VEHICLE_CLASSES).length);
  });

  it('keeps what a truck or barge carries as a separate part, so an empty one is drawn without it', () => {
    for (const cls of ['TRUCK_TANK', 'TRUCK_PRESS', 'TRUCK_BULK', 'BARGE_TANK', 'BARGE_DRY'] as VehicleClassKey[]) {
      const parts = vehicleParts(cls);
      expect(parts.cargo).not.toBeNull();
      // the bare vehicle is lower than the loaded one: nothing on its back
      parts.base.computeBoundingBox();
      const whole = vehicleGeometry(cls);
      whole.computeBoundingBox();
      const baseHeight = cls.startsWith('TRUCK')
        ? heightBehindCab(parts.base)
        : heightAmidships(parts.base);
      expect(baseHeight).toBeLessThan(cls.startsWith('TRUCK') ? heightBehindCab(whole) : heightAmidships(whole));
    }
    // ships are drawn in one piece and only lose their cargo tint when empty
    for (const cls of ['SHIP_TANK', 'SHIP_GAS', 'SHIP_DRY'] as VehicleClassKey[]) {
      expect(vehicleParts(cls).cargo).toBeNull();
    }
  });
});

/** Highest point of a geometry within a slice of its length (local z). */
function heightIn(geo: THREE.BufferGeometry, z0: number, z1: number): number {
  const pos = geo.getAttribute('position');
  let top = 0;
  for (let i = 0; i < pos.count; i++) if (pos.getZ(i) >= z0 && pos.getZ(i) <= z1) top = Math.max(top, pos.getY(i));
  return top;
}
const heightBehindCab = (geo: THREE.BufferGeometry) => heightIn(geo, -1, 0.115); // the cab starts at z = 0.12
const heightAmidships = (geo: THREE.BufferGeometry) => heightIn(geo, -0.38, 1); // forward of the pusher house
