import { describe, expect, it } from 'vitest';
import {
  askAt, demandAt, econMissing, fillTargetAt, limitWords, marginSignalAt, sample, siteCharts, smooth, tankSignal, urgencyAt, type SiteEconReply, type SiteEconTank,
} from './siteEcon';

const buy = { cheapRatio: 0.9, dearRatio: 1.15, cheapFill: 0.9, normalFill: 0.7, dearFill: 0.4 };
const curves = {
  feed: { lo: 0.25, hi: 1.25 }, room: { lo: 0.1, hi: 1 }, urgency: { lo: 1, hi: 2.5 }, ask: { swing: 0.5 }, bid: { swing: 0.5 },
  buy, demand: { elasticity: 0.2, minFrac: 0.6, maxFrac: 1.2 }, margin: { fullAtShareOfBase: 0.5 },
};
const tank = (over: Partial<SiteEconTank>): SiteEconTank => ({ tank: 1, material: 'BENZENE', materialName: 'Benzene', role: 'feed', fill: 0.5, hours: 8, x: 2, signal: 1, ...over });

describe('the model curves', () => {
  it("smooth step: 0 below lo, 1 above hi, t²(3 − 2t) between", () => {
    expect(smooth(0, 0.25, 1.25)).toBe(0);
    expect(smooth(2, 0.25, 1.25)).toBe(1);
    expect(smooth(0.75, 0.25, 1.25)).toBeCloseTo(0.5, 9);
    expect(smooth(0.5, 0.25, 1.25)).toBeCloseTo(0.25 * 0.25 * (3 - 0.5), 9);
    expect(tankSignal(0.55, curves.room)).toBeCloseTo(0.5, 9);
  });

  it("urgency falls as cover grows; asking price falls as the tank fills", () => {
    expect(urgencyAt(1, curves.urgency)).toBe(1);
    expect(urgencyAt(2.5, curves.urgency)).toBe(0);
    expect(urgencyAt(1.75, curves.urgency)).toBeCloseTo(0.5, 9);
    expect(askAt(0, 0.5)).toBe(1.5);
    expect(askAt(0.5, 0.5)).toBe(1);
    expect(askAt(1, 0.5)).toBe(0.5);
  });

  it("a buyer fills high when cheap and low when dear; a customer wants less when dear; no margin, no production", () => {
    expect(fillTargetAt(0.8, buy)).toBe(0.9);
    expect(fillTargetAt(1, buy)).toBeCloseTo(0.7, 9);
    expect(fillTargetAt(1.3, buy)).toBe(0.4);
    expect(fillTargetAt(0.95, buy)).toBeCloseTo(0.8, 9);
    expect(demandAt(1, curves.demand)).toBe(1);
    expect(demandAt(1.12, curves.demand)).toBeCloseTo(1.12 ** -0.2, 9);
    expect(demandAt(100, curves.demand)).toBe(0.6);
    expect(demandAt(0.01, curves.demand)).toBe(1.2);
    expect(marginSignalAt(0.5, 0.5)).toBe(1);
    expect(marginSignalAt(-0.2, 0.5)).toBe(0);
    expect(marginSignalAt(0.25, 0.5)).toBeCloseTo(0.5, 9);
    expect(sample((x) => x, 0, 1, 3)).toEqual([[0, 0], [0.5, 0.5], [1, 1]]);
  });
});

