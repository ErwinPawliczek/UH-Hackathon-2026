// The speed control: one hexagon reading "Speed: 1" whose number is an
// editable field. The number is simulated hours per real second (1 is the
// default); any value from MIN_SPEED to MAX_SPEED is allowed, to one decimal.
//
// Click or tab to the number to edit — the whole value is selected, so typing
// replaces it. Enter or leaving the field applies it; Escape restores what it
// was; ArrowUp/ArrowDown nudge it (by 0.1 below 1, by 1 from 1 up). An empty
// or unreadable entry restores the previous value, and an out-of-range one is
// clamped and shown clamped.

import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { MAX_SPEED, MIN_SPEED, clampSpeed, useSim } from '../store/sim';

/** A speed as the field shows it: no trailing ".0". */
export function formatSpeed(speed: number): string {
  return String(Math.round(speed * 10) / 10);
}

/**
 * The speed a typed entry means, clamped to the allowed range; null when the
 * entry is empty or not a number (a decimal comma is accepted).
 */
export function parseSpeed(text: string): number | null {
  const cleaned = text.trim().replace(',', '.');
  if (cleaned === '' || !/^\d*\.?\d*$/.test(cleaned) || cleaned === '.') return null;
  return clampSpeed(Number(cleaned));
}

/** One arrow-key nudge: steps of 0.1 below 1, of 1 from 1 up, within the range. */
export function nudgeSpeed(speed: number, dir: 1 | -1): number {
  const next = dir > 0 ? (speed < 1 ? speed + 0.1 : speed + 1) : speed <= 1 ? speed - 0.1 : Math.max(1, speed - 1);
  return clampSpeed(next) ?? speed;
}

export function SpeedControl() {
  const speed = useSim((s) => s.speed);
  const setSpeed = useSim((s) => s.setSpeed);
  // null while not editing: the field then shows the store's value
  const [draft, setDraft] = useState<string | null>(null);
  // Escape leaves the field too, and that blur must not apply what was typed.
  const cancelled = useRef(false);
  const [rejected, setRejected] = useState(false);

  const apply = (text: string) => {
    const parsed = parseSpeed(text);
    if (parsed !== null) setSpeed(parsed);
    else if (text.trim() !== '') {
      // not a speed: the previous value stands, and the field flashes so the visitor sees it was refused
      setRejected(true);
      window.setTimeout(() => setRejected(false), 900);
    }
    setDraft(null);
  };

  const onKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      apply(e.currentTarget.value);
      e.currentTarget.select();
    } else if (e.key === 'Escape') {
      e.stopPropagation(); // do not also clear the map selection
      cancelled.current = true;
      setDraft(null);
      e.currentTarget.blur();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const from = parseSpeed(e.currentTarget.value) ?? speed;
      setSpeed(nudgeSpeed(from, e.key === 'ArrowUp' ? 1 : -1));
      setDraft(null);
    }
  };

  return (
    <label className={`btn btn-field ${rejected ? 'btn-field-rejected' : ''}`} data-rejected={rejected ? 'true' : undefined} data-testid="speed-control" title={`Simulated hours per second, ${MIN_SPEED} to ${MAX_SPEED}`}>
      <span>Speed:</span>
      <input
        id="speed-input"
        name="speed"
        type="text"
        inputMode="decimal"
        autoComplete="off"
        value={draft ?? formatSpeed(speed)}
        onFocus={(e) => e.currentTarget.select()}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={(e) => {
          if (cancelled.current) cancelled.current = false;
          else apply(e.currentTarget.value);
        }}
        onKeyDown={onKeyDown}
        aria-invalid={rejected ? true : undefined}
        aria-label={`Speed, simulated hours per second, ${MIN_SPEED} to ${MAX_SPEED}`}
        data-testid="speed-input"
      />
    </label>
  );
}
