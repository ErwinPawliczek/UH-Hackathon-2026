// Data behind the Economy window: fetching it from the live session, and
// turning the engine's numbers into the sentences and figures the window
// shows. Kept apart from the React components so it can be tested on its own.

import { useEffect, useRef, useState } from 'react';
import type { EconomyReply, ForecastReply, SimBackend } from '../engine/api';
import { sessionRequest } from '../store/engineSession';
import { useSim } from '../store/sim';
import { materialName, materialTitle } from './materials';

export const TICKS_PER_DAY = 96;

/** "$5.8 M", "$207 K", "$815", "-$34 K": compact dollars with a thin space before the unit. */
export function fmtMoney(usd: number): string {
  const sign = usd < 0 ? '-' : '';
  const v = Math.abs(usd);
  if (v >= 999_500) return `${sign}$${trim(v / 1e6, v >= 99_950_000 ? 0 : 1)} M`;
  if (v >= 9_995) return `${sign}$${Math.round(v / 1e3)} K`;
  if (v >= 1_000) return `${sign}$${trim(v / 1e3, 1)} K`;
  return `${sign}$${Math.round(v)}`;
}

function trim(v: number, digits: number): string {
  return v.toFixed(digits).replace(/\.0$/, '');
}

/** "12,400 t", "173 t", "8.5 t". */
export function fmtTonnes(t: number): string {
  const v = Math.abs(t);
  return `${v >= 100 ? Math.round(t).toLocaleString('en-US') : Math.round(t * 10) / 10} t`;
}

