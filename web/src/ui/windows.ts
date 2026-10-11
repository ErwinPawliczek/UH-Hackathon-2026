// Floating windows (the event log, analytics panels): which are open, where
// each sits, and their stacking order. Remembered for the browser session —
// a reload keeps the layout, a new tab starts clean — and kept out of the
// persisted settings, which are about the simulation, not the screen.

import { create } from 'zustand';

export interface WindowPlace {
  open: boolean;
  /** top-left corner in viewport pixels */
  x: number;
  y: number;
  /** the visitor dragged it here: this position wins over any automatic placement */
  byUser?: boolean;
}

export interface WindowsState {
  windows: Record<string, WindowPlace>;
  /** window ids, back to front */
  order: string[];
  /** Open or close a window; a window opened for the first time appears at `at`. */
  toggle: (id: string, at: { x: number; y: number }) => void;
  close: (id: string) => void;
  /** The visitor dragged the window here; it stays where they put it from now on. */
  move: (id: string, x: number, y: number) => void;
  /** Put a window somewhere without the visitor asking (clamping, automatic placement). */
  place: (id: string, x: number, y: number) => void;
  /** Bring a window to the front. */
  focus: (id: string) => void;
}

const SESSION_KEY = 'petrogrid-windows-v1';

function load(): Pick<WindowsState, 'windows' | 'order'> {
  try {
    const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(SESSION_KEY);
    if (raw === null) return { windows: {}, order: [] };
    const saved = JSON.parse(raw) as Partial<Pick<WindowsState, 'windows' | 'order'>>;
    return { windows: saved.windows ?? {}, order: saved.order ?? [] };
  } catch {
    return { windows: {}, order: [] }; // unreadable or blocked storage: start clean
  }
}

function save(state: Pick<WindowsState, 'windows' | 'order'>): void {
  try {
    if (typeof sessionStorage !== 'undefined') {
      sessionStorage.setItem(SESSION_KEY, JSON.stringify({ windows: state.windows, order: state.order }));
    }
  } catch {
    // storage full or blocked: the layout just is not remembered
  }
}

const toFront = (order: string[], id: string) => [...order.filter((w) => w !== id), id];

export const useWindows = create<WindowsState>()((set) => {
  const update = (fn: (s: WindowsState) => Pick<WindowsState, 'windows' | 'order'>) =>
    set((s) => {
      const next = fn(s);
      save(next);
      return next;
    });
  return {
    ...load(),
    toggle: (id, at) =>
      update((s) => {
        const cur = s.windows[id];
        const open = !(cur?.open ?? false);
        return {
          windows: { ...s.windows, [id]: { ...cur, x: cur?.x ?? at.x, y: cur?.y ?? at.y, open } },
          order: open ? toFront(s.order, id) : s.order,
        };
      }),
    close: (id) =>
      update((s) => {
        const cur = s.windows[id];
        if (cur === undefined) return { windows: s.windows, order: s.order };
        return { windows: { ...s.windows, [id]: { ...cur, open: false } }, order: s.order };
      }),
    // also places a window that was never toggled (one opened by a selection)
    move: (id, x, y) =>
      update((s) => ({
        windows: { ...s.windows, [id]: { open: s.windows[id]?.open ?? false, x, y, byUser: true } },
        order: s.order,
      })),
    place: (id, x, y) =>
      update((s) => ({
        windows: { ...s.windows, [id]: { open: s.windows[id]?.open ?? false, byUser: s.windows[id]?.byUser, x, y } },
        order: s.order,
      })),
    focus: (id) => update((s) => ({ windows: s.windows, order: toFront(s.order, id) })),
  };
});

/**
 * Keep a window's title bar reachable: the window stays inside the viewport
 * horizontally, below the top bar, and never drops its title bar off the
 * bottom edge.
 */
export function clampToViewport(
  x: number,
  y: number,
  width: number,
  viewport: { width: number; height: number },
  insets: { top: number; titleBar: number } = { top: 56, titleBar: 40 },
): { x: number; y: number } {
  const maxX = Math.max(0, viewport.width - width);
  const maxY = Math.max(insets.top, viewport.height - insets.titleBar);
  return {
    x: Math.min(maxX, Math.max(0, x)),
    y: Math.min(maxY, Math.max(insets.top, y)),
  };
}

// ---- placing a window that opens by itself ----
//
// A window that follows a selection (a clicked site, a clicked vehicle) opens
// where it gets in the way least: over as little of the windows already open
// as possible, and never over the thing just clicked. Once the visitor has
// dragged it somewhere, that position is kept instead.

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Area two rectangles share, in square pixels. */
export function overlapArea(a: Rect, b: Rect): number {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/** Margin kept from the viewport's sides, and the step of a cascade (a title bar's height). */
const EDGE = 16;
const TOP = 64;
const CASCADE = 44;

/**
 * Places to try for a window of `size`, in order of preference: the right
 * column under the top bar, the left column, then a cascade stepping down
 * and in from each by a title bar's height.
 */
export function placementCandidates(viewport: { width: number; height: number }, size: { w: number; h: number }): { x: number; y: number }[] {
  const right = Math.max(EDGE, viewport.width - size.w - EDGE);
  const out = [{ x: right, y: TOP }, { x: EDGE, y: TOP }];
  for (let k = 1; k <= 5; k++) {
    out.push({ x: Math.max(EDGE, right - k * CASCADE), y: TOP + k * CASCADE });
    out.push({ x: Math.min(right, EDGE + k * CASCADE), y: TOP + k * CASCADE });
  }
  // keep every candidate's title bar on screen
  return out.filter((c) => c.y <= Math.max(TOP, viewport.height - CASCADE));
}

/**
 * The candidate that covers the least of the windows already open, and not
 * the point just clicked if any other candidate avoids it. Earlier
 * candidates win ties, so an empty screen gives the first.
 */
export function bestPlacement(
  candidates: { x: number; y: number }[],
  size: { w: number; h: number },
  others: Rect[],
  avoid: { x: number; y: number } | null,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestScore = Infinity;
  for (const c of candidates) {
    const rect = { x: c.x, y: c.y, w: size.w, h: size.h };
    const covered = others.reduce((acc, o) => acc + overlapArea(rect, o), 0);
    const onClick = avoid !== null && avoid.x >= rect.x && avoid.x <= rect.x + rect.w && avoid.y >= rect.y && avoid.y <= rect.y + rect.h;
    const score = covered + (onClick ? 1e12 : 0);
    if (score < bestScore) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

/** Where the visitor last pressed, and when — so a window does not open on top of what they clicked. */
let lastPress: { x: number; y: number; at: number } | null = null;

export function notePress(x: number, y: number, at: number): void {
  lastPress = { x, y, at };
}

/** The last press if it was within `withinMs` of `now`, else null. */
export function recentPress(now: number, withinMs = 1500): { x: number; y: number } | null {
  return lastPress !== null && now - lastPress.at <= withinMs ? { x: lastPress.x, y: lastPress.y } : null;
}
