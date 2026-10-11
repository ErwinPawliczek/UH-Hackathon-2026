// Instanced vehicle layer, updated per snapshot: one instanced mesh per
// vehicle class, coloured by cargo material. (Sites and tanks live in
// siteClusters.ts — they are drawn per-unit now.)

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { materialKeyAt, type VehicleClassKey, type WorldSpec } from '../engine/world';
import type { Snapshot } from '../engine/snapshot';
import { V3, materialColor } from './palette';
import { mapToWorld } from './terrainMesh';

/** A vehicle pose in map km coordinates (from the snapshot arrays). */
export interface VehiclePose {
  x: number;
  y: number;
  dirX: number;
  dirY: number;
}

export interface VehicleLayer {
  meshes: THREE.InstancedMesh[];
  /**
   * Per class mesh: the global vehicle index of each instance slot. A fleet
   * lists vehicles home by home, so one class's vehicles are not contiguous.
   */
  members: number[][];
}

/** Snapshot cargo byte of a vehicle carrying nothing (§7.3 array 7). */
const NO_CARGO = 255;
/** Body colour of an empty vehicle — the v3 lane grey. */
const EMPTY_COLOR = new THREE.Color(V3.lane);

/** Give every vertex of a part the same tone; the instance colour multiplies it. */
function part(geo: THREE.BufferGeometry, tone: number): THREE.BufferGeometry {
  const n = geo.getAttribute('position').count;
  geo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(n * 3).fill(tone), 3));
  return geo;
}

/** Tones: the cargo-carrying part takes the cargo colour in full, a hull a shade of it, cabs and deckhouses stay dark. */
const CARGO = 1;
const HULL = 0.6;
const DARK = 0.12;

const alongZ = (geo: THREE.BufferGeometry) => geo.rotateX(Math.PI / 2);

/** A road truck: dark cab in front (+z), the class-specific body behind it. */
function truck(body: THREE.BufferGeometry): THREE.BufferGeometry {
  return mergeGeometries([
    part(new THREE.BoxGeometry(0.2, 0.2, 0.13).translate(0, 0.16, 0.185), DARK),
    part(new THREE.BoxGeometry(0.16, 0.05, 0.36).translate(0, 0.045, -0.07), DARK), // chassis
    part(body, CARGO),
  ]);
}

/** A river barge: low flat hull, cargo on deck, a small pusher house at the stern. */
function barge(deck: THREE.BufferGeometry[]): THREE.BufferGeometry {
  return mergeGeometries([
    part(new THREE.BoxGeometry(0.36, 0.1, 1.1).translate(0, 0.05, 0), HULL),
    part(new THREE.BoxGeometry(0.22, 0.16, 0.14).translate(0, 0.18, -0.46), DARK),
    ...deck.map((g) => part(g, CARGO)),
  ]);
}

/** A sea-going ship: hull with a pointed bow, deckhouse aft, cargo on deck. */
function ship(deck: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const bow = alongZ(new THREE.ConeGeometry(0.3536, 0.5, 4).rotateY(Math.PI / 4))
    .scale(1, 0.36, 1)
    .translate(0, 0.09, 0.9);
  return mergeGeometries([
    part(new THREE.BoxGeometry(0.5, 0.18, 1.5).translate(0, 0.09, -0.1), HULL),
    part(bow, HULL),
    part(new THREE.BoxGeometry(0.38, 0.3, 0.24).translate(0, 0.33, -0.68), DARK),
    ...deck.map((g) => part(g, CARGO)),
  ]);
}

/**
 * One silhouette per vehicle class, so the eight classes read apart at map
 * scale: tank trucks carry a cylinder, pressurised trucks a rounded bullet,
 * bulk trucks a box; barges are low and flat (tanks or open hoppers); ships
 * have a pointed bow and a deckhouse (flat tanker deck, gas spheres, or
 * hatches). Sized for visibility, not to scale — a truck stays smaller than
 * a unit pad. Forward is +z; the base sits at y = 0.
 */
export function vehicleGeometry(cls: VehicleClassKey): THREE.BufferGeometry {
  switch (cls) {
    case 'TRUCK_TANK':
      return truck(alongZ(new THREE.CylinderGeometry(0.09, 0.09, 0.36, 12)).translate(0, 0.16, -0.07));
    case 'TRUCK_PRESS':
      return truck(alongZ(new THREE.CapsuleGeometry(0.1, 0.18, 4, 10)).translate(0, 0.17, -0.07));
    case 'TRUCK_BULK':
      return truck(new THREE.BoxGeometry(0.2, 0.2, 0.36).translate(0, 0.17, -0.07));
    case 'BARGE_TANK':
      return barge([
        alongZ(new THREE.CylinderGeometry(0.11, 0.11, 0.4, 12)).translate(0, 0.14, 0.26),
        alongZ(new THREE.CylinderGeometry(0.11, 0.11, 0.4, 12)).translate(0, 0.14, -0.17),
      ]);
    case 'BARGE_DRY':
      return barge([
        new THREE.BoxGeometry(0.3, 0.1, 0.4).translate(0, 0.15, 0.27),
        new THREE.BoxGeometry(0.3, 0.1, 0.4).translate(0, 0.15, -0.17),
      ]);
    case 'SHIP_TANK':
      return ship([
        new THREE.BoxGeometry(0.42, 0.05, 1.1).translate(0, 0.205, 0.05),
        new THREE.BoxGeometry(0.06, 0.06, 1.0).translate(0, 0.26, 0.05),
      ]);
    case 'SHIP_GAS':
      return ship([-0.3, 0.1, 0.5].map((z) => new THREE.SphereGeometry(0.2, 12, 8).translate(0, 0.2, z)));
    case 'SHIP_DRY':
      return ship([-0.3, 0.1, 0.5].map((z) => new THREE.BoxGeometry(0.38, 0.08, 0.3).translate(0, 0.22, z)));
    default:
      // An unknown class key (a newer engine catalog) still draws, as a truck.
      return vehicleGeometry('TRUCK_TANK');
  }
}

