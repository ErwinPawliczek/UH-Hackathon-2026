// The numbers behind a site's analytics, as pure functions: turning the
// engine's hourly histories into time series, and composing them into what
// the charts show — a material's flow in or out of the plant (the sum over
// processes of rate × that stream's design t/h), a tank's level, a unit's
// throughput — plus the headline numbers for right now.
//
// The engine records one sample per simulated hour, at ticks 4, 8, 12 …
// (nothing at tick 0), and keeps the last 60 days. A history fetched when
// the run stood at tick T with n samples therefore has its last sample at
// the latest whole hour at or before T, and the ones before it an hour
// apart.

import type { Snapshot } from '../engine/snapshot';
import type { WorldSpec } from '../engine/world';
import {
  rateOf, tankLive, unitLive, type FlowTankNode, type FlowUnitNode, type Flowsheet,
} from './flowsheet';

import { blueRamp } from './charts/palette';
import { TICKS_PER_DAY, TICKS_PER_HOUR } from './charts/scale';

export { TICKS_PER_DAY, TICKS_PER_HOUR };

/** Values over time; `ticks[i]` is when `values[i]` was true. */
export interface Series {
  ticks: number[];
  values: number[];
}

export const EMPTY_SERIES: Series = { ticks: [], values: [] };

/** An hourly history as fetched: the samples, and the tick the run stood at then. */
export interface History {
  values: number[];
  fetchedTick: number;
}

/** Tick at which sample `j` of an `n`-sample history fetched at `fetchedTick` was taken. */
export function sampleTick(j: number, n: number, fetchedTick: number): number {
  return (Math.floor(fetchedTick / TICKS_PER_HOUR) - (n - 1 - j)) * TICKS_PER_HOUR;
}

/** A fetched history as a time series. */
export function toSeries(h: History | undefined): Series {
  if (h === undefined) return EMPTY_SERIES;
  const n = h.values.length;
  return { ticks: h.values.map((_, j) => sampleTick(j, n, h.fetchedTick)), values: [...h.values] };
}

/**
 * The series with the live value added as its last point, so a chart keeps
 * moving between fetches. Samples from a future that no longer exists (a
 * history fetched before going back in time) are dropped.
 */
export function withNow(s: Series, nowTick: number, nowValue: number): Series {
  const keep = s.ticks.filter((t) => t < nowTick).length;
  return { ticks: [...s.ticks.slice(0, keep), nowTick], values: [...s.values.slice(0, keep), nowValue] };
}

/** Only the points at or after `fromTick`. */
export function since(s: Series, fromTick: number): Series {
  const start = s.ticks.findIndex((t) => t >= fromTick);
  if (start < 0) return EMPTY_SERIES;
  return { ticks: s.ticks.slice(start), values: s.values.slice(start) };
}

/**
 * A weighted sum of series, point by point in time: Σ weight × series. The
 * result has a point wherever every part has one (histories fetched together
 * line up exactly; a part with no data yields no points).
 */
export function weightedSum(parts: { series: Series; weight: number }[]): Series {
  if (parts.length === 0) return EMPTY_SERIES;
  const maps = parts.map((p) => new Map(p.series.ticks.map((t, i) => [t, p.series.values[i]])));
  const ticks = parts[0].series.ticks.filter((t) => maps.every((m) => m.has(t)));
  return {
    ticks,
    values: ticks.map((t) => parts.reduce((acc, p, k) => acc + p.weight * (maps[k].get(t) as number), 0)),
  };
}

export type RowGroup = 'in' | 'out' | 'level' | 'unit';

/** One line of the analytics: a named quantity, its value now, its design value, and its history. */
export interface AnalyticsRow {
  id: string;
  group: RowGroup;
  label: string;
  unit: 't/h' | '%';
  now: number;
  /** value at design rate (t/h rows), or null where there is none (levels) */
  design: number | null;
  series: Series;
  /** unit rows: capacity of the trains online now, t/h */
  capacity?: number;
  /** unit rows: the unit's block in the diagram */
  node?: FlowUnitNode;
  /** tank rows: the tank's block */
  tank?: FlowTankNode;
}

/** Fetched histories by key: `p<process index>` (rate / design) and `t<tank index>` (fill). */
export type Histories = Map<string, History>;

const flowSeries = (flows: { proc: number; tph: number }[], hist: Histories): Series =>
  weightedSum(flows.map((f) => ({ series: toSeries(hist.get(`p${f.proc}`)), weight: f.tph })));

const flowNow = (flows: { proc: number; tph: number }[], snap: Snapshot): number =>
  flows.reduce((acc, f) => acc + f.tph * rateOf(snap, f.proc), 0);

/**
 * The plant as a whole: every material it takes in and every material it
 * sends out, in t/h (the sum over its processes of rate × that stream's
 * design t/h), then the level of each of its tanks.
 */
