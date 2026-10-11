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
  /** per class: everything of the vehicle that is always drawn (cab and chassis, hull and deckhouse) */
  meshes: THREE.InstancedMesh[];
  /** per class: what it carries, drawn only while cargo is on board; null for classes drawn in one piece */
  cargo: (THREE.InstancedMesh | null)[];
  /** per class: the point on the vehicle its cargo grows from and shrinks to */
  pivots: [number, number, number][];
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

/** Tone of a truck's bare chassis and a barge's empty deck: lighter than the cab, so an empty one reads as a flatbed. */
const BED = 0.55;

/** A vehicle class in two parts: what is always drawn, and the cargo that shows only while it is loaded. */
export interface VehicleParts {
  base: THREE.BufferGeometry;
  cargo: THREE.BufferGeometry | null;
  /** where the cargo sits: it grows from and shrinks to this point */
  pivot: [number, number, number];
}

/** A road truck: dark cab in front (+z) on a bare chassis; the class-specific body is its cargo. */
function truck(body: THREE.BufferGeometry): VehicleParts {
  return {
    base: mergeGeometries([
      part(new THREE.BoxGeometry(0.2, 0.2, 0.13).translate(0, 0.16, 0.185), DARK),
      part(new THREE.BoxGeometry(0.17, 0.05, 0.38).translate(0, 0.045, -0.07), BED), // chassis
      part(new THREE.BoxGeometry(0.19, 0.03, 0.05).translate(0, 0.02, -0.2), DARK), // rear axle
    ]),
    cargo: part(body, CARGO),
    pivot: [0, 0.07, -0.07],
  };
}

/** A river barge: low flat hull and a small pusher house at the stern; what is on deck is its cargo. */
function barge(deck: THREE.BufferGeometry[], fittings: THREE.BufferGeometry[]): VehicleParts {
  return {
    base: mergeGeometries([
      part(new THREE.BoxGeometry(0.36, 0.1, 1.1).translate(0, 0.05, 0), HULL),
      part(new THREE.BoxGeometry(0.22, 0.16, 0.14).translate(0, 0.18, -0.46), DARK),
      ...fittings.map((g) => part(g, BED)),
    ]),
    cargo: mergeGeometries(deck.map((g) => part(g, CARGO))),
    pivot: [0, 0.1, 0.05],
  };
}

/** A sea-going ship: hull with a pointed bow, deckhouse aft, cargo on deck. Drawn in one piece. */
function ship(deck: THREE.BufferGeometry[]): VehicleParts {
  const bow = alongZ(new THREE.ConeGeometry(0.3536, 0.5, 4).rotateY(Math.PI / 4))
    .scale(1, 0.36, 1)
    .translate(0, 0.09, 0.9);
  return {
    base: mergeGeometries([
      part(new THREE.BoxGeometry(0.5, 0.18, 1.5).translate(0, 0.09, -0.1), HULL),
      part(bow, HULL),
      part(new THREE.BoxGeometry(0.38, 0.3, 0.24).translate(0, 0.33, -0.68), DARK),
      ...deck.map((g) => part(g, CARGO)),
    ]),
    cargo: null,
    pivot: [0, 0, 0],
  };
}

/**
 * One silhouette per vehicle class, so the eight classes read apart at map
 * scale: tank trucks carry a cylinder, pressurised trucks a rounded bullet,
 * bulk trucks a box; barges are low and flat (tanks or filled hoppers); ships
 * have a pointed bow and a deckhouse (flat tanker deck, gas spheres, or
 * hatches). An empty truck is a cab on a bare chassis and an empty barge a
 * bare deck or an open hold: what they carry is a separate part, drawn only
 * while cargo is on board. Sized for visibility, not to scale — a truck
 * stays smaller than a unit pad. Forward is +z; the base sits at y = 0.
 */
export function vehicleParts(cls: VehicleClassKey): VehicleParts {
  switch (cls) {
    case 'TRUCK_TANK':
      return truck(alongZ(new THREE.CylinderGeometry(0.09, 0.09, 0.36, 12)).translate(0, 0.16, -0.07));
    case 'TRUCK_PRESS':
      return truck(alongZ(new THREE.CapsuleGeometry(0.1, 0.18, 4, 10)).translate(0, 0.17, -0.07));
    case 'TRUCK_BULK':
      return truck(new THREE.BoxGeometry(0.2, 0.2, 0.36).translate(0, 0.17, -0.07));
    case 'BARGE_TANK':
      return barge(
        [
          alongZ(new THREE.CylinderGeometry(0.11, 0.11, 0.4, 12)).translate(0, 0.14, 0.26),
          alongZ(new THREE.CylinderGeometry(0.11, 0.11, 0.4, 12)).translate(0, 0.14, -0.17),
        ],
        // saddles the tanks sit in, left on the bare deck
        [0.26, -0.17].map((z) => new THREE.BoxGeometry(0.2, 0.025, 0.3).translate(0, 0.1125, z)),
      );
    case 'BARGE_DRY':
      return barge(
        [
          new THREE.BoxGeometry(0.26, 0.1, 0.36).translate(0, 0.15, 0.27),
          new THREE.BoxGeometry(0.26, 0.1, 0.36).translate(0, 0.15, -0.17),
        ],
        // the coamings of two holds: open and empty until the cargo fills them
        [0.27, -0.17].flatMap((z) => [
          new THREE.BoxGeometry(0.32, 0.06, 0.02).translate(0, 0.13, z + 0.2),
          new THREE.BoxGeometry(0.32, 0.06, 0.02).translate(0, 0.13, z - 0.2),
          new THREE.BoxGeometry(0.02, 0.06, 0.4).translate(0.15, 0.13, z),
          new THREE.BoxGeometry(0.02, 0.06, 0.4).translate(-0.15, 0.13, z),
        ]),
      );
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
      return vehicleParts('TRUCK_TANK');
  }
}

