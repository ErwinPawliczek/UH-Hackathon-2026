import { describe, expect, it } from 'vitest';
import { LAYOUT_KEY, RUN_CUSTOM_KEY, customLayout, leaveCustomMap } from './customMap';

const store = (init: Record<string, string>) => {
  const data = new Map(Object.entries(init));
  return { getItem: (k: string) => data.get(k) ?? null, removeItem: (k: string) => void data.delete(k), data };
};

describe('custom map hand-over', () => {
  const layout = JSON.stringify({ version: 2, wKm: 600, hKm: 400, sites: [] });

  it("runs the stored layout only when the editor asked for it", () => {
    expect(customLayout(store({ [LAYOUT_KEY]: layout, [RUN_CUSTOM_KEY]: '1' }))).toMatchObject({ version: 2, wKm: 600 });
    expect(customLayout(store({ [LAYOUT_KEY]: layout }))).toBeNull(); // drawn, not asked to run
    expect(customLayout(store({ [RUN_CUSTOM_KEY]: '1' }))).toBeNull(); // asked, nothing drawn
    expect(customLayout(store({ [LAYOUT_KEY]: layout, [RUN_CUSTOM_KEY]: '0' }))).toBeNull();
    expect(customLayout(null)).toBeNull();
  });

  it("falls back to the default world on a layout that is not a JSON object", () => {
    expect(customLayout(store({ [LAYOUT_KEY]: '{not json', [RUN_CUSTOM_KEY]: '1' }))).toBeNull();
    expect(customLayout(store({ [LAYOUT_KEY]: '[1,2]', [RUN_CUSTOM_KEY]: '1' }))).toBeNull();
  });

  it("goes back to the default world by clearing the flag and keeping the drawing", () => {
    const s = store({ [LAYOUT_KEY]: layout, [RUN_CUSTOM_KEY]: '1' });
    leaveCustomMap(s);
    expect(customLayout(s)).toBeNull();
    expect(s.data.has(LAYOUT_KEY)).toBe(true);
  });
});
