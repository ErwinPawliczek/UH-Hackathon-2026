// The Economy window's words and figures.

import { describe, expect, it } from 'vitest';
import type { EconomyReply, ForecastReply } from '../engine/api';
import {
  SLOT_COUNT, bucketTicks, classSeries, costParts, countdownSentence, cumulative, defaultSlots, fmtAxisMoney,
  fmtAxisTonnes, fmtDuration, fmtMoney, fmtTonnes, fullBuckets, materialRows, nothingBroken, plantCharts,
  procurementSeries, toggleSlot,
} from './economyData';

const branch = { from_tick: 0, to_tick: 0, totals: { demand_t: 0, unmet_t: 0, unmet_usd: 0, freight_usd: 0, energy_usd: 0, inventory_usd: 0, inventory_change_usd: 0, service: 1, shutdown_h: 0 }, customers: [], plants: [] };
const forecast = (over: Partial<ForecastReply>): ForecastReply => ({
  tick: 1440, to_tick: 4320, days: 30, disruptions: 1, with: branch, without: branch,
  delta: { cost_usd: 0, unmet_usd: 0, freight_usd: 0, energy_usd: 0, inventory_usd: 0, unmet_t: 0, service: 0, shutdown_h: 0 },
  countdown: [],
  ...over,
});

describe('formatting', () => {
  it('writes money compactly', () => {
    expect(fmtMoney(5_838_892.8)).toBe('$5.8 M');
    expect(fmtMoney(207_516)).toBe('$208 K');
    expect(fmtMoney(1_025.8)).toBe('$1 K');
    expect(fmtMoney(815)).toBe('$815');
    expect(fmtMoney(-34_340.6)).toBe('-$34 K');
    expect(fmtMoney(123_400_000)).toBe('$123 M');
    expect(fmtMoney(999_600)).toBe('$1 M');
  });

  it('writes tonnes and durations in words', () => {
    expect(fmtTonnes(172.93)).toBe('173 t');
    expect(fmtTonnes(8.46)).toBe('8.5 t');
    expect(fmtTonnes(51468.5)).toBe('51,469 t');
    expect(fmtDuration(0.25)).toBe('15 minutes');
    expect(fmtDuration(1)).toBe('1 hour');
    expect(fmtDuration(162)).toBe('6 days 18 hours');
    expect(fmtDuration(48)).toBe('2 days');
    expect(fmtDuration(25)).toBe('1 day 1 hour');
  });
});

describe('costParts', () => {
  // the engine's own example: an ethane cracker compressor down for 10 days
  const f = forecast({
    delta: {
      cost_usd: 5838892.775968964, unmet_usd: 207516.1200002066, freight_usd: -34340.55758601241,
      energy_usd: -875294.7527459264, inventory_usd: -6541011.966300696, unmet_t: 172.93, service: -0.0003, shutdown_h: 479.25,
    },
  });

  it('itemises the cost so the parts add up to the total', () => {
    const parts = costParts(f);
    expect(parts.reduce((sum, p) => sum + p.usd, 0)).toBeCloseTo(f.delta.cost_usd, 3);
    expect(parts.map((p) => p.label)).toEqual(['Lost sales', 'Stock run down', 'Energy not used', 'Freight not run']);
    expect(parts[1].usd).toBeCloseTo(6541011.97, 1);
    expect(parts[0].note).toContain('173 t');
  });

  it('names the parts by their direction', () => {
    const other = costParts(forecast({ delta: { ...f.delta, inventory_usd: 5000, energy_usd: 10, freight_usd: 20, unmet_t: 0 } }));
    expect(other.map((p) => p.label)).toEqual(['Lost sales', 'Stock built up', 'Extra energy', 'Extra freight']);
    expect(other[1].usd).toBe(-5000);
  });
});