export function plantRows(sheet: Flowsheet, world: WorldSpec, snap: Snapshot, hist: Histories, materialLabel: (key: string) => string): AnalyticsRow[] {
  const now = Number(snap.tick);
  const tanks = sheet.nodes.filter((nd): nd is FlowTankNode => nd.kind === 'tank');
  const rows: AnalyticsRow[] = [];
  for (const t of tanks) {
    if (t.role !== 'feed') continue;
    const value = flowNow(t.outBy, snap);
    rows.push({
      id: `in-${t.tank}`, group: 'in', label: materialLabel(t.material), unit: 't/h', now: value, design: t.outTph,
      series: withNow(flowSeries(t.outBy, hist), now, value), tank: t,
    });
  }
  for (const t of tanks) {
    if (t.role !== 'product') continue;
    const value = flowNow(t.inBy, snap);
    rows.push({
      id: `out-${t.tank}`, group: 'out', label: materialLabel(t.material), unit: 't/h', now: value, design: t.inTph,
      series: withNow(flowSeries(t.inBy, hist), now, value), tank: t,
    });
  }
  const seen = new Set<number>();
  for (const t of tanks) {
    if (seen.has(t.tank)) continue; // a tank drawn at both ends is still one tank
    seen.add(t.tank);
    const fill = tankLive(world, snap, t).fill;
    const s = toSeries(hist.get(`t${t.tank}`));
    rows.push({
      id: `level-${t.tank}`, group: 'level', label: `${materialLabel(t.material)} tank`, unit: '%', now: fill * 100, design: null,
      series: withNow({ ticks: s.ticks, values: s.values.map((v) => v * 100) }, now, fill * 100), tank: t,
    });
  }
  return rows;
}

/** Inside the process: each unit's throughput in t/h (process rate × everything the unit takes in). */
export function unitRows(sheet: Flowsheet, snap: Snapshot, hist: Histories): AnalyticsRow[] {
  const now = Number(snap.tick);
  return sheet.nodes
    .filter((nd): nd is FlowUnitNode => nd.kind === 'unit')
    .map((u) => {
      const live = unitLive(snap, u);
      const rate = toSeries(hist.get(`p${u.procIndex}`));
      return {
        id: `unit-${u.unitIndex}`, group: 'unit' as const, label: u.unit.key, unit: 't/h' as const,
        now: live.inletTph, design: u.inletTph, capacity: live.capacityTph, node: u,
        series: withNow({ ticks: rate.ticks, values: rate.values.map((v) => v * u.inletTph) }, now, live.inletTph),
      };
    });
}

/** One line of a "Into the plant" / "Out of the plant" chart. */
export interface FlowLine {
  label: string;
  color: string;
  /** line width in px: the sum is heavier than its parts */
  width: number;
  series: Series;
  /** t/h now, and at design rate */
  now: number;
  design: number;
  /** the total over every chemical, not a chemical itself */
  sum: boolean;
}

/** Ink black: the sum line must not be taken for one more chemical. */
const SUM_COLOR = '#0a0a0a';

/**
 * The lines of one flow chart: every chemical in `rows` (all "in" rows or
 * all "out" rows) as its own line in a shade of blue, and their total as a
 * heavier black line named `sumLabel`. Shades are fixed by design flow: the
 * largest stream is the darkest, the smallest the lightest, so a line keeps
 * its colour however the plant is running and whichever lines are shown. A
 * single chemical is its own total, so it gets no separate sum line.
 */
export function flowLines(rows: AnalyticsRow[], sumLabel: string): FlowLine[] {
  const ordered = [...rows].sort((a, b) => (b.design ?? 0) - (a.design ?? 0) || a.label.localeCompare(b.label));
  const shades = blueRamp(ordered.length); // light → dark
  const parts: FlowLine[] = ordered.map((r, i) => ({
    label: r.label,
    color: shades[ordered.length - 1 - i], // largest flow darkest
    width: 2,
    series: r.series,
    now: r.now,
    design: r.design ?? 0,
    sum: false,
  }));
  if (parts.length < 2) return parts;
  const total: FlowLine = {
    label: sumLabel,
    color: SUM_COLOR,
    width: 3,
    series: weightedSum(parts.map((p) => ({ series: p.series, weight: 1 }))),
    now: parts.reduce((acc, p) => acc + p.now, 0),
    design: parts.reduce((acc, p) => acc + p.design, 0),
    sum: true,
  };
  return [total, ...parts];
}

export interface Headline {
  /** throughput now as a share of design: Σ rate × design rate over Σ design rate, 0..1 */
  throughput: number;
  /** hours until the first feed tank runs dry at the current draw; null when nothing is drawn */
  feedCoverH: number | null;
  /** hours until the first product tank is full at the current make; null when nothing is made */
  productRoomH: number | null;
  /** names of the tanks those two numbers come from */
  feedTank: string | null;
  productTank: string | null;
}

export function headline(sheet: Flowsheet, world: WorldSpec, snap: Snapshot): Headline {
  const procs = new Map<number, number>(); // process index → design rate
  for (const nd of sheet.nodes) if (nd.kind === 'unit') procs.set(nd.procIndex, nd.process.designRateTph);
  let made = 0;
  let design = 0;
  for (const [proc, rate] of procs) {
    made += rateOf(snap, proc) * rate;
    design += rate;
  }
  let feedCoverH: number | null = null;
  let productRoomH: number | null = null;
  let feedTank: string | null = null;
  let productTank: string | null = null;
  for (const nd of sheet.nodes) {
    if (nd.kind !== 'tank') continue;
    const live = tankLive(world, snap, nd);
    if (nd.role === 'feed' && live.coverH !== null && (feedCoverH === null || live.coverH < feedCoverH)) {
      feedCoverH = live.coverH;
      feedTank = nd.material;
    }
    if (nd.role === 'product' && live.roomH !== null && (productRoomH === null || live.roomH < productRoomH)) {
      productRoomH = live.roomH;
      productTank = nd.material;
    }
  }
  return { throughput: design > 0 ? made / design : 0, feedCoverH, productRoomH, feedTank, productTank };
}

/** Ticks back from now that each time-window choice covers; null is everything on record. */
export const WINDOWS: { key: string; label: string; ticks: number | null }[] = [
  { key: '24h', label: '24 h', ticks: TICKS_PER_DAY },
  { key: '7d', label: '7 days', ticks: 7 * TICKS_PER_DAY },
  { key: 'all', label: 'All', ticks: null },
];
