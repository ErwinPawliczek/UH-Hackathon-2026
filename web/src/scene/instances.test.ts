// Movement interpolation: polyline sampling (sampleRoute) and snapshot-to-
// snapshot interpolation (lerpPose). The fixture builds a lean typed snapshot
// the same way the codec does, so the tests exercise the views the scene
// consumes.

import { describe, expect, it } from 'vitest';
import type { Snapshot } from '../engine/snapshot';
import { stubWorld, type WorldSpec } from '../engine/world';
import { lerpPose, sampleRoute, type VehiclePose } from './instances';

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
