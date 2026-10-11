// Top bar: brand, sim clock, playback controls, and the seed/scenario
// pickers. Engine choice has no UI — visitors run the hosted engine; the
// in-page stub is selected only via ?engine= for tests and local development.
//
// The scenario control is one button named "Scenario" that opens a list. On
// the hosted engine it triggers a real disruption: picking an entry sends
// that engine command to the live session at once, the entry stays ticked
// for the rest of the run and the button shows its name. On the in-page stub
// it is the stub-era scripted-scenario setting (a session restart).

import { useSim, SPEEDS } from '../store/sim';
import { SCENARIOS } from '../engine/events';
import { scenariosFor, type EngineScenario } from '../engine/scenarios';
import { DropdownMenu } from './DropdownMenu';
import { fmtClock } from './format';
import { LOG_WINDOW_AT, LOG_WINDOW_ID } from './EventLog';
import { useWindows } from './windows';

/**
 * Text on the scenario button: its own name until a disruption is triggered,
 * then the latest one's name (and how many more are running with it).
 */
export function scenarioButtonLabel(scenarios: EngineScenario[], triggered: string[]): string {
  const latest = scenarios.find((s) => s.key === triggered[triggered.length - 1]);
  if (latest === undefined) return 'Scenario';
  return triggered.length > 1 ? `${latest.label} +${triggered.length - 1}` : latest.label;
}

export function TopBar() {
  const playing = useSim((s) => s.playing);
  const started = useSim((s) => s.started);
  const speed = useSim((s) => s.speed);
  const seed = useSim((s) => s.seed);
  const scenario = useSim((s) => s.scenario);
  const tick = useSim((s) => s.snap?.tick);
  const error = useSim((s) => s.error);
  const backendKind = useSim((s) => s.backendKind);
  const world = useSim((s) => s.world);
  const triggered = useSim((s) => s.triggered);
  const live = useSim((s) => s.sendCommand !== null);
  const logOpen = useWindows((s) => s.windows[LOG_WINDOW_ID]?.open === true);

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

      {/* Before the first start this is the primary call to action; afterwards Pause / Resume. */}
      <button className={`btn ${playing || !started ? 'btn-active' : ''}`} onClick={togglePlay} data-testid="play-pause">
        {!started ? '▶ Start simulation' : playing ? '⏸ Pause' : '▶ Resume'}
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

      {/* One control: the button is named "Scenario" and opens the list. */}
      {backendKind === 'http' ? (
        <DropdownMenu
          label={scenarioButtonLabel(engineScenarios, triggered)}
          items={engineScenarios.map((s) => ({
            key: s.key,
            label: s.label,
            checked: triggered.includes(s.key),
            disabled: triggered.includes(s.key),
          }))}
          disabled={!live || engineScenarios.length === 0}
          emptyText="No scenarios for this world"
          onPick={(key) => {
            const picked = engineScenarios.find((s) => s.key === key);
            if (picked !== undefined) void triggerScenario(picked);
          }}
          testId="scenario-select"
        />
      ) : (
        <DropdownMenu
          label={scenario === 'none' ? 'Scenario' : SCENARIOS.find((s) => s.key === scenario)?.label ?? 'Scenario'}
          items={SCENARIOS.map((s) => ({ key: s.key, label: s.label, checked: s.key === scenario }))}
          onPick={setScenario}
          testId="scenario-select"
        />
      )}

      {/* floating windows: each toggle opens or closes one draggable panel */}
      <button
        className={`btn ml-auto ${logOpen ? 'btn-active' : ''}`}
        onClick={() => useWindows.getState().toggle(LOG_WINDOW_ID, LOG_WINDOW_AT)}
        aria-pressed={logOpen}
        data-testid="log-toggle"
      >
        Log
      </button>

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
