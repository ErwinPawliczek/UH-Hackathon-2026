// Card-model tests on the stub world: process/site catalog join, per-unit
// trains indexing across processes, and fed-by/feeds from the route graph.

import { describe, expect, it } from 'vitest';
import { siteRanges, stubWorld } from '../engine/world';
import { decode } from '../engine/snapshot';
import { encodeStub } from '../engine/stub';
import { buildProcessCards, siteFlows, siteNeighbors } from './processCardModel';

const SEED = 42;

/** Decoded stub snapshot at tick 200 with trains sliced per assertion needs. */
function stubSnap(tick = 200) {
  return decode(encodeStub(SEED, tick));
}

describe('siteFlows', () => {
  it('aggregates the refinery site: CRUDE in, fuels and gasoline out', () => {
    const world = stubWorld(SEED);
    const flows = siteFlows(world, 1); // Refinery
    expect(flows.needs).toContain('CRUDE');
    for (const m of ['GASOLINE', 'DIESEL', 'JET', 'LPG']) expect(flows.makes, m).toContain(m);
    // internals never surface at site level
    expect(flows.needs).not.toContain('resid');
    expect(flows.makes).not.toContain('treated');
  });

  it('is catalog-backed for the oil field source (one-sided: makes only)', () => {
    const world = stubWorld(SEED);
    const flows = siteFlows(world, 0); // Oil Field: OIL_PRODUCTION source
    expect(flows.needs).toEqual([]);
    expect(flows.makes).toEqual(['CRUDE']);
  });
});

describe('buildProcessCards', () => {
  const world = stubWorld(SEED);
  const ranges = siteRanges(world);

  it('joins the refinery with its catalog recipes', () => {
    const snap = stubSnap();
    const cards = buildProcessCards(world, snap, 1, ranges[1]);
    expect(cards.map((c) => c.key)).toEqual(['CRUDE_DISTILLATION', 'REFORMING', 'FCC', 'DIESEL_HDT']);

    const cd = cards[0];
    expect(cd.known).toBe(true);
    expect(cd.needs).toEqual(['CRUDE']);
    expect(cd.makes).toContain('JET');
    expect(cd.makes).not.toContain('GASOLINE'); // distillation alone does not make it
    expect(cd.internals).toEqual(['resid']);

    const cdu = cd.units.find((u) => u.key === 'RF-CDU');
    expect(cdu!.singleTrain).toBe(true);
    expect(cdu!.trains).toBe(1);
    expect(cdu!.recipes[0].in).toEqual([{ key: 'CRUDE', share: 1, faded: false }]);
    const resid = cdu!.recipes[0].out.find((m) => m.key === 'resid');
    expect(resid!.faded).toBe(true);

    // REFORMING chains internals (treated → reformate) out to GASOLINE
    const reforming = cards[1];
    expect(reforming.makes).toContain('GASOLINE');
    expect(reforming.internals).toEqual(['treated', 'reformate']);
    const ccr = reforming.units.find((u) => u.key === 'RF-CCR');
    expect(ccr!.singleTrain).toBe(true);
  });

  it('reads each unit its own snapshot slot across processes of one site', () => {
    // Regression: units are flattened site-major; the second and later
    // processes must not re-read the first process's slots.
    const snap = stubSnap();
    const refinery = ranges[1]; // unitStart 1: [CDU, VDU, NHT, CCR, BTX, FCC, FRAC, DHT]
    snap.unitTrains[refinery.unitStart + 0] = 1; // RF-CDU online
    snap.unitTrains[refinery.unitStart + 1] = 0; // RF-VDU down
    snap.unitTrains[refinery.unitStart + 7] = 2; // RF-DHT online (trains 2)
    const cards = buildProcessCards(world, snap, 1, refinery);

    const cd = cards[0];
    expect(cd.units.find((u) => u.key === 'RF-CDU')!.trainsOnline).toBe(1);
    expect(cd.units.find((u) => u.key === 'RF-VDU')!.trainsOnline).toBe(0);
    const dht = cards[3];
    expect(dht.units[0]).toMatchObject({ key: 'RF-DHT', trains: 2, singleTrain: false, trainsOnline: 2 });
  });

  it('renders unknown process keys defensively: bare key, no flows, no throw', () => {
    const world = stubWorld(SEED);
    world.sites[0].processes[0].key = 'NOT_IN_CATALOG'; // simulate a stale payload
    const snap = stubSnap();
    const cards = buildProcessCards(world, snap, 0, ranges[0]);
    expect(cards).toHaveLength(1);
    const card = cards[0];
    expect(card.known).toBe(false);
    expect(card.key).toBe('NOT_IN_CATALOG');
    expect(card.needs).toEqual([]);
    expect(card.makes).toEqual([]);
    expect(card.units[0].recipes).toEqual([]);
    expect(card.units[0].trainsOnline).toBeGreaterThan(0); // snapshot slot still read
  });
});

describe('siteNeighbors — stub route graph', () => {
  const world = stubWorld(SEED);

  it('sees the refinery fed by the Oil Field (CRUDE pipeline) and feeding the cracker (NAPHTHA pipeline)', () => {
    const neighbors = siteNeighbors(world, 1);
    const oilField = neighbors.find((n) => n.name === 'Oil Field');
    expect(oilField!.feedsMe).toContain('CRUDE');
    expect(oilField!.modes).toContain('pipeline');

    const cracker = neighbors.find((n) => n.name === 'Steam Cracker');
    expect(cracker!.iFeed).toContain('NAPHTHA');
  });

  it('ships refinery products to the port over road and pipeline', () => {
    const neighbors = siteNeighbors(world, 1);
    const port = neighbors.find((n) => n.name === 'Port Terminal');
    expect(port).toBeDefined();
    expect(port!.iFeed).toContain('GASOLINE');
  });

  it('marks route materials both ends can make as exchanged, not directed', () => {
    // LPG: the refinery makes it (CDU) and the flex cracker makes it too, so
    // the road truck lane between them carries no inferable direction.
    const neighbors = siteNeighbors(world, 1);
    const cracker = neighbors.find((n) => n.name === 'Steam Cracker');
    expect(cracker!.exchanged).toContain('LPG');
    expect(cracker!.iFeed).not.toContain('LPG');
  });

  it('lists the off-map end of the sea lane as an exchanged neighbour', () => {
    const neighbors = siteNeighbors(world, 3); // Port Terminal
    const overseas = neighbors.find((n) => n.site === null);
    expect(overseas!.name).toBe('Overseas');
    expect(overseas!.exchanged).toContain('CRUDE'); // the tanker's cargo
    expect(overseas!.modes).toContain('sea');
  });
});
