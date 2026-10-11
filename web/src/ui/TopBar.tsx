// Top bar: brand, sim clock, playback and speed controls, and the scenario
// picker. Engine choice and seed have no UI — visitors run the hosted engine
// on a fixed seed (?seed= overrides it for testing); the
// in-page stub is selected only via ?engine= for tests and local development.
//
// The scenario control is one button named "Scenario" that opens a list. On
// the hosted engine it triggers a real disruption: picking an entry sends
// that engine command to the live session at once, the entry stays ticked
// for the rest of the run and the button shows its name. On the in-page stub
// it is the stub-era scripted-scenario setting (a session restart).

import { useId } from 'react';
import { useSim } from '../store/sim';
import { SCENARIOS } from '../engine/events';
import { scenariosFor, type EngineScenario } from '../engine/scenarios';
import { DropdownMenu } from './DropdownMenu';
import { SpeedControl } from './SpeedControl';
import { fmtClock } from './format';
import { LOG_WINDOW_AT, LOG_WINDOW_ID } from './EventLog';
import { REWIND_WINDOW_AT, REWIND_WINDOW_ID } from './RewindWindow';
import { SITES_WINDOW_AT, SITES_WINDOW_ID } from './SitesKey';
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

/** Zigzag period and depth in px: the lower edges of 20 px wide pointy-top hexagons. */
export const CHAIN_PERIOD = 20;
export const CHAIN_DEPTH = CHAIN_PERIOD / (2 * Math.sqrt(3)); // ≈ 5.77: every bend is 120°

/**
 * The top bar's bottom edge, drawn as a carbon chain: the lower edges of a
 * row of pointy-top hexagons side by side — a skeletal-formula zigzag with
 * 120° bends — as a hairline in the border colour, with the bar's fill
 * following the zigzag above it. It hangs below the bar's 48 px box, so
 * nothing inside the bar moves; an SVG pattern keeps it crisp at any width.
 */
function ChainEdge() {
  const id = useId();
  const top = 0.5; // half a pixel down: the hairline's upper bends sit on the bar's edge
  const low = (top + CHAIN_DEPTH).toFixed(2);
  const h = Math.ceil(top + CHAIN_DEPTH + 1);
  // One period, drawn half a period past each side so the bends at the tile
  // edges are whole on both tiles.
  const zigzag = `M${-CHAIN_PERIOD / 2} ${low} L0 ${top} L${CHAIN_PERIOD / 2} ${low} L${CHAIN_PERIOD} ${top} L${CHAIN_PERIOD * 1.5} ${low}`;
  return (
    <svg
      className="pointer-events-none absolute inset-x-0 top-full block w-full"
      height={h}
      aria-hidden="true"
      data-testid="chain-edge"
    >
      <defs>
        <pattern id={id} width={CHAIN_PERIOD} height={h} patternUnits="userSpaceOnUse">
          <path d={`M0 0 H${CHAIN_PERIOD} V${top} L${CHAIN_PERIOD / 2} ${low} L0 ${top} Z`} fill="var(--panel)" />
          <path d={zigzag} fill="none" stroke="var(--line-2)" strokeWidth="1" strokeLinejoin="miter" />
        </pattern>
      </defs>
      <rect width="100%" height={h} fill={`url(#${id})`} />
    </svg>
  );
}

export function TopBar() {
  const playing = useSim((s) => s.playing);
  const started = useSim((s) => s.started);
  const scenario = useSim((s) => s.scenario);
  const tick = useSim((s) => s.snap?.tick);
  const error = useSim((s) => s.error);
  const backendKind = useSim((s) => s.backendKind);
  const world = useSim((s) => s.world);
  const triggered = useSim((s) => s.triggered);
  const live = useSim((s) => s.sendCommand !== null);
  const logOpen = useWindows((s) => s.windows[LOG_WINDOW_ID]?.open === true);
  const rewindOpen = useWindows((s) => s.windows[REWIND_WINDOW_ID]?.open === true);
  const sitesOpen = useWindows((s) => s.windows[SITES_WINDOW_ID]?.open === true);
  const canRewind = useSim((s) => s.rewindTo !== null) && Number(tick ?? 0) > 0;

  const { togglePlay, setScenario, triggerScenario } = useSim.getState();
  const engineScenarios = backendKind === 'http' ? scenariosFor(world) : [];

  return (
    <header className="pointer-events-auto absolute inset-x-0 top-0 z-10 flex h-12 items-center gap-2 bg-panel px-4">
      <ChainEdge />
      <span className="flex items-center gap-2" data-testid="wordmark">
        <img src="/logo.svg" alt="PetroGrid mark" width={20} height={20} />
        <span className="wordmark text-base leading-none">
          Petro<span className="text-blue">Grid</span>
        </span>
      </span>

      <span className="data ml-2 min-w-28 rounded-sm bg-panel-2 px-2 py-1" data-testid="clock">
        {tick === undefined ? '—' : fmtClock(Number(tick))}
      </span>

      {/* Start and Resume are the call to action (primary); Pause, while running, reads as the active state. */}
      <button className={`btn ${playing ? 'btn-active' : 'btn-primary'}`} onClick={togglePlay} data-testid="play-pause">
        {!started ? '▶ Start simulation' : playing ? '⏸ Pause' : '▶ Resume'}
      </button>

      <SpeedControl />

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
        className={`btn ml-auto ${rewindOpen ? 'btn-active' : ''}`}
        onClick={() => useWindows.getState().toggle(REWIND_WINDOW_ID, REWIND_WINDOW_AT)}
        disabled={!canRewind && !rewindOpen}
        aria-pressed={rewindOpen}
        data-testid="rewind-toggle"
      >
        ↶ Back in time
      </button>
      <button
        className={`btn ${sitesOpen ? 'btn-active' : ''}`}
        onClick={() => useWindows.getState().toggle(SITES_WINDOW_ID, SITES_WINDOW_AT)}
        aria-pressed={sitesOpen}
        data-testid="sites-toggle"
      >
        Sites
      </button>
      <button
        className={`btn ${logOpen ? 'btn-active' : ''}`}
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
