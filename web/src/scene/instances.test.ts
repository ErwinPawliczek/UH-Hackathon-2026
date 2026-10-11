// Movement interpolation: polyline sampling (sampleRoute) and snapshot-to-
// snapshot interpolation (lerpPose). The fixture builds a lean typed snapshot
// the same way the codec does, so the tests exercise the views the scene
// consumes.

import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../engine/snapshot';
import { stubWorld, type WorldSpec } from '../engine/world';
import {
  buildVehicleLayer, classMode, lerpPose, liveCargo, sampleRoute, vehicleGeometry, waterSpan,
  type VehiclePose,
} from './instances';
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

describe('sampleRoute', () => {
  const line: [number, number][] = [[0, 0], [10, 0]];
  const elbow: [number, number][] = [[0, 0], [4, 0], [4, 3]];
  const idle: VehiclePose = { x: -1, y: -1, dirX: 0, dirY: 1 };

  it('places and orients a vehicle on a straight lane', () => {
    const p = sampleRoute(line, 0.25, idle);
    expect(p.x).toBeCloseTo(2.5, 5);
    expect(p.y).toBeCloseTo(0, 5);
    expect(p.dirX).toBe(1);
    expect(p.dirY).toBe(0);
  });

  it('samples by arc length across segments', () => {
    // elbow: legs 4 + 3, total 7 — 4.5 km along sits on the vertical leg
    const p = sampleRoute(elbow, 4.5 / 7, idle);
    expect(p.x).toBeCloseTo(4, 5);
    expect(p.y).toBeCloseTo(0.5, 5);
    expect(p.dirX).toBe(0);
    expect(p.dirY).toBe(1);
  });

  it('clamps outside [0,1] to the ends', () => {
    expect(sampleRoute(line, -0.5, idle).x).toBe(0);
    expect(sampleRoute(line, 1.5, idle).x).toBe(10);
  });

  it('falls back to the given pose for degenerate polylines', () => {
    expect(sampleRoute([[3, 3]], 0.5, idle)).toBe(idle);
    expect(sampleRoute([[0, 0], [0, 0]], 0.5, idle)).toBe(idle);
  });
});

describe('lerpPose', () => {
  it('returns the engine pose on v1 payloads (no movement arrays)', () => {
    const cur = makeSnap(1);
    cur.vehPos.set([10, 20, 1, 0, 0.5], 0);
    const pose = lerpPose(world, cur, null, 0, 0.5);
    expect(pose.x).toBe(10);
    expect(pose.y).toBe(20);
  });

  it('slides along the assigned route between snapshot progresses', () => {
    const prev = makeSnap(1, { route: [0], progress: [0.2] });
    const cur = makeSnap(1, { route: [0], progress: [0.4] });
    // f = 0.5 → progress 0.3 along route 0's polyline
    const pose = lerpPose(world, cur, prev, 0, 0.5);
    const expected = sampleRoute(world.routes[0].points, 0.3, pose);
    expect(pose.x).toBeCloseTo(expected.x, 5);
    expect(pose.y).toBeCloseTo(expected.y, 5);
  });

  it('holds at the snapshot pose across a route switch (replan/detour)', () => {
    const prev = makeSnap(1, { route: [0], progress: [0.9] });
    const cur = makeSnap(1, { route: [1], progress: [0.1] });
    const pose = lerpPose(world, cur, prev, 0, 0.5);
    const expected = sampleRoute(world.routes[1].points, 0.1, pose);
    expect(pose.x).toBeCloseTo(expected.x, 5);
    expect(pose.y).toBeCloseTo(expected.y, 5);
  });

  it('holds at the snapshot pose when progress resets backwards', () => {
    const prev = makeSnap(1, { route: [0], progress: [0.9] });
    const cur = makeSnap(1, { route: [0], progress: [0.1] });
    const pose = lerpPose(world, cur, prev, 0, 0.5);
    const expected = sampleRoute(world.routes[0].points, 0.1, pose);
    expect(pose.x).toBeCloseTo(expected.x, 5);
  });

  it('trusts the engine pose over a malformed route id', () => {
    const cur = makeSnap(1, { route: [999], progress: [0.4] });
    cur.vehPos.set([10, 20, 1, 0, 0.5], 0);
    const pose = lerpPose(world, cur, null, 0, 0.5);
    expect(pose.x).toBe(10);
    expect(pose.y).toBe(20);
  });
});

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

  it('lets lerpPose hold a vessel on the wet stretch', () => {
    const snap = makeSnap(1, { route: [0], progress: [0.0] });
    const lane: WorldSpec = {
      ...world,
      routes: [{ mode: 'river', ends: ['A', 'B'], sites: [0, null], points: [[0, 0], [30, 0]] }],
    };
    const span = waterSpan(lane.routes[0].points, isWater)!;
    const clamp = (_r: number, p: number) => Math.min(span.s1, Math.max(span.s0, p * span.length)) / span.length;
    const pose = lerpPose(lane, snap, null, 0, 1, clamp);
    expect(pose.x).toBeGreaterThan(10); // not at the site on the bank
    expect(lerpPose(lane, snap, null, 0, 1).x).toBeCloseTo(0, 6); // unclamped: the lane's dry end
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
});
