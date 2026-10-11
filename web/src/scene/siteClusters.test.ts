// Where a site's block of tank bars goes: beside the site, on the side with
// the most room, and on land.

import { describe, expect, it } from 'vitest';
import { tankBlockCentres } from './siteClusters';

const land = () => false;

describe('tankBlockCentres', () => {
  it('puts a lone site\'s block to its east, just outside the cluster', () => {
    const [c] = tankBlockCentres([{ x: 100, y: 100 }], [6], [4], land);
    expect(c.y).toBeCloseTo(100, 6);
    expect(c.x).toBeGreaterThan(100 + 6 + 4);
    expect(c.x).toBeLessThan(100 + 6 + 4 + 5);
  });

  it('turns away from a neighbour and from its label', () => {
    // a neighbour 25 km to the east: the block goes west instead
    const [c] = tankBlockCentres([{ x: 100, y: 100 }, { x: 125, y: 100 }], [6, 6], [4, 4], land);
    expect(c.x).toBeLessThan(100);
  });

  it('stays off the water', () => {
    // sea everywhere east of x = 105
    const [c] = tankBlockCentres([{ x: 100, y: 100 }], [6], [4], (x) => x > 105);
    expect(c.x).toBeLessThanOrEqual(105);
  });
});
