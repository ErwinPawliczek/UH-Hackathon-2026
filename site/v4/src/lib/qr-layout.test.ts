import { describe, expect, it } from "vitest";
import { getQrPlacement } from "./qr-layout";

describe("approved QR placement", () => {
  it("stacks the two codes on phones", () => {
    const { centers, radius } = getQrPlacement(390, 44);
    expect(radius).toBe(3);
    expect(centers).toEqual([{ c: 4, r: 7 }, { c: 4, r: 17 }]);
  });
  it("places the two codes side by side on desktop", () => {
    const { centers, radius } = getQrPlacement(1280, 64);
    expect(radius).toBe(4);
    expect(centers).toEqual([{ c: 7, r: 9 }, { c: 23, r: 9 }]);
  });
});