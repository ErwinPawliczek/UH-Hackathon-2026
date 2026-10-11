// Store boot integration: a fresh visitor lands on the hosted engine, the
// ?engine= parameter selects the stub for tests and local development, and a
// visitor saved in the legacy chain-reaction-* namespace (stub was the
// default then) starts fresh instead of sticking on the stub. Each case
// re-imports the store module because its bootstrap runs at module load.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { STORAGE_KEY, LEGACY_STORAGE_PREFIX } from './bootstrap';

type SimModule = typeof import('./sim');

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

const globals = globalThis as Record<string, unknown>;
let storage: ReturnType<typeof memoryStorage>;

beforeEach(() => {
  vi.resetModules();
  storage = memoryStorage();
  globals.localStorage = storage;
  globals.window = { localStorage: storage };
  delete globals.location;
});

/** Import the store fresh, then let the (synchronous) persist hydration settle. */
async function importStore(): Promise<SimModule> {
  const mod = (await import('./sim')) as SimModule;
  await new Promise((resolve) => setTimeout(resolve, 0));
  return mod;
}

describe('store boot', () => {
  it('boots a first-time visitor on the hosted engine', async () => {
    const { useSim } = await importStore();
    expect(useSim.getState().backendKind).toBe('http');
  });

  it('selects the in-page stub via ?engine=stub', async () => {
    globals.location = { search: '?engine=stub' };
    const { useSim } = await importStore();
    expect(useSim.getState().backendKind).toBe('stub');
  });

  it('keeps the hosted engine the default for unknown ?engine values', async () => {
    globals.location = { search: '?engine=weird' };
    const { useSim } = await importStore();
    expect(useSim.getState().backendKind).toBe('http');
  });

  it('does not stick a visitor saved in the legacy namespace on the stub', async () => {
    storage.setItem(
      'chain-reaction-v1',
      JSON.stringify({
        state: { backendKind: 'stub', baseUrl: '', seed: 42, scenario: 'none', speed: 16 },
        version: 0,
      }),
    );
    const { useSim } = await importStore();
    expect(useSim.getState().backendKind).toBe('http');
    expect(storage.getItem('chain-reaction-v1')).toBeNull();
  });

  it('drops other legacy-namespace keys consistently', async () => {
    storage.setItem(`${LEGACY_STORAGE_PREFIX}scratch`, 'old');
    const { useSim } = await importStore();
    expect(useSim.getState().backendKind).toBe('http');
    expect(storage.getItem(`${LEGACY_STORAGE_PREFIX}scratch`)).toBeNull();
  });

  it('honours settings already saved under the current key', async () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { seed: 7, scenario: 'none', speed: 64 }, version: 1 }),
    );
    const { useSim } = await importStore();
    expect(useSim.getState().seed).toBe(7);
    expect(useSim.getState().speed).toBe(64);
    // The backend kind is deliberately absent from the persisted shape.
    expect(useSim.getState().backendKind).toBe('http');
  });

  it('resets a speed saved before 1× became the default, and keeps the rest', async () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { seed: 7, scenario: 'none', speed: 16 }, version: 0 }),
    );
    const { useSim } = await importStore();
    expect(useSim.getState().seed).toBe(7);
    expect(useSim.getState().speed).toBe(1);
  });

  it('starts at 1× and offers 0.5×, 1×, 4×, 16× and 64×', async () => {
    const { useSim, SPEEDS } = await importStore();
    expect(useSim.getState().speed).toBe(1);
    expect([...SPEEDS]).toEqual([0.5, 1, 4, 16, 64]);
  });

  it('0.5× is one tick every 500 ms; every other speed steps every 250 ms', async () => {
    const { useSim, SPEEDS, ticksPerStep, stepIntervalFor } = await importStore();
    expect(SPEEDS.map((s) => [ticksPerStep(s), stepIntervalFor(s)])).toEqual([
      [1, 500], [1, 250], [4, 250], [16, 250], [64, 250],
    ]);
    // the store's interval follows the speed setting at once
    expect(useSim.getState().stepIntervalMs).toBe(250);
    useSim.getState().setSpeed(0.5);
    expect(useSim.getState().stepIntervalMs).toBe(500);
    useSim.getState().setSpeed(16);
    expect(useSim.getState().stepIntervalMs).toBe(250);
  });

  it('a saved 0.5× comes back with its 500 ms interval', async () => {
    storage.setItem(
      STORAGE_KEY,
      JSON.stringify({ state: { seed: 7, scenario: 'none', speed: 0.5 }, version: 1 }),
    );
    const { useSim } = await importStore();
    expect(useSim.getState().speed).toBe(0.5);
    expect(useSim.getState().stepIntervalMs).toBe(500);
  });

  it('opens paused and not started; the first play starts the run', async () => {
    const { useSim } = await importStore();
    expect(useSim.getState().started).toBe(false);
    expect(useSim.getState().playing).toBe(false);
    useSim.getState().togglePlay();
    expect(useSim.getState().started).toBe(true);
    expect(useSim.getState().playing).toBe(true);
    useSim.getState().togglePlay(); // pause: still a started run
    expect(useSim.getState().started).toBe(true);
    expect(useSim.getState().playing).toBe(false);
  });

  it('persists only the user-facing settings', async () => {
    const { useSim } = await importStore();
    useSim.getState().setSeed(9);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const persisted = JSON.parse(storage.getItem(STORAGE_KEY) ?? '{}') as {
      state: Record<string, unknown>;
    };
    expect(persisted.state).toEqual({ seed: 9, scenario: 'none', speed: 1 });
  });
});
