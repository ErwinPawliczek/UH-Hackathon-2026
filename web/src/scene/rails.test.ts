// Rail tracks: two parallel rails and evenly spaced sleepers along a strip.

import { describe, expect, it } from 'vitest';
import { RAIL_GAUGE_KM, SLEEPER_LENGTH_KM, SLEEPER_SPACING_KM, trackSegments } from './rails';

describe('trackSegments', () => {
  it('lays two rails a gauge apart along a straight strip', () => {
    const { rails } = trackSegments([[0, 0], [24, 0]]);
    expect(rails).toHaveLength(2);
    const ys = rails.map(([a, b]) => {
      expect(a[1]).toBeCloseTo(b[1], 9);
      expect(Math.abs(b[0] - a[0])).toBeCloseTo(24, 9);
      return a[1];
    });
    expect(Math.abs(ys[0] - ys[1])).toBeCloseTo(RAIL_GAUGE_KM, 9);
  });

  it('spaces sleepers evenly, square to the track and wider than the gauge', () => {
    const { sleepers } = trackSegments([[0, 0], [24, 0]]);
    expect(sleepers).toHaveLength(Math.round(24 / SLEEPER_SPACING_KM));
    sleepers.forEach(([a, b], i) => {
      expect(a[0]).toBeCloseTo(b[0], 9); // square to an east-west track
      expect(Math.abs(b[1] - a[1])).toBeCloseTo(SLEEPER_LENGTH_KM, 9);
      if (i > 0) expect(a[0] - sleepers[i - 1][0][0]).toBeCloseTo(SLEEPER_SPACING_KM, 9);
    });
    expect(SLEEPER_LENGTH_KM).toBeGreaterThan(RAIL_GAUGE_KM);
  });

  it('keeps the rails parallel round a bend and the sleeper spacing across it', () => {
    const { rails, sleepers } = trackSegments([[0, 0], [10, 0], [10, 10]]);
    expect(rails).toHaveLength(4);
    // the outer and inner rail meet their own neighbour at the corner (no gap, no crossing)
    expect(rails[0][1]).toEqual(rails[1][0]);
    expect(rails[2][1]).toEqual(rails[3][0]);
    // each rail runs half a gauge from the centre line on both legs
    for (const [a, b] of [rails[0], rails[2]]) {
      expect(Math.abs(a[1])).toBeCloseTo(RAIL_GAUGE_KM / 2, 9);
      expect(Math.abs(b[1])).toBeCloseTo(RAIL_GAUGE_KM / 2, 9);
    }
    for (const [a, b] of [rails[1], rails[3]]) {
      expect(Math.abs(a[0] - 10)).toBeCloseTo(RAIL_GAUGE_KM / 2, 9);
      expect(Math.abs(b[0] - 10)).toBeCloseTo(RAIL_GAUGE_KM / 2, 9);
    }
    expect(sleepers).toHaveLength(Math.round(20 / SLEEPER_SPACING_KM));
  });

  it('draws nothing for a strip with fewer than two distinct points', () => {
    expect(trackSegments([[3, 3]]).rails).toEqual([]);
    expect(trackSegments([[3, 3], [3, 3]]).sleepers).toEqual([]);
  });
});
