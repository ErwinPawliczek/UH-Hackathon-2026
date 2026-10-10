import { describe, expect, it } from "vitest";
import { getRowOffset, getSnapRow, GRID_SCALE, HEX_POINTS, HEX_RADIUS, HEX_ROW_STEP, HEX_WIDTH } from "./hex-grid";

describe("logo grid attachment", () => {
  it("starts on the original grid hexagon", () => {
    expect(getSnapRow(0, 0)).toBe(0);
    expect(getRowOffset(0)).toBe(0);
  });
  it("rides its hexagon before snapping down to the adjacent one", () => {
    expect(getSnapRow(HEX_ROW_STEP * 0.6, 0)).toBe(0);
    expect(getSnapRow(HEX_ROW_STEP * 0.9, 0)).toBe(1);
    expect(getRowOffset(1)).toBe(HEX_WIDTH / 2);
  });
  it("snaps back to the preceding hexagon when scrolling up", () => {
    expect(getSnapRow(HEX_ROW_STEP * 0.5, 1)).toBe(1);
    expect(getSnapRow(HEX_ROW_STEP * 0.1, 1)).toBe(0);
  });
  it("stays on a grid center even during a large scroll jump", () => {
    expect(getSnapRow(HEX_ROW_STEP * 10, 0)).toBe(10);
    expect(getSnapRow(0, 10)).toBe(0);
  });
  it("zooms the lattice out one more step", () => {
    expect(GRID_SCALE).toBe(0.4);
    expect(HEX_ROW_STEP).toBeLessThan(40);
    expect(HEX_ROW_STEP).toBeGreaterThan(25);
  });
  it("draws a hexagon whose vertices land on the grid radius", () => {
    const points = HEX_POINTS.split(" ").map((pair) => pair.split(",").map(Number) as [number, number]);
    expect(points).toHaveLength(6);
    // The source logo is a hair narrower than a perfect hexagon; the grid keeps
    // that proportion so the brand always sits exactly on a lattice cell.
    for (const [x, y] of points) {
      expect(Math.abs(Math.hypot(x, y) - HEX_RADIUS)).toBeLessThan(0.02);
    }
    expect(Math.max(...points.map(([x]) => x)) - Math.min(...points.map(([x]) => x))).toBeCloseTo(HEX_WIDTH, 6);
  });
});
