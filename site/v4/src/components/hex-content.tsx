import type { ReactNode } from "react";
import { blob, block, bounds, cellCenter, cellPoints, outline, type Cell } from "@/lib/hex-regions";
import { HEX_ROW_STEP } from "@/lib/hex-grid";

type Variant = "outline" | "blue" | "solid" | "quiet";

function Region({ cells, x0, variant = "outline", children, inset }: { cells: Cell[]; x0: number; variant?: Variant; children?: ReactNode; inset?: number }) {
  const box = bounds(cells, x0, inset);
  return (
    <g className={`hx-region hx-${variant}`}>
      {cells.map((cell) => <polygon key={`${cell.c}:${cell.r}`} className="hx-fill" points={cellPoints(cell, x0)} />)}
      <path className="hx-edge" d={outline(cells, x0)} />
      {children && (
        <foreignObject {...box}>
          <div className="hx-text">{children}</div>
        </foreignObject>
      )}
    </g>
  );
}

const STATS = [
  { n: "95%+", t: "of U.S. ethylene capacity sits on the Gulf Coast", s: "PolitiFact, 2018" },
  { n: "75%", t: "of U.S. polyethylene was knocked offline by one storm", s: "Chemistry World, 2021" },
  { n: "$100M", t: "a single cracker outage can cost", s: "Industrial Info, 2014" },
];

const PROBLEMS = [
  ["Concentrated", "One coastline, one pipeline web, one weather system."],
  ["Coupled", "Every plant feeds the next. One trip ripples downstream."],
  ["Blind", "Each operator sees only their own fence line."],
  ["Late", "By the time a shortage shows up, the options are gone."],
  ["Dirty", "Panic shutdowns and restarts flare the most emissions."],
];

const CASCADE = ["Cracker", "Pipeline", "Storage", "PE plant", "PP plant", "Port", "Resin buyer"];

const ANSWERS = [
  ["How long", "Hours of runway before the disruption reaches you."],
  ["What it costs", "The dollar impact of running on versus cutting early."],
  ["Best move", "The action that protects margin and avoids flaring."],
];

export const CONTENT_ROWS = 66;

export function HexContent({ x0 }: { x0: number }) {
  return (
    <g className="hx-content">
      {/* Hero: a ragged block cut out of the lattice */}
      <Region cells={block(3, 17, 3, 9)} x0={x0} inset={44}>
        <p className="hx-eyebrow">Gulf Coast cascade risk</p>
        <h1 className="hx-h1">One coast makes America's plastics. Its plants fail together.</h1>
        <p className="hx-body">No tool sees the cascade coming. PetroGrid models the whole network.</p>
      </Region>

      {/* Numbers: each stat is a hexagon made of hexagons */}
      {STATS.map((s, i) => (
        <Region key={s.n} cells={blob({ c: 5 + i * 6, r: 15 }, 2)} x0={x0} variant={i === 0 ? "blue" : "outline"} inset={30}>
          <div className="hx-stat">
            <strong>{s.n}</strong>
            <span>{s.t}</span>
            <em>{s.s}</em>
          </div>
        </Region>
      ))}

      {/* Problem: a staircase of solid cells walking down the grid */}
      <Region cells={block(3, 13, 20, 22)} x0={x0} variant="quiet" inset={8}>
        <p className="hx-eyebrow">The problem</p>
        <h2 className="hx-h2">Five ways it breaks</h2>
      </Region>
      {PROBLEMS.map(([title, body], i) => {
        const r = 24 + i * 2;
        const c = 3 + i;
        return (
          <g key={title}>
            <Region cells={[{ c, r }]} x0={x0} variant="solid" />
            <text className="hx-num" {...cellCenter({ c, r }, x0)} dy="0.35em">{i + 1}</text>
            <Region cells={block(c + 1, c + 15, r, r)} x0={x0} variant="quiet" inset={2}>
              <p className="hx-line"><b>{title}</b> {body}</p>
            </Region>
          </g>
        );
      })}

      {/* Cascade: failure travels cell by cell along one grid row */}
      <Region cells={block(3, 13, 35, 37)} x0={x0} variant="quiet" inset={8}>
        <p className="hx-eyebrow">What we do</p>
        <h2 className="hx-h2">See the cascade before it lands</h2>
      </Region>
      {Array.from({ length: 19 }, (_, i) => {
        const cell = { c: 3 + i, r: 40 };
        const node = i % 3 === 0;
        return (
          <polygon key={i} className={node ? "hx-node" : "hx-link"} points={cellPoints(cell, x0)} style={{ animationDelay: `${i * 0.18}s` }} />
        );
      })}
      {CASCADE.map((label, i) => {
        const { x, y } = cellCenter({ c: 3 + i * 3, r: 40 }, x0);
        return <text key={label} className="hx-label" x={x} y={y + HEX_ROW_STEP * 1.25} textAnchor="middle">{label}</text>;
      })}

      {/* Answers: three columns cut from the same rows */}
      {ANSWERS.map(([title, body], i) => (
        <Region key={title} cells={block(3 + i * 7, 8 + i * 7, 45, 49)} x0={x0} variant={i === 2 ? "blue" : "outline"} inset={30}>
          <span className="hx-badge">{i + 1}</span>
          <h3 className="hx-h3">{title}</h3>
          <p className="hx-body">{body}</p>
        </Region>
      ))}

      {/* Closing: one big hexagon */}
      <Region cells={blob({ c: 12, r: 58 }, 4)} x0={x0} variant="blue" inset={70}>
        <div className="hx-close">
          <p className="hx-eyebrow">PetroGrid</p>
          <h2 className="hx-h2">One coast. One model. Every plant knows its move.</h2>
        </div>
      </Region>
    </g>
  );
}
