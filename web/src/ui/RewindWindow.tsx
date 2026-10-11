// "Back in time": a floating window that takes the run back to a moment it
// has already been through. A scrubber runs from day 1 00:00 to now in
// one-hour steps, with a marker for every notable event (shutdowns,
// stockouts, repairs, triggered scenarios — no deliveries); the event rows
// below jump the scrubber to just before each one. Confirming rewinds the
// engine session to that tick: everything after it, including scenarios
// triggered since, never happened, and the run waits there paused.
//
// The run pauses while the window is open, and resumes on closing without
// going back if it was running before.

import { useEffect, useRef, useState } from 'react';
import type { SimEvent } from '../engine/events';
import { TICKS_PER_DAY, useSim } from '../store/sim';
import { DraggableWindow } from './DraggableWindow';
import { eventLabel, eventMark, notableEvents } from './eventKinds';
import { fmtClock } from './format';
import { useWindows } from './windows';

export const REWIND_WINDOW_ID = 'rewind';
/** Where the window first appears: under the top bar, a little in from the left. */
export const REWIND_WINDOW_AT = { x: 96, y: 72 };

const TICKS_PER_HOUR = TICKS_PER_DAY / 24;
/** Event rows listed at most — the newest. */
const MAX_ROWS = 60;

/** The latest whole hour at or before `tick`, as a tick. */
export function hourAtOrBefore(tick: number): number {
  return Math.max(0, Math.floor(tick / TICKS_PER_HOUR) * TICKS_PER_HOUR);
}

/**
 * The moment to go back to in order to be just before an event: the hour
 * mark before its tick. A triggered scenario's note sits on the tick the
 * command was given at, and the engine forgets commands given at the rewind
 * tick or later, so its own hour mark already undoes it.
 */
export function momentBefore(e: SimEvent): number {
  return hourAtOrBefore(e.type === 'scenario' ? e.tick : e.tick - 1);
}

/** "Day 12, 06:00" for a tick. */
export function fmtMoment(tick: number): string {
  const day = Math.floor(tick / TICKS_PER_DAY) + 1;
  const minutes = (tick % TICKS_PER_DAY) * (1440 / TICKS_PER_DAY);
  const hh = String(Math.floor(minutes / 60)).padStart(2, '0');
  const mm = String(Math.round(minutes % 60)).padStart(2, '0');
  return `Day ${day}, ${hh}:${mm}`;
}

/** "3 days 4 hours ago" for a span in ticks; "now" for none. */
export function fmtAgo(ticks: number): string {
  const hours = Math.round(ticks / TICKS_PER_HOUR);
  if (hours <= 0) return 'now';
  const d = Math.floor(hours / 24);
  const h = hours % 24;
  const parts: string[] = [];
  if (d > 0) parts.push(`${d} day${d === 1 ? '' : 's'}`);
  if (h > 0) parts.push(`${h} hour${h === 1 ? '' : 's'}`);
  return `${parts.join(' ')} ago`;
}

