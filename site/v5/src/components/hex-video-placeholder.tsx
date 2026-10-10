import { block, bounds, cellPoints, outline } from "@/lib/hex-regions";
import { HEX_ROW_STEP, HEX_WIDTH } from "@/lib/hex-grid";

export function HexVideoPlaceholder({ x0, width }: { x0: number; width: number }) {
  const columns = Math.max(4, Math.min(26, Math.floor((width - HEX_WIDTH * 2) / HEX_WIDTH)));
  const firstColumn = Math.max(0, Math.round((width / 2 - x0) / HEX_WIDTH - (columns - 1) / 2));
  const rows = Math.max(6, Math.round(columns * HEX_WIDTH / (HEX_ROW_STEP * (16 / 9))));
  const cells = block(firstColumn, firstColumn + columns - 1, 5, 5 + rows - 1);
  const box = bounds(cells, x0, 0);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  return (
    <g className="hex-video-placeholder" role="img" aria-label="Video placeholder" data-testid="video-placeholder">
      <defs><clipPath id="video-aperture">{cells.map((cell) => <polygon key={`${cell.c}:${cell.r}`} points={cellPoints(cell, x0)} />)}</clipPath></defs>
      <g className="hex-video-fill">{cells.map((cell) => <polygon key={`${cell.c}:${cell.r}`} points={cellPoints(cell, x0)} />)}</g>
      <path className="hex-video-edge" d={outline(cells, x0)} />
      <g transform={`translate(${cx} ${cy - 16})`}><circle className="hex-video-symbol" r="30" /><path className="hex-video-play" d="M-6 -11 L12 0 L-6 11 Z" /></g>
      <text className="hex-video-label" x={cx} y={cy + 48} textAnchor="middle">Video placeholder</text>
    </g>
  );
}
