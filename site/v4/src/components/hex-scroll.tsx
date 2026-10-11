import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PetroChainMark } from "@/components/petrochain-mark";
import { HexVideoPlaceholder } from "@/components/hex-video-placeholder";
import { HexContent } from "@/components/hex-content";
import { HexQr, qrHeight } from "@/components/hex-qr";
import { WordmarkContentMask } from "@/components/wordmark-content-mask";
import { getOriginX, getPitchLayout } from "@/lib/pitch-layout";
import { getRowOffset, getSnapRow, GRID_SCALE, HEX_POINTS, HEX_RADIUS, HEX_ROW_STEP, HEX_WIDTH, WORDMARK_X } from "@/lib/hex-grid";

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
export function HexScroll({ mode = "video" }: { mode?: "video" | "pitch" | "blank" | "qr" }) {
  const selectedRow = useRef(0);
  const previousRow = useRef(0);
  const animatedBrand = useRef<SVGGElement>(null);
  const animatedWordmark = useRef<SVGGElement>(null);
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

  const centerX = getOriginX(width);
  const contentLayout = getPitchLayout(width, centerX);
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
    const movingParts = [brand, animatedWordmark.current].filter((part): part is SVGGElement => part !== null);
    movingParts.forEach((part) => part.getAnimations().forEach((animation) => animation.cancel()));
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    // Inertia: a long, gentle ease-out so the brand slides into place unhurried.
    movingParts.forEach((part) => part.animate(
      [{ transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0px, 0px)" }],
      { duration: 650, easing: "cubic-bezier(0.25, 1, 0.5, 1)" },
    ));
  }, [row]);

  // One pattern tile = two rows; anchored so row r's centers sit at y = CENTER_Y + r * step.
  const tileHeight = HEX_ROW_STEP * 2;
  return (
    <div className={`hex-scroll ${mode === "pitch" ? "hex-scroll-pitch" : ""}`} style={mode === "pitch" ? { height: contentLayout.height } : mode === "qr" ? { height: qrHeight(width, centerX) } : undefined} aria-label="PetroGrid hexagonal grid">
      <svg className="hex-scene" role="img" aria-label="PetroGrid logo snapped to a light grey hexagonal grid">
        <defs>
          {mode === "pitch" && <>
            <filter id="wordmark-content-soften" x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB">
              <feGaussianBlur stdDeviation={HEX_RADIUS * 0.35} />
            </filter>
            <WordmarkContentMask id="wordmark-content" x0={centerX} width={width} layout={contentLayout} />
          </>}
          <pattern id="hex-tile" patternUnits="userSpaceOnUse" width={HEX_WIDTH} height={tileHeight} x={centerX} y={CENTER_Y}>
            <g fill="none" stroke="var(--grid-line)" strokeWidth="1">
              {[0, HEX_WIDTH].map((x) => <polygon key={`a${x}`} points={HEX_POINTS} transform={`translate(${x} 0)`} />)}
              {[-HEX_WIDTH / 2, HEX_WIDTH / 2, HEX_WIDTH * 1.5].map((x) => <polygon key={`b${x}`} points={HEX_POINTS} transform={`translate(${x} ${HEX_ROW_STEP})`} />)}
              {[0, HEX_WIDTH].map((x) => <polygon key={`c${x}`} points={HEX_POINTS} transform={`translate(${x} ${tileHeight})`} />)}
            </g>
          </pattern>
        </defs>
        <rect data-testid="hex-grid" width="100%" height="100%" fill="url(#hex-tile)" />
        {mode === "blank" ? null : mode === "video" ? <HexVideoPlaceholder x0={centerX} width={width} /> : mode === "qr" ? <HexQr x0={centerX} width={width} /> : <HexContent x0={centerX} layout={contentLayout} />}
        <g data-testid="snapping-logo" data-row={row} data-center-x={logoX} data-center-y={logoY} transform={`translate(${logoX} ${logoY})`}>
          <g ref={animatedBrand} data-testid="animated-brand">
            <g transform={`scale(${GRID_SCALE})`}><PetroChainMark /></g>
          </g>
        </g>
        <g mask={mode === "pitch" ? "url(#wordmark-content)" : undefined} data-testid="wordmark-layer">
          <g transform={`translate(${logoX} ${logoY})`}>
            <g ref={animatedWordmark}>
              <text x={WORDMARK_X} y="1" dominantBaseline="middle" className="identity-wordmark" fill="var(--foreground)">Petro<tspan fill="var(--primary)">Grid</tspan></text>
            </g>
          </g>
        </g>
      </svg>
    </div>
  );
}
