// The map builder's hand-over to the app (EDITOR-CONTRACT.md). The editor at
// /editor/ keeps the layout being drawn in localStorage under
// `petrogrid-layout-v2`; its "Run this world" sets `petrogrid-run-custom` to
// "1" and comes back here. When both are there the app creates its session
// with that layout; "Default world" clears the flag and the app runs the
// built-in map again. The layout itself is left alone, so the editor still
// opens on it.

export const LAYOUT_KEY = 'petrogrid-layout-v2';
export const RUN_CUSTOM_KEY = 'petrogrid-run-custom';
/** Where the map builder lives. */
export const EDITOR_PATH = '/editor/';

type Store = Pick<Storage, 'getItem' | 'removeItem'>;

const browserStore = (): Store | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null; // storage blocked: there is no custom map to run
  }
};

/**
 * The layout to run, or null for the default world: the stored layout, when
 * the editor asked for it to be run and what is stored is a JSON object.
 */
export function customLayout(store: Store | null = browserStore()): Record<string, unknown> | null {
  if (store === null) return null;
  try {
    if (store.getItem(RUN_CUSTOM_KEY) !== '1') return null;
    const raw = store.getItem(LAYOUT_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null; // unreadable layout: run the default world rather than nothing
  }
}

/** Go back to the default world: the next session is created without a layout. */
export function leaveCustomMap(store: Store | null = browserStore()): void {
  try {
    store?.removeItem(RUN_CUSTOM_KEY);
  } catch {
    // nothing to clear
  }
}
