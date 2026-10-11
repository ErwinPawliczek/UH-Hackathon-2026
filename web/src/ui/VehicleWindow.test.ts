// The vehicle window's words and numbers: what a trip reads as, and how far
// along it is.

import { describe, expect, it } from 'vitest';
import type { VehicleDetail } from '../engine/api';
import { StubBackend } from '../engine/stubBackend';
import { HttpBackend } from '../engine/httpBackend';
import { arrivalWords, fmtAbout, hoursToGo, pendingSentence, tripProgress, tripSentence } from './VehicleWindow';
import { materialName, materialTitle } from './materials';

const base: VehicleDetail = {
  index: 59, cls: 'TRUCK_BULK', capacityT: 25, status: 'to_dropoff',
  cargo: { material: 'PE', tonnes: 25 },
  order: {
    id: 834, material: 'PE', tonnes: 25,
    from: { site: 9, key: 'POLYETHYLENE', name: 'Polyethylene' },
    to: { site: 15, key: 'PACKAGING', name: 'Packaging' },
    createdTick: 2010, etaTick: 2070, priceUsdT: 1190, freightUsd: 697,
  },
  at: { site: null },
  legDestination: { site: 15, key: 'PACKAGING', name: 'Packaging' },
  path: [[344, 289], [513, 356]], remainingKm: 142, tripKm: 279,
};

describe('tripSentence', () => {
  it('always names the cargo, in plain words, and the place', () => {
    expect(tripSentence(base)).toBe('Carrying 25 t of polyethylene to Packaging.');
    expect(tripSentence({ ...base, status: 'to_pickup', cargo: null }))
      .toBe('Driving to pick up 25 t of polyethylene at Polyethylene.');
    expect(tripSentence({ ...base, status: 'queue_load', cargo: null }))
      .toBe('Waiting for a bay to load 25 t of polyethylene at Polyethylene.');
    expect(tripSentence({ ...base, status: 'loading', cargo: { material: 'PE', tonnes: 12.5 } }))
      .toBe('Loading 25 t of polyethylene at Polyethylene — 12.5 t on board so far.');
    expect(tripSentence({ ...base, status: 'queue_unload' }))
      .toBe('Carrying 25 t of polyethylene, waiting for a bay to unload at Packaging.');
    expect(tripSentence({ ...base, status: 'unloading', cargo: { material: 'PE', tonnes: 8 } }))
      .toBe('Unloading polyethylene at Packaging — 8 t still on board.');
  });

  it('reads like Erwin\'s example for a pressurised truck', () => {
    const order = { ...base.order!, material: 'PROPYLENE', tonnes: 20, from: { site: 7, key: 'CRACKER_FLEX', name: 'Steam cracker (flex)' } };
    expect(tripSentence({ ...base, status: 'to_pickup', cargo: null, order }))
      .toBe('Driving to pick up 20 t of propylene at Steam cracker (flex).');
  });

  it('says where an idle vehicle is, since it is not drawn', () => {
    const idle = { ...base, status: 'idle', cargo: null, order: null };
    expect(tripSentence(idle, 'Refinery')).toBe('Idle at Refinery, not shown on the map.');
    expect(tripSentence(idle)).toBe('Idle, not shown on the map.');
  });

  it('writes large lots without decimals', () => {
    const ship = { ...base, cargo: { material: 'GASOLINE', tonnes: 3312.4 } };
    expect(tripSentence(ship)).toBe('Carrying 3,312 t of gasoline to Packaging.');
  });
});

describe('before the trip is known', () => {
  it('says the details are loading, never a bare ellipsis', () => {
    expect(pendingSentence('to_pickup', null, null)).toBe('Driving to pick up (loading details…)');
    expect(pendingSentence('to_dropoff', null, null)).toBe('Carrying a load (loading details…)');
    expect(pendingSentence('idle', 'Refinery', null)).toBe('Idle at Refinery, not shown on the map.');
  });

  it('says so when the details could not be loaded', () => {
    expect(pendingSentence('to_pickup', null, 'GET /vehicle -> 404'))
      .toBe('Driving to pick up — the trip details could not be loaded (GET /vehicle -> 404).');
  });
});

describe('material names', () => {
  it('uses the names people say, not the keys', () => {
    expect(materialName('PE')).toBe('polyethylene');
    expect(materialName('PROPYLENE')).toBe('propylene');
    expect(materialName('FUEL_OIL')).toBe('fuel oil');
    expect(materialName('LPG')).toBe('LPG');
    expect(materialName('PVC')).toBe('PVC');
    expect(materialTitle('HEAVY_NAPHTHA')).toBe('Heavy naphtha');
    expect(materialTitle('CAUSTIC')).toBe('Caustic soda');
  });

  it('tidies a key it does not know and leaves internal stream names alone', () => {
    expect(materialName('SOMETHING_NEW')).toBe('something new');
    expect(materialName('wet_cl2')).toBe('wet cl2');
    expect(materialTitle('brine')).toBe('Brine');
  });
});

