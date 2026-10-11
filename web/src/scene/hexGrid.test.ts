// Tests for the axial hex math and terrain classification behind the board.

import { describe, expect, it } from 'vitest';
import {
  buildCells,
  classifyTerrain,
  hexCenter,
  hexSpiral,
  worldToHex,
} from './hexGrid';
import type { TerrainGrid } from '../engine/world';

const SIZE = 6; // km, matches HEX_SIZE_KM

describe('hex roundtrip', () => {
  it('maps a cell centre back to the same cell (worldToHex ∘ hexCenter)', () => {
    for (let q = -9; q <= 9; q++) {
      for (let r = -9; r <= 9; r++) {
        const [x, z] = hexCenter(q, r, SIZE);
        const cell = worldToHex(x, z, SIZE);
        expect({ q: cell.q, r: cell.r }).toEqual({ q, r });
      }
    }
  });

  it('roundtrips arbitrary world points to the cell that contains them', () => {
    const points: [number, number][] = [
      [0, 0], [3.1, 1.7], [-12, 8], [55, -40], [123, 456],
      [SIZE * 0.45, 0], [0, -SIZE * 0.45],
    ];
    for (const [x, z] of points) {
      const cell = worldToHex(x, z, SIZE);
      const [cx, cz] = hexCenter(cell.q, cell.r, SIZE);
      // centre is within one circumradius of the point it was derived from
      expect(Math.hypot(cx - x, cz - z)).toBeLessThan(SIZE);
      expect(worldToHex(cx, cz, SIZE)).toEqual(cell);
    }
  });

  it('spiral layout keeps the requested count and starts at the origin', () => {
    expect(hexSpiral(1)).toEqual([{ q: 0, r: 0 }]);
    const seven = hexSpiral(7);
    expect(seven).toHaveLength(7);
    expect(seven[0]).toEqual({ q: 0, r: 0 });
    expect(new Set(seven.map((h) => `${h.q},${h.r}`)).size).toBe(7); // no duplicates
  });
});

describe('terrain classification', () => {
  const seaLevel = 100;
  it('splits water, shoreline sand, grass and forest at the documented thresholds', () => {
    expect(classifyTerrain(seaLevel - 0.1, seaLevel)).toBe('water');
    expect(classifyTerrain(seaLevel, seaLevel)).toBe('sand');
    expect(classifyTerrain(seaLevel + 24.9, seaLevel)).toBe('sand');
    expect(classifyTerrain(seaLevel + 25, seaLevel)).toBe('grass');
    expect(classifyTerrain(seaLevel + 219.9, seaLevel)).toBe('grass');
    expect(classifyTerrain(seaLevel + 220, seaLevel)).toBe('forest');
  });
});

describe('buildCells', () => {
  // 4×4 height grid at 10 km spacing: row heights 60/260/460/660 m against a
  // 100 m sea level → row 0 water, row 1 grass, rows 2-3 forest.
  const grid: TerrainGrid = {
    cols: 4,
    rows: 4,
    cellKm: 10,
    height: Float32Array.from([60, 60, 60, 60, 260, 260, 260, 260, 460, 460, 460, 460, 660, 660, 660, 660]),
    seaLevelM: 100,
  };

  it('covers the map extent and classifies every cell', () => {
    const cells = buildCells(grid, SIZE);
    expect(cells.length).toBeGreaterThan(0);

    const wKm = (grid.cols - 1) * grid.cellKm;
    const hKm = (grid.rows - 1) * grid.cellKm;
    for (const cell of cells) {
      expect(['water', 'sand', 'grass', 'forest']).toContain(cell.terrain);
      const [x, z] = hexCenter(cell.q, cell.r, SIZE);
      expect(x).toBeGreaterThanOrEqual(-SIZE - 1);
      expect(x).toBeLessThanOrEqual(wKm + SIZE + 1);
      expect(z).toBeGreaterThanOrEqual(-SIZE - 1);
      expect(z).toBeLessThanOrEqual(hKm + SIZE + 1);
    }
  });

  it('puts below-sea-level terrain in water cells', () => {
    const cells = buildCells(grid, SIZE);
    const origin = cells.find((c) => c.q === 0 && c.r === 0);
    expect(origin).toBeDefined();
    expect(origin?.terrain).toBe('water'); // 60 m against a 100 m sea level
  });

  it('produces forest cells from the high inland rows', () => {
    const cells = buildCells(grid, SIZE);
    const classes = new Set(cells.map((c) => c.terrain));
    expect(classes.has('forest')).toBe(true);
    expect(classes.has('grass')).toBe(true);
    expect(classes.has('water')).toBe(true);
  });
});
