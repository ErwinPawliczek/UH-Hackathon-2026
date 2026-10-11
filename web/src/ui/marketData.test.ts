import { describe, expect, it } from 'vitest';
import type { MarketReply } from '../engine/api';
import {
  changeBar, customerWords, demandBar, fmtChange, marketMissing, paidChangePct, perTonne, plantWords, rulesWords, sortedCustomers,
  sortedMaterials, sortedPlants, tonneSplit,
} from './marketData';

const reply: MarketReply = {
  tick: 400,
  rules: { priceAwareBuying: true, demandElasticity: 0.2, marginControl: true },
  materials: [
    { material: 'DIESEL', name: 'Diesel', baseUsdPerT: 800, paidUsdPerT: 896, changePct: 12 },
    { material: 'SALT', baseUsdPerT: 50, paidUsdPerT: null, changePct: 0 },
    { material: 'PVC', baseUsdPerT: 1000, paidUsdPerT: 700, changePct: -30 },
  ],
  customers: [
    { site: 13, name: 'Fuel depot', material: 'DIESEL', demandFactor: 0.95, pricePaidUsdPerT: 896, baseUsdPerT: 800, pricedOutUsd: 42000, notServedUsd: 0 },
    { site: 15, name: 'Packaging', material: 'PE', demandFactor: 1, pricePaidUsdPerT: 1200, baseUsdPerT: 1200, pricedOutUsd: 0, notServedUsd: 0 },
  ],
  plants: [
    { site: 5, name: 'Refinery', rate: 1, marginUsdPerT: 85, marginSignal: 1, revenueUsdPerT: 700, feedCostUsdPerT: 560, energyUsdPerT: 55 },
    { site: 9, name: 'Polyethylene', rate: 0.4, marginUsdPerT: -14, marginSignal: 0, revenueUsdPerT: 1186, feedCostUsdPerT: 1100, energyUsdPerT: 100 },
    { site: 10, name: 'Polypropylene', rate: 1, marginUsdPerT: null },
  ],
};

describe('the market tab in words and bars', () => {
  it("orders chemicals by how far their price has moved, either way", () => {
    expect(sortedMaterials(reply).map((m) => m.material)).toEqual(['PVC', 'DIESEL', 'SALT']);
    expect(fmtChange(12)).toBe('+12%');
    expect(fmtChange(-30)).toBe('−30%');
    expect(fmtChange(0.2)).toBe('0%');
    expect(perTonne(896)).toBe('$896 /t');
    expect(perTonne(null)).toBe('—');
  });

  it("draws a change either side of the centre line and clips beyond 50%", () => {
    expect(changeBar(25)).toEqual({ left: 0.5, width: 0.25, clipped: false });
    expect(changeBar(-25)).toEqual({ left: 0.25, width: 0.25, clipped: false });
    expect(changeBar(80)).toEqual({ left: 0.5, width: 0.5, clipped: true });
    expect(demandBar(1).normal).toBeCloseTo(2 / 3, 6);
    expect(demandBar(0.6).fill).toBe(0);
    expect(demandBar(1.5).fill).toBe(1);
  });

  it("says what a customer is buying and why", () => {
    expect(paidChangePct(reply.customers![0])).toBeCloseTo(12, 6);
    expect(customerWords(reply.customers![0])).toBe('buying 95% of normal: diesel is 12% dearer');
    expect(customerWords(reply.customers![1])).toBe('buying as normal');
    expect(customerWords({ ...reply.customers![0], pricePaidUsdPerT: null })).toBe('buying 95% of normal');
    expect(sortedCustomers(reply).map((c) => c.name)).toEqual(['Fuel depot', 'Packaging']);
  });

  it("says what a margin is doing to a plant, worst first", () => {
    expect(sortedPlants(reply).map((p) => p.name)).toEqual(['Polyethylene', 'Refinery', 'Polypropylene']);
    expect(plantWords(reply.plants![1])).toBe('running at minimum: losing $14/t');
    expect(plantWords(reply.plants![0])).toBeNull();
    expect(plantWords({ ...reply.plants![0], marginSignal: 0.5, marginUsdPerT: 3 })).toBe('held back: only $3/t');
    expect(plantWords({ ...reply.plants![0], marginUsdPerT: -5 })).toBe('losing $5/t');
    const good = tonneSplit(reply.plants![0])!;
    expect(good.feed + good.energy + good.margin).toBeCloseTo(1, 6);
    expect(good.over).toBe(false);
    const bad = tonneSplit(reply.plants![1])!;
    expect(bad.margin).toBe(0);
    expect(bad.over).toBe(true);
    expect(tonneSplit(reply.plants![2])).toBeNull(); // a server that sent no cost figures
  });

  it("puts the rules in a sentence and knows a server without the view", () => {
    expect(rulesWords(reply.rules)).toBe('Market rules: buyers time and size orders by price; customers want 2% less for every 10% a price rises; plants drop to minimum when a tonne loses money.');
    expect(rulesWords({})).toBe('Market rules are off in this world.');
    expect(rulesWords(undefined)).toBe('Market rules are on.');
    expect(marketMissing('404')).toBe(true);
    expect(marketMissing('GET /api/sim/x/market -> 404')).toBe(true);
    expect(marketMissing('Cannot reach the hosted engine')).toBe(false);
    expect(marketMissing(null)).toBe(false);
  });
});

import { lostSalesRows } from './DamageSummary';

describe('damage summary: lost sales', () => {
  const t = (lost: number, notServed?: number, priced?: number) => ({ lostSalesUsd: lost, notServedUsd: notServed, pricedOutUsd: priced, deliveredT: 0, plantsStoppedNow: 0 });

  it("stays one row when nothing was priced out", () => {
    expect(lostSalesRows(t(100), t(250))).toEqual([{ label: 'Customer sales lost', before: 100, after: 250 }]);
    expect(lostSalesRows(t(100, 100, 0), t(250, 250, 0))).toHaveLength(1);
  });

  it("splits into not delivered and priced out when either run has priced-out sales", () => {
    expect(lostSalesRows(t(100, 100, 0), t(250, 180, 70))).toEqual([
      { label: 'Not delivered', before: 100, after: 180 },
      { label: 'Priced out', before: 0, after: 70 },
    ]);
    // a server that sends only the total and the priced-out part
    expect(lostSalesRows(t(100, undefined, 40), t(250))[0]).toEqual({ label: 'Not delivered', before: 60, after: 250 });
  });
});
