// Where road bridges go: over the wet stretch of a road, a ramp onto each bank.

import { describe, expect, it } from 'vitest';
import { BRIDGE_RAMP_KM, bridgeSpans } from './bridges';

// a channel between x = 20 and x = 50
const channel = (x: number) => x > 20 && x < 50;

describe('bridgeSpans', () => {
  it('bridges the wet stretch of a road and runs a ramp onto each bank', () => {
    const [span, ...rest] = bridgeSpans([[0, 0], [80, 0]], channel);
    expect(rest).toEqual([]);
    expect(span.wet0).toBeGreaterThan(20);
    expect(span.wet0).toBeLessThanOrEqual(21);
    expect(span.wet1).toBeGreaterThanOrEqual(49);
    expect(span.wet1).toBeLessThan(50);
    expect(span.s0).toBeCloseTo(span.wet0 - BRIDGE_RAMP_KM, 6);
    expect(span.s1).toBeCloseTo(span.wet1 + BRIDGE_RAMP_KM, 6);
  });

  it('measures along a bent road and stops at the road\'s own ends', () => {
    // down 30 km on land, then east across the channel, ending in the water
    const [span] = bridgeSpans([[0, -30], [0, 0], [40, 0]], channel);
    expect(span.wet0).toBeGreaterThan(50); // 30 km south-north leg + 20 km to the bank
    expect(span.s1).toBeCloseTo(70, 6); // the road ends mid-channel: no ramp beyond it
  });

  it('gives no bridge to a road on dry land or one that only clips the shore', () => {
    expect(bridgeSpans([[0, 0], [15, 0]], channel)).toEqual([]);
    expect(bridgeSpans([[0, 0], [21, 0]], channel)).toEqual([]);
  });

  it('treats a sandbar under the road as part of one crossing, and two channels as two', () => {
    const sandbar = (x: number) => (x > 20 && x < 30) || (x > 32 && x < 50);
    expect(bridgeSpans([[0, 0], [80, 0]], sandbar)).toHaveLength(1);
    const two = (x: number) => (x > 20 && x < 30) || (x > 60 && x < 70);
    expect(bridgeSpans([[0, 0], [100, 0]], two)).toHaveLength(2);
  });
});
