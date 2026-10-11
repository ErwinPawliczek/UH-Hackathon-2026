// The Economy window's words and figures.

import { describe, expect, it } from 'vitest';
import type { ForecastReply } from '../engine/api';
import { costParts, countdownSentence, fmtDuration, fmtMoney, fmtTonnes, nothingBroken } from './economyData';

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
