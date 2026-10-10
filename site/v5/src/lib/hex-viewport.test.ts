import { expect, it } from "vitest";
import { getViewportAttachment, HEX_ROW_STEP } from "./hex-grid";

it("keeps the brand within its top-left viewport band throughout long scrolling", () => {
  let row = 0;
  for (let scroll = 0; scroll <= 100000; scroll += 17) {
    const attachment = getViewportAttachment(scroll, row);
    row = attachment.row;
    expect(Math.abs(attachment.offsetY)).toBeLessThanOrEqual(HEX_ROW_STEP * 0.7);
  }
});

it("keeps the brand in view when scrolling back up or jumping across the page", () => {
  let row = 0;
  for (const scroll of [100000, 50000, 12000, 2000, 100, 0]) {
    const attachment = getViewportAttachment(scroll, row);
    row = attachment.row;
    expect(80 + attachment.offsetY).toBeGreaterThan(50);
    expect(80 + attachment.offsetY).toBeLessThan(110);
    expect(attachment.row * HEX_ROW_STEP - scroll).toBeCloseTo(attachment.offsetY);
  }
});

it("holds the brand on its hexagon where the scroll depth lands on a row boundary", () => {
  const attachment = getViewportAttachment(14994, 424);
  expect(Math.abs(attachment.offsetY)).toBeLessThanOrEqual(HEX_ROW_STEP * 0.7);
  expect(attachment.phase).toBeGreaterThanOrEqual(0);
  expect(attachment.phase).toBeLessThan(HEX_ROW_STEP);
});