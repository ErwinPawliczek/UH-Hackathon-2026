// How the UI sorts engine log entries: bad states get alarm red, and routine
// logistics chatter stays off the timeline strip and out of the default log.

import type { SimEvent } from '../engine/events';

/** Alarm red is reserved for bad states and the disruptions a visitor triggers. */
export const CRITICAL_EVENTS = new Set(['stockout', 'unit_failed', 'process_shutdown', 'site_shutdown', 'route_break', 'supply_shock', 'demand_shock', 'scenario', 'user_outage']);

/** Snapshot site status for a site that runs with its output or demand cut by a shock. */
export const SITE_LIMITED = 5;

/** Every order logs a dispatch and a delivery: hundreds a day on the full map. */
const ROUTINE_EVENTS = new Set(['dispatch', 'delivered']);

export function isRoutineEvent(e: SimEvent): boolean {
  return ROUTINE_EVENTS.has(e.type);
}

/**
 * The events worth a marker or a row when looking back over a run: everything
 * notable up to `tick`. A note that the visitor went back in time is not a
 * moment to go back to, so it is left out.
 */
export function notableEvents(events: SimEvent[], tick: number): SimEvent[] {
  return events.filter((e) => e.tick <= tick && !isRoutineEvent(e) && e.type !== 'rewind');
}

export { isUserEvent } from '../store/userNotes';

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

/** Labels for the entries the client writes on the visitor's behalf. */
const USER_LABELS: Record<string, string> = {
  scenario: 'scenario',
  user_outage: 'you: disruption',
  user_action: 'you',
  rewind: 'back in time',
};

/** Engine entry types whose name is jargon, in plain words. */
const ENGINE_LABELS: Record<string, string> = {
  supply_shock: 'output cut',
  demand_shock: 'demand changed',
  shock_ended: 'back to normal',
};

/** An event type as a label: "route reopened", "unit failed", "you: disruption". */
export function eventLabel(e: SimEvent): string {
  return USER_LABELS[e.type] ?? ENGINE_LABELS[e.type] ?? e.type.replace(/_/g, ' ');
}
