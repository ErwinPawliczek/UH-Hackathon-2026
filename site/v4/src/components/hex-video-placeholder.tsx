import { block, bounds, cellPoints, outline } from "@/lib/hex-regions";
import { getHexVideoLayout } from "@/lib/hex-video-layout";

/** A video aperture whose boundary is made entirely from existing lattice cells. */
export function HexVideoPlaceholder({ x0, width }: { x0: number; width: number }) {
  const { columns, firstColumn, firstRow, rows } = getHexVideoLayout(width, x0);
  const cells = block(firstColumn, firstColumn + columns - 1, firstRow, firstRow + rows - 1);
  const box = bounds(cells, x0, 0);
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;

  return (
    <g className="hex-video-placeholder" role="img" aria-label="Video placeholder" data-testid="video-placeholder">
      <defs>
        {/* The same aperture can clip the eventual video without changing its outline. */}
        <clipPath id="video-aperture">
          {cells.map((cell) => <polygon key={`${cell.c}:${cell.r}`} points={cellPoints(cell, x0)} />)}
        </clipPath>
      </defs>
      <g className="hex-video-fill">
        {cells.map((cell) => <polygon key={`${cell.c}:${cell.r}`} points={cellPoints(cell, x0)} />)}
      </g>
      <path className="hex-video-edge" d={outline(cells, x0)} />
      <g transform={`translate(${cx} ${cy - 16})`}>
        <circle className="hex-video-symbol" r="30" />
        <path className="hex-video-play" d="M-6 -11 L12 0 L-6 11 Z" />
      </g>
      <text className="hex-video-label" x={cx} y={cy + 48} textAnchor="middle">Video placeholder</text>
    </g>
  );
}