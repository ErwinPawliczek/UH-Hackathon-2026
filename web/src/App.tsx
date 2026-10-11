// App shell: mounts the engine hook once, layers the scene, top bar,
// inspectors and floating windows over it, and shows loading/error states.

import { useEffect } from 'react';
import { useSimEngine } from './store/useSimEngine';
import { useSim } from './store/sim';
import { SceneCanvas } from './scene/SceneCanvas';
import { TopBar } from './ui/TopBar';
import { EngineErrorOverlay } from './ui/EngineErrorOverlay';
import { SiteInspector } from './ui/SiteInspector';
import { VehicleInspector } from './ui/VehicleInspector';
import { RewindWindow } from './ui/RewindWindow';
import { SitesKey } from './ui/SitesKey';
import { EventLog } from './ui/EventLog';

function InspectorPanel() {
  const selected = useSim((s) => s.selected);
  if (selected === null) return null;
  return selected.kind === 'site'
    ? <div className="absolute right-2 top-14 z-10"><SiteInspector siteIdx={selected.index} /></div>
    : <div className="absolute right-2 top-14 z-10"><VehicleInspector vehIdx={selected.index} /></div>;
}

export default function App() {
  useSimEngine();
  const world = useSim((s) => s.world);
  const snap = useSim((s) => s.snap);
  const error = useSim((s) => s.error);
  const retry = useSim((s) => s.retry);
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
      <InspectorPanel />
      <EventLog />
      <RewindWindow />
      <SitesKey />

      {/* A new run waits here, paused at day 0, until the visitor starts it. */}
      {world !== null && snap !== null && !started && error === null && (
        <div className="pointer-events-none absolute inset-x-0 bottom-8 z-10 flex justify-center">
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
