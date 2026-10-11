import { cellPoints } from "@/lib/hex-regions";
import type { PitchLayout } from "@/lib/pitch-layout";
import { HEX_RADIUS } from "@/lib/hex-grid";

/** World-space occlusion: content stays stationary while the wordmark passes behind it. */
export function WordmarkContentMask({ id, x0, width, layout }: { id: string; x0: number; width: number; layout: PitchLayout }) {
  return (
    <mask id={id} maskUnits="userSpaceOnUse" x="0" y="0" width={width} height={layout.height} style={{ maskType: "luminance" }}>
      <rect width={width} height={layout.height} fill="var(--mask-visible)" />
      <g fill="var(--mask-hidden)" stroke="var(--mask-hidden)" strokeWidth={HEX_RADIUS * 0.6} filter={`url(#${id}-soften)`}>
        {layout.items.map((item) => {
          if (item.kind === "region") return <g key={item.key}>{item.cells.map((cell) => <polygon key={`${cell.c}:${cell.r}`} points={cellPoints(cell, x0)} />)}</g>;
          if (item.kind === "flow") return <polygon key={item.key} points={cellPoints(item.cell, x0)} />;
          if (item.kind === "label") return <text key={item.key} className="hx-label" x={item.x} y={item.y} textAnchor={item.anchor} dominantBaseline={item.anchor === "start" ? "middle" : undefined}>{item.text}</text>;
          return null;
        })}
      </g>
    </mask>
  );
}