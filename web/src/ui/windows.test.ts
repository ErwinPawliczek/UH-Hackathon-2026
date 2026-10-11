// Floating-window state and the event log's row selection.

import { beforeEach, describe, expect, it } from 'vitest';
import { clampToViewport, useWindows } from './windows';
import { logRows } from './EventLog';
import { timelineMarkers } from './Timeline';
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
    expect(clampToViewport(-50, 10, 400, viewport)).toEqual({ x: 0, y: 48 });
    expect(clampToViewport(900, 100, 400, viewport)).toEqual({ x: 600, y: 100 });
  });
  it('never lets the title bar drop off the bottom', () => {
    expect(clampToViewport(100, 5000, 400, viewport)).toEqual({ x: 100, y: 660 });
  });
});

describe('event log rows and timeline markers', () => {
  const ev = (seq: number, tick: number, type: string): SimEvent => ({ seq, tick, type, text: `${type} ${seq}` });
  const events = [ev(0, 10, 'dispatch'), ev(1, 20, 'unit_failed'), ev(2, 30, 'delivered'), ev(3, 40, 'process_shutdown'), ev(4, 90, 'unit_repaired')];

  it('lists newest first, up to the current tick, without routine logistics by default', () => {
    expect(logRows(events, 50, false).map((e) => e.seq)).toEqual([3, 1]);
    expect(logRows(events, 50, true).map((e) => e.seq)).toEqual([3, 2, 1, 0]);
    expect(logRows(events, 100, true, 2).map((e) => e.seq)).toEqual([4, 3]);
  });

  it('marks only notable events on the strip', () => {
    expect(timelineMarkers(events, 50).map((e) => e.seq)).toEqual([1, 3]);
  });
});
