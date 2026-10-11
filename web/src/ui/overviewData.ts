// The Economy window's Overview, as plain data: five answers, each small
// enough to read at a glance.

import type { EconomyReply } from '../engine/api';
import type { Snapshot } from '../engine/snapshot';
import { fullBuckets } from './economyData';
import type { PriceRow } from './pricesData';

/** Below this share of demand served, the figure is drawn in alarm red. */
export const SERVICE_ALARM = 0.95;

/** Customers served on the latest full day (0..1), with the days so far for the line under it; null before any day is in. */
export function serviceNow(reply: Pick<EconomyReply, 'totals' | 'buckets' | 'bucketH' | 'tick'>): { now: number; series: number[] } | null {
  const n = Math.min(fullBuckets(reply), reply.totals.service.length);
  if (reply.buckets === 0 || n <= 0) return null;
  const series = reply.totals.service.slice(0, n);
  return { now: series[n - 1], series };
}

/** A share as a whole percentage, rounded down so "100%" only ever means all of it. */
export function fmtShare(share: number): string {
  if (share >= 0.99995) return '100%';
  const v = Math.floor(share * 1000) / 10;
  return `${v >= 99 || v < 10 ? v.toFixed(1).replace(/\.0$/, '') : Math.floor(v)}%`;
}

/** The chemicals paid furthest above base now (up to `n`), and the one furthest below if any is below. */
export function pricePressure(rows: PriceRow[], n = 3): { above: PriceRow[]; below: PriceRow | null } {
  const paid = rows.filter((r) => r.paidPct !== null);
  const above = paid.filter((r) => Math.round(r.paidPct as number) > 0).sort((a, b) => (b.paidPct as number) - (a.paidPct as number)).slice(0, n);
  const under = paid.filter((r) => Math.round(r.paidPct as number) < 0).sort((a, b) => (a.paidPct as number) - (b.paidPct as number));
  return { above, below: under[0] ?? null };
}

export interface PlantState {
  site: number;
  name: string;
  process: string;
  /** "shut down", "restarting", "held at minimum" */
  words: string;
  down: boolean;
}

const STATE_WORDS: Record<number, string> = { 1: 'held at minimum', 2: 'shut down', 3: 'restarting' };

/**
 * How many plants (processes that make something: not customers) are
 * running normally right now, and the ones that are not, worst first. A
 * site with several processes is named with the process.
 */
export function plantsRunning(reply: Pick<EconomyReply, 'plants'>, snap: Pick<Snapshot, 'procStatus'>): { total: number; running: number; others: PlantState[] } {
  const plants = reply.plants.filter((p) => p.boundary !== 'sink');
  const perSite = new Map<number, number>();
  for (const p of plants) perSite.set(p.site_index, (perSite.get(p.site_index) ?? 0) + 1);
  const others: (PlantState & { rank: number })[] = [];
  for (const p of plants) {
    const status = snap.procStatus[p.index] ?? 0;
    if (status === 0) continue;
    others.push({
      site: p.site_index,
      name: (perSite.get(p.site_index) ?? 1) > 1 ? `${p.name}: ${p.process_name}` : p.name,
      process: p.process,
      words: STATE_WORDS[status] ?? 'not running',
      down: status === 2 || status === 3,
      rank: status === 2 ? 0 : status === 3 ? 1 : 2,
    });
  }
  others.sort((a, b) => a.rank - b.rank || a.name.localeCompare(b.name));
  return { total: plants.length, running: plants.length - others.length, others: others.map(({ rank: _rank, ...o }) => o) };
}