/** A class's whole shape, loaded: base and cargo in one geometry. */
export function vehicleGeometry(cls: VehicleClassKey): THREE.BufferGeometry {
  const parts = vehicleParts(cls);
  return parts.cargo === null ? parts.base : mergeGeometries([parts.base, parts.cargo]);
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
  const cargo: (THREE.InstancedMesh | null)[] = [];
  const pivots: [number, number, number][] = [];
  const members: number[][] = [];
  const instanced = (geo: THREE.BufferGeometry, count: number) => {
    const mesh = new THREE.InstancedMesh(
      geo,
      new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.1 }),
      count,
    );
    mesh.frustumCulled = false;
    return mesh;
  };
  for (const [cls, indices] of byClass) {
    const parts = vehicleParts(cls);
    const mesh = instanced(parts.base, indices.length);
    const load = parts.cargo === null ? null : instanced(parts.cargo, indices.length);
    indices.forEach((vehIdx, k) => {
      // one-piece classes are tinted by their cargo; the rest keep a neutral body
      mesh.setColorAt(k, load === null ? materialColor(world.vehicles[vehIdx].cargo) : EMPTY_COLOR);
      load?.setColorAt(k, materialColor(world.vehicles[vehIdx].cargo));
    });
    meshes.push(mesh);
    cargo.push(load);
    pivots.push(parts.pivot);
    members.push(indices);
  }
  return { meshes, cargo, pivots, members };
}

const m4 = new THREE.Matrix4();
const cargoM4 = new THREE.Matrix4();
const growM4 = new THREE.Matrix4();
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
  /** how much of its cargo part is drawn, 0 (empty) to 1 (loaded); loaded when omitted */
  loaded?: (vehicle: number) => number,
): void {
  layer.meshes.forEach((mesh, j) => {
    const members = layer.members[j];
    const load = layer.cargo[j];
    const [px, py, pz] = layer.pivots[j];
    for (let k = 0; k < mesh.count; k++) {
      const pose = poses[members[k]];
      if (pose === undefined) continue;
      const [x, z] = mapToWorld(pose.x, pose.y);
      p3.set(x, terrainY(pose.x, pose.y, members[k]) + 0.04, z);
      q4.setFromAxisAngle(up, Math.atan2(pose.dirX, pose.dirY));
      s3.setScalar(shown === undefined ? 1 : Math.max(0, Math.min(1, shown(members[k]))));
      m4.compose(p3, q4, s3);
      mesh.setMatrixAt(k, m4);
      if (load !== null) {
        // the cargo part grows out of the bed as it is loaded and sinks back as it is unloaded
        const g = loaded === undefined ? 1 : Math.max(0, Math.min(1, loaded(members[k])));
        growM4.makeScale(g, g, g).setPosition(px * (1 - g), py * (1 - g), pz * (1 - g));
        load.setMatrixAt(k, cargoM4.multiplyMatrices(m4, growM4));
      }
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (load !== null) load.instanceMatrix.needsUpdate = true;
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

/**
 * Recolour vehicles from the cargo on board. A truck's or barge's cargo part
 * takes the material's class colour and its body stays lane grey; a ship,
 * drawn in one piece, is tinted by its cargo and lane grey when empty.
 */
export function updateVehicleCargo(layer: VehicleLayer, world: WorldSpec, snap: Snapshot): void {
  layer.meshes.forEach((mesh, j) => {
    const members = layer.members[j];
    const load = layer.cargo[j];
    for (let k = 0; k < mesh.count; k++) {
      const cargo = liveCargo(world, snap, members[k]);
      const color = cargo === null ? EMPTY_COLOR : materialColor(cargo);
      if (load === null) mesh.setColorAt(k, color);
      // an emptying cargo part keeps its colour while it shrinks away
      else if (cargo !== null) load.setColorAt(k, color);
    }
    if (mesh.instanceColor !== null) mesh.instanceColor.needsUpdate = true;
    if (load !== null && load.instanceColor !== null) load.instanceColor.needsUpdate = true;
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
