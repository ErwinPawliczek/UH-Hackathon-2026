// Supply options: the order of tanks, and the words for time, price and blockage.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SourcingDetail, SourcingOption, SourcingTank } from '../engine/api';
import { SupplyDetail } from './EconomySupply';
import { ECONOMY_WINDOW_ID, openSupplyOptions, useEconomyView } from './economyView';
import {
  blockedWords, fmtCover, fmtTrip, inTime, nextPassWords, orderBookedWords, orderCommand, orderRefusedWords,
  priceParts, sortByCover, stateWords, supplierDown, tankHeadline, vehicleWords,
} from './supplyData';
import { useWindows } from './windows';

const tank = (over: Partial<SourcingTank>): SourcingTank => ({
  site: 'STYRENICS', site_index: 12, name: 'Styrenics', material: 'BENZENE', material_name: 'Benzene', fill: 0.3,
  cover_h: 72.58, draw_t_h: 5.39, inbound_t: 75, options: 3, usual: 'CRACKER_FLEX', usual_state: 'shut_down', ...over,
});

// the engine's own answer for Styrenics benzene with the flex cracker down
const option = (over: Partial<SourcingOption>): SourcingOption => ({
  seller: 'REFINERY', seller_index: 5, seller_name: 'Refinery', seller_state: 'running', stock_t: 2344.48, free_t: 2269.48,
  seller_fill: 0.3247, cls: 'TRUCK_TANK', mode: 'road', vehicles: 13, idle_now: 4, km: 540.41, travel_h: 7.72, handling_h: 1,
  pickup_h: 1.05, door_to_door_h: 9.77, lot_t: 25, ask_usd_t: 1057.78, freight_usd_t: 54.04, time_usd_t: 0, switch_usd_t: 45,
  landed_usd_t: 1156.82, price_usd_t: 978.89, feasible_now: true, blocked: null, arrives_before_dry: true, chosen: false, usual: false,
  ...over,
});
const detail: SourcingDetail = {
  tick: 1840,
  tank: {
    site: 'STYRENICS', site_index: 12, name: 'Styrenics', material: 'BENZENE', material_name: 'Benzene', buys: true, piped_in: false,
    level_t: 391.41, capacity_t: 1294.3, fill: 0.3024, target_t: 906.01, draw_t_h: 5.39292, cover_h: 72.58, inbound_t: 75,
    lead_time_h: 32, urgency: 0, want_t: 439.6, quoted_for_t: 439.6,
  },
  next_pass: { tick: 1844, lots: [], tonnes: 0 },
  usual: { site: 'CRACKER_FLEX', site_index: 7, name: 'Steam cracker (flex)', delivered_t: 1100, state: 'shut_down' },
  options: [
    option({}),
    option({ seller: 'CRACKER_FLEX', seller_index: 7, seller_name: 'Steam cracker (flex)', seller_state: 'shut_down', km: 218.09, door_to_door_h: 9.46, landed_usd_t: 1160.89, usual: true }),
    option({ seller: 'CRACKER_ETHANE', seller_index: 6, seller_name: 'Steam cracker (ethane)', km: 293.31, door_to_door_h: 80, free_t: 12, landed_usd_t: 1188.02, blocked: 'seller_short', feasible_now: false }),
  ],
};

describe('tank list', () => {
  it('puts the tank that runs dry soonest first and tanks nothing draws from last', () => {
    const sorted = sortByCover([tank({ site: 'A', cover_h: 90 }), tank({ site: 'B', cover_h: null }), tank({ site: 'C', cover_h: 12 })]);
    expect(sorted.map((t) => t.site)).toEqual(['C', 'A', 'B']);
  });

  it('knows a supplier that cannot deliver', () => {
    expect(supplierDown('shut_down')).toBe(true);
    expect(supplierDown('restarting')).toBe(true);
    expect(supplierDown('held')).toBe(false);
    expect(supplierDown('running')).toBe(false);
    expect(supplierDown(null)).toBe(false);
  });
});

