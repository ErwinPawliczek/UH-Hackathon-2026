// The "is scrolling" mark behind the blue scroll bar.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installScrollState } from './scrollState';

/** A minimal stand-in for an element: all the listener touches is `dataset`. */
class FakeElement {
  dataset: Record<string, string> = {};
}

describe('installScrollState', () => {
  const g = globalThis as unknown as { HTMLElement?: unknown };
  const realHTMLElement = g.HTMLElement;
  let listener: ((e: Event) => void) | null = null;
  const root = {
    documentElement: new FakeElement() as unknown as HTMLElement,
    addEventListener: vi.fn((_type: string, fn: (e: Event) => void) => { listener = fn; }),
    removeEventListener: vi.fn(),
  };

  beforeEach(() => {
    g.HTMLElement = FakeElement; // node has no DOM; the listener checks instanceof
    vi.useFakeTimers();
    listener = null;
    root.addEventListener.mockClear();
    root.removeEventListener.mockClear();
    (root.documentElement as unknown as FakeElement).dataset = {};
  });
  afterEach(() => {
    vi.useRealTimers();
    g.HTMLElement = realHTMLElement;
  });

  const scroll = (target: unknown) => listener?.({ target } as Event);

  it('listens in the capture phase, since scroll does not bubble', () => {
    installScrollState(root as unknown as Document);
    expect(root.addEventListener).toHaveBeenCalledWith('scroll', expect.any(Function), true);
  });

  it('marks a scrolling element and clears the mark once it has been still for a while', () => {
    installScrollState(root as unknown as Document, 500);
    const el = new FakeElement();
    scroll(el);
    expect('scrolling' in el.dataset).toBe(true);
    vi.advanceTimersByTime(400);
    scroll(el); // still moving: the pause starts again
    vi.advanceTimersByTime(400);
    expect('scrolling' in el.dataset).toBe(true);
    vi.advanceTimersByTime(101);
    expect('scrolling' in el.dataset).toBe(false);
  });

  it('marks the page itself when the document scrolls, and each element on its own clock', () => {
    installScrollState(root as unknown as Document, 500);
    const a = new FakeElement();
    const b = new FakeElement();
    scroll(root); // the document is the target when the page scrolls
    scroll(a);
    vi.advanceTimersByTime(300);
    scroll(b);
    vi.advanceTimersByTime(250);
    expect('scrolling' in (root.documentElement as unknown as FakeElement).dataset).toBe(false);
    expect('scrolling' in a.dataset).toBe(false);
    expect('scrolling' in b.dataset).toBe(true);
  });

  it('cleans up: no listener, no marks left behind', () => {
    const stop = installScrollState(root as unknown as Document, 500);
    const el = new FakeElement();
    scroll(el);
    stop();
    expect(root.removeEventListener).toHaveBeenCalledWith('scroll', expect.any(Function), true);
    expect('scrolling' in el.dataset).toBe(false);
  });
});
