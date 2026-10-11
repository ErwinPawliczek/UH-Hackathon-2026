// The site window's Economics tab in numbers and words: the model's curves
// as pure functions, the charts that apply to a site, where each of its
// tanks sits on them, and one plain sentence per chart. The view is
// SiteEconomics.tsx; the data is GET …/site-econ?site=N.
//
// The curves are the website's supply chain model. Its smooth step is
// S(t) = t²(3 − 2t) with t = clamp((x − lo) / (hi − lo), 0, 1).

import { useEffect, useState } from 'react';
import type { SimBackend } from '../engine/api';
import { HttpError } from '../engine/httpBackend';
import { blueRamp } from './charts/palette';
import { useSessionData, type Polled } from './economyData';
import { materialName, materialTitle } from './materials';

export interface Band { lo: number; hi: number }
export interface SiteEconTank {
  tank: number; material: string; materialName?: string; role: 'feed' | 'product';
  fill: number; hours: number | null; x: number | null; signal: number | null;
  cover?: number | null; urgency?: number | null; leadTimeH?: number | null; bestOfferRatio?: number | null; orderBelowCover?: number | null; fillTarget?: number | null;
  askRatio?: number | null; costDelta?: number | null; markup?: number | null;
  demandFactor?: number | null; pricePaidRatio?: number | null;
}
export interface SiteEconReply {
  site?: number; name?: string; tick?: number;
  rules?: { priceAwareBuying?: boolean; demandElasticity?: number; marginControl?: boolean };
  curves?: {
    feed?: Band; room?: Band; urgency?: Band; ask?: { swing: number }; bid?: { swing: number };
    buy?: { cheapRatio: number; dearRatio: number; cheapFill: number; normalFill: number; dearFill: number; cheapCover?: number; normalCover?: number; dearCover?: number };
    demand?: { elasticity: number; minFrac: number; maxFrac: number };
    margin?: { fullAtShareOfBase: number };
  };
  tanks?: SiteEconTank[];
  plant?: null | { rate: number; governor?: number; limitedBy?: { kind: 'feed' | 'room' | 'margin' | 'none'; tank?: number | null }; marginSignal?: number | null; margin?: number | null; marginBase?: number | null };
}

// ---- the curves ----

export const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
/** The model's smooth step: 0 at or below `lo`, 1 at or above `hi`, t²(3 − 2t) between. */
export function smooth(x: number, lo: number, hi: number): number {
  const t = hi === lo ? (x >= hi ? 1 : 0) : clamp((x - lo) / (hi - lo), 0, 1);
  return t * t * (3 - 2 * t);
}
/** Curves 1 and 2: how freely a tank lets the plant run, from its hours of feed (or of room) over four. */
export const tankSignal = (x: number, band: Band) => smooth(x, band.lo, band.hi);
/** Curve 4: how urgently a tank buys, from its cover in delivery times. */
export const urgencyAt = (cover: number, band: Band) => 1 - smooth(cover, band.lo, band.hi);
/** Curve 5: asking price over base from how full the tank is: +swing when empty, −swing when full. */
export const askAt = (fill: number, swing: number) => 1 + swing * (1 - 2 * clamp(fill, 0, 1));
/** Curve 6: the fill a buyer aims for at a best-offer price ratio: high when cheap, low when dear. */
export function fillTargetAt(ratio: number, b: NonNullable<NonNullable<SiteEconReply['curves']>['buy']>): number {
  if (ratio <= b.cheapRatio) return b.cheapFill;
  if (ratio >= b.dearRatio) return b.dearFill;
  return ratio <= 1
    ? b.cheapFill + (b.normalFill - b.cheapFill) * smooth(ratio, b.cheapRatio, 1)
    : b.normalFill + (b.dearFill - b.normalFill) * smooth(ratio, 1, b.dearRatio);
}
/** Curve 7: what a customer wants against normal at a price ratio. */
export const demandAt = (ratio: number, d: { elasticity: number; minFrac: number; maxFrac: number }) =>
  clamp(Math.max(1e-6, ratio) ** -d.elasticity, d.minFrac, d.maxFrac);
