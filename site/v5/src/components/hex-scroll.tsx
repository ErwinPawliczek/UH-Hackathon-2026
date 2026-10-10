import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { PetroChainMark } from "@/components/petrochain-mark";
import { HexVideoPlaceholder } from "@/components/hex-video-placeholder";
import { getRowOffset, getSnapRow, GRID_SCALE, HEX_POINTS, HEX_ROW_STEP, HEX_WIDTH, WORDMARK_X } from "@/lib/hex-grid";

const CENTER_Y = 80;

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
      selectedRow.current = getSnapRow(window.scrollY, selectedRow.current);
      setRow(selectedRow.current);
      setWidth(window.innerWidth);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(update); };
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
  const logoY = CENTER_Y + row * HEX_ROW_STEP;
  useLayoutEffect(() => {
    const brand = animatedBrand.current;
    const oldRow = previousRow.current;
    previousRow.current = row;
    if (!brand || oldRow === row) return;
    const matrix = new DOMMatrixReadOnly(getComputedStyle(brand).transform);
    const x = matrix.m41 + getRowOffset(oldRow) - getRowOffset(row);
    const y = Math.max(-HEX_ROW_STEP * 2, Math.min(HEX_ROW_STEP * 2, matrix.m42 + (oldRow - row) * HEX_ROW_STEP));
    brand.getAnimations().forEach((animation) => animation.cancel());
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    brand.animate([{ transform: `translate(${x}px, ${y}px)` }, { transform: "translate(0px, 0px)" }], { duration: 650, easing: "cubic-bezier(0.25, 1, 0.5, 1)" });
  }, [row]);
  const tileHeight = HEX_ROW_STEP * 2;
  return (
    <div className="hex-scroll" aria-label="PetroGrid hexagonal grid">
      <svg className="hex-scene" role="img" aria-label="PetroGrid logo snapped to a light grey hexagonal grid">
        <defs><pattern id="hex-tile" patternUnits="userSpaceOnUse" width={HEX_WIDTH} height={tileHeight} x={centerX} y={CENTER_Y}>
          <g fill="none" stroke="var(--grid-line)" strokeWidth="1">
            {[0, HEX_WIDTH].map((x) => <polygon key={`a${x}`} points={HEX_POINTS} transform={`translate(${x} 0)`} />)}
            {[-HEX_WIDTH / 2, HEX_WIDTH / 2, HEX_WIDTH * 1.5].map((x) => <polygon key={`b${x}`} points={HEX_POINTS} transform={`translate(${x} ${HEX_ROW_STEP})`} />)}
            {[0, HEX_WIDTH].map((x) => <polygon key={`c${x}`} points={HEX_POINTS} transform={`translate(${x} ${tileHeight})`} />)}
          </g>
        </pattern></defs>
        <rect data-testid="hex-grid" width="100%" height="100%" fill="url(#hex-tile)" />
        <HexVideoPlaceholder x0={centerX} width={width} />
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
