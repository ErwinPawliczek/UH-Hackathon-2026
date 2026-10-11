// Session lifecycle against real backends: an unreachable hosted engine
// surfaces the store's error state and never switches to the stub, while the
// stub path still opens a working session for tests and local development.

import { describe, expect, it, vi } from 'vitest';
import { openEngineSession } from './engineSession';
import { HttpBackend } from '../engine/httpBackend';
import { useSim } from './sim';

/** A fetch that fails the way an offline/refused connection fails. */
const unreachableFetch: typeof fetch = async () => {
  throw new TypeError('Failed to fetch');
};

describe('openEngineSession', () => {
  it('reports an unreachable hosted engine and never falls back to the stub', async () => {
    useSim.setState({ playing: false, backendKind: 'http', error: null });
    const cleanup = openEngineSession(
      { kind: 'http', seed: 42, scenario: 'none' },
      new HttpBackend('http://engine.test', unreachableFetch),
    );
    try {
      await vi.waitFor(() => expect(useSim.getState().error).not.toBeNull());
      expect(useSim.getState().error).toContain('Cannot reach the hosted engine');
      // No silent fallback: the kind is unchanged and no stub world rendered.
      expect(useSim.getState().backendKind).toBe('http');
      expect(useSim.getState().world).toBeNull();
      expect(useSim.getState().sendCommand).toBeNull();
    } finally {
      cleanup();
    }
  });

  it('opens a working stub session when explicitly selected', async () => {
    useSim.setState({ playing: false, backendKind: 'stub', error: null });
    const cleanup = openEngineSession({ kind: 'stub', seed: 42, scenario: 'none' });
    try {
      await vi.waitFor(() => expect(useSim.getState().world).not.toBeNull());
      expect(useSim.getState().error).toBeNull();
      expect(useSim.getState().sendCommand).not.toBeNull();
    } finally {
      cleanup();
    }
  });

  it('cancels an in-flight session without surfacing its error', async () => {
    useSim.setState({ playing: false, error: null });
    const cleanup = openEngineSession(
      { kind: 'http', seed: 42, scenario: 'none' },
      new HttpBackend('http://engine.test', unreachableFetch),
    );
    cleanup();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(useSim.getState().error).toBeNull();
    expect(useSim.getState().sendCommand).toBeNull();
  });
});
