// Floating-window state and the event log's row selection.

import { beforeEach, describe, expect, it } from 'vitest';
import { clampToViewport, useWindows } from './windows';
import { logRows } from './EventLog';
import { eventLabel, eventMark, isRoutineEvent, isUserEvent, notableEvents } from './eventKinds';
import type { SimEvent } from '../engine/events';

describe('windows store', () => {
  beforeEach(() => useWindows.setState({ windows: {}, order: [] }));

  it('is closed until toggled, opens where asked, and remembers a moved position', () => {
    const w = () => useWindows.getState();
    expect(w().windows.log).toBeUndefined();
    w().toggle('log', { x: 16, y: 64 });
    expect(w().windows.log).toEqual({ open: true, x: 16, y: 64 });
    w().move('log', 300, 200);
    w().toggle('log', { x: 16, y: 64 }); // close
    expect(w().windows.log).toEqual({ open: false, x: 300, y: 200 });
    w().toggle('log', { x: 16, y: 64 }); // reopen: where it was left
    expect(w().windows.log).toEqual({ open: true, x: 300, y: 200 });
    w().close('log');
    expect(w().windows.log.open).toBe(false);
  });

  it('brings the focused or newly opened window to the front', () => {
    const w = () => useWindows.getState();
    w().toggle('log', { x: 0, y: 64 });
    w().toggle('analytics', { x: 0, y: 64 });
    expect(w().order).toEqual(['log', 'analytics']);
    w().focus('log');
    expect(w().order).toEqual(['analytics', 'log']);
  });
});

describe('clampToViewport', () => {
  const viewport = { width: 1000, height: 700 };
  it('leaves a window that fits alone', () => {
    expect(clampToViewport(100, 100, 400, viewport)).toEqual({ x: 100, y: 100 });
  });
  it('keeps the window inside the sides and under the top bar', () => {
    expect(clampToViewport(-50, 10, 400, viewport)).toEqual({ x: 0, y: 56 });
    expect(clampToViewport(900, 100, 400, viewport)).toEqual({ x: 600, y: 100 });
  });
  it('never lets the title bar drop off the bottom', () => {
    expect(clampToViewport(100, 5000, 400, viewport)).toEqual({ x: 100, y: 660 });
  });
});

describe('event log rows and notable events', () => {
  const ev = (seq: number, tick: number, type: string): SimEvent => ({ seq, tick, type, text: `${type} ${seq}` });
  const events = [ev(0, 10, 'dispatch'), ev(1, 20, 'unit_failed'), ev(2, 30, 'delivered'), ev(3, 40, 'process_shutdown'), ev(4, 90, 'unit_repaired')];

  it('lists only what the visitor did by default; the engine\'s entries are behind the tick boxes', () => {
    const mine = [
      ...events,
      { seq: -1, tick: 15, type: 'scenario', text: 'Refinery crude unit down (7 days)' },
      { seq: -2, tick: 35, type: 'user_order', text: 'You ordered 25 t of salt …' },
    ].sort((a, b) => a.tick - b.tick);
    const off = { consequences: false, deliveries: false };
    expect(logRows(mine, 50, off).map((e) => e.seq)).toEqual([-2, -1]);
    expect(logRows(mine, 50, { consequences: true, deliveries: false }).map((e) => e.seq)).toEqual([3, -2, 1, -1]);
    expect(logRows(mine, 50, { consequences: false, deliveries: true }).map((e) => e.seq)).toEqual([-2, 2, -1, 0]);
    expect(logRows(mine, 100, { consequences: true, deliveries: true }, 2).map((e) => e.seq)).toEqual([4, 3]);
    expect(logRows(events, 100, off)).toEqual([]); // nothing changed by the visitor yet
  });

  it('keeps only notable events for markers', () => {
    expect(notableEvents(events, 50).map((e) => e.seq)).toEqual([1, 3]);
  });
});

describe('event kinds', () => {
  const ev = (type: string): SimEvent => ({ seq: 1, tick: 5, type, text: '' });

  it('treats route closures and reopenings as notable, with their own mark', () => {
    expect(isRoutineEvent(ev('route_break'))).toBe(false);
    expect(isRoutineEvent(ev('route_reopened'))).toBe(false);
    expect(eventMark(ev('route_break'))).toEqual({ color: 'var(--alarm)', shape: 'diamond' });
    expect(eventMark(ev('route_reopened'))).toEqual({ color: 'var(--blue)', shape: 'diamond' });
    expect(eventLabel(ev('route_reopened'))).toBe('route reopened');
    expect(notableEvents([ev('route_break'), ev('delivered'), ev('route_reopened')], 10).map((e) => e.type))
      .toEqual(['route_break', 'route_reopened']);
  });

  it('keeps plant events on bars: red for bad states, blue for the rest', () => {
    expect(eventMark(ev('unit_failed'))).toEqual({ color: 'var(--alarm)', shape: 'bar' });
    expect(eventMark(ev('unit_repaired'))).toEqual({ color: 'var(--blue)', shape: 'bar' });
  });
});

describe('whose entry it is', () => {
  it('is decided by the entry itself: the client numbers the visitor\'s actions below zero', () => {
    expect(isUserEvent({ seq: -3 })).toBe(true);
    expect(isUserEvent({ seq: 0 })).toBe(false);
    expect(isUserEvent({ seq: 812 })).toBe(false);
  });

  it('labels the visitor\'s entries as theirs and keeps a rewind note out of Back in time', () => {
    const ev = (seq: number, type: string): SimEvent => ({ seq, tick: 5, type, text: '' });
    expect(eventLabel(ev(-1, 'user_outage'))).toBe('you: disruption');
    expect(eventLabel(ev(-2, 'user_order'))).toBe('you: order');
    expect(eventLabel(ev(-3, 'rewind'))).toBe('back in time');
    expect(eventMark(ev(-1, 'user_outage')).color).toBe('var(--alarm)');
    expect(eventMark(ev(-2, 'user_order')).color).toBe('var(--blue)');
    expect(notableEvents([ev(-1, 'user_outage'), ev(-3, 'rewind'), ev(4, 'unit_failed')], 10).map((e) => e.type))
      .toEqual(['user_outage', 'unit_failed']);
  });
});
