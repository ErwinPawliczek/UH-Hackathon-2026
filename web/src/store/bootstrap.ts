// App bootstrap inputs: the persisted-settings namespace and the one URL
// parameter that can still pick a backend. Both are resolved before the
// persist middleware hydrates, so a visitor's first paint already runs the
// right engine.

import type { BackendKind } from '../engine/api';

/** Current persisted-settings key. */
export const STORAGE_KEY = 'petrogrid-v1';

/** Abandoned namespace of the stub-default era; dropped, never read. */
export const LEGACY_STORAGE_PREFIX = 'chain-reaction-';

/**
 * Drop every key under the abandoned `chain-reaction-` namespace.
 *
 * Visitors saved there picked a backend when the app booted on the in-page
 * stub; a stored `backendKind: 'stub'` must not stick now that the default is
 * the hosted engine. Rather than interpret the old shape we discard it: those
 * visitors start fresh on the hosted engine with default settings. A no-op
 * when nothing legacy is stored.
 */
export function dropLegacyPersistedState(
  storage: Pick<Storage, 'length' | 'key' | 'getItem' | 'removeItem'>,
  prefix: string = LEGACY_STORAGE_PREFIX,
): void {
  // Collect first: removing while iterating reindexes Storage.key(i).
  const doomed: string[] = [];
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i);
    if (key !== null && key.startsWith(prefix)) doomed.push(key);
  }
  for (const key of doomed) storage.removeItem(key);
}

/**
 * Backend picked by the `?engine=` URL parameter, or null when absent or
 * unknown (the hosted-engine default applies). The in-page stub is a test and
 * local-development artifact: this parameter is its only selector — there is
 * no UI for engine choice.
 */
export function backendOverride(params: URLSearchParams): BackendKind | null {
  const value = params.get('engine');
  return value === 'stub' || value === 'http' ? value : null;
}
