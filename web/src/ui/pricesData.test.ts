import { describe, expect, it } from 'vitest';
import { askPrice, bucketMidTicks, defaultPriceSlots, drawable, fmtSigned, pctReach, pipedOnly, priceRows, sellerAsks } from './pricesData';

const reply = {
  bucketH: 6, buckets: 3, tick: 70,
  materials: [
    { key: 'DIESEL', name: '', basePriceUsdT: 700, orderedT: [100, 0, 50], spendUsd: [77000, 0, 31500], lots: [], freightUsd: [], deliveredT: [], priceIndex: [1, 1, 1.02] },
    { key: 'SALT', name: '', basePriceUsdT: 50, orderedT: [0, 0, 0], spendUsd: [0, 0, 0], lots: [], freightUsd: [], deliveredT: [] },
    { key: 'PVC', name: '', basePriceUsdT: 1000, orderedT: [10, 10, 10], spendUsd: [10100, 10000, 9700], lots: [], freightUsd: [], deliveredT: [] },
  ],
} as never;

describe('prices', () => {
  it('prices a bucket from spend over tonnes, and leaves a gap where nothing was ordered', () => {
    const rows = priceRows(reply);
    const diesel = rows.find((r) => r.key === 'DIESEL')!;
    expect(diesel.pct[0]).toBeCloseTo(10);
    expect(diesel.pct[1]).toBeNaN();
    expect(diesel.pct[2]).toBeCloseTo(-10);
    expect(diesel.paidUsdT).toBeCloseTo(630);
    expect(diesel.paidBucket).toBe(2);
    expect(diesel.indexPct).toBeCloseTo(2);
    expect(rows.map((r) => r.key)).toEqual(['DIESEL', 'PVC', 'SALT']); // paid furthest from base now first
    expect(drawable([12, 36, 60, 84], [NaN, 5, NaN, NaN], 12)).toEqual({ x: [12, 24, 48], values: [NaN, 5, 5] });
    expect(rows[2].paidUsdT).toBeNull();
    expect([...defaultPriceSlots(rows).keys()]).toEqual(['DIESEL', 'PVC']); // never-ordered ones are not drawn
  });
  it('signs every percentage', () => {
    expect(fmtSigned(12.4)).toBe('+12%');
    expect(fmtSigned(-8.2)).toBe('-8%');
    expect(fmtSigned(0.2)).toBe('0%');
    expect(fmtSigned(NaN)).toBe('—');
  });
  it('puts each bucket at its middle and picks a symmetric reach', () => {
    expect(bucketMidTicks(reply)).toEqual([12, 36, 60]);
    expect(pctReach([3, -7, NaN])).toBe(10);
    expect(pctReach([18, -31])).toBe(40);
  });
  it('asks base at half full, half as much again when empty, half when full', () => {
    expect(askPrice(600, 0.5)).toBeCloseTo(600);
    expect(askPrice(600, 0)).toBeCloseTo(900);
    expect(askPrice(600, 1)).toBeCloseTo(300);
    expect(askPrice(600, 0.86)).toBeCloseTo(600 * 0.64);
  });
  it('lists the sellers of a chemical cheapest first, and the piped-only chemicals', () => {
    const world = {
      sites: [{ name: 'Refinery' }, { name: 'Flex' }, { name: 'Depot' }],
      tanks: [
        { site: 0, material: 'DIESEL', role: 'product' }, { site: 1, material: 'DIESEL', role: 'both' },
        { site: 2, material: 'DIESEL', role: 'feed' }, { site: 0, material: 'PVC', role: 'product' },
      ],
      pipelines: [{ material: 'ETHYLENE' }, { material: 'CRUDE' }, { material: 'ETHYLENE' }, { material: 'DIESEL' }],
    } as never;
    const snap = { tanks: new Float32Array([0.2, 0, 0, 0, 0.9, 0, 0, 0, 0.1, 0, 0, 0, 0.5, 0, 0, 0]) };
    const asks = sellerAsks(world, snap, 'DIESEL', 700);
    expect(asks.map((a) => a.name)).toEqual(['Flex', 'Refinery']);
    expect(asks[1].pct).toBeCloseTo(30);
    expect(pipedOnly(world, reply)).toEqual(['Crude oil', 'Ethylene']);
  });
});
