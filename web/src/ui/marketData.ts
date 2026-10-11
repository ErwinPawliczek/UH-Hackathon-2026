// The Market tab's data and wording: prices against base, what customers
// want at those prices, and what each plant makes on a tonne. Pure functions
// plus the polling hook; the view is EconomyMarket.tsx.

import { useEffect, useState } from 'react';
import type { MarketReply } from '../engine/api';
import { HttpError } from '../engine/httpBackend';
import { useSessionData, type Polled } from './economyData';
import { materialName, materialTitle } from './materials';

/** Real milliseconds between polls while the tab is open. */
export const MARKET_POLL_MS = 2000;

export type MarketMaterial = NonNullable<MarketReply['materials']>[number];
export type MarketCustomer = NonNullable<MarketReply['customers']>[number];
export type MarketPlant = NonNullable<MarketReply['plants']>[number];

const usd = (v: number) => `${v < 0 ? '-' : ''}$${Math.round(Math.abs(v)).toLocaleString('en-US')}`;
/** "$612 /t" */
export const perTonne = (v: number | null | undefined) => (v === null || v === undefined || !Number.isFinite(v) ? '—' : `${usd(v)} /t`);
/** "+12%", "−4%", "0%" */
export function fmtChange(pct: number): string {
  const r = Math.round(pct);
  return `${r > 0 ? '+' : r < 0 ? '−' : ''}${Math.abs(r)}%`;
}
/** "$1.2 M", "$340 K", "$0" */
export function fmtUsd(v: number): string {
  const a = Math.abs(v);
  if (a >= 999_500) return `$${(a / 1e6).toFixed(1)} M`;
  if (a >= 1000) return `$${Math.round(a / 1000)} K`;
  return `$${Math.round(a)}`;
}

/** Chemicals with a price to show, the biggest move first. */
export function sortedMaterials(reply: MarketReply): MarketMaterial[] {
  return [...(reply.materials ?? [])].sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct) || a.material.localeCompare(b.material));
}

/** Where a change sits on a bar from -span% to +span% around a centre line: left edge and width, in 0..1. */
export function changeBar(pct: number, span = 50): { left: number; width: number; clipped: boolean } {
  const c = Math.max(-span, Math.min(span, pct));
  const half = Math.abs(c) / (2 * span);
  return { left: c < 0 ? 0.5 - half : 0.5, width: half, clipped: Math.abs(pct) > span };
}

/** Where a demand factor sits on a bar from 60% to 120% of normal, in 0..1. */
export function demandBar(factor: number, lo = 0.6, hi = 1.2): { fill: number; normal: number } {
  const at = (v: number) => Math.max(0, Math.min(1, (v - lo) / (hi - lo)));
  return { fill: at(factor), normal: at(1) };
}

/** How much dearer or cheaper than base a customer is paying, in percent; null when it has paid nothing yet. */
export function paidChangePct(c: Pick<MarketCustomer, 'pricePaidUsdPerT' | 'baseUsdPerT'>): number | null {
  if (c.pricePaidUsdPerT === null || !(c.baseUsdPerT > 0)) return null;
  return (c.pricePaidUsdPerT / c.baseUsdPerT - 1) * 100;
}

/** "buying 95% of normal: diesel is 12% dearer" */
export function customerWords(c: MarketCustomer): string {
  const want = Math.round(c.demandFactor * 100);
  const what = materialName(c.material);
  const change = paidChangePct(c);
  const dear = change === null || Math.abs(change) < 0.5 ? null : `${what} is ${Math.abs(Math.round(change))}% ${change > 0 ? 'dearer' : 'cheaper'}`;
  if (want === 100) return dear === null ? 'buying as normal' : `buying as normal: ${dear}`;
  return `buying ${want}% of normal${dear === null ? '' : `: ${dear}`}`;
}

/** Customers, the one that has cut back most first. */
export function sortedCustomers(reply: MarketReply): MarketCustomer[] {
  return [...(reply.customers ?? [])].sort((a, b) => a.demandFactor - b.demandFactor || (b.pricedOutUsd ?? 0) - (a.pricedOutUsd ?? 0) || a.name.localeCompare(b.name));
}

/** What a plant's margin is doing to it, in a phrase; null when it is making money and running freely. */
export function plantWords(p: MarketPlant): string | null {
  const signal = p.marginSignal ?? 1;
  const m = p.marginUsdPerT;
  if (signal >= 1) return m !== null && m < 0 ? `losing ${usd(-m)}/t` : null;
  const how = signal <= 0.001 ? 'running at minimum' : 'held back';
  if (m === null) return how;
  return m < 0 ? `${how}: losing ${usd(-m)}/t` : `${how}: only ${usd(m)}/t`;
}

/** Plants, the worst margin first; those with no margin yet go last. */
export function sortedPlants(reply: MarketReply): MarketPlant[] {
  return [...(reply.plants ?? [])].sort((a, b) => (a.marginUsdPerT ?? Infinity) - (b.marginUsdPerT ?? Infinity) || a.name.localeCompare(b.name));
}

/** A plant's tonne split three ways, as shares of the revenue bar: feed, energy, and what is left (never below 0). */
export function tonneSplit(p: MarketPlant): { feed: number; energy: number; margin: number; over: boolean } | null {
  const rev = p.revenueUsdPerT ?? 0;
  const feed = p.feedCostUsdPerT ?? 0;
  const energy = p.energyUsdPerT ?? 0;
  const whole = Math.max(rev, feed + energy);
  if (!(whole > 0)) return null;
  return { feed: feed / whole, energy: energy / whole, margin: Math.max(0, rev - feed - energy) / whole, over: feed + energy > rev };
}

/** The rules in one sentence, from what the server says is on. */
export function rulesWords(rules: MarketReply['rules']): string {
  if (rules === undefined) return 'Market rules are on.';
  const parts: string[] = [];
  if (rules.priceAwareBuying) parts.push('buyers time and size orders by price');
  if ((rules.demandElasticity ?? 0) > 0) parts.push(`customers want ${Math.round((rules.demandElasticity ?? 0) * 100) / 10}% less for every 10% a price rises`);
  if (rules.marginControl) parts.push('plants drop to minimum when a tonne loses money');
  return parts.length === 0 ? 'Market rules are off in this world.' : `Market rules: ${parts.join('; ')}.`;
}

export const marketTitle = (key: string, name?: string) => (name !== undefined && name !== '' ? name : materialTitle(key));

/** True when the server does not have the market view (an engine a commit behind). */
export const marketMissing = (error: string | null) => error !== null && /404|not found|no route/i.test(error);

/** The market view, polled every two seconds while its tab is open. */
export function useMarket(open: boolean): Polled<MarketReply> {
  const [beat, setBeat] = useState(0);
  useEffect(() => {
    if (!open) return undefined;
    const t = setInterval(() => setBeat((n) => n + 1), MARKET_POLL_MS);
    return () => clearInterval(t);
  }, [open]);
  return useSessionData(open, `market|${beat}`, (backend, id) => {
    if (backend.market === undefined) return Promise.reject(new Error('404: this view needs the hosted engine.'));
    return backend.market(id).catch((err: unknown) => {
      throw err instanceof HttpError && err.status === 404 ? new Error('404') : err;
    });
  });
}
