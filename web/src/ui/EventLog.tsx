// The event log as a floating window: every logged event up to the current
// tick, newest first, scrollable. Routine logistics (dispatches and
// deliveries, hundreds a day on the full map) are hidden unless asked for,
// so disruptions, shutdowns and restarts are what the log shows by default.
// Clicking a row selects the site it happened at.

import { useState } from 'react';
import type { SimEvent } from '../engine/events';
import { useSim } from '../store/sim';
import { DraggableWindow } from './DraggableWindow';
import { fmtClock } from './format';
import { eventLabel, eventMark, isRoutineEvent } from './eventKinds';

export const LOG_WINDOW_ID = 'log';
/** Where the log first appears: under the top bar, left edge. */
export const LOG_WINDOW_AT = { x: 16, y: 64 };
/** Rows rendered at most — the newest; a full run logs many thousands. */
const MAX_ROWS = 300;

/** Events to list: up to `tick`, newest first, routine ones only when asked for. */
export function logRows(events: SimEvent[], tick: number, showRoutine: boolean, limit = MAX_ROWS): SimEvent[] {
  const rows: SimEvent[] = [];
  for (let i = events.length - 1; i >= 0 && rows.length < limit; i--) {
    const e = events[i];
    if (e.tick > tick) continue;
    if (!showRoutine && isRoutineEvent(e)) continue;
    rows.push(e);
  }
  return rows;
}

export function EventLog() {
  const events = useSim((s) => s.events);
  const tick = useSim((s) => Number(s.snap?.tick ?? 0));
  const select = useSim((s) => s.select);
  const [showRoutine, setShowRoutine] = useState(false);

  const rows = logRows(events, tick, showRoutine);

  return (
    <DraggableWindow
      id={LOG_WINDOW_ID}
      title="Event log"
      width={520}
      maxHeight="55vh"
      actions={
        <label className="flex cursor-pointer items-center gap-1 text-xs text-muted">
          <input
            id="log-show-routine"
            name="log-show-routine"
            type="checkbox"
            checked={showRoutine}
            onChange={(e) => setShowRoutine(e.target.checked)}
            data-testid="log-show-routine"
          />
          Deliveries
        </label>
      }
    >
      <ul className="data divide-y divide-line" data-testid="event-log">
        {rows.map((e) => (
          <li key={e.seq}>
            <button
              className="flex w-full cursor-pointer items-baseline gap-2 px-3 py-1.5 text-left hover:bg-panel-2"
              onClick={() => e.site !== undefined && select({ kind: 'site', index: e.site })}
            >
              <span className="w-20 shrink-0 text-muted">{fmtClock(e.tick)}</span>
              <span className="label flex w-36 shrink-0 items-center gap-1.5" style={{ color: eventMark(e).color === 'var(--alarm)' ? 'var(--alarm)' : undefined }}>
                {eventMark(e).shape === 'diamond' && (
                  <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rotate-45" style={{ backgroundColor: eventMark(e).color }} />
                )}
                {eventLabel(e)}
              </span>
              <span className="min-w-0 flex-1 break-words">{e.text}</span>
            </button>
          </li>
        ))}
        {rows.length === 0 && (
          <li className="px-3 py-3 text-muted">
            {showRoutine ? 'No events yet.' : 'Nothing but routine deliveries so far.'}
          </li>
        )}
      </ul>
    </DraggableWindow>
  );
}
