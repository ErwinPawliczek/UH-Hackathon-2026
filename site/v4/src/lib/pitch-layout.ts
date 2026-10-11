import { HEX_RADIUS, HEX_ROW_STEP, HEX_WIDTH } from "@/lib/hex-grid";
import { blob, block, cellCenter, GRID_TOP, type Cell } from "@/lib/hex-regions";
import { CASCADE, PROBLEMS, STATS, ANSWERS } from "@/content/pitch";

export type Tier = "phone" | "tablet" | "desktop" | "wide";
export type Variant = "outline" | "blue" | "solid" | "quiet";
export type ContentKey = "hero" | "stat" | "problemsHead" | "problem" | "cascadeHead" | "answer" | "close";

export type PitchItem =
  | { kind: "region"; key: string; cells: Cell[]; variant: Variant; inset: number; content?: ContentKey; index?: number }
  | { kind: "num"; key: string; cell: Cell; n: number }
  | { kind: "flow"; key: string; cell: Cell; node: boolean; delay: number }
  | { kind: "label"; key: string; text: string; x: number; y: number; anchor: "middle" | "start" };

export type PitchLayout = { tier: Tier; columns: number; firstColumn: number; height: number; items: PitchItem[] };

/** Single source of truth for screen-size breakpoints (also used by the video page). */
export function getTier(width: number): Tier {
  if (width < 600) return "phone";
  if (width < 1024) return "tablet";
  if (width < 1600) return "desktop";
  return "wide";
}

/** Grid x-origin for a screen width; the logo is pinned to this column. */
export function getOriginX(width: number) {
  return width < 600 ? 44 : 64;
}

/** Largest column count whose staggered rows still fit inside the screen. */
export function maxColumns(width: number, originX: number) {
  return Math.floor((width - 8 - originX) / HEX_WIDTH);
}

const TIER_COLUMNS: Record<Tier, (fit: number, width: number) => number> = {
  phone: (fit) => fit,
  tablet: (fit) => Math.min(16, fit - 1),
  desktop: (fit) => Math.min(22, fit - 2),
  wide: (fit, width) => Math.min(28, Math.floor((width * 0.6) / HEX_WIDTH), fit - 2),
};

