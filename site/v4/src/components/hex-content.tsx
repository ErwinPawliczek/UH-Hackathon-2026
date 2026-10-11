import type { ReactNode } from "react";
import { bounds, cellCenter, cellPoints, outline, type Cell } from "@/lib/hex-regions";
import type { ContentKey, PitchLayout, Variant } from "@/lib/pitch-layout";
import { ANSWERS, PROBLEMS, STATS } from "@/content/pitch";

function Region({ cells, x0, variant, children, inset }: { cells: Cell[]; x0: number; variant: Variant; children?: ReactNode; inset: number }) {
  return (
    <g className={`hx-region hx-${variant}`}>
      {cells.map((cell) => <polygon key={`${cell.c}:${cell.r}`} className="hx-fill" points={cellPoints(cell, x0)} />)}
      <path className="hx-edge" d={outline(cells, x0)} />
      {children && (
        <foreignObject {...bounds(cells, x0, inset)}>
          <div className="hx-text">{children}</div>
        </foreignObject>
      )}
    </g>
  );
}

function Content({ k, i = 0 }: { k: ContentKey; i?: number | undefined }) {
  switch (k) {
    case "hero":
      return (<><p className="hx-eyebrow">Gulf Coast cascade risk</p><h1 className="hx-h1">One coast makes America's plastics. Its plants fail together.</h1><p className="hx-body">No tool sees the cascade coming. PetroGrid models the whole network.</p></>);
    case "stat": {
      const s = STATS[i]!;
      return <div className="hx-stat"><strong>{s.n}</strong><span>{s.t}</span><em>{s.s}</em></div>;
    }
    case "problemsHead":
      return (<><p className="hx-eyebrow">The problem</p><h2 className="hx-h2">Five ways it breaks</h2></>);
    case "problem": {
      const [title, body] = PROBLEMS[i]!;
      return <p className="hx-line"><b>{title}</b> {body}</p>;
    }
    case "cascadeHead":
      return (<><p className="hx-eyebrow">What we do</p><h2 className="hx-h2">See the cascade before it lands</h2></>);
    case "answer": {
      const [title, body] = ANSWERS[i]!;
      return (<><span className="hx-badge">{i + 1}</span><h3 className="hx-h3">{title}</h3><p className="hx-body">{body}</p></>);
    }
    case "close":
      return <div className="hx-close"><p className="hx-eyebrow">PetroGrid</p><h2 className="hx-h2">One coast. One model. Every plant knows its move.</h2></div>;
  }
}

/** Renders whatever the pitch layout engine places; no coordinates live here. */
export function HexContent({ x0, layout }: { x0: number; layout: PitchLayout }) {
  return (
    <g className={`hx-content hx-tier-${layout.tier}`} data-tier={layout.tier}>
      {layout.items.map((item) => {
        switch (item.kind) {
          case "region":
            return (
              <Region key={item.key} cells={item.cells} x0={x0} variant={item.variant} inset={item.inset}>
                {item.content && <Content k={item.content} i={item.index} />}
              </Region>
            );
          case "num":
            return <text key={item.key} className="hx-num" {...cellCenter(item.cell, x0)} dy="0.35em">{item.n}</text>;
          case "flow":
            return <polygon key={item.key} className={item.node ? "hx-node" : "hx-link"} points={cellPoints(item.cell, x0)} style={{ animationDelay: `${item.delay}s` }} />;
          case "label":
            return <text key={item.key} className="hx-label" x={item.x} y={item.y} textAnchor={item.anchor} dominantBaseline={item.anchor === "start" ? "middle" : undefined}>{item.text}</text>;
        }
      })}
    </g>
  );
}
