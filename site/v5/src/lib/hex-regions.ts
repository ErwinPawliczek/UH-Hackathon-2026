import { getRowOffset, HEX_RADIUS, HEX_ROW_STEP, HEX_WIDTH } from "@/lib/hex-grid";

export type Cell = { c: number; r: number };

// Must match the grid pattern anchor in hex-scroll.
export const GRID_TOP = 80;

export function cellCenter({ c, r }: Cell, originX: number) {
  return { x: originX + c * HEX_WIDTH + getRowOffset(r), y: GRID_TOP + r * HEX_ROW_STEP };
}

function corners(cell: Cell, originX: number): [number, number][] {
  const { x, y } = cellCenter(cell, originX);
  const h = HEX_WIDTH / 2;
  const R = HEX_RADIUS;
  const out: [number, number][] = [[x, y - R], [x + h, y - R / 2], [x + h, y + R / 2], [x, y + R], [x - h, y + R / 2], [x - h, y - R / 2]];
  return out;
}

export function cellPoints(cell: Cell, originX: number) {
  return corners(cell, originX).map((p) => p.join(",")).join(" ");
}

/** Rectangle-ish block of cells (ragged hex edges). */
export function block(c0: number, c1: number, r0: number, r1: number): Cell[] {
  const out: Cell[] = [];
  for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) out.push({ c, r });
  return out;
}

const parity = (r: number) => ((r % 2) + 2) % 2;

/** All cells within `radius` hex steps of a center: a big hexagon made of cells. */
export function blob(center: Cell, radius: number): Cell[] {
  const q0 = center.c - (center.r - parity(center.r)) / 2;
  const out: Cell[] = [];
  for (let dq = -radius; dq <= radius; dq++) {
    for (let dr = Math.max(-radius, -dq - radius); dr <= Math.min(radius, -dq + radius); dr++) {
      const r = center.r + dr;
      out.push({ r, c: q0 + dq + (r - parity(r)) / 2 });
    }
  }
  return out;
}

/** Outer boundary of a set of cells, traced along the grid's own edges. */
export function outline(cells: Cell[], originX: number): string {
  const edges = new Map<string, { a: [number, number]; b: [number, number]; n: number }>();
  const k = (p: [number, number]) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`;
  for (const cell of cells) {
    const pts = corners(cell, originX);
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % 6]!;
      const key = [k(a), k(b)].sort().join("|");
      const e = edges.get(key);
      if (e) e.n++;
      else edges.set(key, { a, b, n: 1 });
    });
  }
  let d = "";
  for (const e of edges.values()) if (e.n === 1) d += `M${e.a[0]} ${e.a[1]}L${e.b[0]} ${e.b[1]}`;
  return d;
}

/** Inner text box of a cell region, inset so text never touches the ragged edge. */
export function bounds(cells: Cell[], originX: number, inset = HEX_WIDTH * 0.6) {
  const xs = cells.map((cell) => cellCenter(cell, originX).x);
  const ys = cells.map((cell) => cellCenter(cell, originX).y);
  const x = Math.min(...xs) + inset - HEX_WIDTH / 2;
  const y = Math.min(...ys) - HEX_RADIUS / 2 + inset * 0.5;
  return { x, y, width: Math.max(...xs) - Math.min(...xs) + HEX_WIDTH - inset * 2, height: Math.max(...ys) - Math.min(...ys) + HEX_RADIUS - inset };
}
