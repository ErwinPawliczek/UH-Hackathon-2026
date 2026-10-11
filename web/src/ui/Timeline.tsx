// Timeline panel: 60-day horizon strip with event markers coloured by type,
// a playhead at the current tick, and a rolling event log beneath.

import type { SimEvent } from '../engine/events';
import { HORIZON_DAYS, TICKS_PER_DAY, useSim } from '../store/sim';
import { fmtClock } from './format';

const HORIZON_TICKS = HORIZON_DAYS * TICKS_PER_DAY;

// Alarm red is reserved for bad states (stockouts, failures, shutdowns);
// every other event is the one blue.
const CRITICAL = new Set(['stockout', 'unit_failed', 'process_shutdown']);

function markerColor(e: SimEvent): string {
  return CRITICAL.has(e.type) ? 'var(--alarm)' : 'var(--blue)';
}

export function Timeline() {
  const events = useSim((s) => s.events);
  const tick = useSim((s) => s.snap?.tick ?? 0);
  const select = useSim((s) => s.select);

  const visible = events.filter((e) => e.tick <= tick);
  const recent = [...visible].reverse().slice(0, 4);

  return (
    <footer className="panel pointer-events-auto absolute inset-x-2 bottom-2 z-10 p-3" data-testid="timeline">
      <div className="relative mb-2 h-1 w-full rounded-sm bg-line-2">
        {/* day gridlines every 10 days */}
        {Array.from({ length: HORIZON_DAYS / 10 - 1 }, (_, i) => (
          <div key={i} className="absolute top-0 h-full w-px bg-line" style={{ left: `${((i + 1) * 10 * TICKS_PER_DAY * 100) / HORIZON_TICKS}%` }} />
        ))}
        {/* event markers */}
        {visible.map((e) => (
          <button
            key={e.seq}
            title={`D${Math.floor(e.tick / 96) + 1} — ${e.text}`}
            className={`absolute bottom-0 w-1.5 cursor-pointer rounded-t-sm ${CRITICAL.has(e.type) ? 'h-5' : 'h-3'}`}
            style={{
              left: `${(e.tick * 100) / HORIZON_TICKS}%`,
              backgroundColor: markerColor(e),
            }}
            onClick={() => e.site !== undefined && select({ kind: 'site', index: e.site })}
            aria-label={`Event at ${fmtClock(e.tick)}: ${e.text}`}
          />
        ))}
        {/* playhead */}
        <div
          className="absolute -top-1 h-3 w-0.5 bg-ink"
          style={{ left: `${(Number(tick) * 100) / HORIZON_TICKS}%` }}
          data-testid="playhead"
        />
      </div>

      <div className="flex justify-between">
        {Array.from({ length: HORIZON_DAYS / 10 + 1 }, (_, i) => (
          <span key={i} className="label">D{i * 10 + 1}</span>
        ))}
      </div>

      <ul className="data mt-2 space-y-1">
        {recent.map((e) => (
          <li key={e.seq} className="flex gap-2">
            <span className="w-20 shrink-0 text-muted">{fmtClock(e.tick)}</span>
            <span className="label w-36 shrink-0">{e.type.replace(/_/g, ' ')}</span>
            <span className="truncate">{e.text}</span>
          </li>
        ))}
        {recent.length === 0 && <li className="text-muted">No events yet — advance the sim.</li>}
      </ul>
    </footer>
  );
}