/** One instanced mesh per vehicle class; colour by cargo material. */
export function buildVehicleLayer(world: WorldSpec): VehicleLayer {
  const byClass = new Map<VehicleClassKey, number[]>();
  world.vehicles.forEach((v, i) => {
    const list = byClass.get(v.cls) ?? [];
    list.push(i);
    byClass.set(v.cls, list);
  });
  const meshes: THREE.InstancedMesh[] = [];
  const members: number[][] = [];
  for (const [cls, indices] of byClass) {
    const mesh = new THREE.InstancedMesh(
      vehicleGeometry(cls),
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1 }),
      indices.length,
    );
    indices.forEach((vehIdx, k) => {
      mesh.setColorAt(k, materialColor(world.vehicles[vehIdx].cargo));
    });
    mesh.frustumCulled = false;
    meshes.push(mesh);
    members.push(indices);
  }
  return { meshes, members };
}

const m4 = new THREE.Matrix4();
const q4 = new THREE.Quaternion();
const p3 = new THREE.Vector3();
const s3 = new THREE.Vector3(1, 1, 1);
const up = new THREE.Vector3(0, 1, 0);

/** Update vehicle transforms from interpolated poses. */
export function updateVehicles(
  layer: VehicleLayer,
  poses: VehiclePose[],
  /** world Y of what the vehicle stands on; `vehicle` is its index in the fleet */
  terrainY: (xKm: number, yKm: number, vehicle: number) => number,
  /** drawn size of a vehicle, 0 (hidden) to 1; all are full size when omitted */
  shown?: (vehicle: number) => number,
): void {
  layer.meshes.forEach((mesh, j) => {
    const members = layer.members[j];
    for (let k = 0; k < mesh.count; k++) {
      const pose = poses[members[k]];
      if (pose === undefined) continue;
      const [x, z] = mapToWorld(pose.x, pose.y);
      p3.set(x, terrainY(pose.x, pose.y, members[k]) + 0.04, z);
      q4.setFromAxisAngle(up, Math.atan2(pose.dirX, pose.dirY));
      s3.setScalar(shown === undefined ? 1 : Math.max(0, Math.min(1, shown(members[k]))));
      m4.compose(p3, q4, s3);
      mesh.setMatrixAt(k, m4);
    }
    mesh.instanceMatrix.needsUpdate = true;
  });
}

/**
 * Material key the vehicle is carrying right now, or null when it is empty.
 * Read from the snapshot's cargo byte (array 7), which indexes the world's
 * material list.
 */
export function liveCargo(world: WorldSpec, snap: Snapshot, v: number): string | null {
  const byte = snap.vehStatus[2 * v + 1];
  if (byte === undefined || byte === NO_CARGO) return null;
  return materialKeyAt(world, byte);
}

/** Recolour vehicles from the cargo on board: material class colour, lane grey when empty. */
export function updateVehicleCargo(layer: VehicleLayer, world: WorldSpec, snap: Snapshot): void {
  layer.meshes.forEach((mesh, j) => {
    const members = layer.members[j];
    for (let k = 0; k < mesh.count; k++) {
      const cargo = liveCargo(world, snap, members[k]);
      mesh.setColorAt(k, cargo === null ? EMPTY_COLOR : materialColor(cargo));
    }
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
  });
}

/** Transport mode a vehicle class runs on, from its key. */
export function classMode(cls: string): 'road' | 'river' | 'sea' {
  return cls.startsWith('BARGE') ? 'river' : cls.startsWith('SHIP') ? 'sea' : 'road';
}

/** The stretch of a lane that lies over water, as arc lengths in km. */
export interface WaterSpan {
  s0: number;
  s1: number;
  length: number;
}

/**
 * Where along a river or sea lane the water starts and ends. Lanes are drawn
 * from site to site, so their last few km cross the shore to the site itself;
 * vessels are drawn only on the wet stretch — they stop at the water's edge
 * instead of sailing up the bank. Null when no sampled point is over water.
 */
export function waterSpan(
  points: [number, number][],
  isWater: (xKm: number, yKm: number) => boolean,
  stepKm = 1,
): WaterSpan | null {
  let length = 0;
  let s0 = Infinity;
  let s1 = -Infinity;
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const seg = Math.hypot(bx - ax, by - ay);
    const n = Math.max(1, Math.ceil(seg / stepKm));
    for (let k = 0; k <= n; k++) {
      const t = k / n;
      if (isWater(ax + (bx - ax) * t, ay + (by - ay) * t)) {
        const s = length + seg * t;
        if (s < s0) s0 = s;
        if (s > s1) s1 = s;
      }
    }
    length += seg;
  }
  return s1 >= s0 ? { s0, s1, length } : null;
}