describe('tripProgress', () => {
  it('is the share of the drive already covered', () => {
    expect(tripProgress(base)).toBeCloseTo(1 - 142 / 279, 6);
    expect(tripProgress({ ...base, remainingKm: 0 })).toBe(1);
    expect(tripProgress({ ...base, remainingKm: 400 })).toBe(0); // never negative
  });

  it('estimates the time left from the distance left and the class speed', () => {
    expect(hoursToGo(base, 70)).toBeCloseTo(142 / 70, 6);
    expect(hoursToGo({ ...base, status: 'loading' }, 70)).toBeNull();
    expect(hoursToGo(base, 0)).toBeNull();
  });

  it('is absent when the vehicle is not driving or the trip has no length', () => {
    expect(tripProgress({ ...base, status: 'loading' })).toBeNull();
    expect(tripProgress({ ...base, tripKm: 0 })).toBeNull();
  });
});

describe('vehicle detail from the backends', () => {
  it('asks the hosted engine for one vehicle by index', async () => {
    const urls: string[] = [];
    const impl: typeof fetch = async (input) => {
      urls.push(String(input));
      return new Response(JSON.stringify(base), { status: 200 });
    };
    const b = new HttpBackend('http://x', impl);
    expect(await b.vehicle('sim-7', 59)).toEqual(base);
    expect(urls).toEqual(['http://x/api/sim/sim-7/vehicle?index=59']);
  });

  it('the stub describes its shuttling vehicles in the same shape', async () => {
    const b = new StubBackend();
    const { id } = await b.create({ seed: 42, scenario: 'none' });
    await b.step(id, 30);
    const d = await b.vehicle(id, 0);
    expect(d.index).toBe(0);
    expect(d.capacityT).toBeGreaterThan(0);
    expect(d.order).not.toBeNull();
    expect(d.path.length).toBeGreaterThanOrEqual(2);
    expect(d.remainingKm).toBeLessThanOrEqual(d.tripKm);
    expect(typeof tripSentence(d)).toBe('string');
    await expect(b.vehicle(id, 9999)).rejects.toThrow(/no such stub vehicle/);
  });
});

describe('arrivalWords', () => {
  const truck = { speedKmh: 70, loadTph: 50 };

  it("estimates from what is left now, never from the booked time", () => {
    // 142 km at 70 km/h, then 25 t off at 50 t/h
    expect(arrivalWords(base, truck)).toBe('Arrives and unloads in about 2.5 h');
    // to the pickup: 142 km; then load 0.5 h, the loaded drive as booked (60 ticks = 15 h), unload 0.5 h
    expect(arrivalWords({ ...base, status: 'to_pickup', cargo: null }, truck))
      .toBe('Picks up in about 2 h, delivers about 16 h after that');
    expect(arrivalWords({ ...base, status: 'queue_load', cargo: null, remainingKm: 0 }, truck))
      .toBe('Delivers about 16 h after it gets a bay to load');
    expect(arrivalWords({ ...base, status: 'loading', cargo: { material: 'PE', tonnes: 10 }, remainingKm: 0 }, truck))
      .toBe('Delivers in about 15.8 h');
    expect(arrivalWords({ ...base, status: 'queue_unload', remainingKm: 0 }, truck)).toBe('Unloads in about 30 min once it gets a bay');
    expect(arrivalWords({ ...base, status: 'unloading', cargo: { material: 'PE', tonnes: 5 }, remainingKm: 0 }, truck)).toBe('Unloaded in about 6 min');
  });

  it("never says running late, and says nothing when idle or when the class is unknown", () => {
    const overdue = { ...base, order: { ...base.order!, etaTick: 1 } };
    expect(arrivalWords(overdue, truck)).not.toMatch(/late/i);
    expect(arrivalWords({ ...base, status: 'idle', order: null, cargo: null }, truck)).toBeNull();
    expect(arrivalWords(base, undefined)).toBeNull();
    expect(fmtAbout(0.01)).toBe('1 min');
    expect(fmtAbout(60)).toBe('2.5 days');
  });
});


describe('vessels', () => {
  it("sail; trucks drive", () => {
    const toLoad = { ...base, status: 'to_pickup', cargo: null };
    expect(tripSentence({ ...toLoad, cls: 'BARGE_TANK' })).toMatch(/^Sailing to pick up /);
    expect(tripSentence({ ...toLoad, cls: 'SHIP_GAS' })).toMatch(/^Sailing to pick up /);
    expect(tripSentence(toLoad)).toMatch(/^Driving to pick up /);
    expect(pendingSentence('to_pickup', null, null, 'BARGE_DRY')).toBe('Sailing to pick up (loading details…)');
  });
});
