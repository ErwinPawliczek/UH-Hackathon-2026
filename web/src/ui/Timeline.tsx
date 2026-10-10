// Timeline panel: 60-day horizon strip with event markers coloured by type,
// a playhead at the current tick, and a rolling event log beneath.

import type { SimEvent } from '../engine/events';
import { HORIZON_DAYS, TICKS_PER_DAY, useSim } from '../store/sim';
import { fmtClock } from './format';

const HORIZON_TICKS = HORIZON_DAYS * TICKS_PER_DAY;

function eventHue(e: SimEvent): number {
  let h = 0;
  for (let i = 0; i < e.type.length; i++) h = (h * 31 + e.type.charCodeAt(i)) >>> 0;
  return h % 360;
}

const CRITICAL = new Set(['stockout', 'unit_failed', 'process_shutdown']);

export function Timeline() {
  const events = useSim((s) => s.events);
  const tick = useSim((s) => s.snap?.tick ?? 0);
  const select = useSim((s) => s.select);

  const visible = events.filter((e) => e.tick <= tick);
  const recent = [...visible].reverse().slice(0, 4);

  return (
    <footer className="panel pointer-events-auto absolute inset-x-2 bottom-2 z-10 p-3" data-testid="timeline">
      <div className="relative mb-1 h-1 w-full rounded bg-slate-700">
        {/* day gridlines every 10 days */}
        {Array.from({ length: HORIZON_DAYS / 10 - 1 }, (_, i) => (
          <div key={i} className="absolute top-0 h-full w-px bg-slate-600" style={{ left: `${((i + 1) * 10 * TICKS_PER_DAY * 100) / HORIZON_TICKS}%` }} />
        ))}
        {/* event markers */}
        {visible.map((e) => (
          <button
            key={e.seq}
            title={`D${Math.floor(e.tick / 96) + 1} — ${e.text}`}
            className={`absolute bottom-0 w-1.5 cursor-pointer rounded-t ${CRITICAL.has(e.type) ? 'h-5' : 'h-3'}`}
            style={{
              left: `${(e.tick * 100) / HORIZON_TICKS}%`,
              backgroundColor: `hsl(${eventHue(e)} 70% 60%)`,
            }}
            onClick={() => e.site !== undefined && select({ kind: 'site', index: e.site })}
            aria-label={`Event at ${fmtClock(e.tick)}: ${e.text}`}
          />
        ))}
        {/* playhead */}
        <div
          className="absolute -top-1 h-3 w-0.5 bg-white"
          style={{ left: `${(Number(tick) * 100) / HORIZON_TICKS}%` }}
          data-testid="playhead"
        />
      </div>

      <div className="flex justify-between text-[10px] text-slate-500">
        {Array.from({ length: HORIZON_DAYS / 10 + 1 }, (_, i) => (
          <span key={i}>D{i * 10 + 1}</span>
        ))}
      </div>

      <ul className="mt-2 space-y-0.5 text-xs text-slate-300">
        {recent.map((e) => (
          <li key={e.seq} className="flex gap-2">
            <span className="w-16 shrink-0 font-mono text-slate-500">{fmtClock(e.tick)}</span>
            <span className="w-28 shrink-0 text-slate-500">{e.type.replace(/_/g, ' ')}</span>
            <span className="truncate">{e.text}</span>
          </li>
        ))}
        {recent.length === 0 && <li className="text-slate-500">No events yet — advance the sim.</li>}
      </ul>
    </footer>
  );
}