describe('words', () => {
  it('writes stock and journeys in hours, then days', () => {
    expect(fmtCover(31.4)).toBe('31 hours');
    expect(fmtCover(72.58)).toBe('3.0 days');
    expect(fmtCover(0.4)).toBe('under an hour');
    expect(fmtCover(null)).toBe('plenty');
    expect(fmtTrip(9.77)).toBe('9.8 h');
    expect(fmtTrip(31.2)).toBe('31 h');
    expect(fmtTrip(50.4)).toBe('2.1 days');
  });

  it('compares door to door with the stock left', () => {
    expect(inTime(option({ door_to_door_h: 9.77 }), 72.58)).toEqual({ ok: true, words: 'arrives in time' });
    expect(inTime(option({ door_to_door_h: 81.6 }), 72.58)).toEqual({ ok: false, words: 'too late by 9.0 h' });
    expect(inTime(option({ door_to_door_h: 500 }), null).ok).toBe(true);
  });

  it('names vehicles, states and blockages plainly', () => {
    expect(vehicleWords('TRUCK_PRESS')).toBe('pressurised truck');
    expect(vehicleWords('SHIP_GAS')).toBe('gas carrier');
    expect(stateWords('shut_down')).toBe('shut down');
    expect(stateWords('held')).toBe('held at its lowest rate');
    expect(blockedWords(option({}))).toBeNull();
    expect(blockedWords(option({ blocked: 'no_vehicles', cls: 'BARGE_TANK' }))).toBe('no tank barge can get there');
    expect(blockedWords(option({ blocked: 'seller_short' }))).toBe('not enough in its tank for one tank truck load');
    expect(blockedWords(option({ blocked: 'unreachable', cls: 'SHIP_TANK' }))).toBe('no way through by tanker');
  });

  it('itemises the delivered price', () => {
    expect(priceParts(option({}))).toBe('$1,058 asked + $54 freight + $45 for switching supplier');
    expect(priceParts(option({ switch_usd_t: 0, time_usd_t: 12.2 }))).toBe('$1,058 asked + $54 freight + $12 for the wait');
  });

  it('sums a tank up in one sentence, and what the next ordering round will do', () => {
    expect(tankHeadline(detail)).toBe('Styrenics has 3.0 days of benzene; its usual supplier, Steam cracker (flex), is shut down.');
    expect(tankHeadline({ ...detail, usual: null })).toBe('Styrenics has 3.0 days of benzene; nobody has delivered any yet.');
    // not urgent yet: it has stock above its reorder point
    expect(nextPassWords(detail)).toBe('The next ordering round will book nothing: what is on hand and on the way is above its reorder point.');
    const urgent = { ...detail, tank: { ...detail.tank, urgency: 0.4 } };
    expect(nextPassWords(urgent)).toContain('waiting until it needs most of a vehicle load');
    expect(nextPassWords({ ...urgent, options: urgent.options.map((o) => ({ ...o, feasible_now: false })) })).toContain('no supplier can fill a load right now');
    const booking = { ...detail, next_pass: { tick: 1844, tonnes: 50, lots: [{ seller: 'REFINERY', cls: 'TRUCK_TANK', tonnes: 25 }, { seller: 'REFINERY', cls: 'TRUCK_TANK', tonnes: 25 }] } };
    expect(nextPassWords(booking)).toBe('The next ordering round will book 2 tank truck loads from Refinery (50 t).');
    expect(nextPassWords({ ...detail, next_pass: null })).toContain('pipeline');
  });
});

