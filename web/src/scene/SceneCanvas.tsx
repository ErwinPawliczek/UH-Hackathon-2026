// Full-viewport three.js canvas: builds the MapScene when the world changes,
// drives the render loop (vehicles drive continuously between the 250 ms
// snapshots, see vehicleMotion.ts), forwards clicks to picking, and handles
// resize.

import { NAMES_LABEL, useNamesMode } from '../ui/namesMode';
import { useEffect, useRef } from 'react';
import { useSim } from '../store/sim';
import { MapScene, viewFromParams } from './mapScene';
import type { VehicleTrip } from './tripOverlay';

export function SceneCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const world = useSim((s) => s.world);

  const sceneRef = useRef<MapScene | null>(null);
  const arriving = typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('from') === 'build';

  // build/teardown the scene when the world changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || world === null) return;
    const scene = new MapScene(canvas, world, viewFromParams(new URLSearchParams(window.location.search)));
    sceneRef.current = scene;
    // `?debug` exposes the scene to the console and to capture scripts, which
    // may also hand it a trip to draw (window.__petrogridTrip)
    const debug = new URLSearchParams(window.location.search).has('debug');
    const fromBuild = new URLSearchParams(window.location.search).get('from') === 'build';
    if (debug) (window as unknown as { __petrogridScene?: MapScene }).__petrogridScene = scene;

    const ro = new ResizeObserver(() => {
      const parent = canvas.parentElement;
      if (parent !== null) scene.resize(parent.clientWidth, parent.clientHeight);
    });
    if (canvas.parentElement !== null) {
      scene.resize(canvas.parentElement.clientWidth, canvas.parentElement.clientHeight);
      ro.observe(canvas.parentElement);
    }
    // arriving from the map builder's build animation (`?from=build`): the flat map stands up into the world
    if (fromBuild) scene.playIntro();

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const st = useSim.getState();
      scene.setMine(st.room !== null ? st.mySite : null);
      if (st.snap !== null) {
        // real time between snapshots (longer below speed 1)
        const stepMs = st.stepIntervalMs ?? 250;
        const f = st.playing ? Math.min(1, (now - st.snapAt) / stepMs) : 1;
        scene.applySnapshot(st.snap, st.prevSnap, f, st.selected, now, st.runEpoch, stepMs);
        // the selected vehicle's trip, once the UI has fetched it (absent on older stores)
        const trip =
          (st as unknown as { selectedVehicleDetail?: VehicleTrip | null }).selectedVehicleDetail ??
          (debug ? ((window as unknown as { __petrogridTrip?: VehicleTrip }).__petrogridTrip ?? null) : null);
        scene.showTrip(trip, st.selected);
      }
      scene.animate(dt);
      scene.render();
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      scene.dispose();
      sceneRef.current = null;
    };
  }, [world]);

  // click-picking: distinguish a click from an OrbitControls drag
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    let downX = 0;
    let downY = 0;
    const lastTap = { t: 0, x: 0, y: 0 };
    const onDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > (e.pointerType === 'touch' ? 10 : 6)) return; // drag, not click
      const touch = e.pointerType === 'touch';
      const hit = sceneRef.current?.pick(e.clientX, e.clientY, touch) ?? null;
      // a second tap on empty map soon after the first, close by: back to the start view
      if (touch && hit === null) {
        const now = performance.now();
        if (now - lastTap.t < 320 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 36) {
          sceneRef.current?.resetView();
          lastTap.t = 0;
          return;
        }
        lastTap.t = now;
        lastTap.x = e.clientX;
        lastTap.y = e.clientY;
      }
      useSim.getState().select(hit);
    };
    canvas.addEventListener('pointerdown', onDown);
    // double-click on empty map: back to the start view
    const onDouble = (e: MouseEvent) => {
      const scene = sceneRef.current;
      if (scene !== null && scene.pick(e.clientX, e.clientY) === null) scene.resetView();
    };
    canvas.addEventListener('pointerup', onUp);
    canvas.addEventListener('dblclick', onDouble);
    return () => {
      canvas.removeEventListener('dblclick', onDouble);
      canvas.removeEventListener('pointerdown', onDown);
      canvas.removeEventListener('pointerup', onUp);
    };
  }, []);

  const namesMode = useNamesMode((s) => s.mode);
  const cycleNames = useNamesMode((s) => s.cycle);

  return (
    <>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full touch-none select-none" aria-label="Simulation map" />
      {/* from the build animation: the app fades in from the same paper white the drawing faded to */}
      {arriving && <div className="build-arrival pointer-events-none fixed inset-0 z-[70] bg-white" aria-hidden="true" />}
      <div className="absolute bottom-4 right-4 z-10 flex gap-2">
      {/* plant names get big beside a zoomed-out map: names and icons, icons only, or nothing */}
      <button
        type="button"
        className={`btn ${namesMode === 'full' ? '' : 'btn-active'}`}
        onClick={cycleNames}
        title="Plant names on the map: names and icons, icons only, or hidden"
        data-testid="names-toggle"
        data-names={namesMode}
      >
        {NAMES_LABEL[namesMode]}
      </button>
      <button
        type="button"
        className="btn"
        onClick={() => sceneRef.current?.resetView()}
        title="Show the whole map again (or double-click empty map)"
        data-testid="reset-view"
      >
        Reset view
      </button>
      </div>
    </>
  );
}
