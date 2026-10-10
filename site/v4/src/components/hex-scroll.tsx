import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PetroChainMark } from "@/components/petrochain-mark";
import { HexContent } from "@/components/hex-content";
import { getRowOffset, getSnapRow, GRID_SCALE, HEX_POINTS, HEX_ROW_STEP, HEX_WIDTH, WORDMARK_X } from "@/lib/hex-grid";

// Enough room that the hexagon's top vertex and its blue tail stay on screen
// when the brand sits on its topmost snap row.
const CENTER_Y = 80;

/**
 * The grid is printed onto the page (it scrolls natively with the document, so it
 * always moves up as you scroll down). The brand lives on the same sheet, always on
 * the grid row nearest the top-left corner (with hysteresis), so it stays near the top-left of
 * the screen while the lattice moves beneath it; it only glides when it hops to
 * the next cell.
 */
export function HexScroll() {
  const selectedRow = useRef(0);
  const previousRow = useRef(0);
  const animatedBrand = useRef<SVGGElement>(null);
  const [row, setRow] = useState(0);
  const [width, setWidth] = useState(1280);

  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      // The brand sits on page row k; it rides with the grid until the next row
      // is closer to the top-left corner, then hops there. Its screen offset from
      // the corner is therefore always less than one row, so it never drifts away.
      selectedRow.current = getSnapRow(window.scrollY, selectedRow.current);
      setRow(selectedRow.current);
      setWidth(window.innerWidth);
    };
    const schedule = () => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", schedule, { passive: true });
    window.addEventListener("resize", schedule);
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", schedule);
      window.removeEventListener("resize", schedule);
    };
  }, []);

  const centerX = width < 600 ? 44 : 64;
  const logoX = centerX + getRowOffset(row);
  // Always exactly on a grid cell center (page coordinates, same sheet as the grid).
  const logoY = CENTER_Y + row * HEX_ROW_STEP;

  useLayoutEffect(() => {
    const brand = animatedBrand.current;
    const oldRow = previousRow.current;
    previousRow.current = row;
    if (!brand || oldRow === row) return;
    // Start the glide from where the brand visually was, then settle on the new cell.
    const matrix = new DOMMatrixReadOnly(getComputedStyle(brand).transform);
    const x = matrix.m41 + getRowOffset(oldRow) - getRowOffset(row);
    const y = Math.max(-HEX_ROW_STEP * 2, Math.min(HEX_ROW_STEP * 2, matrix.m42 + (oldRow - row) * HEX_ROW_STEP));
    brand.getAnimations().forEach((animation) => animation.cancel());
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Inertia: a long, gentle ease-out so the brand slides into place unhurried.
    brand.animate(
      [{ transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0px, 0px)" }],
      { duration: 650, easing: "cubic-bezier(0.25, 1, 0.5, 1)" },
    );
  }, [row]);

  // One pattern tile = two rows; anchored so row r's centers sit at y = CENTER_Y + r * step.
  const tileHeight = HEX_ROW_STEP * 2;
  return (
    <div className="hex-scroll" aria-label="PetroGrid hexagonal grid">
      <svg className="hex-scene" role="img" aria-label="PetroGrid logo snapped to a light grey hexagonal grid">
        <defs>
          <pattern id="hex-tile" patternUnits="userSpaceOnUse" width={HEX_WIDTH} height={tileHeight} x={centerX} y={CENTER_Y}>
            <g fill="none" stroke="var(--grid-line)" strokeWidth="1">
              {[0, HEX_WIDTH].map((x) => <polygon key={`a${x}`} points={HEX_POINTS} transform={`translate(${x} 0)`} />)}
              {[-HEX_WIDTH / 2, HEX_WIDTH / 2, HEX_WIDTH * 1.5].map((x) => <polygon key={`b${x}`} points={HEX_POINTS} transform={`translate(${x} ${HEX_ROW_STEP})`} />)}
              {[0, HEX_WIDTH].map((x) => <polygon key={`c${x}`} points={HEX_POINTS} transform={`translate(${x} ${tileHeight})`} />)}
            </g>
          </pattern>
        </defs>
        <rect data-testid="hex-grid" width="100%" height="100%" fill="url(#hex-tile)" />
        <HexContent x0={centerX} />
        <g data-testid="snapping-logo" data-row={row} data-center-x={logoX} data-center-y={logoY} transform={`translate(${logoX} ${logoY})`}>
          <g ref={animatedBrand} data-testid="animated-brand">
            <g transform={`scale(${GRID_SCALE})`}><PetroChainMark /></g>
            <text x={WORDMARK_X} y="1" dominantBaseline="middle" className="identity-wordmark" fill="var(--foreground)">Petro<tspan fill="var(--primary)">Grid</tspan></text>
          </g>
        </g>
      </svg>
    </div>
  );
}