/** Hours as words: "15 minutes", "3 hours", "6 days 18 hours", "2 days". */
export function fmtDuration(hours: number): string {
  const h = Math.max(0, hours);
  if (h < 1) {
    const m = Math.max(1, Math.round(h * 60));
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  const whole = Math.round(h);
  const days = Math.floor(whole / 24);
  const rest = whole % 24;
  const d = `${days} day${days === 1 ? '' : 's'}`;
  const r = `${rest} hour${rest === 1 ? '' : 's'}`;
  if (days === 0) return r;
  return rest === 0 ? d : `${d} ${r}`;
}

/** One line of the cost breakdown: what it is, in plain words, and what it adds to the total. */
export interface CostPart {
  key: 'lost_sales' | 'stock' | 'energy' | 'freight';
  label: string;
  note: string;
  /** dollars this adds to the cost (negative = it offsets the cost) */
  usd: number;
}

/**
 * The forecast's cost, itemised. The parts add up to `delta.cost_usd`: sales
 * lost to unmet demand, plus stock that will have been run down (or minus
 * stock built up), plus the change in energy and freight bills.
 */
export function costParts(f: ForecastReply): CostPart[] {
  const d = f.delta;
  const stock = -d.inventory_usd;
  return [
    {
      key: 'lost_sales',
      label: 'Lost sales',
      note: d.unmet_t > 0.5 ? `customers go without ${fmtTonnes(d.unmet_t)} they ordered` : 'every customer still gets what it ordered',
      usd: d.unmet_usd,
    },
    {
      key: 'stock',
      label: stock >= 0 ? 'Stock run down' : 'Stock built up',
      note: stock >= 0 ? 'product that will not be in the tanks at the end' : 'product left sitting in the tanks at the end',
      usd: stock,
    },
    {
      key: 'energy',
      label: d.energy_usd <= 0 ? 'Energy not used' : 'Extra energy',
      note: d.energy_usd <= 0 ? 'stopped plants burn no fuel' : 'plants running harder to catch up',
      usd: d.energy_usd,
    },
    {
      key: 'freight',
      label: d.freight_usd <= 0 ? 'Freight not run' : 'Extra freight',
      note: d.freight_usd <= 0 ? 'fewer loads to carry' : 'longer or more urgent deliveries',
      usd: d.freight_usd,
    },
  ];
}

/** True when the forecast says nothing is wrong: no disruption and no difference worth a dollar. */
export function nothingBroken(f: ForecastReply): boolean {
  return f.disruptions === 0 && Math.abs(f.delta.cost_usd) < 1 && f.countdown.length === 0;
}

/** "Polyethylene shuts down in 6 days 18 hours" / "Gas grid runs dry of methane in 3 hours" / "… is already shut down". */
export function countdownSentence(row: ForecastReply['countdown'][number]): string {
  const dry = row.kind === 'runs_dry';
  const what = materialName(row.what);
  if (row.already) return dry ? `${row.name} is already out of ${what}` : `${row.name} is already shut down`;
  const when = fmtDuration(row.hours_from_now);
  return dry ? `${row.name} runs dry of ${what} in ${when}` : `${row.name} shuts down in ${when}`;
}

export interface Polled<T> {
  data: T | null;
  /** why the last fetch failed, when it did */
  error: string | null;
  /** a fetch is in flight (the previous data stays on screen meanwhile) */
  loading: boolean;
}

/**
 * Data fetched from the live session while a panel is open. It is fetched
 * when the panel opens and again whenever `key` changes (callers fold into
 * it whatever should trigger a refresh: the sim day, a scenario count). It
 * goes through the session's own request queue, one fetch at a time, and is
 * dropped whenever the run is replaced or taken back in time.
 */
export function useSessionData<T>(
  open: boolean,
  key: string,
  fetcher: (backend: SimBackend, id: string) => Promise<T>,
): Polled<T> {
  const epoch = useSim((s) => s.runEpoch);
  const [state, setState] = useState<Polled<T> & { epoch: number }>({ data: null, error: null, loading: false, epoch });
  const inFlight = useRef(false);
  const wanted = useRef('');
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!open) return;
    const want = `${epoch}|${key}`;
    wanted.current = want;
    let cancelled = false;
    const run = () => {
      if (inFlight.current) return; // the fetch in flight re-checks when it lands
      const asked = wanted.current;
      const askedEpoch = epoch;
      const request = sessionRequest((backend, id) => fetcherRef.current(backend, id));
      if (request === null) return;
      inFlight.current = true;
      setState((s) => ({ ...s, loading: true, ...(s.epoch !== askedEpoch ? { data: null, error: null, epoch: askedEpoch } : {}) }));
      request
        .then(
          (data) => {
            if (useSim.getState().runEpoch === askedEpoch) setState({ data, error: null, loading: false, epoch: askedEpoch });
          },
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            setState((s) => ({ ...s, error: message, loading: false }));
          },
        )
        .finally(() => {
          inFlight.current = false;
          if (!cancelled && wanted.current !== asked) run(); // something changed while it was in flight
        });
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [open, key, epoch]);

  // data from a run that is gone is never shown
  return state.epoch === epoch ? state : { data: null, error: null, loading: state.loading };
}

/** Trains online across every unit: changes whenever a unit fails or is repaired. */
function trainsOnline(): number {
  const snap = useSim.getState().snap;
  if (snap === null) return 0;
  let n = 0;
  for (let i = 0; i < snap.unitTrains.length; i++) n += snap.unitTrains[i];
  return n;
}

/**
 * The forecast for the Disruption impact tab: fetched when the tab opens,
 * when a scenario is triggered or a unit fails or comes back, after a step
 * back in time, and otherwise once per simulated day.
 */
export function useForecast(open: boolean, days: number): Polled<ForecastReply> {
  const day = useSim((s) => Math.floor(Number(s.snap?.tick ?? 0) / TICKS_PER_DAY));
  const triggered = useSim((s) => s.triggered.length);
  const trains = useSim(() => trainsOnline());
  return useSessionData(open, `${day}|${triggered}|${trains}|${days}`, (backend, id) => {
    if (backend.forecast === undefined) return Promise.reject(new Error('This view needs the hosted engine.'));
    return backend.forecast(id, days);
  });
}

// ---------------------------------------------------------------------------
// Procurement and production: the run so far, from GET /economy
// ---------------------------------------------------------------------------


/** Hours per bucket the Economy window asks for: one value per simulated day. */
export const ECONOMY_BUCKET_H = 24;

