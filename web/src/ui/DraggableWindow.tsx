// A floating window: drag it by the title bar, close it with the button in
// the corner, and it stays inside the viewport. Its corners are cut at 45
// degrees (the shared .chamfer class in index.css), so every window in the
// app has the same shape. Which windows are open and
// where they sit lives in the windows store, so any panel (the event log,
// analytics) is one <DraggableWindow id="…"> around its content plus a
// toggle button that calls useWindows.toggle.
//
// A window can also follow something else: pass `open` and `onClose` and it
// shows while `open` is true (a selected vehicle, a selected site) and tells
// its owner when the close button is pressed. Its place is still remembered.

import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { clampToViewport, useWindows } from './windows';

/**
 * Windows stack from here up, one step each in focus order — above the map
 * and its overlays, below the top bar (z 60) so the bar's menus open over
 * any window.
 */
const BASE_Z = 20;
const DEFAULT_AT = { x: 96, y: 72 };

export function DraggableWindow({
  id,
  title,
  width = 440,
  maxHeight = '60vh',
  actions,
  header,
  open: openProp,
  onClose,
  at = DEFAULT_AT,
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
  /**
   * The title bar's own content, in place of the plain title — for a window
   * whose heading is more than a name (a site's icon, name and state). It is
   * part of the drag handle. `title` still names the window for assistive
   * technology and its close button.
   */
  header?: ReactNode;
  /** controlled mode: show while true, whatever the windows store says */
  open?: boolean;
  /** controlled mode: the close button was pressed */
  onClose?: () => void;
  /** where the window appears before it has ever been placed or dragged */
  at?: { x: number; y: number };
  children: ReactNode;
}) {
  const saved = useWindows((s) => s.windows[id]);
  const stack = useWindows((s) => s.order.indexOf(id));
  const drag = useRef<{ dx: number; dy: number } | null>(null);
  const open = openProp ?? saved?.open === true;
  const place = saved ?? { open, x: at.x, y: at.y };

  // a window that follows a selection comes to the front when it appears
  useEffect(() => {
    if (openProp === true) useWindows.getState().focus(id);
  }, [id, openProp]);

  // A shrinking browser window must not strand the title bar off screen.
  useEffect(() => {
    if (!open) return;
    const onResize = () => {
      const cur = useWindows.getState().windows[id] ?? { x: at.x, y: at.y };
      const next = clampToViewport(cur.x, cur.y, width, { width: window.innerWidth, height: window.innerHeight });
      if (next.x !== cur.x || next.y !== cur.y) useWindows.getState().move(id, next.x, next.y);
    };
    onResize();
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // `at` is read once per open: a caller's fresh object must not re-run this
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, open, width]);

  if (!open) return null;

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
      className="chamfer pointer-events-auto fixed flex flex-col"
      style={{ left: place.x, top: place.y, width, maxHeight, zIndex: BASE_Z + Math.max(0, stack) }}
      role="dialog"
      aria-label={title}
      data-testid={`window-${id}`}
      onPointerDown={() => useWindows.getState().focus(id)}
    >
      {/* clipped to the window's cut corners: nothing inside can paint past them */}
      <div className="chamfer-body flex min-h-0 flex-1 flex-col">
      <header
        className="flex cursor-move touch-none select-none items-center gap-2 border-b border-line px-3 py-2"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        data-testid={`window-${id}-titlebar`}
      >
        {header !== undefined
          ? <div className="mr-auto min-w-0 flex-1">{header}</div>
          : <h2 className="label mr-auto">{title}</h2>}
        {actions}
        <button
          className="btn btn-glyph"
          onClick={() => (onClose !== undefined ? onClose() : useWindows.getState().close(id))}
          aria-label={`Close ${title}`}
          data-testid={`window-${id}-close`}
        >
          ✕
        </button>
      </header>
      {/* the window body scrolls; its bar's strip is reserved, so content never jumps when the bar appears */}
      <div className="scroll-steady min-h-0 flex-1 overflow-auto" data-testid={`window-${id}-body`}>{children}</div>
      </div>
    </section>
  );
}
