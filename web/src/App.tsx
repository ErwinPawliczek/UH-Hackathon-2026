// App shell: mounts the engine hook once, layers the scene, top bar and
// floating windows over it (a selected site or vehicle opens its own
// window), and shows loading/error states.

import { useEffect } from 'react';
import { useSimEngine } from './store/useSimEngine';
import { useSim } from './store/sim';
import { SceneCanvas } from './scene/SceneCanvas';
import { TopBar } from './ui/TopBar';
import { EngineErrorOverlay, RunEndedOverlay } from './ui/EngineErrorOverlay';
import { SiteWindow } from './ui/SiteWindow';
import { VehicleWindow } from './ui/VehicleWindow';
import { RewindWindow } from './ui/RewindWindow';
import { SitesKey } from './ui/SitesKey';
import { EconomyWindow } from './ui/EconomyWindow';
import { EventLog } from './ui/EventLog';

export default function App() {
  useSimEngine();
  const world = useSim((s) => s.world);
  const snap = useSim((s) => s.snap);
  const error = useSim((s) => s.error);
  const retry = useSim((s) => s.retry);
  const ended = useSim((s) => s.ended);
  const queued = useSim((s) => s.triggered.length);
  const started = useSim((s) => s.started);
  const togglePlay = useSim((s) => s.togglePlay);

  // Escape clears the selection
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') useSim.getState().select(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-white text-ink">
      <SceneCanvas />
      <TopBar />
      <EventLog />
      <RewindWindow />
      <SitesKey />
      <EconomyWindow />
      <VehicleWindow />
      <SiteWindow />

      {/* A new run waits here, paused at day 0, until the visitor starts it. */}
      {world !== null && snap !== null && !started && error === null && (
        <div className="pointer-events-none absolute inset-x-0 bottom-8 z-10 flex flex-col items-center gap-2">
          {queued > 0 && (
            <p className="chamfer chamfer-sm px-3 py-1.5 text-xs text-ink" data-testid="scenario-queued">
              {queued === 1 ? 'A scenario is' : `${queued} scenarios are`} queued: {queued === 1 ? 'it begins' : 'they begin'} when you start.
            </p>
          )}
          <button
            className="btn btn-primary btn-lg pointer-events-auto"
            onClick={togglePlay}
            data-testid="start-simulation"
          >
            ▶ Start simulation
          </button>
        </div>
      )}

      {world === null && error === null && (
        <div className="absolute inset-0 z-20 flex items-center justify-center text-sm text-muted" data-testid="loading">
          Building world…
        </div>
      )}
      {world === null && error !== null && (
        <EngineErrorOverlay message={error} onRetry={retry} />
      )}
      {ended && <RunEndedOverlay onNewRun={retry} />}
      {world !== null && snap === null && error !== null && (
        <div className="absolute inset-x-0 top-14 z-20 flex justify-center">
          <span className="rounded-sm border border-alarm/50 bg-alarm/10 px-4 py-2 text-xs font-medium text-alarm" role="alert">
            {error}
          </span>
        </div>
      )}
    </div>
  );
}