/** The run so far in daily buckets: fetched when a tab that needs it opens, then once per simulated day. */
export function useEconomy(open: boolean): Polled<EconomyReply> {
  const day = useSim((s) => Math.floor(Number(s.snap?.tick ?? 0) / TICKS_PER_DAY));
  return useSessionData(open, `${day}`, (backend, id) => {
    if (backend.economy === undefined) return Promise.reject(new Error('This view needs the hosted engine.'));
    return backend.economy(id, ECONOMY_BUCKET_H);
  });
}

export const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

/** Running total of a per-bucket series. */
export function cumulative(values: number[]): number[] {
  let acc = 0;
  return values.map((v) => (acc += v));
}

/** The tick each bucket starts at: the x of its value on a chart (bucket 0 is day 1). */
export function bucketTicks(reply: Pick<EconomyReply, 'buckets' | 'bucketH'>): number[] {
  return Array.from({ length: reply.buckets }, (_, i) => i * reply.bucketH * 4);
}

/**
 * How many buckets are complete. The last bucket of a reply is still filling
 * unless the run stands exactly on a bucket boundary; a per-day chart leaves
 * it out so its last point is a whole day, not a dip.
 */
export function fullBuckets(reply: Pick<EconomyReply, 'buckets' | 'bucketH' | 'tick'>): number {
  const partial = reply.tick % (reply.bucketH * 4) !== 0;
  return partial ? Math.max(1, reply.buckets - 1) : reply.buckets;
}

export type Measure = 'usd' | 't';
export type Span = 'daily' | 'total';

export interface MaterialRow {
  key: string;
  label: string;
  spendUsd: number;
  orderedT: number;
  freightUsd: number;
  lots: number;
  /** latest price against par (1 = par), when the engine reports it */
  priceIndex: number | null;
  /** per-bucket series in the chosen measure */
  perBucket: number[];
}

/** Every chemical that has been ordered, biggest spend first. */
export function materialRows(reply: EconomyReply, measure: Measure): MaterialRow[] {
  return reply.materials
    .map((m) => ({
      key: m.key,
      label: materialTitle(m.key),
      spendUsd: sum(m.spendUsd),
      orderedT: sum(m.orderedT),
      freightUsd: sum(m.freightUsd),
      lots: sum(m.lots),
      priceIndex: m.priceIndex !== undefined && m.priceIndex.length > 0 ? m.priceIndex[m.priceIndex.length - 1] : null,
      perBucket: measure === 'usd' ? m.spendUsd : m.orderedT,
    }))
    .sort((a, b) => b.spendUsd - a.spendUsd || a.key.localeCompare(b.key));
}

export interface PlottedSeries {
  key: string;
  label: string;
  /** palette slot, or -1 for the folded "Other" line */
  slot: number;
  values: number[];
}

/**
 * The lines of the procurement chart: one per chemical that holds a colour
 * slot, in slot order, then one "Other" line summing every chemical that
 * does not (when `other` is on and there are any).
 */
export function procurementSeries(
  rows: MaterialRow[],
  slots: ReadonlyMap<string, number>,
  other: boolean,
  span: Span,
): PlottedSeries[] {
  const shape = (v: number[]) => (span === 'total' ? cumulative(v) : v);
  const shown = rows
    .filter((r) => slots.has(r.key))
    .sort((a, b) => (slots.get(a.key) ?? 0) - (slots.get(b.key) ?? 0))
    .map((r) => ({ key: r.key, label: r.label, slot: slots.get(r.key) ?? 0, values: shape(r.perBucket) }));
  const rest = rows.filter((r) => !slots.has(r.key));
  if (other && rest.length > 0) {
    const n = Math.max(...rest.map((r) => r.perBucket.length));
    const total = Array.from({ length: n }, (_, i) => sum(rest.map((r) => r.perBucket[i] ?? 0)));
    shown.push({ key: '__other__', label: `Other (${rest.length})`, slot: -1, values: shape(total) });
  }
  return shown;
}

/** How many colour slots a chart has: chemicals beyond these fold into "Other". */
export const SLOT_COUNT = 7;

