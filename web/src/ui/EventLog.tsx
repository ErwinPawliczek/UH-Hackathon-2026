// The log as a floating window, newest first, scrollable. By default it
// lists only what the visitor did: scenarios triggered, units failed from a
// site window, orders placed by hand, going back in time. Everything the
// simulation does on its own is behind two tick boxes in the title bar:
// "Consequences" (shutdowns and restarts, stockouts, failures and repairs as
// the engine logs them, routes closing and reopening, cancelled orders) and
// "Deliveries" (dispatches and deliveries, hundreds a day on the full map).
// Clicking a row selects the site it happened at.
//
// Whose entry it is comes from the entry itself: the client writes the
// visitor's actions with a negative sequence number (store/userNotes.ts);
// the engine numbers its own from zero.

import { useState } from 'react';
import type { SimEvent } from '../engine/events';
import { useSim } from '../store/sim';
import { DraggableWindow } from './DraggableWindow';
import { fmtClock } from './format';
import { eventLabel, eventMark, isRoutineEvent, isUserEvent } from './eventKinds';

export const LOG_WINDOW_ID = 'log';
/** Where the log first appears: under the top bar, left edge. */
export const LOG_WINDOW_AT = { x: 16, y: 64 };
/** Rows rendered at most — the newest; a full run logs many thousands. */
const MAX_ROWS = 300;

/** What the log shows besides the visitor's own actions. */
export interface LogFilter {
  /** what the simulation did in response: shutdowns, stockouts, repairs, routes, cancelled orders */
  consequences: boolean;
  /** dispatches and deliveries */
  deliveries: boolean;
}

/** Events to list: up to `tick`, newest first — the visitor's own always, the engine's by tick box. */
export function logRows(events: SimEvent[], tick: number, show: LogFilter, limit = MAX_ROWS): SimEvent[] {
  const rows: SimEvent[] = [];
  for (let i = events.length - 1; i >= 0 && rows.length < limit; i--) {
    const e = events[i];
    if (e.tick > tick) continue;
    if (!isUserEvent(e)) {
      if (isRoutineEvent(e) ? !show.deliveries : !show.consequences) continue;
    }
    rows.push(e);
  }
  return rows;
}

export function EventLog() {
  const events = useSim((s) => s.events);
  const tick = useSim((s) => Number(s.snap?.tick ?? 0));
  const select = useSim((s) => s.select);
  const [consequences, setConsequences] = useState(false);
  const [deliveries, setDeliveries] = useState(false);

  const rows = logRows(events, tick, { consequences, deliveries });

  return (
    <DraggableWindow
      id={LOG_WINDOW_ID}
      title="Event log"
      width={520}
      maxHeight="55vh"
      actions={
        <>
          <label className="flex cursor-pointer items-center gap-1 text-xs text-muted" title="What the simulation did in response: shutdowns and restarts, stockouts, repairs, routes, cancelled orders">
            <input
              id="log-show-consequences"
              name="log-show-consequences"
              type="checkbox"
              checked={consequences}
              onChange={(e) => setConsequences(e.target.checked)}
              data-testid="log-show-consequences"
            />
            Consequences
          </label>
          <label className="flex cursor-pointer items-center gap-1 text-xs text-muted" title="Every dispatch and delivery">
            <input
              id="log-show-routine"
              name="log-show-routine"
              type="checkbox"
              checked={deliveries}
              onChange={(e) => setDeliveries(e.target.checked)}
              data-testid="log-show-routine"
            />
            Deliveries
          </label>
        </>
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
          <li className="px-3 py-3 text-muted" data-testid="log-empty">
            {consequences || deliveries ? 'Nothing to show yet.' : 'Nothing changed by you yet.'}
          </li>
        )}
      </ul>
    </DraggableWindow>
  );
}
