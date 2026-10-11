// Pure bootstrap helpers: the legacy-namespace drop and the ?engine= override.

import { describe, expect, it } from 'vitest';
import {
  backendOverride,
  DEFAULT_WORLD,
  dropLegacyPersistedState,
  LEGACY_STORAGE_PREFIX,
  STORAGE_KEY,
  worldFromParams,
} from './bootstrap';

function memoryStorage(seed: Record<string, string> = {}) {
  const map = new Map(Object.entries(seed));
  return {
    get length(): number {
      return map.size;
    },
    key: (i: number): string | null => [...map.keys()][i] ?? null,
    getItem: (k: string): string | null => map.get(k) ?? null,
    setItem: (k: string, v: string): void => void map.set(k, v),
    removeItem: (k: string): void => void map.delete(k),
  };
}

describe('dropLegacyPersistedState', () => {
  it('drops every key under the legacy prefix and nothing else', () => {
    const storage = memoryStorage({
      'chain-reaction-v1': '{"state":{"backendKind":"stub"}}',
      'chain-reaction-scratch': 'x',
      [STORAGE_KEY]: '{"state":{"seed":7}}',
      unrelated: 'keep me',
    });

    dropLegacyPersistedState(storage);

    expect(storage.getItem('chain-reaction-v1')).toBeNull();
    expect(storage.getItem('chain-reaction-scratch')).toBeNull();
    expect(storage.getItem(STORAGE_KEY)).toBe('{"state":{"seed":7}}');
    expect(storage.getItem('unrelated')).toBe('keep me');
  });

  it('is a no-op on an empty storage', () => {
    const storage = memoryStorage();
    dropLegacyPersistedState(storage);
    expect(storage.length).toBe(0);
  });

  it('defaults to the chain-reaction- prefix constant', () => {
    const storage = memoryStorage({ [`${LEGACY_STORAGE_PREFIX}v1`]: 'old' });
    dropLegacyPersistedState(storage);
    expect(storage.length).toBe(0);
  });
});

describe('backendOverride', () => {
  it.each([
    ['', null],
    ['?engine=stub', 'stub'],
    ['?engine=http', 'http'],
    ['?engine=weird', null],
    ['?other=1', null],
  ] as const)('maps %s to %s', (search, expected) => {
    expect(backendOverride(new URLSearchParams(search))).toBe(expected);
  });

  it('reads the engine parameter among other parameters', () => {
    expect(backendOverride(new URLSearchParams('?foo=bar&engine=stub'))).toBe('stub');
  });
});

describe('worldFromParams', () => {
  it('defaults to the hand-drawn map', () => {
    expect(worldFromParams(new URLSearchParams(''))).toBe(DEFAULT_WORLD);
    expect(DEFAULT_WORLD).toBe('erwin-world-v1');
  });

  it('reads the world parameter', () => {
    expect(worldFromParams(new URLSearchParams('world=sixsite'))).toBe('sixsite');
    expect(worldFromParams(new URLSearchParams('engine=http&world=my-map-2'))).toBe('my-map-2');
  });

  it('ignores anything that is not a world name', () => {
    expect(worldFromParams(new URLSearchParams('world=../etc/passwd'))).toBe(DEFAULT_WORLD);
    expect(worldFromParams(new URLSearchParams('world=Six Site'))).toBe(DEFAULT_WORLD);
    expect(worldFromParams(new URLSearchParams('world='))).toBe(DEFAULT_WORLD);
  });
});