describe('SupplyDetail', () => {
  const html = renderToStaticMarkup(<SupplyDetail detail={detail} presetOf={() => 'REFINERY'} onSupplier={() => undefined} />);
  const text = html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/&amp;/g, '&').replace(/\s+/g, ' ');

  it('lists every option with its vehicle, distance, timing, spare stock and delivered price', () => {
    expect(html.match(/data-testid="supply-option"/g)).toHaveLength(3);
    expect(text).toContain('3 ways to supply it, cheapest delivered first');
    expect(text).toMatch(/Refinery .*\$1,157 \/t/);
    expect(text).toContain('by tank truck');
    expect(text).toContain('540 km');
    expect(text).toContain('9.8 h door to door');
    expect(text).toContain('arrives in time');
    expect(text).toContain('can spare 2,269 t');
    expect(text).toContain('$1,058 asked + $54 freight + $45 for switching supplier');
  });

  it('marks the usual supplier, a supplier that is down, lateness and what blocks an option', () => {
    expect(text).toMatch(/Steam cracker \(flex\) usual shut down/);
    expect(text).toContain('too late by 7.4 h');
    expect(text).toContain('Cannot be used now: not enough in its tank for one tank truck load.');
  });
});

describe('ordering by hand', () => {
  const order = { id: 1342, tonnes: 25, requestedTonnes: 400, material: 'BENZENE', seller: 'REFINERY', site: 'STYRENICS', cls: 'TRUCK_TANK', priceUsdT: 975.87, freightUsd: 1351.02, km: 540.41, etaTick: 991 };

  it('sends one vehicle load of the option as a place_order command', () => {
    expect(orderCommand({ site: 'STYRENICS', material: 'BENZENE' }, option({}))).toEqual({
      type: 'place_order', site: 'STYRENICS', material: 'BENZENE', seller: 'REFINERY', cls: 'TRUCK_TANK', tonnes: 25,
    });
  });

  it('says what was booked, or why it was not', () => {
    expect(orderBookedWords(order, 'Refinery', (t) => `tick ${t}`)).toBe('25 t of benzene from Refinery by tank truck, $976/t, due tick 991');
    expect(orderRefusedWords({ ok: false, error: 'place_order: the seller has only 12 t free', blocked: 'seller_short' })).toBe('The seller has only 12 t free.');
    expect(orderRefusedWords({ ok: false, blocked: 'no_room' })).toBe('The tank has no room for another load.');
    expect(orderRefusedWords({ ok: false })).toBe('The order was not accepted.');
  });

  it('offers the order on options that can be used now, and shows the outcome', () => {
    const html = renderToStaticMarkup(
      <SupplyDetail detail={detail} presetOf={() => 'REFINERY'} onSupplier={() => undefined} onOrder={() => undefined} note={{ ok: true, text: 'Booked 25 t of benzene.' }} />,
    );
    // two of the three options are feasible; the third is short of stock
    expect(html.match(/data-testid="supply-order"/g)).toHaveLength(2);
    expect(html).toContain('data-testid="supply-order-note"');
    expect(html).toContain('Booked 25 t of benzene.');
    // without a live session there is nothing to order through
    expect(renderToStaticMarkup(<SupplyDetail detail={detail} presetOf={() => ''} onSupplier={() => undefined} />)).not.toContain('supply-order"');
  });
});

describe('openSupplyOptions', () => {
  it('opens the Economy window on the Supply options tab, on that tank', () => {
    useWindows.setState({ windows: {}, order: [] });
    useEconomyView.setState({ tab: 'procurement', supplyTank: null });
    openSupplyOptions(12, 'BENZENE');
    expect(useWindows.getState().windows[ECONOMY_WINDOW_ID]?.open).toBe(true);
    expect(useEconomyView.getState()).toMatchObject({ tab: 'supply', supplyTank: { site: 12, material: 'BENZENE' } });
    // already open: it stays open (a second call must not close it) and moves to the new tank
    openSupplyOptions(10, 'PROPYLENE');
    expect(useWindows.getState().windows[ECONOMY_WINDOW_ID]?.open).toBe(true);
    expect(useEconomyView.getState().supplyTank).toEqual({ site: 10, material: 'PROPYLENE' });
  });
});
