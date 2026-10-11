// Timeline strip: the 60-day horizon with a marker per notable event and a
// playhead at the current tick. The event text lives in the Event log window
// (top bar → Log); routine dispatches and deliveries get no marker — there
// are hundreds a day on the full map.

import type { SimEvent } from '../engine/events';
import { HORIZON_DAYS, TICKS_PER_DAY, useSim } from '../store/sim';
import { CRITICAL_EVENTS, isRoutineEvent } from './eventKinds';
import { fmtClock } from './format';

const HORIZON_TICKS = HORIZON_DAYS * TICKS_PER_DAY;

// Alarm red is reserved for bad states (stockouts, failures, shutdowns);
// every other event is the one blue.
function markerColor(e: SimEvent): string {
  return CRITICAL_EVENTS.has(e.type) ? 'var(--alarm)' : 'var(--blue)';
}

/** Events that get a marker on the strip: everything notable up to `tick`. */
export function timelineMarkers(events: SimEvent[], tick: number): SimEvent[] {
  return events.filter((e) => e.tick <= tick && !isRoutineEvent(e));
}

export function Timeline() {
  const events = useSim((s) => s.events);
  const tick = useSim((s) => s.snap?.tick ?? 0);
  const select = useSim((s) => s.select);

  const markers = timelineMarkers(events, Number(tick));

  return (
    <footer className="panel pointer-events-auto absolute inset-x-2 bottom-2 z-10 px-3 pb-2 pt-4" data-testid="timeline">
      <div className="relative mb-2 h-1 w-full rounded-sm bg-line-2">
        {/* day gridlines every 10 days */}
        {Array.from({ length: HORIZON_DAYS / 10 - 1 }, (_, i) => (
          <div key={i} className="absolute top-0 h-full w-px bg-line" style={{ left: `${((i + 1) * 10 * TICKS_PER_DAY * 100) / HORIZON_TICKS}%` }} />
        ))}
        {/* event markers */}
        {markers.map((e) => (
          <button
            key={e.seq}
            title={`D${Math.floor(e.tick / 96) + 1} — ${e.text}`}
            className={`absolute bottom-0 w-1.5 cursor-pointer rounded-t-sm ${CRITICAL_EVENTS.has(e.type) ? 'h-3' : 'h-2'}`}
            style={{
              left: `${Math.min(100, (e.tick * 100) / HORIZON_TICKS)}%`,
              backgroundColor: markerColor(e),
            }}
            onClick={() => e.site !== undefined && select({ kind: 'site', index: e.site })}
            aria-label={`Event at ${fmtClock(e.tick)}: ${e.text}`}
          />
        ))}
        {/* playhead */}
        <div
          className="absolute -top-1 h-3 w-0.5 bg-ink"
          style={{ left: `${Math.min(100, (Number(tick) * 100) / HORIZON_TICKS)}%` }}
          data-testid="playhead"
        />
      </div>

      <div className="flex justify-between">
        {Array.from({ length: HORIZON_DAYS / 10 + 1 }, (_, i) => (
          <span key={i} className="label">D{i * 10 + 1}</span>
        ))}
      </div>
    </footer>
  );
}
