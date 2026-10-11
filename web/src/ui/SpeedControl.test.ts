// The speed field's arithmetic: what a typed entry means, how it is shown,
// and what the arrow keys do.

import { describe, expect, it } from 'vitest';
import { formatSpeed, nudgeSpeed, parseSpeed } from './SpeedControl';

describe('parseSpeed', () => {
  it('reads whole numbers and decimals, with a point or a comma', () => {
    expect(parseSpeed('1')).toBe(1);
    expect(parseSpeed(' 1.5 ')).toBe(1.5);
    expect(parseSpeed('0,5')).toBe(0.5);
    expect(parseSpeed('.5')).toBe(0.5);
    expect(parseSpeed('4.')).toBe(4);
  });

  it('clamps to the allowed range and one decimal', () => {
    expect(parseSpeed('0')).toBe(0.1);
    expect(parseSpeed('0.01')).toBe(0.1);
    expect(parseSpeed('999')).toBe(64);
    expect(parseSpeed('2.449')).toBe(2.4);
  });

  it('rejects an empty or unreadable entry, so the previous value is restored', () => {
    for (const bad of ['', '   ', '.', 'fast', '1x', '-2', '1.2.3', '1e3']) expect(parseSpeed(bad)).toBeNull();
  });
});

describe('formatSpeed', () => {
  it('shows no trailing zero and at most one decimal', () => {
    expect(formatSpeed(1)).toBe('1');
    expect(formatSpeed(64)).toBe('64');
    expect(formatSpeed(0.5)).toBe('0.5');
    expect(formatSpeed(0.30000000000000004)).toBe('0.3');
  });
});

describe('nudgeSpeed', () => {
  it('steps by 0.1 below 1 and by 1 from 1 up', () => {
    expect(nudgeSpeed(0.5, 1)).toBe(0.6);
    expect(nudgeSpeed(0.9, 1)).toBe(1);
    expect(nudgeSpeed(1, 1)).toBe(2);
    expect(nudgeSpeed(1.5, 1)).toBe(2.5);
    expect(nudgeSpeed(2, -1)).toBe(1);
    expect(nudgeSpeed(1.5, -1)).toBe(1);
    expect(nudgeSpeed(1, -1)).toBe(0.9);
    expect(nudgeSpeed(0.5, -1)).toBe(0.4);
  });

  it('stays inside the range', () => {
    expect(nudgeSpeed(64, 1)).toBe(64);
    expect(nudgeSpeed(63.5, 1)).toBe(64);
    expect(nudgeSpeed(0.1, -1)).toBe(0.1);
  });
});