describe('countdown and the quiet case', () => {
  const row = { site: 'POLYETHYLENE', site_index: 9, name: 'Polyethylene', kind: 'shuts_down', what: 'PE polymerisation', tick: 2088, hours_from_now: 162, already: false };

  it('says what stops and when', () => {
    expect(countdownSentence(row)).toBe('Polyethylene shuts down in 6 days 18 hours');
    expect(countdownSentence({ ...row, name: 'Gas grid', kind: 'runs_dry', what: 'METHANE', hours_from_now: 3 })).toBe('Gas grid runs dry of methane in 3 hours');
    expect(countdownSentence({ ...row, name: 'Port terminal B', kind: 'runs_dry', what: 'FUEL_OIL', hours_from_now: 209 })).toBe('Port terminal B runs dry of fuel oil in 8 days 17 hours');
    expect(countdownSentence({ ...row, already: true })).toBe('Polyethylene is already shut down');
    expect(countdownSentence({ ...row, name: 'Packaging', kind: 'runs_dry', what: 'PE', already: true })).toBe('Packaging is already out of polyethylene');
  });

  it('knows when nothing is broken', () => {
    expect(nothingBroken(forecast({ disruptions: 0 }))).toBe(true);
    expect(nothingBroken(forecast({ disruptions: 1 }))).toBe(false);
    expect(nothingBroken(forecast({ disruptions: 0, countdown: [row] }))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// the run so far
// ---------------------------------------------------------------------------


const mat = (key: string, spend: number[], tonnes: number[]) => ({
  key, name: key, basePriceUsdT: 700, orderedT: tonnes, lots: tonnes.map(() => 1), spendUsd: spend,
  freightUsd: spend.map((s) => s / 100), deliveredT: tonnes, priceIndex: [1, 1.08, 0.94],
});
const keys = ['DIESEL', 'GASOLINE', 'PE', 'FUEL_OIL', 'PVC', 'LPG', 'JET', 'NAPHTHA', 'SALT'];
const reply: EconomyReply = {
  tick: 288, bucketH: 24, buckets: 3,
  // each next chemical spends a tenth less than the one before
  materials: keys.map((k, i) => mat(k, [900 - 100 * i, 90 - 10 * i, 9 - i], [9 - i, 9 - i, 9 - i])),
  byClass: [
    { cls: 'TRUCK_TANK', tonnes: [10, 20, 30], tonneKm: [1, 2, 3], freightUsd: [100, 200, 300] },
    { cls: 'SHIP_GAS', tonnes: [1000, 0, 500], tonneKm: [1, 2, 3], freightUsd: [40, 0, 20] },
  ],
  totals: { spendUsd: [1, 2, 3], freightUsd: [1, 1, 1], energyUsd: [0, 0, 0], unmetUsd: [0, 0, 5], unmetT: [0, 0, 1], demandT: [10, 10, 10], service: [1, 1, 0.9], shutdownH: [0, 24, 6] },
  plants: [
    { site: 'REFINERY', site_index: 5, name: 'Refinery', process: 'FCC', process_name: 'Fluid catalytic cracking', index: 7, designRateTph: 80, turndown: 0.6, rateMin: [1, 0, 0.5], rateMean: [1, 0, 0.55], rateMax: [1, 0, 0.6] },
    { site: 'REFINERY', site_index: 5, name: 'Refinery', process: 'CRUDE_DISTILLATION', process_name: 'Crude distillation', index: 5, designRateTph: 321, turndown: 0.6, rateMin: [1, 1, 1], rateMean: [1, 1, 1], rateMax: [1, 1, 1] },
    { site: 'OIL_FIELD', site_index: 0, name: 'Oil field', process: 'OIL_PRODUCTION', process_name: 'Oil wellhead and gathering', index: 0, designRateTph: 165, turndown: 0, rateMin: [0.9, 0.9, 0.2], rateMean: [0.94, 0.94, 0.3], rateMax: [1, 1, 0.4] },
  ],
};

describe('procurement', () => {
  it('lists every ordered chemical, biggest spend first, in plain words', () => {
    const rows = materialRows(reply, 'usd');
    expect(rows.map((r) => r.key)).toEqual(keys);
    expect(rows[0]).toMatchObject({ label: 'Diesel', spendUsd: 999, orderedT: 27, priceIndex: 0.94 });
    expect(rows[2].label).toBe('Polyethylene');
    expect(materialRows(reply, 't')[0].perBucket).toEqual([9, 9, 9]);
  });

  it('gives the biggest seven a line each and folds the rest into Other', () => {
    const rows = materialRows(reply, 'usd');
    const slots = defaultSlots(rows);
    expect(slots.size).toBe(SLOT_COUNT);
    const lines = procurementSeries(rows, slots, true, 'daily');
    expect(lines.map((l) => l.label)).toEqual(['Diesel', 'Gasoline', 'Polyethylene', 'Fuel oil', 'PVC', 'LPG', 'Jet fuel', 'Other (2)']);
    expect(lines[7]).toMatchObject({ slot: -1, values: [200 + 100, 20 + 10, 2 + 1] });
    expect(procurementSeries(rows, slots, false, 'daily')).toHaveLength(7);
    expect(procurementSeries(rows, slots, true, 'total')[0].values).toEqual([900, 990, 999]);
  });

  it('keeps a chemical on its colour when another is dropped or picked', () => {
    const rows = materialRows(reply, 'usd');
    let slots = defaultSlots(rows);
    expect(slots.get('PE')).toBe(2);
    expect(toggleSlot(slots, 'SALT').has('SALT')).toBe(false); // all seven taken: nothing changes
    slots = toggleSlot(slots, 'GASOLINE'); // drop the second
    expect(slots.has('GASOLINE')).toBe(false);
    expect(slots.get('PE')).toBe(2);
    slots = toggleSlot(slots, 'SALT'); // the newcomer takes the freed colour
    expect(slots.get('SALT')).toBe(1);
    expect(slots.get('DIESEL')).toBe(0);
    expect(procurementSeries(rows, slots, true, 'daily').map((l) => l.label).slice(0, 2)).toEqual(['Diesel', 'Salt']);
  });

  it('splits freight by vehicle type in dollars or tonnes', () => {
    expect(classSeries(reply, 'usd', 'daily')).toEqual([
      { label: 'Tank trucks', values: [100, 200, 300] },
      { label: 'Gas carriers', values: [40, 0, 20] },
    ]);
    expect(classSeries(reply, 't', 'total')[1].values).toEqual([1000, 1000, 1500]);
  });

  it('places buckets on their days, knows the last one may be unfinished, and formats axis values', () => {
    expect(bucketTicks(reply)).toEqual([0, 96, 192]);
    expect(fullBuckets(reply)).toBe(3); // tick 288 is exactly the end of day 3
    expect(fullBuckets({ ...reply, tick: 250 })).toBe(2);
    expect(fullBuckets({ tick: 10, bucketH: 24, buckets: 1 })).toBe(1);
    expect(cumulative([1, 2, 3])).toEqual([1, 3, 6]);
    expect(fmtAxisMoney(19_700_000)).toBe('$19.7M');
    expect(fmtAxisMoney(815)).toBe('$815');
    expect(fmtAxisTonnes(108_085)).toBe('108K t');
    expect(fmtAxisTonnes(640)).toBe('640 t');
  });
});

describe('production', () => {
  const charts = plantCharts(reply);

  it('orders plants by site, names a process only where a site has several', () => {
    expect(charts.map((c) => c.title)).toEqual(['Oil field', 'Refinery · Crude distillation', 'Refinery · Fluid catalytic cracking']);
    expect(charts[0].siteIndex).toBe(0);
  });

  it('marks the days a plant stood still or ran below its lowest stable rate', () => {
    const fcc = charts[2];
    expect(fcc.turndownPct).toBe(60);
    expect(fcc.mean.map((v) => Math.round(v))).toEqual([100, 0, 55]);
    expect(fcc.low).toEqual([false, true, true]);
    expect(fcc).toMatchObject({ stoppedDays: 1, belowMinDays: 1 });
    // a field has no lowest stable rate: slow is not red, only stopped would be
    expect(charts[0].turndownPct).toBe(0);
    expect(charts[0].low).toEqual([false, false, false]);
    expect(charts[1].low).toEqual([false, false, false]);
  });
});
