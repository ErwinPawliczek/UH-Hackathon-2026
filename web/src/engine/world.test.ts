import { describe, expect, it } from 'vitest';
import { routeLength, routePointAt, sampleHeight, stubWorld, VEHICLE_CLASSES, MATERIALS } from './world';
import { stubVehicleState } from './stub';

describe('stubWorld', () => {
  it('is deterministic per seed', () => {
    const a = stubWorld(42);
    const b = stubWorld(42);
    expect(Array.from(a.terrain.height)).toEqual(Array.from(b.terrain.height));
    expect(a.routes.map((r) => r.points)).toEqual(b.routes.map((r) => r.points));
  });

  it('varies terrain by seed', () => {
    expect(Array.from(stubWorld(1).terrain.height)).not.toEqual(Array.from(stubWorld(2).terrain.height));
  });

  it('keeps every route and pipeline point inside the map', () => {
    for (const seed of [1, 42, 999]) {
      const w = stubWorld(seed);
      for (const r of [...w.routes, ...w.pipelines]) {
        for (const [x, y] of r.points) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(w.wKm);
          expect(y).toBeGreaterThanOrEqual(0);
          expect(y).toBeLessThanOrEqual(w.hKm);
        }
      }
    }
  });

  it('references valid sites from tanks, pipelines and vehicles', () => {
    const w = stubWorld(42);
    const nSites = w.sites.length;
    for (const t of w.tanks) expect(t.site).toBeLessThan(nSites);
    for (const p of w.pipelines) {
      expect(p.fromSite).toBeLessThan(nSites);
      expect(p.toSite).toBeLessThan(nSites);
    }
    for (const v of w.vehicles) expect(v.route).toBeLessThan(w.routes.length);
    expect(Object.keys(VEHICLE_CLASSES)).toContain(w.vehicles[0].cls);
  });

  it('builds terrain with land and sea', () => {
    const w = stubWorld(42);
    expect(w.terrain.height.length).toBe(w.terrain.cols * w.terrain.rows);
    const min = Math.min(...w.terrain.height);
    const max = Math.max(...w.terrain.height);
    expect(min).toBeLessThan(w.terrain.seaLevelM); // sea floor below water
    expect(max).toBeGreaterThan(w.terrain.seaLevelM); // land above it
  });
});

describe('route helpers', () => {
  const line: [number, number][] = [[0, 0], [10, 0], [10, 15]];

  it('computes arc length', () => {
    expect(routeLength(line)).toBe(25);
  });

  it('interpolates positions and directions', () => {
    const mid = routePointAt(line, 12.5);
    expect(mid.x).toBe(10);
    expect(mid.y).toBe(2.5);
    expect(mid.dirX).toBe(0);
    expect(mid.dirY).toBe(1);
  });

  it('clamps to the ends', () => {
    const start = routePointAt(line, -5);
    const end = routePointAt(line, 999);
    expect(start.x).toBe(0);
    expect(end.x).toBe(10);
    expect(end.y).toBe(15);
  });

  it('rides vehicles along their routes in both directions', () => {
    const w = stubWorld(42);
    const v = w.vehicles[0];
    const route = w.routes[v.route];
    const a = stubVehicleState(w, 0, 0);
    const half = stubVehicleState(w, v.loopTicks / 2, 0);
    // poses match the polyline interpolation at the same arc length
    const expectedHalf = routePointAt(route.points, 0.5 * routeLength(route.points));
    expect(a.x).toBeCloseTo(route.points[0][0], 5);
    expect(a.y).toBeCloseTo(route.points[0][1], 5);
    expect(half.x).toBeCloseTo(expectedHalf.x, 5);
    expect(half.y).toBeCloseTo(expectedHalf.y, 5);
    expect(half.legProgress).toBeCloseTo(0.5, 5);
    // etaTick is absolute: at half the leg (tick loopTicks/2) it is loopTicks/2 away
    expect(half.etaTick).toBe(v.loopTicks);
  });
});

describe('sampleHeight', () => {
  const grid = stubWorld(1).terrain;

  it('matches grid samples exactly at lattice points', () => {
    expect(sampleHeight(grid, 0, 0)).toBeCloseTo(grid.height[0], 5);
    const i = 3 * grid.cols + 7;
    expect(sampleHeight(grid, 70, 30)).toBeCloseTo(grid.height[i], 5);
  });

  it('clamps outside the grid', () => {
    expect(sampleHeight(grid, -50, 200)).toBeCloseTo(sampleHeight(grid, 0, 200), 5);
    expect(sampleHeight(grid, 100, 900)).toBeCloseTo(sampleHeight(grid, 100, 400), 5);
  });

  it('bilinearly interpolates the cell interior', () => {
    const a = grid.height[0];
    const b = grid.height[1];
    const mid = sampleHeight(grid, 5, 0);
    expect(mid).toBeCloseTo((a + b) / 2, 5);
  });
});

describe('materials palette', () => {
  it('has an entry for every traded material', () => {
    const w = stubWorld(1);
    for (const t of w.tanks) expect(MATERIALS).toContain(t.material);
    for (const v of w.vehicles) expect(MATERIALS).toContain(v.cargo);
  });
});
