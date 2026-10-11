// The notes the client writes for what the visitor did.

import { describe, expect, it } from 'vitest';
import { describeCommand, isUserEvent, momentWords, userSeq } from './userNotes';
import { stubWorld, type WorldSpec } from '../engine/world';

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
