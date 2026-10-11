import { describe, expect, it } from "vitest";
import { getPitchLayout, getTier, getOriginX } from "@/lib/pitch-layout";
import { cellCenter } from "@/lib/hex-regions";
import { HEX_WIDTH } from "@/lib/hex-grid";

const WIDTHS = [360, 390, 768, 1024, 1280, 1440, 1920, 2560];

describe("pitch layout", () => {
  it("maps widths to tiers", () => {
    expect([360, 600, 1023, 1024, 1599, 1600].map(getTier)).toEqual(["phone", "tablet", "tablet", "desktop", "desktop", "wide"]);
  });

  for (const width of WIDTHS) {
    it(`keeps every cell on screen and regions non-overlapping at ${width}px`, () => {
      const x0 = getOriginX(width);
      const layout = getPitchLayout(width, x0);
      const seen = new Set<string>();
      for (const item of layout.items) {
        if (item.kind !== "region") continue;
        for (const cell of item.cells) {
          const { x } = cellCenter(cell, x0);
          expect(x - HEX_WIDTH / 2).toBeGreaterThanOrEqual(0);
          expect(x + HEX_WIDTH / 2).toBeLessThanOrEqual(width);
          expect(cell.r).toBeGreaterThanOrEqual(3); // logo rows stay clear
          const key = `${cell.c}:${cell.r}`;
          expect(seen.has(key), `${item.key} overlaps at ${key}`).toBe(false);
          seen.add(key);
        }
      }
    });
  }

  it("centers content on wide screens", () => {
    for (const width of [1440, 1920, 2560]) {
      const x0 = getOriginX(width);
      const { firstColumn, columns } = getPitchLayout(width, x0);
      const left = x0 + firstColumn * HEX_WIDTH - HEX_WIDTH / 2;
      const right = width - (left + columns * HEX_WIDTH);
      expect(Math.abs(left - right)).toBeLessThanOrEqual(HEX_WIDTH * 1.5);
    }
  });
});
