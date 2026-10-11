// Top bar: brand, sim clock, playback controls, and the seed/scenario
// pickers. Engine choice has no UI — visitors run the hosted engine; the
// in-page stub is selected only via ?engine= for tests and local development.
//
// The scenario picker has two forms. On the hosted engine it triggers a real
// disruption: picking an entry sends that engine command to the live session
// at once, and the entry stays ticked for the rest of the run. On the in-page
// stub it is the stub-era scripted-scenario setting (a session restart).

import { useSim, SPEEDS, TICKS_PER_DAY } from '../store/sim';
import { SCENARIOS } from '../engine/events';
import { scenariosFor } from '../engine/scenarios';
import { fmtClock } from './format';

export function TopBar() {
  const playing = useSim((s) => s.playing);
  const speed = useSim((s) => s.speed);
  const seed = useSim((s) => s.seed);
  const scenario = useSim((s) => s.scenario);
  const tick = useSim((s) => s.snap?.tick);
  const error = useSim((s) => s.error);
  const backendKind = useSim((s) => s.backendKind);
  const world = useSim((s) => s.world);
  const triggered = useSim((s) => s.triggered);
  const live = useSim((s) => s.sendCommand !== null);

  const { togglePlay, setSpeed, setSeed, setScenario, triggerScenario } = useSim.getState();
  const engineScenarios = backendKind === 'http' ? scenariosFor(world) : [];

  return (
    <header className="pointer-events-auto absolute inset-x-0 top-0 z-10 flex h-12 items-center gap-2 border-b border-line bg-panel px-4">
      <span className="flex items-center gap-2" data-testid="wordmark">
        <img src="/logo.svg" alt="PetroGrid mark" width={20} height={20} />
        <span className="wordmark text-base leading-none">
          Petro<span className="text-blue">Grid</span>
        </span>
      </span>

      <span className="data ml-2 min-w-28 rounded-sm bg-panel-2 px-2 py-1" data-testid="clock">
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

      <label className="ml-2 flex items-center gap-2">
        <span className="label">Seed</span>
        <input
          id="seed-input"
          name="seed"
          type="number"
          className="field w-20"
          value={seed}
          min={0}
          onChange={(e) => setSeed(Number(e.target.value) || 0)}
          data-testid="seed-input"
        />
      </label>

      {backendKind === 'http' ? (
        <label className="flex items-center gap-2">
          <span className="label">Scenario</span>
          {/* value stays "" so the picker always reads as an action, not a state */}
          <select
            id="scenario-select"
            name="scenario"
            className="field"
            value=""
            disabled={!live || engineScenarios.length === 0}
            onChange={(e) => {
              const picked = engineScenarios.find((s) => s.key === e.target.value);
              if (picked !== undefined) void triggerScenario(picked);
            }}
            data-testid="scenario-select"
          >
            <option value="">
              {engineScenarios.length === 0 ? 'No scenarios for this world' : 'Trigger a disruption…'}
            </option>
            {engineScenarios.map((s) => (
              <option key={s.key} value={s.key} disabled={triggered.includes(s.key)}>
                {triggered.includes(s.key) ? `✓ ${s.label}` : s.label}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <label className="flex items-center gap-2">
          <span className="label">Scenario</span>
          <select id="scenario-select" name="scenario" className="field" value={scenario} onChange={(e) => setScenario(e.target.value)} data-testid="scenario-select">
            {SCENARIOS.map((s) => (
              <option key={s.key} value={s.key}>{s.label}</option>
            ))}
          </select>
        </label>
      )}

      <span className="data ml-auto text-muted">{Math.floor(Number(tick ?? 0) / TICKS_PER_DAY)}/60 d</span>

      {error !== null && (
        <span
          className="rounded-sm border border-alarm/50 bg-alarm/10 px-2 py-1 text-xs font-medium text-alarm"
          data-testid="error-banner"
          role="alert"
        >
          {error}
        </span>
      )}
    </header>
  );
}
