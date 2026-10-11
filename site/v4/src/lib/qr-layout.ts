import { HEX_WIDTH } from "@/lib/hex-grid";
import type { Cell } from "@/lib/hex-regions";

/** QR-only geometry, independent of pitch content and its future revisions. */
export function getQrPlacement(width: number, x0: number): { centers: Cell[]; radius: number } {
  const cols = Math.floor((width - 8 - x0) / HEX_WIDTH);
  if (width < 600) {
    const c = Math.floor(cols / 2);
    return { radius: 3, centers: [{ c, r: 7 }, { c, r: 17 }] };
  }
  return { radius: 4, centers: [{ c: Math.floor(cols / 4), r: 9 }, { c: Math.floor((cols * 3) / 4), r: 9 }] };
}