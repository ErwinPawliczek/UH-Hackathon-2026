import { blob, bounds, cellCenter, cellPoints, outline, GRID_TOP } from "@/lib/hex-regions";
import { getQrPlacement } from "@/lib/qr-layout";
import { HEX_RADIUS, HEX_ROW_STEP } from "@/lib/hex-grid";

const CODES = [
  { label: "Demo", src: "/qr/ezqr-demo.svg", domain: "demo.petrogrid.xyz" },
  { label: "Main Page", src: "/qr/ezqr-main.svg", domain: "petrogrid.xyz" },
];

/** Page height the QR layout needs, so the grid sheet always covers both regions. */
export function qrHeight(width: number, x0: number): number {
  const { centers, radius } = getQrPlacement(width, x0);
  const lastRow = Math.max(...centers.map((c) => c.r)) + radius;
  return GRID_TOP + (lastRow + 1) * HEX_ROW_STEP;
}

/** The two QR codes, each hugged by a grid-cut hex outline with a clean interior. */
export function HexQr({ x0, width }: { x0: number; width: number }) {
  const { centers, radius } = getQrPlacement(width, x0);
  const inset = radius <= 3 ? 10 : 18;
  return (
    <g className="hx-content">
      {centers.map((center, i) => {
        const cells = blob(center, radius);
        const code = CODES[i];
        if (!code) return null;
        const { y: cy } = cellCenter(center, x0);
        // The name sits above its outline, clear of the region's top vertex.
        const labelY = cy - radius * HEX_ROW_STEP - HEX_RADIUS - 18;
        return (
          <g className="hx-region hx-qr" key={code.label}>
            {cells.map((cell) => <polygon key={`${cell.c}:${cell.r}`} className="hx-fill" points={cellPoints(cell, x0)} />)}
            <path className="hx-edge" d={outline(cells, x0)} />
            <foreignObject {...bounds(cells, x0, inset)}>
              <div className="hx-text qr-card">
                <img src={code.src} alt={`QR code for ${code.domain}`} />
              </div>
            </foreignObject>
            <text className="hx-label qr-label" x={cellCenter(center, x0).x} y={labelY} textAnchor="middle">
              <tspan className="qr-label-name">{code.label}</tspan>
            </text>
          </g>
        );
      })}
    </g>
  );
}