/** Give `key` the lowest free slot, or take its slot away; unchanged when every slot is taken. */
export function toggleSlot(slots: ReadonlyMap<string, number>, key: string): Map<string, number> {
  const next = new Map(slots);
  if (next.has(key)) {
    next.delete(key);
    return next;
  }
  const taken = new Set(next.values());
  for (let s = 0; s < SLOT_COUNT; s++) {
    if (!taken.has(s)) {
      next.set(key, s);
      break;
    }
  }
  return next;
}

/** The first colours of a run: the biggest chemicals by spend, in that order. */
export function defaultSlots(rows: MaterialRow[]): Map<string, number> {
  return new Map(rows.slice(0, SLOT_COUNT).map((r, i) => [r.key, i]));
}

/** Vehicle classes in plain words, in the order the fleet is listed. */
const CLASS_WORDS: Record<string, string> = {
  TRUCK_TANK: 'Tank trucks', TRUCK_PRESS: 'Pressurised trucks', TRUCK_BULK: 'Bulk trucks',
  BARGE_TANK: 'Tank barges', BARGE_DRY: 'Dry barges',
  SHIP_TANK: 'Tankers', SHIP_GAS: 'Gas carriers', SHIP_DRY: 'Bulk carriers',
};
export const classWords = (cls: string) => CLASS_WORDS[cls] ?? cls.toLowerCase().replace(/_/g, ' ');

/** Freight per vehicle type: dollars of freight, or tonnes carried, per bucket or as a running total. */
export function classSeries(reply: EconomyReply, measure: Measure, span: Span): { label: string; values: number[] }[] {
  return reply.byClass.map((c) => {
    const v = measure === 'usd' ? c.freightUsd : c.tonnes;
    return { label: classWords(c.cls), values: span === 'total' ? cumulative(v) : v };
  });
}

export interface PlantChart {
  key: string;
  title: string;
  siteIndex: number;
  /** percentages of design, one per bucket */
  mean: number[];
  min: number[];
  max: number[];
  /** lowest stable rate as a percentage of design; 0 when it has none (a field, a mine) */
  turndownPct: number;
  /** per bucket: the mean was zero, or under the lowest stable rate */
  low: boolean[];
  stoppedDays: number;
  belowMinDays: number;
}

/** One small chart per plant process, in site order: the daily low-to-high band and its mean. */
export function plantCharts(reply: EconomyReply): PlantChart[] {
  const perSite = new Map<number, number>();
  for (const p of reply.plants) perSite.set(p.site_index, (perSite.get(p.site_index) ?? 0) + 1);
  return [...reply.plants]
    .sort((a, b) => a.site_index - b.site_index || a.index - b.index)
    .map((p) => {
      const turndown = p.turndown ?? 0;
      const stopped = p.rateMean.map((r) => r <= 0.005);
      const below = p.rateMean.map((r, i) => !stopped[i] && turndown > 0 && r < turndown - 1e-6);
      return {
        key: `${p.site}/${p.process}`,
        title: (perSite.get(p.site_index) ?? 1) > 1 ? `${p.name} · ${p.process_name}` : p.name,
        siteIndex: p.site_index,
        mean: p.rateMean.map((r) => r * 100),
        min: p.rateMin.map((r) => r * 100),
        max: p.rateMax.map((r) => r * 100),
        turndownPct: turndown * 100,
        low: stopped.map((s, i) => s || below[i]),
        stoppedDays: stopped.filter(Boolean).length,
        belowMinDays: below.filter(Boolean).length,
      };
    });
}

/** "$19.7 M" style money for axis marks and readouts (same as fmtMoney, kept short). */
export const fmtAxisMoney = (usd: number) => fmtMoney(usd).replace(' ', '');
/** Tonnes for axis marks and readouts: "108K t", "640 t". */
export function fmtAxisTonnes(t: number): string {
  const a = Math.abs(t);
  if (a >= 1e6) return `${(t / 1e6).toFixed(1)}M t`;
  if (a >= 1e4) return `${Math.round(t / 1e3)}K t`;
  if (a >= 1e3) return `${(t / 1e3).toFixed(1)}K t`;
  return `${Math.round(t)} t`;
}
