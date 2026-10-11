// The selected vehicle's trip line: cut fine enough to shorten smoothly, and
// shortened by how far along it the vehicle is.

import { describe, expect, it } from 'vitest';
import { densify, passedIndex } from './tripOverlay';

describe('densify', () => {
  it('cuts long stretches into short steps and keeps every corner', () => {
    const out = densify([[0, 0], [10, 0], [10, 3]], 2);
    expect(out[0]).toEqual([0, 0]);
    expect(out).toContainEqual([10, 0]);
    expect(out[out.length - 1]).toEqual([10, 3]);
    for (let i = 1; i < out.length; i++) {
      expect(Math.hypot(out[i][0] - out[i - 1][0], out[i][1] - out[i - 1][1])).toBeLessThanOrEqual(2 + 1e-9);
    }
  });

  it('leaves a single point alone', () => {
    expect(densify([[4, 4]])).toEqual([[4, 4]]);
  });
});

describe('passedIndex', () => {
  const pts = densify([[0, 0], [20, 0]], 2); // a point every 2 km

  it('finds how far along the path the vehicle is', () => {
    expect(passedIndex(pts, 0.3, 0.2, 0)).toBe(0);
    expect(passedIndex(pts, 8.1, 0.5, 0)).toBe(4);
    expect(passedIndex(pts, 19.8, 0, 4)).toBe(10);
  });

  it('never goes back, and looks only a little ahead on a path that doubles back', () => {
    expect(passedIndex(pts, 2, 0, 6)).toBe(6);
    // out and back along the same road: the vehicle near the start is at the start, not the end
    const there = densify([[0, 0], [100, 0]], 2);
    const loop = [...there, ...[...there].reverse()];
    expect(passedIndex(loop, 1.6, 0, 0)).toBe(1);
  });
});
