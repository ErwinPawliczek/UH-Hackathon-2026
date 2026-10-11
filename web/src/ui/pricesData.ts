// The Economy window's Prices tab, as plain data: what each traded chemical
// was paid for against its base price, bucket by bucket, and what every
// seller of it is asking at this moment.
//
// Price paid in a bucket is what was spent on the orders booked in it over
// the tonnes they were for. A bucket with no orders has no price: it is a
// gap, never a zero.
//
// A seller's asking price follows its tank: base x (1 + 0.5 x (1 - 2 x fill)),
// so half full asks the base price, empty asks 50% more, full asks 50% less.

import type { EconomyReply } from '../engine/api';
import type { Snapshot } from '../engine/snapshot';
import type { WorldSpec } from '../engine/world';
import { materialTitle } from './materials';
import { MIN_REFETCH_MS, SLOT_COUNT, useSessionData, type Polled } from './economyData';
import { useSim } from '../store/sim';

/** Hours per bucket on this tab: daily hides most of the movement, so four values a day. */
export const PRICE_BUCKET_H = 6;
const TICKS_PER_HOUR = 4;

/** The run so far in six-hour buckets, refreshed once per bucket (and never more than every 2 s). */
export function usePriceHistory(open: boolean): Polled<EconomyReply> {
  const bucket = useSim((s) => Math.floor(Number(s.snap?.tick ?? 0) / (PRICE_BUCKET_H * TICKS_PER_HOUR)));
  return useSessionData(open, `prices|${bucket}`, (backend, id) => {
    if (backend.economy === undefined) return Promise.reject(new Error('This view needs the hosted engine.'));
    return backend.economy(id, PRICE_BUCKET_H);
  }, MIN_REFETCH_MS);
}

/** "+12%", "-8%", "0%": a share of the base price, always signed. */
export function fmtSigned(pct: number): string {
  if (!Number.isFinite(pct)) return '—';
  const r = Math.round(pct);
  return `${r > 0 ? '+' : ''}${r}%`;
}

export interface PriceRow {
  key: string;
  label: string;
  baseUsdT: number;
  /** price paid per bucket as % above (+) or below (-) base; NaN where nothing was ordered */
  pct: number[];
  /** latest bucket with orders: what was paid there, and when; null before the first order */
  paidUsdT: number | null;
  paidPct: number | null;
  paidBucket: number;
  /** how far from base it is paid now, in % points (0 before the first order) */
  movement: number;
  /** the engine's market index now, as % against base; null when it sends none */
  indexPct: number | null;
}

/** One row per chemical traded by vehicle, the one paid furthest from its base price now first. */
export function priceRows(reply: EconomyReply): PriceRow[] {
  return reply.materials
    .filter((m) => m.basePriceUsdT > 0)
    .map((m) => {
      const pct = m.spendUsd.map((usd, i) => {
        const t = m.orderedT[i] ?? 0;
        return t > 0 ? ((usd / t) / m.basePriceUsdT - 1) * 100 : NaN;
      });
      let paidBucket = -1;
      for (let i = pct.length - 1; i >= 0; i--) if (Number.isFinite(pct[i])) { paidBucket = i; break; }
      const index = m.priceIndex !== undefined && m.priceIndex.length > 0 ? m.priceIndex[m.priceIndex.length - 1] : null;
      return {
        key: m.key,
        label: materialTitle(m.key),
        baseUsdT: m.basePriceUsdT,
        pct,
        paidUsdT: paidBucket >= 0 ? m.spendUsd[paidBucket] / m.orderedT[paidBucket] : null,
        paidPct: paidBucket >= 0 ? pct[paidBucket] : null,
        paidBucket,
        movement: paidBucket >= 0 ? Math.abs(pct[paidBucket]) : 0,
        indexPct: index === null ? null : (index - 1) * 100,
      };
    })
    .sort((a, b) => b.movement - a.movement || a.label.localeCompare(b.label));
}

/** The chemicals drawn by default: the seven paid furthest from base now. */
export function defaultPriceSlots(rows: PriceRow[]): Map<string, number> {
  return new Map(rows.filter((r) => r.paidBucket >= 0).slice(0, SLOT_COUNT).map((r, i) => [r.key, i]));
}

/** The middle of each bucket, in ticks: where its average price sits on the time axis. */
export function bucketMidTicks(reply: Pick<EconomyReply, 'buckets' | 'bucketH'>): number[] {
  const w = reply.bucketH * TICKS_PER_HOUR;
  return Array.from({ length: reply.buckets }, (_, i) => i * w + w / 2);
}

/** A value-axis reach (± this many %) that holds every drawn value, with 0 and the half marks on round numbers. */
export function pctReach(values: number[]): number {
  const most = Math.max(0, ...values.filter(Number.isFinite).map(Math.abs));
  for (const r of [10, 20, 30, 40, 50, 60, 80, 100]) if (most <= r) return r;
  return Math.ceil(most / 50) * 50;
}

/** What a seller asks for a tonne when its tank is `fill` (0..1) full. */
export function askPrice(baseUsdT: number, fill: number): number {
  return baseUsdT * (1 + 0.5 * (1 - 2 * Math.min(1, Math.max(0, fill))));
}

export interface SellerAsk {
  site: number;
  name: string;
  fill: number;
  usdT: number;
  pct: number;
}

/** Every site that sells `material` (it has a product tank of it), with what it asks now, cheapest first. */
export function sellerAsks(world: WorldSpec, snap: Pick<Snapshot, 'tanks'>, material: string, baseUsdT: number): SellerAsk[] {
  const out: SellerAsk[] = [];
  world.tanks.forEach((tank, i) => {
    if (tank.material !== material || (tank.role !== 'product' && tank.role !== 'both')) return;
    const fill = snap.tanks[4 * i];
    if (!Number.isFinite(fill)) return;
    const usdT = askPrice(baseUsdT, fill);
    out.push({ site: tank.site, name: world.sites[tank.site]?.name ?? `Site ${tank.site + 1}`, fill, usdT, pct: (usdT / baseUsdT - 1) * 100 });
  });
  return out.sort((a, b) => a.usdT - b.usdT || a.name.localeCompare(b.name));
}

/** Chemicals that only ever move by pipeline here: they are never ordered, so they have no price. */
export function pipedOnly(world: WorldSpec, reply: Pick<EconomyReply, 'materials'>): string[] {
  const traded = new Set(reply.materials.map((m) => m.key));
  const piped = new Set(world.pipelines.map((p) => p.material));
  return [...piped].filter((m) => !traded.has(m)).map(materialTitle).sort((a, b) => a.localeCompare(b));
}

/**
 * A % series ready to draw: it ends at the last bucket with orders (so the
 * chart's legend reads the price paid now), and a bucket with orders that
 * has none either side becomes a short level stroke across its own hours,
 * since a single point would draw nothing.
 */
export function drawable(x: number[], pct: number[], halfWidth: number): { x: number[]; values: number[] } {
  let last = -1;
  for (let i = pct.length - 1; i >= 0; i--) if (Number.isFinite(pct[i])) { last = i; break; }
  const xs: number[] = [];
  const values: number[] = [];
  for (let i = 0; i <= last; i++) {
    const alone = Number.isFinite(pct[i]) && !Number.isFinite(pct[i - 1]) && !Number.isFinite(pct[i + 1]);
    if (alone) {
      xs.push(x[i] - halfWidth, x[i] + halfWidth);
      values.push(pct[i], pct[i]);
    } else {
      xs.push(x[i]);
      values.push(pct[i]);
    }
  }
  return { x: xs, values };
}
