// Instanced vehicle layer, updated per snapshot: one instanced mesh per
// vehicle class, coloured by cargo material. (Sites and tanks live in
// siteClusters.ts — they are drawn per-unit now.)

import * as THREE from 'three';
import { VEHICLE_CLASSES, materialKeyAt, type VehicleClassKey, type WorldSpec } from '../engine/world';
import type { Snapshot } from '../engine/snapshot';
import { V3, materialColor } from './palette';
import { SCALE, mapToWorld } from './terrainMesh';

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

function vehicleGeometry(cls: VehicleClassKey): THREE.BufferGeometry {
  // An unknown class key (a newer engine catalog) still draws, as a truck.
  const spec = VEHICLE_CLASSES[cls] ?? VEHICLE_CLASSES.TRUCK_TANK;
  // Sized for visibility, not to scale — but a truck stays smaller than a
  // unit pad, so a busy road does not bury the sites it serves.
  const len = Math.max(0.45, spec.sceneLength * SCALE);
  const wid = Math.max(0.22, spec.sceneWidth * SCALE);
  const height = Math.max(0.2, wid * 0.6);
  const geo =
    cls.startsWith('SHIP')
      ? new THREE.CapsuleGeometry(wid / 2, Math.max(0.01, len - wid), 4, 8).rotateX(Math.PI / 2)
      : new THREE.BoxGeometry(wid, height, len);
  return geo.translate(0, height / 2 + 0.08, 0);
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
      new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.3 }),
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
  terrainY: (xKm: number, yKm: number) => number,
): void {
  layer.meshes.forEach((mesh, j) => {
    const members = layer.members[j];
    for (let k = 0; k < mesh.count; k++) {
      const pose = poses[members[k]];
      if (pose === undefined) continue;
      const [x, z] = mapToWorld(pose.x, pose.y);
      p3.set(x, terrainY(pose.x, pose.y) + 0.2, z);
      q4.setFromAxisAngle(up, Math.atan2(pose.dirX, pose.dirY));
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

/** Interpolate two snapshot poses for vehicle `v`.
 *
 * With the v2 movement arrays present (and both snapshots on the same route),
 * the pose slides along the assigned route polyline between the previous and
 * current snapshot progress — vehicles follow the road, river or sea lanes on
 * the map instead of cutting straight lines across terrain. Falls back to the
 * engine's straight-line pose whenever the movement contract is unavailable
 * (v1 payload, first frame, or a route switch between snapshots).
 */
export function lerpPose(
  world: WorldSpec,
  cur: Snapshot,
  prev: Snapshot | null,
  v: number,
  f: number,
): VehiclePose {
  const read = (s: Snapshot): VehiclePose => ({
    x: s.vehPos[5 * v],
    y: s.vehPos[5 * v + 1],
    dirX: s.vehPos[5 * v + 2],
    dirY: s.vehPos[5 * v + 3],
  });
  const a = read(cur);

  const routeId = cur.vehRoute?.[v];
  const progress = cur.vehProgress?.[v];
  if (routeId === undefined || progress === undefined) return a;
  if (routeId >= world.routes.length) return a; // malformed index — trust the engine pose
  const prevRouteId = prev?.vehRoute?.[v];
  const prevProgress = prev?.vehProgress?.[v];
  // A route switch or progress reset between snapshots (replan, closure
  // detour) cannot be interpolated along the old polyline: hold at the
  // snapshot pose this frame and slide again next frame.
  if (prev === null || prevRouteId !== routeId || prevProgress === undefined ||
      prevProgress > progress) {
    return sampleRoute(world.routes[routeId].points, progress, a);
  }
  const p = prevProgress + (progress - prevProgress) * f;
  return sampleRoute(world.routes[routeId].points, p, a);
}

/** Pose at fraction `p` (0..1 by arc length) along a route polyline.
 *
 * Points are km tuples in map coordinates, matching `routePointAt` in
 * engine/world. `fallback` supplies the direction for degenerate inputs
 * (fewer than two points or a zero-length polyline).
 */
export function sampleRoute(
  points: [number, number][],
  p: number,
  fallback: VehiclePose,
): VehiclePose {
  if (points.length < 2) return fallback;
  const clamped = Math.min(1, Math.max(0, p));
  // Segment lengths in map km; sample uniformly by arc length.
  let total = 0;
  const segLen: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const len = Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
    segLen.push(len);
    total += len;
  }
  if (total <= 0) return fallback;
  let remaining = clamped * total;
  for (let i = 0; i < segLen.length; i++) {
    if (remaining > segLen[i]) {
      remaining -= segLen[i];
      continue;
    }
    const len = segLen[i];
    const t = len > 0 ? remaining / len : 0;
    return {
      x: points[i][0] + (points[i + 1][0] - points[i][0]) * t,
      y: points[i][1] + (points[i + 1][1] - points[i][1]) * t,
      dirX: (points[i + 1][0] - points[i][0]) / len,
      dirY: (points[i + 1][1] - points[i][1]) / len,
    };
  }
  // Numerically past the end: rest on the final heading.
  const n = points.length;
  const dx = points[n - 1][0] - points[n - 2][0];
  const dy = points[n - 1][1] - points[n - 2][1];
  const len = Math.hypot(dx, dy);
  return {
    x: points[n - 1][0],
    y: points[n - 1][1],
    dirX: len > 0 ? dx / len : fallback.dirX,
    dirY: len > 0 ? dy / len : fallback.dirY,
  };
}