export function getPitchLayout(width: number, originX = getOriginX(width)): PitchLayout {
  const tier = getTier(width);
  const fit = maxColumns(width, originX);
  const columns = Math.max(6, TIER_COLUMNS[tier](fit, width));
  const stacked = tier === "phone" || tier === "tablet";
  // Center the content block on the grid, snapped to whole cells.
  const firstColumn = tier === "phone" ? 0 : Math.max(0, Math.round(((width - columns * HEX_WIDTH) / 2 - originX) / HEX_WIDTH + 0.5));
  const c0 = firstColumn;
  const c1 = c0 + columns - 1;
  const mid = c0 + Math.floor(columns / 2);
  const items: PitchItem[] = [];
  const gap = 2;
  let r = tier === "phone" ? 4 : 3;

  // Hero
  const heroRows = { phone: 12, tablet: 9, desktop: 7, wide: 8 }[tier];
  items.push({ kind: "region", key: "hero", cells: block(c0, c1, r, r + heroRows - 1), variant: "outline", inset: tier === "phone" ? 20 : 44, content: "hero" });
  r += heroRows + gap + 1;

  // Stats
  const radius = tier === "wide" ? 3 : 2;
  const statInset = tier === "wide" ? 40 : tier === "phone" ? 25 : 30;
  if (tier === "phone") {
    STATS.forEach((_, i) => {
      const cr = r + 2 + i * 6;
      items.push({ kind: "region", key: `stat${i}`, cells: blob({ c: mid, r: cr }, 2), variant: i === 0 ? "blue" : "outline", inset: statInset, content: "stat", index: i });
    });
    r += 18;
  } else if (tier === "tablet") {
    const q = Math.floor(columns / 4);
    ([[c0 + q, r + 2], [c1 - q, r + 2], [mid, r + 8]] as [number, number][]).forEach(([c, cr], i) => {
      items.push({ kind: "region", key: `stat${i}`, cells: blob({ c, r: cr }, 2), variant: i === 0 ? "blue" : "outline", inset: statInset, content: "stat", index: i });
    });
    r += 12;
  } else {
    const span = Math.floor(columns / 3);
    STATS.forEach((_, i) => {
      items.push({ kind: "region", key: `stat${i}`, cells: blob({ c: c0 + i * span + Math.floor(span / 2), r: r + radius }, radius), variant: i === 0 ? "blue" : "outline", inset: statInset, content: "stat", index: i });
    });
    r += radius * 2 + 1;
  }
  r += gap;

  // Problems
  const headRows = tier === "phone" ? 4 : 3;
  items.push({ kind: "region", key: "problemsHead", cells: block(c0, Math.min(c1, c0 + (tier === "wide" ? 17 : 12)), r, r + headRows - 1), variant: "quiet", inset: 8, content: "problemsHead" });
  r += headRows + 1;
  PROBLEMS.forEach((_, i) => {
    if (stacked) {
      const rowsEach = tier === "phone" ? 3 : 2;
      items.push({ kind: "region", key: `pn${i}`, cells: [{ c: c0, r }], variant: "solid", inset: 0 });
      items.push({ kind: "num", key: `n${i}`, cell: { c: c0, r }, n: i + 1 });
      items.push({ kind: "region", key: `p${i}`, cells: block(c0 + 1, c1, r, r + rowsEach - 1), variant: "quiet", inset: 10, content: "problem", index: i });
      r += rowsEach + 1;
    } else {
      const c = c0 + i;
      items.push({ kind: "region", key: `pn${i}`, cells: [{ c, r }], variant: "solid", inset: 0 });
      items.push({ kind: "num", key: `n${i}`, cell: { c, r }, n: i + 1 });
      items.push({ kind: "region", key: `p${i}`, cells: block(c + 1, Math.min(c1, c + 16), r, r), variant: "quiet", inset: 2, content: "problem", index: i });
      r += 2;
    }
  });
  r += gap;

  // Cascade
  items.push({ kind: "region", key: "cascadeHead", cells: block(c0, Math.min(c1, c0 + (tier === "wide" ? 17 : 12)), r, r + headRows - 1), variant: "quiet", inset: 8, content: "cascadeHead" });
  r += headRows + 2;
  if (stacked) {
    CASCADE.forEach((text, i) => {
      const cell = { c: c0 + 1, r: r + i * 3 };
      // Keep the chain on one column: shift odd rows back so cells touch.
      items.push({ kind: "flow", key: `f${i}`, cell, node: true, delay: i * 0.54 });
      const { x, y } = cellCenter(cell, originX);
      items.push({ kind: "label", key: `l${i}`, text, x: x + HEX_WIDTH * 1.1, y, anchor: "start" });
      if (i < CASCADE.length - 1) [1, 2].forEach((o) => items.push({ kind: "flow", key: `f${i}-${o}`, cell: { c: c0 + 1, r: cell.r + o }, node: false, delay: i * 0.54 + o * 0.18 }));
    });
    r += CASCADE.length * 3;
  } else {
    const n = CASCADE.length * 3 - 2;
    const start = c0 + Math.floor((columns - n) / 2);
    for (let i = 0; i < n; i++) items.push({ kind: "flow", key: `f${i}`, cell: { c: start + i, r }, node: i % 3 === 0, delay: i * 0.18 });
    CASCADE.forEach((text, i) => {
      const { x, y } = cellCenter({ c: start + i * 3, r }, originX);
      items.push({ kind: "label", key: `l${i}`, text, x, y: y + HEX_ROW_STEP * 1.25, anchor: "middle" });
    });
    r += 3;
  }
  r += gap;

  // Answers
  if (stacked) {
    const rowsEach = tier === "phone" ? 5 : 4;
    ANSWERS.forEach((_, i) => {
      items.push({ kind: "region", key: `a${i}`, cells: block(c0, c1, r, r + rowsEach - 1), variant: i === 2 ? "blue" : "outline", inset: 20, content: "answer", index: i });
      r += rowsEach + 1;
    });
  } else {
    const w = Math.floor((columns - 2) / 3);
    const rows = tier === "wide" ? 6 : 5;
    ANSWERS.forEach((_, i) => {
      const a = c0 + i * (w + 1);
      items.push({ kind: "region", key: `a${i}`, cells: block(a, a + w - 1, r, r + rows - 1), variant: i === 2 ? "blue" : "outline", inset: 30, content: "answer", index: i });
    });
    r += rows;
  }
  r += gap + 1;

  // Closing
  if (tier === "phone") {
    items.push({ kind: "region", key: "close", cells: block(c0, c1, r, r + 8), variant: "blue", inset: 24, content: "close" });
    r += 9;
  } else {
    const R = tier === "wide" ? 5 : 4;
    items.push({ kind: "region", key: "close", cells: blob({ c: mid, r: r + R }, R), variant: "blue", inset: tier === "tablet" ? 60 : 70, content: "close" });
    r += R * 2 + 1;
  }

  return { tier, columns, firstColumn, height: GRID_TOP + (r + 1) * HEX_ROW_STEP + HEX_RADIUS, items };
}
