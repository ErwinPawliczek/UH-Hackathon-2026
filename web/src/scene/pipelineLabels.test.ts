// Where pipeline names go: near the middle, on a stretch only that pipeline
// uses, on a straight run, clear of sites.

import { describe, expect, it } from 'vitest';
import { pipelineLabelSpots, pipelineName } from './pipelineLabels';

describe('pipelineName', () => {
  it('uses plain words for the material', () => {
    expect(pipelineName('ETHYLENE')).toBe('Ethylene pipeline');
    expect(pipelineName('CRUDE')).toBe('Crude oil pipeline');
    expect(pipelineName('RAW_GAS')).toBe('Raw gas pipeline');
    expect(pipelineName('FUEL_OIL')).toBe('Fuel oil pipeline');
  });
});

describe('pipelineLabelSpots', () => {
  it('puts the name near the middle of a lone straight pipeline, along it', () => {
    const [spots] = pipelineLabelSpots([{ points: [[0, 0], [100, 0]] }], []);
    expect(spots.length).toBeGreaterThan(0);
    expect(spots[0].x).toBeGreaterThan(40);
    expect(spots[0].x).toBeLessThan(60);
    expect(spots[0].y).toBeCloseTo(0, 6);
    expect(spots[0].dirX).toBeCloseTo(1, 6);
    expect(spots[0].dirY).toBeCloseTo(0, 6);
  });

  it('keeps each name off the stretch two pipelines share', () => {
    // both leave (0,0) along the same 60 km, then part: one north, one south
    const a = { points: [[0, 0], [60, 0], [60, 80]] as [number, number][] };
    const b = { points: [[0, 0], [60, 0], [60, -80]] as [number, number][] };
    const [sa, sb] = pipelineLabelSpots([a, b], []);
    expect(sa[0].y).toBeGreaterThan(7);
    expect(sb[0].y).toBeLessThan(-7);
    expect(sa[0].x).toBeCloseTo(60, 6);
    expect(Math.abs(sa[0].dirY)).toBeCloseTo(1, 6);
  });

  it('prefers the long straight run over a short kink at the exact middle', () => {
    const pipe = { points: [[0, 0], [48, 0], [52, 4], [100, 4]] as [number, number][] };
    const [spots] = pipelineLabelSpots([pipe], []);
    // not on the 5.7 km diagonal between x = 48 and 52
    expect(spots[0].x < 46 || spots[0].x > 54).toBe(true);
  });

  it('stays clear of a site sitting at the middle', () => {
    const [spots] = pipelineLabelSpots([{ points: [[0, 0], [120, 0]] }], [{ x: 60, y: 2 }]);
    expect(Math.abs(spots[0].x - 60)).toBeGreaterThan(15);
  });

  it('offers alternatives apart from one another, and none for a degenerate line', () => {
    const [spots, none] = pipelineLabelSpots([{ points: [[0, 0], [200, 0]] }, { points: [[5, 5]] }], []);
    expect(spots.length).toBeGreaterThan(2);
    for (let i = 1; i < spots.length; i++) expect(Math.abs(spots[i].x - spots[0].x)).toBeGreaterThan(12);
    expect(none).toEqual([]);
  });
});
