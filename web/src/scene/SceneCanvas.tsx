// Full-viewport three.js canvas: builds the MapScene when the world changes,
// drives the render loop (vehicles drive continuously between the 250 ms
// snapshots, see vehicleMotion.ts), forwards clicks to picking, and handles
// resize.

import { useEffect, useRef } from 'react';
import { useSim } from '../store/sim';
import { MapScene, viewFromParams } from './mapScene';
import type { VehicleTrip } from './tripOverlay';

export function SceneCanvas() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const world = useSim((s) => s.world);

  const sceneRef = useRef<MapScene | null>(null);

  // build/teardown the scene when the world changes
  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null || world === null) return;
    const scene = new MapScene(canvas, world, viewFromParams(new URLSearchParams(window.location.search)));
    sceneRef.current = scene;
    // `?debug` exposes the scene to the console and to capture scripts, which
    // may also hand it a trip to draw (window.__petrogridTrip)
    const debug = new URLSearchParams(window.location.search).has('debug');
    if (debug) (window as unknown as { __petrogridScene?: MapScene }).__petrogridScene = scene;

    const ro = new ResizeObserver(() => {
      const parent = canvas.parentElement;
      if (parent !== null) scene.resize(parent.clientWidth, parent.clientHeight);
    });
    if (canvas.parentElement !== null) {
      scene.resize(canvas.parentElement.clientWidth, canvas.parentElement.clientHeight);
      ro.observe(canvas.parentElement);
    }

    let raf = 0;
    let last = performance.now();
    const frame = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      const st = useSim.getState();
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
    const onDown = (e: PointerEvent) => {
      downX = e.clientX;
      downY = e.clientY;
    };
    const onUp = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (Math.hypot(e.clientX - downX, e.clientY - downY) > 6) return; // drag, not click
      const hit = sceneRef.current?.pick(e.clientX, e.clientY) ?? null;
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

  return (
    <>
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" aria-label="Simulation map" />
      <div className="absolute bottom-4 right-4 z-10">
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
