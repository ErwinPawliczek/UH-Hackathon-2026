// Top bar: brand, sim clock, playback controls, seed and scenario pickers,
// and the backend switch (stub ↔ HTTP). Settings here are the persisted ones.

import { useSim, SPEEDS, TICKS_PER_DAY } from '../store/sim';
import { SCENARIOS } from '../engine/events';
import { fmtClock } from './format';

export function TopBar() {
  const playing = useSim((s) => s.playing);
  const speed = useSim((s) => s.speed);
  const seed = useSim((s) => s.seed);
  const scenario = useSim((s) => s.scenario);
  const backendKind = useSim((s) => s.backendKind);
  const baseUrl = useSim((s) => s.baseUrl);
  const tick = useSim((s) => s.snap?.tick);
  const error = useSim((s) => s.error);

  const { togglePlay, setSpeed, setSeed, setScenario, setBackendKind, setBaseUrl } = useSim.getState();

  return (
    <header className="pointer-events-auto absolute inset-x-0 top-0 z-10 flex h-12 items-center gap-3 border-b border-slate-700/70 bg-slate-900/85 px-4 backdrop-blur">
      <span className="text-sm font-semibold tracking-wide text-cyan-300">Chain Reaction</span>

      <span className="ml-2 min-w-28 rounded bg-slate-800 px-2 py-1 font-mono text-xs text-slate-100" data-testid="clock">
        {tick === undefined ? '—' : fmtClock(Number(tick))}
      </span>

      <button className={`btn ${playing ? 'btn-active' : ''}`} onClick={togglePlay} data-testid="play-pause">
        {playing ? '⏸ Pause' : '▶ Play'}
      </button>

      <div className="flex items-center gap-1" role="group" aria-label="Simulation speed">
        {SPEEDS.map((s) => (
          <button key={s} className={`btn ${speed === s ? 'btn-active' : ''}`} onClick={() => setSpeed(s)}>
            {s}×
          </button>
        ))}
      </div>

      <label className="ml-2 flex items-center gap-1 text-xs text-slate-400">
        Seed
        <input
          type="number"
          className="field w-20"
          value={seed}
          min={0}
          onChange={(e) => setSeed(Number(e.target.value) || 0)}
          data-testid="seed-input"
        />
      </label>

      <label className="flex items-center gap-1 text-xs text-slate-400">
        Scenario
        <select className="field" value={scenario} onChange={(e) => setScenario(e.target.value)} data-testid="scenario-select">
          {SCENARIOS.map((s) => (
            <option key={s.key} value={s.key}>{s.label}</option>
          ))}
        </select>
      </label>

      <label className="flex items-center gap-1 text-xs text-slate-400">
        Engine
        <select className="field" value={backendKind} onChange={(e) => setBackendKind(e.target.value as 'stub' | 'http')} data-testid="backend-select">
          <option value="stub">In-page stub</option>
          <option value="http">Hosted (HTTP)</option>
        </select>
      </label>

      {backendKind === 'http' && (
        <label className="flex items-center gap-1 text-xs text-slate-400">
          URL
          <input
            type="text"
            placeholder="https://…"
            className="field w-40"
            value={baseUrl}
            onChange={(e) => setBaseUrl(e.target.value)}
            data-testid="base-url-input"
          />
        </label>
      )}

      <span className="ml-auto text-xs text-slate-500">{Math.floor(Number(tick ?? 0) / TICKS_PER_DAY)}/60 d</span>

      {error !== null && (
        <span className="rounded border border-red-500/60 bg-red-950/80 px-2 py-1 text-xs text-red-300" data-testid="error-banner" role="alert">
          {error}
        </span>
      )}
    </header>
  );
}