/** Curve 8: the margin signal from margin as a share of the normal margin. */
export const marginSignalAt = (share: number, fullAt: number) => smooth(share, 0, fullAt);

/** `n` points of y = f(x) from x0 to x1. */
export function sample(f: (x: number) => number, x0: number, x1: number, n = 41): [number, number][] {
  return Array.from({ length: n }, (_, i) => {
    const x = x0 + ((x1 - x0) * i) / (n - 1);
    return [x, f(x)] as [number, number];
  });
}

// ---- the charts of a site ----

export interface EconDot { x: number; y: number; label: string; color: string; alarm: boolean }
export interface EconBar { label: string; value: number; lowest: boolean }
export interface EconChart {
  n: number;
  key: 'feed' | 'room' | 'rate' | 'urgency' | 'ask' | 'buy' | 'demand' | 'margin';
  title: string;
  xLabel: string;
  yLabel: string;
  curve: [number, number][];
  xDomain: [number, number];
  yDomain: [number, number];
  /** how axis and dot values are written */
  xUnit: 'x' | 'pct';
  yUnit: 'pct';
  dots: EconDot[];
  /** chart 3 has bars in place of a curve */
  bars?: EconBar[];
  sentence: string;
}

const DEFAULTS = {
  feed: { lo: 0.25, hi: 1.25 }, room: { lo: 0.1, hi: 1 }, urgency: { lo: 1, hi: 2.5 }, ask: { swing: 0.5 },
};
const pct = (v: number) => `${Math.round(v * 100)}%`;
const hoursWords = (h: number | null) => (h === null ? 'plenty' : h >= 48 ? `${(h / 24).toFixed(1)} days` : `${h < 10 ? h.toFixed(1) : Math.round(h)} hours`);
const nameOf = (t: SiteEconTank) => (t.materialName !== undefined && t.materialName !== '' ? t.materialName : materialTitle(t.material));
const lowerName = (t: SiteEconTank) => (t.materialName !== undefined && t.materialName !== '' ? t.materialName.toLowerCase() : materialName(t.material));
const num = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v);
const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.round(Math.abs(v) * 100)}%`;

/** Shades for a chart's dots, the same tank keeping its shade order; the limiting one is flagged. */
function dotsOf(tanks: SiteEconTank[], at: (t: SiteEconTank) => { x: number; y: number } | null, limiting: number | null): EconDot[] {
  const shades = blueRamp(tanks.length);
  return tanks.flatMap((t, i) => {
    const p = at(t);
    return p === null ? [] : [{ ...p, label: nameOf(t), color: shades[tanks.length - 1 - i], alarm: t.tank === limiting }];
  });
}

/** What holds the plant back, in words: "room for benzene", "feed of ethylene", "its margin", or null. */
export function limitWords(reply: SiteEconReply): string | null {
  const l = reply.plant?.limitedBy;
  if (l === undefined || l.kind === 'none') return null;
  if (l.kind === 'margin') return 'its margin';
  const t = (reply.tanks ?? []).find((x) => x.tank === l.tank);
  const what = t === undefined ? 'a tank' : lowerName(t);
  return l.kind === 'feed' ? `feed of ${what}` : `room for ${what}`;
}

/** The charts that apply to this site, in the model's order, numbered 1 to 8. */
export function siteCharts(reply: SiteEconReply): EconChart[] {
  const tanks = reply.tanks ?? [];
  const c = reply.curves ?? {};
  const plant = reply.plant ?? null;
  const limit = plant?.limitedBy;
  const out: EconChart[] = [];
  const feed = tanks.filter((t) => t.role === 'feed');
  const product = tanks.filter((t) => t.role === 'product');
  const held = plant === null ? '' : `: the plant is held to ${pct(plant.rate)}`;

  // 1 and 2 belong to a site that makes something out of something: one with a plant
  if (plant !== null && feed.some((t) => num(t.x))) {
    const band = c.feed ?? DEFAULTS.feed;
    const worst = [...feed].filter((t) => num(t.signal)).sort((a, b) => (a.signal as number) - (b.signal as number))[0];
    const limiting = limit?.kind === 'feed' ? limit.tank ?? null : null;
    out.push({
      n: 1, key: 'feed', title: 'Feed: how freely its tanks let it run', xLabel: 'hours of feed ÷ 4', yLabel: 'signal',
      curve: sample((x) => tankSignal(x, band), 0, 2), xDomain: [0, 2], yDomain: [0, 1], xUnit: 'x', yUnit: 'pct',
      dots: dotsOf(feed, (t) => (num(t.x) && num(t.signal) ? { x: Math.min(2, t.x), y: t.signal } : null), limiting),
      sentence: worst === undefined ? 'No feed tank reports yet.'
        : (worst.signal as number) >= 0.995 ? `Every feed tank has enough: the least is ${lowerName(worst)}, with ${hoursWords(worst.hours)} left.`
          : `${nameOf(worst)} has ${hoursWords(worst.hours)} of feed left${limiting === worst.tank ? held : `: on its own it would allow ${pct(worst.signal as number)}`}.`,
    });
  }
  if (plant !== null && product.some((t) => num(t.x))) {
    const band = c.room ?? DEFAULTS.room;
    const worst = [...product].filter((t) => num(t.signal)).sort((a, b) => (a.signal as number) - (b.signal as number))[0];
    const limiting = limit?.kind === 'room' ? limit.tank ?? null : null;
    out.push({
      n: 2, key: 'room', title: 'Room: space left for what it makes', xLabel: 'hours of free room ÷ 4', yLabel: 'signal',
      curve: sample((x) => tankSignal(x, band), 0, 2), xDomain: [0, 2], yDomain: [0, 1], xUnit: 'x', yUnit: 'pct',
      dots: dotsOf(product, (t) => (num(t.x) && num(t.signal) ? { x: Math.min(2, t.x), y: t.signal } : null), limiting),
      sentence: worst === undefined ? 'No product tank reports yet.'
        : (worst.signal as number) >= 0.995 ? `Every product tank has room: the tightest is ${lowerName(worst)}, with ${hoursWords(worst.hours)} to go.`
          : `${nameOf(worst)} has ${hoursWords(worst.hours)} of room left${limiting === worst.tank ? held : `: on its own it would allow ${pct(worst.signal as number)}`}.`,
    });
  }
  if (plant !== null) {
    const min = (ts: SiteEconTank[]) => ts.filter((t) => num(t.signal)).reduce<number | null>((a, t) => (a === null ? (t.signal as number) : Math.min(a, t.signal as number)), null);
    const raw: { label: string; value: number | null; kind: string }[] = [
      { label: 'Feed', value: min(feed), kind: 'feed' },
      { label: 'Room', value: min(product), kind: 'room' },
      { label: 'Margin', value: reply.rules?.marginControl === true && num(plant.marginSignal) ? plant.marginSignal : null, kind: 'margin' },
    ];
    const bars = raw.filter((b): b is { label: string; value: number; kind: string } => b.value !== null)
      .map((b) => ({ label: b.label, value: b.value, lowest: limit !== undefined && limit.kind === b.kind }));
    const why = limitWords(reply);
    out.push({
      n: 3, key: 'rate', title: 'Plant rate: the lowest of its limits', xLabel: '', yLabel: '', curve: [], xDomain: [0, 1], yDomain: [0, 1], xUnit: 'pct', yUnit: 'pct',
      dots: [], bars,
      sentence: why === null ? `Nothing holds it back: it runs at ${pct(plant.rate)} of design.` : `Limited by: ${why}. It runs at ${pct(plant.rate)} of design.`,
    });
  }
  const buying = tanks.filter((t) => num(t.cover) && num(t.urgency));
  if (buying.length > 0) {
    const band = c.urgency ?? DEFAULTS.urgency;
    const most = [...buying].sort((a, b) => (b.urgency as number) - (a.urgency as number))[0];
    out.push({
      n: 4, key: 'urgency', title: 'Urgency: how hard it pushes to buy', xLabel: 'stock, in delivery times', yLabel: 'urgency',
      curve: sample((x) => urgencyAt(x, band), 0, 3.5), xDomain: [0, 3.5], yDomain: [0, 1], xUnit: 'x', yUnit: 'pct',
      dots: dotsOf(buying, (t) => ({ x: Math.min(3.5, t.cover as number), y: t.urgency as number }), null),
      sentence: (most.urgency as number) < 0.005
        ? `No hurry: its ${lowerName(most)} would last ${(most.cover as number).toFixed(1)} deliveries${num(most.leadTimeH) ? ` (one takes about ${hoursWords(most.leadTimeH)})` : ''}.`
        : `${nameOf(most)} would last ${(most.cover as number).toFixed(1)} deliveries: it is buying at ${pct(most.urgency as number)} urgency.`,
    });
  }
  const selling = tanks.filter((t) => num(t.askRatio));
  if (selling.length > 0) {
    const swing = c.ask?.swing ?? DEFAULTS.ask.swing;
    const first = [...selling].sort((a, b) => Math.abs((b.askRatio as number) - askAt(b.fill, swing)) - Math.abs((a.askRatio as number) - askAt(a.fill, swing)))[0];
    const off = (first.askRatio as number) - askAt(first.fill, swing);
    const reasons: string[] = [];
    if (num(first.costDelta) && Math.abs(first.costDelta) >= 0.005) reasons.push(`${signed(first.costDelta)} from ${first.costDelta > 0 ? 'dearer' : 'cheaper'} feed`);
    if (num(first.markup) && Math.abs(first.markup) >= 0.005) reasons.push(`${signed(first.markup)} set by its owner`);
    out.push({
      n: 5, key: 'ask', title: 'Asking price: fuller tank, lower price', xLabel: 'how full the tank is', yLabel: 'asking ÷ base',
      curve: sample((x) => askAt(x, swing), 0, 1, 2), xDomain: [0, 1], yDomain: [Math.min(0.4, ...selling.map((t) => t.askRatio as number)), Math.max(1.6, ...selling.map((t) => t.askRatio as number))], xUnit: 'pct', yUnit: 'pct',
      dots: dotsOf(selling, (t) => ({ x: clamp(t.fill, 0, 1), y: t.askRatio as number }), null),
      sentence: Math.abs(off) < 0.005
        ? `${nameOf(first)} is ${pct(first.fill)} full, so it asks ${signed((first.askRatio as number) - 1)} on the usual price.`
        : `${nameOf(first)} asks ${signed((first.askRatio as number) - 1)} on the usual price, off the line by ${reasons.length > 0 ? reasons.join(' and ') : signed(off)}.`,
    });
  }
  const market = reply.rules?.priceAwareBuying === true;
  const priced = tanks.filter((t) => num(t.bestOfferRatio) && num(t.fillTarget));
  if (market && c.buy !== undefined && priced.length > 0) {
    const b = c.buy;
    const first = [...priced].sort((a, z) => Math.abs((z.bestOfferRatio as number) - 1) - Math.abs((a.bestOfferRatio as number) - 1))[0];
    const r = first.bestOfferRatio as number;
    const x0 = Math.min(b.cheapRatio - 0.1, ...priced.map((t) => t.bestOfferRatio as number));
    const x1 = Math.max(b.dearRatio + 0.1, ...priced.map((t) => t.bestOfferRatio as number));
    out.push({
      n: 6, key: 'buy', title: 'When and how much it buys', xLabel: 'best offer ÷ usual price', yLabel: 'fills up to',
      curve: sample((x) => fillTargetAt(x, b), x0, x1), xDomain: [x0, x1], yDomain: [0, 1], xUnit: 'pct', yUnit: 'pct',
      dots: dotsOf(priced, (t) => ({ x: t.bestOfferRatio as number, y: t.fillTarget as number }), null),
      sentence: `${nameOf(first)} is on offer at ${signed(r - 1)} on the usual price: it ${r < 0.995 ? 'stocks up' : r > 1.005 ? 'holds off' : 'buys as usual'}, filling to ${pct(first.fillTarget as number)}`
        + `${num(first.orderBelowCover) ? ` and ordering once stock drops under ${first.orderBelowCover.toFixed(1)} deliveries` : ''}.`,
    });
  }
  const wants = tanks.filter((t) => num(t.demandFactor) && num(t.pricePaidRatio));
  if (c.demand !== undefined && (reply.rules?.demandElasticity ?? 0) > 0 && wants.length > 0) {
    const d = c.demand;
    const first = [...wants].sort((a, z) => (a.demandFactor as number) - (z.demandFactor as number))[0];
    const r = first.pricePaidRatio as number;
    const x0 = Math.min(0.5, ...wants.map((t) => t.pricePaidRatio as number));
    const x1 = Math.max(2, ...wants.map((t) => t.pricePaidRatio as number));
    out.push({
      n: 7, key: 'demand', title: 'What it wants: dearer means less', xLabel: 'price paid ÷ usual price', yLabel: 'demand ÷ normal',
      curve: sample((x) => demandAt(x, d), x0, x1), xDomain: [x0, x1], yDomain: [Math.min(0.6, d.minFrac), Math.max(1.2, d.maxFrac)], xUnit: 'pct', yUnit: 'pct',
      dots: dotsOf(wants, (t) => ({ x: t.pricePaidRatio as number, y: t.demandFactor as number }), null),
      sentence: Math.abs(r - 1) < 0.005 ? `${nameOf(first)} costs what it usually does: it wants ${pct(first.demandFactor as number)} of normal.`
        : `${nameOf(first)} is ${Math.abs(Math.round((r - 1) * 100))}% ${r > 1 ? 'dearer' : 'cheaper'} than usual: it wants ${pct(first.demandFactor as number)} of normal.`,
    });
  }
  if (plant !== null && reply.rules?.marginControl === true && c.margin !== undefined && num(plant.marginSignal)) {
    const fullAt = c.margin.fullAtShareOfBase;
    const share = num(plant.margin) && num(plant.marginBase) && plant.marginBase !== 0 ? plant.margin / plant.marginBase : null;
    const x1 = Math.max(1.2, fullAt + 0.3);
    const x0 = Math.min(-0.3, share ?? 0);
    const losing = num(plant.margin) && plant.margin < 0;
    out.push({
      n: 8, key: 'margin', title: 'Margin: no money, no production', xLabel: 'margin ÷ normal margin', yLabel: 'signal',
      curve: sample((x) => marginSignalAt(x, fullAt), x0, x1), xDomain: [x0, x1], yDomain: [0, 1], xUnit: 'pct', yUnit: 'pct',
      dots: share === null ? [] : [{ x: clamp(share, x0, x1), y: plant.marginSignal, label: 'this plant', color: blueRamp(1)[0], alarm: limit?.kind === 'margin' }],
      sentence: share === null ? 'Its margin is not known yet.'
        : losing ? `It loses $${Math.round(-(plant.margin as number))} on a tonne: it is held to its lowest rate.`
          : plant.marginSignal >= 0.995 ? `It makes $${Math.round(plant.margin as number)} on a tonne, ${pct(share)} of its normal margin: nothing held back.`
            : `It makes $${Math.round(plant.margin as number)} on a tonne, ${pct(share)} of normal: its margin allows ${pct(plant.marginSignal)}.`,
    });
  }
  return out;
}

/** True when the server does not have the view. */
export const econMissing = (error: string | null) => error !== null && /404|not found|no route/i.test(error);

type EconBackend = SimBackend & { siteEcon?: (id: string, site: number) => Promise<SiteEconReply> };

/** A site's economics, polled every two seconds while its tab is open. */
export function useSiteEcon(open: boolean, site: number | null): Polled<SiteEconReply> {
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    if (!open) return undefined;
    const t = setInterval(() => setBeat((n) => n + 1), 2000);
    return () => clearInterval(t);
  }, [open]);
  return useSessionData(open && site !== null, `site-econ|${site}|${beat}`, (backend: EconBackend, id) => {
    if (backend.siteEcon === undefined || site === null) return Promise.reject(new Error('404: this view needs the hosted engine.'));
    return backend.siteEcon(id, site).catch((err: unknown) => {
      throw err instanceof HttpError && err.status === 404 ? new Error('404') : err;
    });
  });
}
