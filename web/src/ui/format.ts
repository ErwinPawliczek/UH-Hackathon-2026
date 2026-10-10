// Time and quantity formatting shared by the top bar, inspectors and timeline.

/** Tick → "D3 08:30" (96 ticks/day, 4 ticks/hour). */
export function fmtClock(tick: number): string {
  const day = Math.floor(tick / 96) + 1;
  const hour = Math.floor((tick % 96) / 4);
  const minute = Math.floor(((tick % 96) % 4) * 15);
  const hh = String(hour).padStart(2, '0');
  const mm = String(minute).padStart(2, '0');
  return `D${day} ${hh}:${mm}`;
}

/** Difference between two ticks as "+2d 06h" / "now" / "—". */
export function fmtDelta(fromTick: number, toTick: number | null): string {
  if (toTick === null) return '—';
  const dt = toTick - fromTick;
  if (dt <= 0) return 'now';
  const days = Math.floor(dt / 96);
  const hours = Math.round((dt % 96) / 4);
  if (days === 0) return `+${hours}h`;
  return `+${days}d ${String(hours).padStart(2, '0')}h`;
}

/** Hours-to-empty → days of cover ("4.2 d"); u ≈ 0 means indefinite. */
export function fmtDaysOfCover(hoursToEmpty: number): string {
  if (hoursToEmpty < 1e-6) return '—';
  return `${(hoursToEmpty / 24).toFixed(1)} d`;
}

/**
 * Days-of-cover estimate from snapshot data: hours of stock left at the
 * current draw rate. The §7.3 snapshot carries per-tank control signals
 * (fill, f, u, h), not hours-to-empty, so the UI derives cover from the
 * catalog draw. `rateFactor` is the consuming processes' current rate as a
 * fraction of design. Returns 0 when nothing draws (cover is indefinite —
 * fmtDaysOfCover renders "—").
 */
export function hoursOfCover(
  fill: number,
  capacityT: number,
  drawTph: number,
  rateFactor: number,
): number {
  if (drawTph <= 0 || rateFactor <= 1e-6) return 0;
  return (fill * capacityT) / (drawTph * rateFactor);
}

export function fmtPct(x: number): string {
  return `${Math.round(x * 100)}%`;
}
