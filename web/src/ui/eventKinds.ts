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
