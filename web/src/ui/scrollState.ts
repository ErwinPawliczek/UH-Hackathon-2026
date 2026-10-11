// Scroll bars turn blue while their content is moving — by wheel, trackpad,
// keyboard or dragging — and go back to grey about half a second after it
// stops. CSS has no state for "is scrolling", so one capturing listener on
// the document marks whatever element is scrolling with a data attribute
// (index.css styles `[data-scrolling]`), and clears it again after a pause.
//
// A data attribute rather than a class: React rewrites `className` when a
// component re-renders, but never touches attributes it did not set.

/** How long after the last scroll event an element still counts as moving. */
export const SCROLL_REST_MS = 550;

/**
 * Start marking scrolling elements under `root`. Installed once at startup;
 * every scrolling area in the app is covered, whoever built it. Returns a
 * function that removes the listener and any marks still set.
 */
export function installScrollState(
  root: Pick<Document, 'addEventListener' | 'removeEventListener' | 'documentElement'>,
  restMs: number = SCROLL_REST_MS,
): () => void {
  const timers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();
  const onScroll = (e: Event) => {
    // the page itself scrolls on the document; everything else on its element
    const target: unknown = (e.target as unknown) === root ? root.documentElement : e.target;
    if (!(target instanceof HTMLElement)) return;
    target.dataset.scrolling = '';
    const pending = timers.get(target);
    if (pending !== undefined) clearTimeout(pending);
    timers.set(target, setTimeout(() => {
      delete target.dataset.scrolling;
      timers.delete(target);
    }, restMs));
  };
  // scroll does not bubble, but it can be captured on the way down
  root.addEventListener('scroll', onScroll, true);
  return () => {
    root.removeEventListener('scroll', onScroll, true);
    for (const [el, timer] of timers) {
      clearTimeout(timer);
      delete el.dataset.scrolling;
    }
    timers.clear();
  };
}
