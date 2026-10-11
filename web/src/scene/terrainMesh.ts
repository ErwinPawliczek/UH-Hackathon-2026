// The hex board: the world's height grid sampled into an instanced board of
// pointy-top hexagonal tiles (§ v3 style — light, flat, hairline grid). Cells
// sit at or below the smooth height field that routes and vehicles are draped
// on, so nothing drawn on `terrainYAt` can clip the board.

import * as THREE from 'three';
import { sampleHeight, type WorldSpec } from '../engine/world';
import { buildCells, hexCenter, type HexCell } from './hexGrid';
import { terrainHexColor } from './palette';

/** World units per km — the 600 × 400 km map becomes 60 × 40 units. */
export const SCALE = 0.1;
/** World units per metre of elevation (2 500 m → 30 units). */
export const HEIGHT_SCALE = 0.012;

/** Hex circumradius in map km — ~2.8k cells across the 600 × 400 km map. */
export const HEX_SIZE_KM = 6;
/** Sea cells sit this far below the sampled height so the coast has a visible wall. */
export const WATER_DROP = 0.5;
/** Land cells sink this far below the smooth height field — the clip guarantee. */
const LAND_SINK = 0.02;
/** Horizontal shrink of each tile; the gap shows the white background as a hairline. */
const TILE_SHRINK = 0.965;
/** Tile wall thickness (world units) below the tile top, so height steps don't show gaps. */
const TILE_THICKNESS = 1.0;

/** Ground height (world units) at map km coordinates, for draping and placement. */
export function terrainYAt(world: WorldSpec, xKm: number, yKm: number): number {
  return (sampleHeight(world.terrain, xKm, yKm) - world.terrain.seaLevelM) * HEIGHT_SCALE;
}

/** Map km coordinates to world XZ: x → x, y → z. */
export function mapToWorld(xKm: number, yKm: number): [number, number] {
  return [xKm * SCALE, yKm * SCALE];
}

/** Top surface (world Y) of one board cell. */
export function cellTopY(cell: HexCell, seaLevelM: number): number {
  const h = (cell.heightM - seaLevelM) * HEIGHT_SCALE;
  return cell.terrain === 'water' ? h - WATER_DROP : h - LAND_SINK;
}

/** The instanced hex board replacing the old smooth terrain mesh. */
export function buildHexBoard(world: WorldSpec): THREE.InstancedMesh {
  const cells = buildCells(world.terrain, HEX_SIZE_KM);
  const r = HEX_SIZE_KM * SCALE;
  const geo = new THREE.CylinderGeometry(1, 1, 1, 6);
  const mesh = new THREE.InstancedMesh(
    geo,
    new THREE.MeshLambertMaterial({ color: 0xffffff }),
    cells.length,
  );
  const m = new THREE.Matrix4();
  const identity = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  const color = new THREE.Color();
  cells.forEach((cell, i) => {
    const [xKm, zKm] = hexCenter(cell.q, cell.r, HEX_SIZE_KM);
    const [x, z] = mapToWorld(xKm, zKm);
    const top = cellTopY(cell, world.terrain.seaLevelM);
    pos.set(x, top - TILE_THICKNESS / 2, z);
    scl.set(r * TILE_SHRINK, TILE_THICKNESS, r * TILE_SHRINK);
    m.compose(pos, identity, scl);
    mesh.setMatrixAt(i, m);
    mesh.setColorAt(i, color.setHex(terrainHexColor(cell.terrain)));
  });
  mesh.instanceMatrix.needsUpdate = true;
  if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  // Instances span the whole map; the base bounding sphere would cull them wrongly.
  mesh.frustumCulled = false;
  return mesh;
}
