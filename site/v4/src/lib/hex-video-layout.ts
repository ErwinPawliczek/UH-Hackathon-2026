import { HEX_ROW_STEP, HEX_WIDTH } from "@/lib/hex-grid";
import { getTier } from "@/lib/pitch-layout";

export type HexVideoLayout = {
  columns: number;
  firstColumn: number;
  firstRow: number;
  rows: number;
};

export function getHexVideoLayout(width: number, originX: number): HexVideoLayout {
  const isPhone = getTier(width) === "phone";
  // Leave enough room for staggered rows, whose half-cell offset extends the
  // ragged aperture beyond its nominal column width.
  const horizontalMargin = isPhone ? HEX_WIDTH * 1.5 : HEX_WIDTH * 2;
  const columns = Math.max(4, Math.min(26, Math.floor((width - horizontalMargin) / HEX_WIDTH)));
  const firstColumn = Math.max(0, Math.round((width / 2 - originX) / HEX_WIDTH - (columns - 1) / 2));
  const rows = isPhone
    ? Math.max(9, Math.round((columns * HEX_WIDTH) / (HEX_ROW_STEP * (4 / 5))))
    : Math.max(6, Math.round((columns * HEX_WIDTH) / (HEX_ROW_STEP * (16 / 9))));

  return { columns, firstColumn, firstRow: isPhone ? 6 : 5, rows };
}