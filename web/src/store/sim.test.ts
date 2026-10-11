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

  it('starts at speed 1 and clamps whatever is set to 0.1–64, one decimal', async () => {
    const { useSim, clampSpeed, MIN_SPEED, MAX_SPEED } = await importStore();
    expect(useSim.getState().speed).toBe(1);
    expect([MIN_SPEED, MAX_SPEED]).toEqual([0.1, 64]);
    expect(clampSpeed(0)).toBe(0.1);
    expect(clampSpeed(-3)).toBe(0.1);
    expect(clampSpeed(0.04)).toBe(0.1);
    expect(clampSpeed(1.26)).toBe(1.3);
    expect(clampSpeed(64)).toBe(64);
    expect(clampSpeed(500)).toBe(64);
    expect(clampSpeed(NaN)).toBeNull();
    useSim.getState().setSpeed(1000);
    expect(useSim.getState().speed).toBe(64);
    useSim.getState().setSpeed(NaN); // not a number: the previous value stands
    expect(useSim.getState().speed).toBe(64);
  });

  it('steps every 250 ms from speed 1 up and stretches the interval below it', async () => {
    const { useSim, stepIntervalFor } = await importStore();
    expect([0.1, 0.5, 1, 1.5, 4, 64].map(stepIntervalFor)).toEqual([2500, 500, 250, 250, 250, 250]);
    // the store's interval follows the speed setting at once
    expect(useSim.getState().stepIntervalMs).toBe(250);
    useSim.getState().setSpeed(0.5);
    expect(useSim.getState().stepIntervalMs).toBe(500);
    useSim.getState().setSpeed(16);
    expect(useSim.getState().stepIntervalMs).toBe(250);
  });

  it('carries fractional ticks so the average is the speed itself', async () => {
    const { nextStep } = await importStore();
    const run = (speed: number, steps: number) => {
      let carry = 0;
      const out: number[] = [];
      for (let i = 0; i < steps; i++) {
        const step = nextStep(speed, carry);
        carry = step.carry;
        out.push(step.ticks);
      }
      return out;
    };
    expect(run(1, 4)).toEqual([1, 1, 1, 1]);
    expect(run(1.5, 6)).toEqual([1, 2, 1, 2, 1, 2]);
    expect(run(4, 3)).toEqual([4, 4, 4]);
    expect(run(64, 2)).toEqual([64, 64]);
    for (const speed of [1.1, 1.3, 2.7, 9.9, 63.9]) {
      const ticks = run(speed, 1000);
      expect(ticks.reduce((a, b) => a + b, 0) / 1000).toBeCloseTo(speed, 2);
      // never an empty step, never a burst: each step is the speed rounded down or up
      expect(Math.min(...ticks)).toBe(Math.floor(speed));
      expect(Math.max(...ticks)).toBe(Math.ceil(speed));
    }
    // below 1 every step is one tick: the interval does the slowing
    expect(run(0.5, 3)).toEqual([1, 1, 1]);
    expect(run(0.1, 3)).toEqual([1, 1, 1]);
    // a carry left over from a faster setting never bursts
    expect(nextStep(1.2, 0.999).ticks).toBe(2);
    expect(nextStep(0.5, 0.999)).toEqual({ ticks: 1, carry: 0 });
  });

  it('a saved speed in range comes back with its interval', async () => {
    storage.setItem(STORAGE_KEY, JSON.stringify({ state: { seed: 7, scenario: 'none', speed: 0.5 }, version: 1 }));
    const { useSim } = await importStore();
    expect(useSim.getState().speed).toBe(0.5);
    expect(useSim.getState().stepIntervalMs).toBe(500);
  });

  it.each([0, 900, -2, 'fast', null])('a saved speed of %s is out of range and resets to 1', async (bad) => {
    storage.setItem(STORAGE_KEY, JSON.stringify({ state: { seed: 7, scenario: 'none', speed: bad }, version: 1 }));
    const { useSim } = await importStore();
    expect(useSim.getState().speed).toBe(1);
    expect(useSim.getState().stepIntervalMs).toBe(250);
    expect(useSim.getState().seed).toBe(7); // the rest of the saved settings is kept
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
