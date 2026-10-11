// Back in time: the moment arithmetic behind the scrubber and its readout.

import { describe, expect, it } from 'vitest';
import { fmtAgo, fmtMoment, hourAtOrBefore, momentBefore } from './RewindWindow';

describe('moments', () => {
  it('formats a tick as a day and a clock time', () => {
    expect(fmtMoment(0)).toBe('Day 1, 00:00');
    expect(fmtMoment(11 * 96 + 24)).toBe('Day 12, 06:00');
    expect(fmtMoment(96 + 1)).toBe('Day 2, 00:15');
  });

  it('says how long ago in days and hours', () => {
    expect(fmtAgo(0)).toBe('now');
    expect(fmtAgo(4)).toBe('1 hour ago');
    expect(fmtAgo(3 * 96 + 16)).toBe('3 days 4 hours ago');
    expect(fmtAgo(96)).toBe('1 day ago');
  });

  it('snaps to whole hours', () => {
    expect(hourAtOrBefore(0)).toBe(0);
    expect(hourAtOrBefore(7)).toBe(4);
    expect(hourAtOrBefore(8)).toBe(8);
  });

  it('goes to just before an event', () => {
    // an engine event logged at tick 101 happened after hour mark 100
    expect(momentBefore({ seq: 3, tick: 101, type: 'unit_failed', text: '' })).toBe(100);
    // one logged exactly on an hour mark needs the hour before
    expect(momentBefore({ seq: 4, tick: 100, type: 'process_shutdown', text: '' })).toBe(96);
    // a scenario note sits on the tick its command was given at: going back
    // to that tick (or its hour mark) already undoes it
    expect(momentBefore({ seq: -1, tick: 100, type: 'scenario', text: '' })).toBe(100);
    expect(momentBefore({ seq: -1, tick: 102, type: 'scenario', text: '' })).toBe(100);
    expect(momentBefore({ seq: 0, tick: 0, type: 'unit_failed', text: '' })).toBe(0);
  });
});
