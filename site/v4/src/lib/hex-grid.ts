export const GRID_SCALE = 0.4;
export const HEX_RADIUS = 56 * GRID_SCALE;
export const HEX_WIDTH = 96.96 * GRID_SCALE;
export const HEX_ROW_STEP = HEX_RADIUS * 1.5;

// Derived from the scale so every zoom keeps the logo exactly on a grid hexagon.
const HALF_FLAT = HEX_WIDTH / 2;
export const HEX_POINTS = `0,${-HEX_RADIUS} ${HALF_FLAT},${-HEX_RADIUS / 2} ${HALF_FLAT},${HEX_RADIUS / 2} 0,${HEX_RADIUS} ${-HALF_FLAT},${HEX_RADIUS / 2} ${-HALF_FLAT},${-HEX_RADIUS / 2}`;

// Keeps the name locked to the logo at any zoom level. 128 sits just past the
// blue tail's endpoint, which lands on the next grid intersection one hexagon
// out at unscaled x ≈ 112.5 plus the endpoint dot.
export const WORDMARK_X = 128 * GRID_SCALE;

// A dead band prevents trackpad jitter from repeatedly reversing a snap.
export function getSnapRow(scroll: number, currentRow: number): number {
  const distance = scroll - currentRow * HEX_ROW_STEP;
  const threshold = HEX_ROW_STEP * 0.7;
  if (distance > threshold) {
    return currentRow + Math.ceil((distance - threshold) / HEX_ROW_STEP);
  }
  if (distance < -threshold) {
    return currentRow - Math.ceil((-distance - threshold) / HEX_ROW_STEP);
  }
  return currentRow;
}

export function getRowOffset(row: number): number {
  return Math.abs(row % 2) * HEX_WIDTH / 2;
}

// Render in viewport-local coordinates, not ever-growing document coordinates.
export function getViewportAttachment(scroll: number, previousRow: number) {
  const row = getSnapRow(scroll, previousRow);
  // Derive the phase from the row instead of using `%`, whose rounding can
  // disagree with floor() and throw the brand a full hexagon off center.
  const viewportRow = Math.round(scroll / HEX_ROW_STEP - 0.5);
  const phase = scroll - viewportRow * HEX_ROW_STEP;
  return { row, viewportRow, phase, offsetY: (row - viewportRow) * HEX_ROW_STEP - phase };
}
