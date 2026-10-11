// Axial hex-grid math (pointy-top) and terrain classification, in one pure
// module: no three.js, no scene state — everything here is unit-agnostic
// plane geometry over whatever unit the caller uses (the scene passes map km).
//
// Pointy-top hexagons: vertices up/down, flat sides left/right. Neighbours sit
// √3·size apart horizontally and 1.5·size apart vertically, which matches
// CylinderGeometry(r, r, h, 6) in the scene (its first vertex points at +z).

import { sampleHeight, type TerrainGrid } from '../engine/world';

/** Terrain classes the board samples the height grid into. */
export type TerrainClass = 'water' | 'sand' | 'grass' | 'forest';

/** One board cell: axial coordinates, terrain class, representative height. */
export interface HexCell {
  q: number;
  r: number;
  terrain: TerrainClass;
  /**
   * Metres at this cell — the minimum over the centre and the six corners, so
   * a flat cell built from it never pokes above the smooth height field that
   * routes and vehicles are draped on.
   */
  heightM: number;
}

/** Axial hex coordinates. */
export interface Hex {
  q: number;
  r: number;
}

const SQRT3 = Math.sqrt(3);

const HEX_DIRS: readonly [number, number][] = [
  [1, 0],
  [1, -1],
  [0, -1],
  [-1, 0],
  [-1, 1],
  [0, 1],
];

/** World (x, z) → the axial cell containing that point (cube rounding). */
export function worldToHex(x: number, z: number, size: number): Hex {
  const qf = ((SQRT3 / 3) * x - (1 / 3) * z) / size;
  const rf = ((2 / 3) * z) / size;
  return axialRound(qf, rf);
}

/** Axial cell → the world (x, z) of its centre. Inverse of `worldToHex`. */
export function hexCenter(q: number, r: number, size: number): [number, number] {
  return [size * SQRT3 * (q + r / 2), size * 1.5 * r];
}

/** Corner `i` (0..5) of the hex centred at (x, z); corners start at 30°. */
export function hexCorner(x: number, z: number, size: number, i: number): [number, number] {
  const a = (Math.PI / 180) * (60 * i + 30);
  return [x + size * Math.cos(a), z + size * Math.sin(a)];
}

/** The six cells at ring distance `k` from the origin (k = 0 → the origin). */
export function hexRing(k: number): Hex[] {
  if (k === 0) return [{ q: 0, r: 0 }];
  const out: Hex[] = [];
  let q = -k; // k steps in direction (−1, 1), then walk the ring
  let r = k;
  for (const [dq, dr] of HEX_DIRS) {
    for (let j = 0; j < k; j++) {
      out.push({ q, r });
      q += dq;
      r += dr;
    }
  }
  return out;
}

/** First `n` cells of a spiral out from the origin — a compact blob layout. */
export function hexSpiral(n: number): Hex[] {
  const out: Hex[] = [{ q: 0, r: 0 }];
  for (let k = 1; out.length < n && k < 64; k++) out.push(...hexRing(k));
  return out.slice(0, Math.max(1, n));
}

/**
 * Terrain class from a height sample. Shoreline sand is the 25 m band above
 * sea level; forest covers the high inland terrain, grass the rest.
 */
export function classifyTerrain(heightM: number, seaLevelM: number): TerrainClass {
  if (heightM < seaLevelM) return 'water';
  if (heightM < seaLevelM + 25) return 'sand';
  if (heightM >= seaLevelM + 220) return 'forest';
  return 'grass';
}

/**
 * Sample the height grid into board cells covering the full map extent.
 * `hexSizeKm` is the hex circumradius in km; class comes from the height at
 * the cell centre, `heightM` from the deepest of centre + corners.
 */
export function buildCells(grid: TerrainGrid, hexSizeKm: number): HexCell[] {
  const wKm = (grid.cols - 1) * grid.cellKm;
  const hKm = (grid.rows - 1) * grid.cellKm;
  const corners = Array.from({ length: 6 }, (_, i) => hexCorner(0, 0, hexSizeKm, i));

  const cells: HexCell[] = [];
  const rMin = Math.floor(-1 / (1.5 * hexSizeKm)) - 1;
  const rMax = Math.ceil(hKm / (1.5 * hexSizeKm)) + 1;
  for (let r = rMin; r <= rMax; r++) {
    const z = hexSizeKm * 1.5 * r;
    if (z < -hexSizeKm || z > hKm + hexSizeKm) continue;
    const xAtQ0 = hexSizeKm * SQRT3 * (r / 2);
    const qMin = Math.floor((0 - xAtQ0) / (hexSizeKm * SQRT3)) - 1;
    const qMax = Math.ceil((wKm - xAtQ0) / (hexSizeKm * SQRT3)) + 1;
    for (let q = qMin; q <= qMax; q++) {
      const [x, z2] = hexCenter(q, r, hexSizeKm);
      if (x < -hexSizeKm || x > wKm + hexSizeKm) continue;
      const centreM = sampleHeight(grid, x, z2);
      let minM = centreM;
      for (const [dx, dz] of corners) {
        const h = sampleHeight(grid, x + dx, z2 + dz);
        if (h < minM) minM = h;
      }
      cells.push({ q, r, terrain: classifyTerrain(centreM, grid.seaLevelM), heightM: minM });
    }
  }
  return cells;
}

function axialRound(qf: number, rf: number): Hex {
  const xf = qf;
  const yf = -qf - rf;
  const zf = rf;
  let x = Math.round(xf);
  let y = Math.round(yf);
  let z = Math.round(zf);
  const dx = Math.abs(x - xf);
  const dy = Math.abs(y - yf);
  const dz = Math.abs(z - zf);
  if (dx > dy && dx > dz) x = -y - z;
  else if (dy > dz) y = -x - z;
  else z = -x - y;
  return { q: x, r: z };
}
