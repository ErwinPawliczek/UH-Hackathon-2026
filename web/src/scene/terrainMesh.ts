// Terrain surface: the world's height grid as a coloured, height-displaced
// triangle mesh. Grid vertices are 10 km apart and bilinearly resampled, so
// the mesh matches the grid the engine ships in world JSON.

import * as THREE from 'three';
import { sampleHeight, type WorldSpec } from '../engine/world';
import { terrainColor } from './palette';

/** World units per km — the 600 × 400 km map becomes 60 × 40 units. */
export const SCALE = 0.1;
/** World units per metre of elevation (2 500 m → 30 units). */
export const HEIGHT_SCALE = 0.012;

/** Ground height (world units) at map km coordinates, for draping and placement. */
export function terrainYAt(world: WorldSpec, xKm: number, yKm: number): number {
  return (sampleHeight(world.terrain, xKm, yKm) - world.terrain.seaLevelM) * HEIGHT_SCALE;
}

/** Map km coordinates to world XZ: x → x, y → z. */
export function mapToWorld(xKm: number, yKm: number): [number, number] {
  return [xKm * SCALE, yKm * SCALE];
}

export function buildTerrain(world: WorldSpec): THREE.Mesh {
  const g = world.terrain;
  const positions = new Float32Array(g.cols * g.rows * 3);
  const colors = new Float32Array(g.cols * g.rows * 3);
  for (let r = 0; r < g.rows; r++) {
    for (let c = 0; c < g.cols; c++) {
      const i = r * g.cols + c;
      const xKm = c * g.cellKm;
      const yKm = r * g.cellKm;
      const [x, z] = mapToWorld(xKm, yKm);
      positions.set([x, (g.height[i] - g.seaLevelM) * HEIGHT_SCALE, z], i * 3);
      colors.set(terrainColor(g.height[i], g.seaLevelM), i * 3);
    }
  }
  const indices: number[] = [];
  for (let r = 0; r < g.rows - 1; r++) {
    for (let c = 0; c < g.cols - 1; c++) {
      const a = r * g.cols + c;
      const b = a + 1;
      const d = a + g.cols;
      const e = d + 1;
      indices.push(a, d, b, b, d, e);
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setIndex(indices);
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geo.computeVertexNormals();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  return new THREE.Mesh(geo, mat);
}
