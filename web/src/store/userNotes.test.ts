// The notes the client writes for what the visitor did.

import { describe, expect, it } from 'vitest';
import { describeCommand, isUserEvent, momentWords, userSeq } from './userNotes';
import { stubWorld, type WorldSpec } from '../engine/world';
import fixture from '../ui/__fixtures__/flowsheetSites.json';

const base = stubWorld(1);
const world: WorldSpec = {
  ...base,
  sites: [
    { ...base.sites[0], key: 'CHLOR_ALKALI', name: 'Chlor-alkali' },
    { ...base.sites[1], key: 'SALT_MINE', name: 'Salt mine' },
  ],
  routes: [{ mode: 'river', ends: ['Salt mine', 'near Steam cracker (ethane)'], sites: [1, null], points: [] }],
};

describe('describeCommand', () => {
  it('says which unit the visitor failed, where and for how long', () => {
    expect(describeCommand(world, { type: 'unit_outage', site: 0, unit: 'CA-CELL', trains: 3, duration_h: 96 })).toEqual({
      type: 'user_outage', site: 0, text: 'You took down 3 trains of CA-CELL at Chlor-alkali for 4 days',
    });
    expect(describeCommand(world, { type: 'unit_outage', site: 'CHLOR_ALKALI', unit: 'CA-CL2', trains: 1, duration_h: 30 })?.text)
      .toBe('You took down 1 train of CA-CL2 at Chlor-alkali for 30 h');
  });

  describe('with the real flowsheet data', () => {
    const real = { ...(fixture as unknown as WorldSpec), pipelines: [] } as WorldSpec;
    const siteIndex = (key: string) => real.sites.findIndex((x) => x.key === key);
    const unitIndex = (site: string, process: string) =>
      real.sites[siteIndex(site)].processes.find((p) => p.name === process)?.units[0].index as number;

    it("names the process a failed unit belongs to, going by the unit's index where a key is shared", () => {
      // a fuel depot has four units keyed FD-OUT, one per fuel: the index says which
      const jet = unitIndex('FUEL_DEPOT', 'City jet fuel demand');
      const depot = siteIndex('FUEL_DEPOT');
      expect(real.sites[depot].processes.filter((p) => p.units.some((u) => u.key === 'FD-OUT'))).toHaveLength(4);
      expect(describeCommand(real, { type: 'unit_outage', site: depot, unit: 'FD-OUT', unit_index: jet, trains: 1, duration_h: 24 })).toEqual({
        type: 'user_outage', site: depot, text: 'You took down City jet fuel demand at Fuel depot for 1 day',
      });
      const diesel = unitIndex('FUEL_DEPOT', 'City diesel demand');
      expect(describeCommand(real, { type: 'unit_outage', site: depot, unit: 'FD-OUT', unit_index: diesel, trains: 1, duration_h: 48 })?.text)
        .toBe('You took down City diesel demand at Fuel depot for 2 days');
      // the index is enough on its own: the note still lands on the unit's site
      expect(describeCommand(real, { type: 'unit_outage', unit_index: jet, trains: 1, duration_h: 24 })).toEqual({
        type: 'user_outage', site: depot, text: 'You took down City jet fuel demand at Fuel depot for 1 day',
      });
    });

    it("names the unit and its process when the process has other units, and the trains when only some go down", () => {
      expect(describeCommand(real, { type: 'unit_outage', site: 'REFINERY', unit: 'RF-CDU', trains: 1, duration_h: 168 })?.text)
        .toBe('You took down RF-CDU (Crude distillation) at Refinery for 7 days');
      expect(describeCommand(real, { type: 'unit_outage', site: 'CHLOR_ALKALI', unit: 'CA-CELL', trains: 3, duration_h: 96 })?.text)
        .toBe('You took down 3 of 6 trains of CA-CELL (Chlor-alkali electrolysis) at Chlor-alkali for 4 days');
      expect(describeCommand(real, { type: 'unit_outage', site: 'CHLOR_ALKALI', unit: 'CA-CELL', trains: 6, duration_h: 96 })?.text)
        .toBe('You took down CA-CELL (Chlor-alkali electrolysis) at Chlor-alkali for 4 days');
      // one of the diesel hydrotreater's two trains: the only unit of its process, but not all of it
      expect(describeCommand(real, { type: 'unit_outage', site: 'REFINERY', unit: 'RF-DHT', trains: 1, duration_h: 24 })?.text)
        .toBe('You took down 1 of 2 trains of RF-DHT (Diesel hydrotreating) at Refinery for 1 day');
    });

    it("does not guess which unit a shared key means, or invent one for an index the world does not have", () => {
      expect(describeCommand(real, { type: 'unit_outage', site: 'FUEL_DEPOT', unit: 'FD-OUT', trains: 1, duration_h: 24 })?.text)
        .toBe('You took down 1 train of FD-OUT at Fuel depot for 1 day');
      expect(describeCommand(real, { type: 'unit_outage', site: 'FUEL_DEPOT', unit: 'FD-OUT', unit_index: 99999, trains: 1, duration_h: 24 })?.text)
        .toBe('You took down 1 train of FD-OUT at Fuel depot for 1 day');
    });
  });

  it('says what the visitor ordered by hand, from whom and for whom', () => {
    expect(describeCommand(world, { type: 'place_order', site: 0, material: 'SALT', seller: 1, cls: 'BARGE_DRY', tonnes: 1500 })).toEqual({
      type: 'user_order', site: 0, text: 'You ordered 1500 t of salt from Salt mine for Chlor-alkali, by barge (dry)',
    });
  });

  it('describes a route closure by the route, and other disruptions by their site', () => {
    expect(describeCommand(world, { type: 'route_break', edge: 0, duration_h: 120 })?.text)
      .toBe('You closed the river lane between Salt mine and near Steam cracker (ethane) for 5 days');
    expect(describeCommand(world, { type: 'supply_shock', site: 'SALT_MINE', multiplier: 0.5, duration_h: 240 })?.text)
      .toBe("You set Salt mine's output to 50% for 10 days");
  });

  it('leaves no note for a command that is not an action', () => {
    expect(describeCommand(world, { type: 'something_else' })).toBeNull();
    expect(describeCommand(world, { cmd: 'set_adaptation' })).toBeNull();
  });
});

describe('client-written entries', () => {
  it('take fresh negative sequence numbers, which is what marks them as the visitor\'s', () => {
    const a = userSeq();
    const b = userSeq();
    expect(a).toBeLessThan(0);
    expect(b).toBeLessThan(a);
    expect(isUserEvent({ seq: a })).toBe(true);
    expect(isUserEvent({ seq: 0 })).toBe(false);
  });

  it('words a moment as a day and a time', () => {
    expect(momentWords(0)).toBe('Day 1, 00:00');
    expect(momentWords(2 * 96)).toBe('Day 3, 00:00');
    expect(momentWords(11 * 96 + 25)).toBe('Day 12, 06:15');
  });
});