describe('the charts of a site', () => {
  const plant: SiteEconReply = {
    site: 12, name: 'Styrenics', rules: { priceAwareBuying: true, demandElasticity: 0.2, marginControl: true }, curves,
    tanks: [
      tank({ tank: 1, role: 'feed', hours: 8, x: 2, signal: 1, cover: 3.1, urgency: 0, leadTimeH: 12, bestOfferRatio: 1.08, fillTarget: 0.52, orderBelowCover: 1.4 }),
      tank({ tank: 2, material: 'STYRENE', materialName: 'Styrene', role: 'product', fill: 0.86, hours: 2.1, x: 0.525, signal: 0.62, askRatio: 0.7, costDelta: 0.06, markup: 0 }),
    ],
    plant: { rate: 0.62, governor: 0.62, limitedBy: { kind: 'room', tank: 2 }, marginSignal: 1, margin: 120, marginBase: 150 },
  };

  it("shows a plant every chart that applies, in the model's order, with its limit named", () => {
    const charts = siteCharts(plant);
    expect(charts.map((c) => c.n)).toEqual([1, 2, 3, 4, 5, 6, 8]);
    expect(limitWords(plant)).toBe('room for styrene');
    const room = charts.find((c) => c.key === 'room')!;
    expect(room.sentence).toBe('Styrene has 2.1 hours of room left: the plant is held to 62%.');
    expect(room.dots).toHaveLength(1);
    expect(room.dots[0].alarm).toBe(true); // the dot that is holding the plant back
    const rate = charts.find((c) => c.key === 'rate')!;
    expect(rate.sentence).toBe('Limited by: room for styrene. It runs at 62% of design.');
    expect(rate.bars!.map((b) => [b.label, b.lowest])).toEqual([['Feed', false], ['Room', true], ['Margin', false]]);
    // the asking price is off the line, and says why
    expect(charts.find((c) => c.key === 'ask')!.sentence).toBe('Styrene asks −30% on the usual price, off the line by +6% from dearer feed.');
    expect(charts.find((c) => c.key === 'buy')!.sentence).toBe('Benzene is on offer at +8% on the usual price: it holds off, filling to 52% and ordering once stock drops under 1.4 deliveries.');
    expect(charts.find((c) => c.key === 'margin')!.sentence).toBe('It makes $120 on a tonne, 80% of its normal margin: nothing held back.');
    // every curve chart has a line to draw
    for (const c of charts) if (c.bars === undefined) expect(c.curve.length).toBeGreaterThan(1);
  });

  it("shows a customer 4, 6 and 7, and a source 2 and 5", () => {
    const customer: SiteEconReply = {
      rules: plant.rules, curves, plant: null,
      tanks: [tank({ material: 'DIESEL', materialName: 'Diesel', cover: 1.6, urgency: 0.65, bestOfferRatio: 1.12, fillTarget: 0.45, demandFactor: 0.95, pricePaidRatio: 1.12 })],
    };
    const charts = siteCharts(customer);
    expect(charts.map((c) => c.n)).toEqual([4, 6, 7]);
    expect(charts[0].sentence).toBe('Diesel would last 1.6 deliveries: it is buying at 65% urgency.');
    expect(charts[2].sentence).toBe('Diesel is 12% dearer than usual: it wants 95% of normal.');

    const source: SiteEconReply = {
      rules: plant.rules, curves,
      tanks: [tank({ material: 'CRUDE', materialName: 'Crude oil', role: 'product', fill: 0.3, hours: 30, x: 7.5, signal: 1, askRatio: 1.2 })],
      plant: { rate: 1, limitedBy: { kind: 'none' }, marginSignal: null },
    };
    expect(siteCharts(source).map((c) => c.n)).toEqual([2, 3, 5]);
    expect(siteCharts(source).find((c) => c.key === 'ask')!.sentence).toBe('Crude oil is 30% full, so it asks +20% on the usual price.');
  });

  it("leaves the market-only charts out of the standard world, and copes with a thin reply", () => {
    const standard = { ...plant, rules: { priceAwareBuying: false, demandElasticity: 0, marginControl: false } };
    expect(siteCharts(standard).map((c) => c.n)).toEqual([1, 2, 3, 4, 5]);
    expect(siteCharts({})).toEqual([]);
    expect(siteCharts({ tanks: [], plant: null })).toEqual([]);
    expect(econMissing('404')).toBe(true);
    expect(econMissing(null)).toBe(false);
  });
});
