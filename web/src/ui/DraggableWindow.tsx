// A floating window: drag it by the title bar, close it with the button in
// the corner, and it stays inside the viewport. Which windows are open and
// where they sit lives in the windows store, so any panel (the event log,
// analytics) is one <DraggableWindow id="…"> around its content plus a
// toggle button that calls useWindows.toggle.

import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { clampToViewport, useWindows } from './windows';

const BASE_Z = 20; // above the top bar, inspector and timeline (z-10)

export function DraggableWindow({
  id,
  title,
  width = 440,
  maxHeight = '60vh',
  actions,
  children,
}: {
  /** stable id — the key its place is remembered under */
  id: string;
  title: string;
  /** width in pixels */
  width?: number;
  /** CSS max-height of the whole window; the body scrolls inside it */
  maxHeight?: string;
  /** extra controls for the title bar, left of the close button */
  actions?: ReactNode;
  children: ReactNode;
}) {
  const place = useWindows((s) => s.windows[id]);
  const stack = useWindows((s) => s.order.indexOf(id));
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const open = place?.open === true;

  // A shrinking browser window must not strand the title bar off screen.
  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      const cur = useWindows.getState().windows[id];
      if (cur === undefined) return;
      const next = clampToViewport(cur.x, cur.y, width, { width: window.innerWidth, height: window.innerHeight });
      if (next.x !== cur.x || next.y !== cur.y) useWindows.getState().move(id, next.x, next.y);
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [id, open, width]);

  if (!open || place === undefined) return null;

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    if (e.button !== 0) return;
    if ((e.target as HTMLElement).closest('button, input, select, label, a') !== null) return; // a control, not a drag
    drag.current = { dx: e.clientX - place.x, dy: e.clientY - place.y };
    e.currentTarget.setPointerCapture(e.pointerId);
    useWindows.getState().focus(id);
  };
  const onPointerMove = (e: ReactPointerEvent<HTMLElement>) => {
    if (drag.current === null) return;
    const next = clampToViewport(
      e.clientX - drag.current.dx,
      e.clientY - drag.current.dy,
      width,
      { width: window.innerWidth, height: window.innerHeight },
    );
    useWindows.getState().move(id, next.x, next.y);
  };
  const endDrag = (e: ReactPointerEvent<HTMLElement>) => {
    if (drag.current === null) return;
    drag.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  };

  return (
    <section
      className="panel pointer-events-auto fixed flex flex-col"
      style={{ left: place.x, top: place.y, width, maxHeight, zIndex: BASE_Z + Math.max(0, stack) }}
      role="dialog"
      aria-label={title}
      data-testid={`window-${id}`}
      onPointerDown={() => useWindows.getState().focus(id)}
    >
      <header
        className="flex cursor-move touch-none select-none items-center gap-2 border-b border-line px-3 py-2"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        data-testid={`window-${id}-titlebar`}
      >
        <h2 className="label mr-auto">{title}</h2>
        {actions}
        <button
          className="btn btn-glyph"
          onClick={() => useWindows.getState().close(id)}
          aria-label={`Close ${title}`}
          data-testid={`window-${id}-close`}
        >
          ✕
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto">{children}</div>
    </section>
  );
}
