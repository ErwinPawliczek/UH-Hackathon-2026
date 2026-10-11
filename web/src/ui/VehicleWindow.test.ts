// The vehicle window's words and numbers: what a trip reads as, and how far
// along it is.

import { describe, expect, it } from 'vitest';
import type { VehicleDetail } from '../engine/api';
import { StubBackend } from '../engine/stubBackend';
import { HttpBackend } from '../engine/httpBackend';
import { tripProgress, tripSentence } from './VehicleWindow';

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
  it('says what is on board and where it is going', () => {
    expect(tripSentence(base)).toBe('Carrying 25 t of PE to Packaging.');
  });

  it('says an empty vehicle is on its way to load', () => {
    expect(tripSentence({ ...base, status: 'to_pickup', cargo: null }))
      .toBe('Empty, on the way to load 25 t of PE at Polyethylene.');
  });

  it('covers queueing, loading and unloading', () => {
    expect(tripSentence({ ...base, status: 'queue_load', cargo: null }))
      .toBe('Empty, waiting for a bay to load 25 t of PE at Polyethylene.');
    expect(tripSentence({ ...base, status: 'loading', cargo: { material: 'PE', tonnes: 12.5 } }))
      .toBe('Loading 25 t of PE at Polyethylene — 12.5 t on board so far.');
    expect(tripSentence({ ...base, status: 'queue_unload' }))
      .toBe('Carrying 25 t of PE, waiting for a bay to unload at Packaging.');
    expect(tripSentence({ ...base, status: 'unloading', cargo: { material: 'PE', tonnes: 8 } }))
      .toBe('Unloading PE at Packaging — 8 t still on board.');
  });

  it('says where an idle vehicle is, since it is not drawn', () => {
    const idle = { ...base, status: 'idle', cargo: null, order: null };
    expect(tripSentence(idle, 'Refinery')).toBe('Idle at Refinery, not shown on the map.');
    expect(tripSentence(idle)).toBe('Idle, not shown on the map.');
  });

  it('writes large lots without decimals', () => {
    const ship = { ...base, cargo: { material: 'GASOLINE', tonnes: 3312.4 } };
    expect(tripSentence(ship)).toBe('Carrying 3,312 t of GASOLINE to Packaging.');
  });
});

describe('tripProgress', () => {
  it('is the share of the drive already covered', () => {
    expect(tripProgress(base)).toBeCloseTo(1 - 142 / 279, 6);
    expect(tripProgress({ ...base, remainingKm: 0 })).toBe(1);
    expect(tripProgress({ ...base, remainingKm: 400 })).toBe(0); // never negative
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
