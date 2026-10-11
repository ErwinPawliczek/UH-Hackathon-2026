// One check for "this is a phone": the app's layout below this width is the
// phone layout (one Menu in the top bar, windows as bottom sheets), and at or
// above it nothing changes. The same number is the CSS breakpoint of the
// `narrow:` variant in index.css.

import { useSyncExternalStore } from 'react';
import { create } from 'zustand';

export const NARROW_PX = 700;
const QUERY = `(max-width: ${NARROW_PX - 1}px)`;

export function isNarrow(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function' && window.matchMedia(QUERY).matches;
}

/** True on a screen narrower than NARROW_PX; follows rotation and resizing. */
export function useNarrow(): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return () => undefined;
      const mq = window.matchMedia(QUERY);
      mq.addEventListener('change', onChange);
      return () => mq.removeEventListener('change', onChange);
    },
    isNarrow,
    () => false,
  );
}

/** On a phone one panel shows at a time: the id of the window that is it, and whether it fills the screen. */
export const useSheet = create<{ current: string | null; full: boolean; show: (id: string | null) => void; setFull: (full: boolean) => void }>()((set) => ({
  current: null,
  full: false,
  show: (current) => set({ current, full: false }),
  setFull: (full) => set({ full }),
}));
