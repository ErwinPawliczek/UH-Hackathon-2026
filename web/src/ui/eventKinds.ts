// How the UI sorts engine log entries: bad states get alarm red, and routine
// logistics chatter stays off the timeline strip and out of the default log.

import type { SimEvent } from '../engine/events';

/** Alarm red is reserved for bad states and the disruptions a visitor triggers. */
export const CRITICAL_EVENTS = new Set(['stockout', 'unit_failed', 'process_shutdown', 'site_shutdown', 'route_break', 'scenario']);

/** Every order logs a dispatch and a delivery: hundreds a day on the full map. */
const ROUTINE_EVENTS = new Set(['dispatch', 'delivered']);

export function isRoutineEvent(e: SimEvent): boolean {
  return ROUTINE_EVENTS.has(e.type);
}

/** The events worth a marker or a row when looking back over a run: everything notable up to `tick`. */
export function notableEvents(events: SimEvent[], tick: number): SimEvent[] {
  return events.filter((e) => e.tick <= tick && !isRoutineEvent(e));
}

/** Route closures and reopenings: about a lane, not a plant. */
const ROUTE_EVENTS = new Set(['route_break', 'route_reopened']);

export function isRouteEvent(e: SimEvent): boolean {
  return ROUTE_EVENTS.has(e.type);
}

/**
 * How an event is marked in the log and on the Back in time scrubber: alarm
 * red for bad states, blue for the rest; route events are set apart by
 * shape (a diamond, where plant events are a bar) so a closed lane reads
 * differently from a failed unit at a glance.
 */
export function eventMark(e: SimEvent): { color: string; shape: 'bar' | 'diamond' } {
  return {
    color: CRITICAL_EVENTS.has(e.type) ? 'var(--alarm)' : 'var(--blue)',
    shape: isRouteEvent(e) ? 'diamond' : 'bar',
  };
}

/** An event type as a label: "route reopened", "unit failed". */
export function eventLabel(e: SimEvent): string {
  return e.type.replace(/_/g, ' ');
}
