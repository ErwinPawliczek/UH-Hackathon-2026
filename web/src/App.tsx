// App shell: mounts the engine hook once, layers the scene, top bar,
// inspectors and timeline over it, and shows loading/error states.

import { useEffect } from 'react';
import { useSimEngine } from './store/useSimEngine';
import { useSim } from './store/sim';
import { SceneCanvas } from './scene/SceneCanvas';
import { TopBar } from './ui/TopBar';
import { SiteInspector } from './ui/SiteInspector';
import { VehicleInspector } from './ui/VehicleInspector';
import { Timeline } from './ui/Timeline';

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
      <Timeline />

      {world === null && error === null && (
        <div className="absolute inset-0 z-20 flex items-center justify-center text-sm text-muted" data-testid="loading">
          Building world…
        </div>
      )}
      {world === null && error !== null && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 text-sm" data-testid="fatal-error">
          <p className="text-alarm" role="alert">{error}</p>
          <button className="btn" onClick={retry}>Retry</button>
        </div>
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