export function RewindWindow() {
  const open = useWindows((s) => s.windows[REWIND_WINDOW_ID]?.open === true);
  const now = useSim((s) => Number(s.snap?.tick ?? 0));
  const events = useSim((s) => s.events);
  const rewindTo = useSim((s) => s.rewindTo);

  const [pick, setPick] = useState(0);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [pausedIt, setPausedIt] = useState(false);
  const wasPlaying = useRef(false);
  const wentBack = useRef(false);

  // Opening pauses the run; closing without going back resumes it if it was running.
  useEffect(() => {
    if (!open) return;
    const sim = useSim.getState();
    wasPlaying.current = sim.playing;
    wentBack.current = false;
    setPausedIt(sim.playing);
    setFailure(null);
    if (sim.playing) useSim.setState({ playing: false });
    // start a day back (or at the beginning of a shorter run)
    setPick(hourAtOrBefore(Math.max(0, Number(sim.snap?.tick ?? 0) - TICKS_PER_DAY)));
    return () => {
      if (wasPlaying.current && !wentBack.current) useSim.setState({ playing: true });
    };
  }, [open]);

  if (!open) return null;

  const latest = hourAtOrBefore(now);
  const chosen = Math.min(pick, latest);
  const marks = notableEvents(events, now);
  const rows = [...marks].reverse().slice(0, MAX_ROWS);
  const canGo = rewindTo !== null && !busy && chosen < now;

  const goBack = async () => {
    if (rewindTo === null) return;
    setBusy(true);
    setFailure(null);
    try {
      await rewindTo(chosen);
      wentBack.current = true; // stay paused there: Resume is the next move
      useWindows.getState().close(REWIND_WINDOW_ID);
    } catch (err) {
      setFailure(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <DraggableWindow id={REWIND_WINDOW_ID} title="Back in time" width={480} maxHeight="70vh">
      <div className="flex flex-col gap-3 p-3 text-xs" data-testid="rewind-body">
        <p className="text-muted" data-testid="rewind-paused-note">
          {pausedIt
            ? 'The run is paused while this window is open; closing it without going back resumes it.'
            : 'The run is paused.'}
        </p>

        <div>
          <p className="data text-base text-ink" data-testid="rewind-readout">
            {fmtMoment(chosen)}
            <span className="ml-2 text-xs text-muted">{fmtAgo(now - chosen)}</span>
          </p>
          <p className="text-muted">Now: {fmtMoment(now)}</p>
        </div>

        <div className="relative pt-3">
          {/* event markers above the track, at their place between day 1 and now */}
          {marks.map((e) => {
            const mark = eventMark(e);
            return (
              <span
                key={e.seq}
                title={`${fmtClock(e.tick)} — ${e.text}`}
                className={mark.shape === 'diamond'
                  ? 'absolute top-0.5 h-2 w-2 -translate-x-1/2 rotate-45'
                  : 'absolute top-0 h-2.5 w-1 -translate-x-1/2 rounded-sm'}
                style={{
                  left: `${latest > 0 ? Math.min(100, (e.tick * 100) / latest) : 0}%`,
                  backgroundColor: mark.color,
                }}
              />
            );
          })}
          <input
            id="rewind-scrubber"
            name="rewind-scrubber"
            type="range"
            className="block w-full"
            min={0}
            max={Math.max(latest, TICKS_PER_HOUR)}
            step={TICKS_PER_HOUR}
            value={chosen}
            disabled={latest === 0}
            onChange={(e) => setPick(Number(e.target.value))}
            aria-label="Moment to go back to"
            aria-valuetext={`${fmtMoment(chosen)}, ${fmtAgo(now - chosen)}`}
            data-testid="rewind-scrubber"
          />
          <div className="flex justify-between text-muted">
            <span>Day 1, 00:00</span>
            <span>now</span>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <button
            className="btn btn-primary"
            disabled={!canGo}
            onClick={() => void goBack()}
            data-testid="rewind-confirm"
          >
            {busy ? 'Going back…' : 'Go back to this moment'}
          </button>
          <span className="text-muted">Everything after it is discarded.</span>
        </div>
        {failure !== null && (
          <p className="rounded-sm border border-alarm/50 bg-alarm/10 px-2 py-1 text-alarm" role="alert" data-testid="rewind-error">
            Could not go back: {failure}
          </p>
        )}

        <div>
          <p className="label mb-1">Go to just before an event</p>
          <div
            className="chamfer chamfer-sm"
            style={{ '--chamfer-fill': 'var(--white)', '--chamfer-line': 'var(--line)' } as React.CSSProperties}
          >
            <ul className="chamfer-body data divide-y divide-line" data-testid="rewind-events">
            {rows.map((e) => (
              <li key={e.seq}>
                <button
                  className={`flex w-full cursor-pointer items-baseline gap-2 px-2 py-1.5 text-left hover:bg-panel-2 ${momentBefore(e) === chosen ? 'bg-blue-soft' : ''}`}
                  onClick={() => setPick(momentBefore(e))}
                >
                  <span className="w-20 shrink-0 text-muted">{fmtClock(e.tick)}</span>
                  <span className="label flex w-32 shrink-0 items-center gap-1.5" style={{ color: eventMark(e).color === 'var(--alarm)' ? 'var(--alarm)' : undefined }}>
                    {eventMark(e).shape === 'diamond' && (
                      <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rotate-45" style={{ backgroundColor: eventMark(e).color }} />
                    )}
                    {eventLabel(e)}
                  </span>
                  <span className="min-w-0 flex-1 break-words">{e.text}</span>
                </button>
              </li>
            ))}
            {rows.length === 0 && <li className="px-2 py-2 text-muted">Nothing but routine deliveries so far.</li>}
            </ul>
          </div>
        </div>
      </div>
    </DraggableWindow>
  );
}
