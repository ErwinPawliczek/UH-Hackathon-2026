import { describe, expect, it } from 'vitest';
import { resolveWorld, routeLength, routePointAt, sampleHeight, stubWorld, VEHICLE_CLASSES, MATERIALS } from './world';
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

describe('resolveWorld', () => {
  // The M0 stub engine's actual /world reply shape (apps/server over engine/src/api.cpp).
  const engineStubWorld = (overrides: Record<string, unknown> = {}): unknown => ({
    world: 'stub',
    dt_h: 0.25,
    materials: [...MATERIALS],
    sites: [
      { i: 0, name: 'Oil Field', x: 120.0, y: 260.0 },
      { i: 1, name: 'Refinery', x: 260.0, y: 210.0 },
      { i: 2, name: 'Steam Cracker', x: 340.0, y: 150.0 },
      { i: 3, name: 'Port Terminal', x: 480.0, y: 90.0 },
    ],
    tanks: [
      { i: 0, site: 0, material: 'CRUDE' },
      { i: 1, site: 1, material: 'METHANE' },
      { i: 2, site: 2, material: 'NAPHTHA' },
      { i: 3, site: 3, material: 'DIESEL' },
      { i: 4, site: 0, material: 'BENZENE' },
      { i: 5, site: 1, material: 'CHLORINE' },
      { i: 6, site: 2, material: 'PE' },
      { i: 7, site: 3, material: 'PS' },
    ],
    ...overrides,
  });

  it('passes a full WorldSpec through untouched', () => {
    const full = stubWorld(7);
    expect(resolveWorld(full, 7)).toBe(full);
  });

  it('keeps stub geometry and applies engine facts by index', () => {
    const w = resolveWorld(engineStubWorld(), 42);
    const base = stubWorld(42);
    // engine site facts win
    expect(w.sites.map((s) => s.name)).toEqual(base.sites.map((s) => s.name));
    expect(w.sites[3].x).toBe(480.0);
    // engine tank assignments win...
    expect(w.tanks[1].material).toBe('METHANE');
    expect(w.tanks[4].site).toBe(0);
    // ...while stub tank fields the engine does not publish survive
    expect(w.tanks[0].capacityT).toBe(base.tanks[0].capacityT);
    expect(w.tanks[0].role).toBe(base.tanks[0].role);
    // static geometry is the seeded stub world
    expect(Array.from(w.terrain.height)).toEqual(Array.from(base.terrain.height));
    expect(w.routes).toHaveLength(base.routes.length);
    expect(w.vehicles).toHaveLength(base.vehicles.length);
    expect(w.pipelines).toHaveLength(base.pipelines.length);
  });

  it('falls back to the stub world on unusable payloads', () => {
    const base = stubWorld(42);
    for (const junk of [null, undefined, 'garbage', 3, { sites: 'nope' }]) {
      const w = resolveWorld(junk, 42);
      expect(Array.from(w.terrain.height)).toEqual(Array.from(base.terrain.height));
      expect(w.sites).toHaveLength(base.sites.length);
    }
  });

  it('ignores engine facts that would corrupt the render', () => {
    const w = resolveWorld(
      engineStubWorld({
        sites: [{ i: 9, name: 'Ghost', x: 9999, y: 9999 }, { i: 0, name: 'Renamed' }],
        tanks: [{ i: 99, site: 0, material: 'CRUDE' }, { i: 0, site: 99, material: 'UNOBTAINIUM' }],
      }),
      42,
    );
    expect(w.sites).toHaveLength(4);
    expect(w.sites.map((s) => s.name)).toContain('Renamed'); // applied, no phantom site added
    expect(w.sites.map((s) => s.name)).not.toContain('Ghost');
    expect(w.tanks[0].site).toBe(0); // out-of-range site keeps the stub value
    expect(w.tanks[0].material).not.toBe('UNOBTAINIUM'); // off-palette material keeps the stub value
  });
});
