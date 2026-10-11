// How much of the plant names the map shows: names and icons, icons only, or
// nothing. Names get big next to a zoomed-out map, so the visitor can step
// them down. Remembered for the session; on by default.
//
// The choice is published as `data-names` on the document root and the
// labels are restyled by CSS (index.css), so nothing in the scene has to
// listen: "icons" hides each label's name and leaves the badge, which stays
// the click target and keeps its state colours; "hidden" hides the labels
// and the pipeline names with them.

import { create } from 'zustand';

export type NamesMode = 'full' | 'icons' | 'hidden';
export const NAMES_ORDER: readonly NamesMode[] = ['full', 'icons', 'hidden'];
const KEY = 'petrogrid-names-v1';

/** The next mode in the cycle: names and icons, icons only, hidden, and round again. */
export function nextNamesMode(mode: NamesMode): NamesMode {
  return NAMES_ORDER[(NAMES_ORDER.indexOf(mode) + 1) % NAMES_ORDER.length];
}

/** What the button says for a mode. */
export const NAMES_LABEL: Record<NamesMode, string> = { full: 'Names: on', icons: 'Names: icons', hidden: 'Names: off' };

function load(): NamesMode {
  try {
    const raw = typeof sessionStorage === 'undefined' ? null : sessionStorage.getItem(KEY);
    return raw === 'icons' || raw === 'hidden' ? raw : 'full';
  } catch {
    return 'full';
  }
}

function publish(mode: NamesMode): void {
  if (typeof document !== 'undefined') document.documentElement.dataset.names = mode;
  try {
    if (typeof sessionStorage !== 'undefined') sessionStorage.setItem(KEY, mode);
  } catch {
    // blocked storage: the choice lasts until the page is closed
  }
}

export const useNamesMode = create<{ mode: NamesMode; cycle: () => void }>()((set, get) => {
  const mode = load();
  publish(mode);
  return {
    mode,
    cycle: () => {
      const next = nextNamesMode(get().mode);
      publish(next);
      set({ mode: next });
    },
  };
});
