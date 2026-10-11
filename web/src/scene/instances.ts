// Instanced vehicle layer, updated per snapshot: one instanced mesh per
// vehicle class, coloured by cargo material. (Sites and tanks live in
// siteClusters.ts — they are drawn per-unit now.)

import * as THREE from 'three';
import { VEHICLE_CLASSES, type VehicleClassKey, type WorldSpec } from '../engine/world';
import type { Snapshot } from '../engine/snapshot';
import { materialColor } from './palette';
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
  /** class mesh j owns global vehicle indices classStart[j]..classStart[j]+count[j]-1 */
  classStart: number[];
}

function vehicleGeometry(cls: VehicleClassKey): THREE.BufferGeometry {
  const spec = VEHICLE_CLASSES[cls];
  const len = Math.max(0.6, spec.sceneLength * SCALE);
  const wid = Math.max(0.3, spec.sceneWidth * SCALE);
  const height = Math.max(0.28, wid * 0.6);
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
  const classStart: number[] = [];
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
    classStart.push(indices[0]);
  }
  return { meshes, classStart };
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
    const start = layer.classStart[j];
    for (let k = 0; k < mesh.count; k++) {
      const pose = poses[start + k];
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

/** Interpolate two snapshot poses for vehicle `v`. */
export function lerpPose(cur: Snapshot, prev: Snapshot | null, v: number, f: number): VehiclePose {
  const read = (s: Snapshot): VehiclePose => ({
    x: s.vehPos[5 * v],
    y: s.vehPos[5 * v + 1],
    dirX: s.vehPos[5 * v + 2],
    dirY: s.vehPos[5 * v + 3],
  });
  const a = read(cur);
  if (prev === null || (v + 1) * 5 > prev.vehPos.length) return a;
  const b = read(prev);
  // direction flips at leg ends — dot < 0 means we turned around, snap to current
  const dot = b.dirX * a.dirX + b.dirY * a.dirY;
  const t = dot < 0 ? 1 : f;
  return {
    x: b.x + (a.x - b.x) * f,
    y: b.y + (a.y - b.y) * f,
    dirX: b.dirX + (a.dirX - b.dirX) * t,
    dirY: b.dirY + (a.dirY - b.dirY) * t,
  };
}
