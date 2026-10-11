// How vehicles move between snapshots: the network path between two places,
// continuous driving across a junction and against a route's drawn direction,
// carrying on from mid-drive when a snapshot arrives early, and placing at
// once when the run was replaced.

import { describe, expect, it } from 'vitest';
import type { RouteSpec } from '../engine/world';
import type { VehiclePose } from './instances';
import { RouteNet, VehicleMotion, type DrawTarget, type NetLoc } from './vehicleMotion';

// An L-shaped road in two routes that meet at (10, 0), a spur off that
// junction, and a river elsewhere (never joined to the roads).
const routes: RouteSpec[] = [
  { mode: 'road', ends: ['A', 'J'], sites: [0, null], points: [[0, 0], [10, 0]] },
  { mode: 'road', ends: ['J', 'B'], sites: [null, 1], points: [[10, 0], [10, 4], [10, 10]] },
  { mode: 'road', ends: ['C', 'J'], sites: [2, null], points: [[20, 0], [10, 0]] },
  { mode: 'river', ends: ['R', 'S'], sites: [3, 4], points: [[0, 50], [40, 50]] },
];
const net = new RouteNet({ routes });
const truck = { mode: 'road' as const, speedKmh: 70 };

const on = (route: number, s: number): NetLoc => ({ kind: 'route', route, s });
function target(loc: NetLoc): DrawTarget {
  const at = loc.kind === 'route' ? net.pointAt(loc.route, loc.s) : { x: 0, y: 0 };
  return { x: at.x, y: at.y, net: loc, dir: [0, 1], restDir: null, standoffKm: 0 };
}
const lengthOf = (pts: [number, number][]) =>
  pts.slice(1).reduce((sum, p, i) => sum + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);

describe('RouteNet', () => {
  it('joins route ends that share a point, per mode', () => {
    expect(net.siteNode(0, 'road')).toBeGreaterThanOrEqual(0);
    expect(net.siteNode(0, 'river')).toBe(-1);
    expect(net.nodeNear('road', 10.2, 0.1, 1.5)).toBe(net.nodeNear('road', 10, 0, 0.01));
    expect(net.nodeNear('river', 10, 0, 1.5)).toBe(-1);
  });

  it('gives the stretch of one route in either direction', () => {
    expect(net.path(on(1, 2), on(1, 7))).toEqual([[10, 2], [10, 4], [10, 7]]);
    expect(net.path(on(1, 7), on(1, 2))).toEqual([[10, 7], [10, 4], [10, 2]]);
  });

  it('goes through the junction when the route changes', () => {
    const path = net.path(on(0, 6), on(1, 3))!;
    expect(path).toEqual([[6, 0], [10, 0], [10, 3]]);
    // against route 2's drawn direction, then down route 0
    const back = net.path(on(2, 4), on(0, 5))!;
    expect(back).toEqual([[16, 0], [10, 0], [5, 0]]);
    expect(lengthOf(back)).toBeCloseTo(11, 6);
  });

  it('finds no path between a road and a river', () => {
    expect(net.path(on(0, 5), on(3, 5))).toBeNull();
  });
});

