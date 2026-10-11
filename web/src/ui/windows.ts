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
}

export interface WindowsState {
  windows: Record<string, WindowPlace>;
  /** window ids, back to front */
  order: string[];
  /** Open or close a window; a window opened for the first time appears at `at`. */
  toggle: (id: string, at: { x: number; y: number }) => void;
  close: (id: string) => void;
  move: (id: string, x: number, y: number) => void;
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
          windows: { ...s.windows, [id]: { x: cur?.x ?? at.x, y: cur?.y ?? at.y, open } },
          order: open ? toFront(s.order, id) : s.order,
        };
      }),
    close: (id) =>
      update((s) => {
        const cur = s.windows[id];
        if (cur === undefined) return { windows: s.windows, order: s.order };
        return { windows: { ...s.windows, [id]: { ...cur, open: false } }, order: s.order };
      }),
    move: (id, x, y) =>
      update((s) => {
        const cur = s.windows[id];
        if (cur === undefined) return { windows: s.windows, order: s.order };
        return { windows: { ...s.windows, [id]: { ...cur, x, y } }, order: s.order };
      }),
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
