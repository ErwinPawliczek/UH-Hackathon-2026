import { describe, expect, it } from "vitest";
import { HEX_ROW_STEP, HEX_WIDTH } from "./hex-grid";
import { getHexVideoLayout } from "./hex-video-layout";

describe("video aperture layout", () => {
  it("uses a tall, centered aperture on a narrow phone", () => {
    const width = 320;
    const originX = 44;
    const layout = getHexVideoLayout(width, originX);
    const apertureWidth = layout.columns * HEX_WIDTH;
    const apertureHeight = layout.rows * HEX_ROW_STEP;
    const centerX = originX + (layout.firstColumn + (layout.columns - 1) / 2) * HEX_WIDTH;

    expect(apertureHeight).toBeGreaterThan(apertureWidth);
    expect(layout.firstRow).toBe(6);
    expect(Math.abs(centerX - width / 2)).toBeLessThanOrEqual(HEX_WIDTH / 2);
  });

  it("keeps the desktop aperture wide", () => {
    const layout = getHexVideoLayout(1280, 64);
    expect(layout.columns * HEX_WIDTH).toBeGreaterThan(layout.rows * HEX_ROW_STEP);
    expect(layout.firstRow).toBe(5);
  });
});