describe('VehicleMotion', () => {
  const run = (motion: VehicleMotion, t: number): VehiclePose => {
    const out: VehiclePose[] = [];
    motion.sample(t, out);
    return out[0];
  };

  it('drives round a junction instead of cutting the corner or freezing', () => {
    const motion = new VehicleMotion(net, [truck]);
    motion.retarget([target(on(0, 6))], 0, 0, true);
    motion.retarget([target(on(1, 3))], 250, 1, false);
    // 7 km to drive (4 to the junction, 3 beyond) over the step
    const seen: VehiclePose[] = [];
    for (let t = 250; t <= 550; t += 25) seen.push(run(motion, t));
    expect(seen[0].x).toBeCloseTo(6, 6);
    const last = seen[seen.length - 1];
    expect(last.x).toBeCloseTo(10, 6);
    expect(last.y).toBeCloseTo(3, 6);
    for (const p of seen) {
      // always on one of the two roads, never across the corner
      expect(Math.min(Math.abs(p.y), Math.abs(p.x - 10))).toBeLessThan(1e-6);
    }
    for (let i = 1; i < seen.length - 1; i++) {
      // constant speed: equal steps along the path
      const step = Math.abs(seen[i].x - seen[i - 1].x) + Math.abs(seen[i].y - seen[i - 1].y);
      expect(step).toBeGreaterThan(0.3);
      expect(step).toBeLessThan(0.9);
    }
  });

  it('drives smoothly against a route\'s drawn direction', () => {
    const motion = new VehicleMotion(net, [truck]);
    motion.retarget([target(on(0, 9))], 0, 0, true);
    motion.retarget([target(on(0, 2))], 250, 1, false);
    const mid = run(motion, 250 + 137.5);
    expect(mid.x).toBeGreaterThan(2);
    expect(mid.x).toBeLessThan(9);
    // facing the way it drives (west), not the way the route was drawn
    run(motion, 250 + 200);
    expect(run(motion, 250 + 250).dirX).toBeLessThan(-0.9);
  });

  it('carries on from where it is when the next snapshot comes early', () => {
    const motion = new VehicleMotion(net, [truck]);
    motion.retarget([target(on(0, 0))], 0, 0, true);
    motion.retarget([target(on(0, 8))], 250, 1, false);
    const before = run(motion, 400);
    motion.retarget([target(on(1, 6))], 400, 1, false);
    const after = run(motion, 400);
    expect(after.x).toBeCloseTo(before.x, 6);
    expect(after.y).toBeCloseTo(before.y, 6);
    // and still arrives at the newest place
    const end = run(motion, 2000);
    expect(end.x).toBeCloseTo(10, 6);
    expect(end.y).toBeCloseTo(6, 6);
  });

  it('stands still while its place does not change', () => {
    const motion = new VehicleMotion(net, [truck]);
    motion.retarget([target(on(1, 5))], 0, 0, true);
    motion.retarget([target(on(1, 5))], 250, 1, false);
    const a = run(motion, 300);
    const b = run(motion, 480);
    expect(b).toEqual(a);
  });

  it('is placed at once when the run is replaced or goes back in time', () => {
    const motion = new VehicleMotion(net, [truck]);
    motion.retarget([target(on(0, 9))], 0, 0, true);
    motion.retarget([target(on(1, 9))], 250, 1, false);
    motion.retarget([target(on(0, 1))], 300, 0, true);
    const p = run(motion, 300);
    expect(p.x).toBeCloseTo(1, 6);
    expect(p.y).toBeCloseTo(0, 6);
    expect(run(motion, 320).x).toBeCloseTo(1, 6);
  });

  it('does not drive a distance the vehicle cannot have covered', () => {
    const far: RouteSpec[] = [{ mode: 'road', ends: ['A', 'B'], sites: [0, 1], points: [[0, 0], [900, 0]] }];
    const farNet = new RouteNet({ routes: far });
    const at = (s: number): DrawTarget => ({ x: s, y: 0, net: { kind: 'route', route: 0, s }, dir: [1, 0], restDir: null, standoffKm: 0 });
    const motion = new VehicleMotion(farNet, [truck]);
    motion.retarget([at(0)], 0, 0, true);
    motion.retarget([at(800)], 250, 1, false); // 800 km in one 15-minute tick
    expect(run(motion, 251).x).toBeCloseTo(800, 6);
  });

  it('pulls a parked truck off the road beside its site and back on', () => {
    const motion = new VehicleMotion(net, [truck]);
    const node = net.siteNode(1, 'road');
    const parked: DrawTarget = { x: 12, y: 11, net: { kind: 'node', node }, dir: [0, 1], restDir: [1, 0], standoffKm: 2 };
    motion.retarget([target(on(1, 4))], 0, 0, true);
    motion.retarget([parked], 250, 1, false);
    const end = run(motion, 1000);
    expect(end.x).toBeCloseTo(12, 6);
    expect(end.y).toBeCloseTo(11, 6);
    // it left the road 2 km short of the site at (10, 10)
    const mid: VehiclePose[] = [];
    for (let t = 250; t < 525; t += 5) mid.push(run(motion, t));
    expect(mid.some((p) => Math.abs(p.x - 10) < 1e-6 && p.y > 7.5 && p.y <= 8.01)).toBe(true);
    expect(mid.every((p) => !(Math.abs(p.x - 10) < 1e-6 && p.y > 8.01))).toBe(true);
  });
});
