// Instanced scene layers built from the WorldSpec, updated per snapshot:
// - sites: one instanced glyph each, coloured by status, breathing with urgency
// - tanks: instanced level bars arranged around their site (tank specs carry no position)
// - vehicles: one instanced mesh per vehicle class, coloured by cargo material

import * as THREE from 'three';
import {
  siteRanges, VEHICLE_CLASSES, type VehicleClassKey, type WorldSpec,
} from '../engine/world';
import type { Snapshot } from '../engine/snapshot';
import { materialColor, PROC_STATUS_COLORS, SITE_STATUS } from './palette';
import { SCALE, mapToWorld, terrainYAt } from './terrainMesh';

/** A vehicle pose in map km coordinates (from the snapshot arrays). */
export interface VehiclePose {
  x: number;
  y: number;
  dirX: number;
  dirY: number;
}

export interface SiteLayer {
  glyphs: THREE.InstancedMesh;
  /** instanceId → site index */
  glyphSite: number[];
  tanks: THREE.InstancedMesh;
  /** world-space anchor per tank, in tank order */
  anchors: TankAnchor[];
}

export interface VehicleLayer {
  meshes: THREE.InstancedMesh[];
  /** class mesh j owns global vehicle indices classStart[j]..classStart[j]+count[j]-1 */
  classStart: number[];
}

export interface TankAnchor {
  x: number;
  z: number;
  groundY: number;
}

const SITE_STATUS_COLORS: number[] = [
  SITE_STATUS.ok, SITE_STATUS.warn, SITE_STATUS.impact, SITE_STATUS.down, SITE_STATUS.offline,
];

const SITE_GLYPH = new THREE.OctahedronGeometry(0.8).translate(0, 0.9, 0);

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

function tankMatrix(anchor: TankAnchor, fill: number): THREE.Matrix4 {
  const height = 0.12 + Math.max(0.02, fill) * 1.6;
  return new THREE.Matrix4().compose(
    new THREE.Vector3(anchor.x, anchor.groundY + height / 2, anchor.z),
    new THREE.Quaternion(),
    new THREE.Vector3(0.55, height, 0.55),
  );
}

export function buildSiteLayer(world: WorldSpec): SiteLayer {
  const glyphs = new THREE.InstancedMesh(
    SITE_GLYPH,
    new THREE.MeshLambertMaterial(),
    Math.max(1, world.sites.length),
  );
  glyphs.count = world.sites.length;
  const glyphSite: number[] = [];
  const m = new THREE.Matrix4();
  world.sites.forEach((site, s) => {
    const [x, z] = mapToWorld(site.x, site.y);
    m.makeTranslation(x, terrainYAt(world, site.x, site.y), z);
    glyphs.setMatrixAt(s, m);
    glyphs.setColorAt(s, new THREE.Color(SITE_STATUS_COLORS[0] ?? PROC_STATUS_COLORS[0]));
    glyphSite.push(s);
  });
  glyphs.instanceMatrix.needsUpdate = true;

  // Tank specs have no position — arrange each site's tanks in a shallow arc
  // in front of the site (facing -y = towards the default camera).
  const anchors: TankAnchor[] = [];
  const tanks = new THREE.InstancedMesh(
    new THREE.BoxGeometry(0.55, 1, 0.55),
    new THREE.MeshLambertMaterial(),
    Math.max(1, world.tanks.length),
  );
  tanks.count = world.tanks.length;
  const ranges = siteRanges(world);
  world.tanks.forEach((tank, t) => {
    const site = world.sites[tank.site];
    const k = ranges[tank.site].tankIndices.indexOf(t);
    const count = Math.max(1, ranges[tank.site].tankIndices.length);
    const angle = -Math.PI / 2 + (k / count - 0.5) * (Math.PI * 2 / 3);
    const x = site.x + Math.cos(angle) * 2.0;
    const y = site.y + Math.sin(angle) * 2.0;
    const [wx, wz] = mapToWorld(x, y);
    const anchor: TankAnchor = { x: wx, z: wz, groundY: terrainYAt(world, x, y) };
    anchors.push(anchor);
    tanks.setMatrixAt(t, tankMatrix(anchor, 0.3));
    tanks.setColorAt(t, materialColor(tank.material));
  });
  tanks.instanceMatrix.needsUpdate = true;

  return { glyphs, glyphSite, tanks, anchors };
}

/** Update glyph colours/scale and tank bar heights from a snapshot; `f` interpolates fills. */
export function updateInstances(
  layer: SiteLayer,
  snap: Snapshot,
  prev: Snapshot | null,
  f: number,
): void {
  for (let s = 0; s < layer.glyphSite.length; s++) {
    const status = snap.siteStatus[s] ?? 0;
    const urgency = snap.siteUrgency[s] ?? 0;
    const prevUrgency = prev !== null && prev.nSites > s ? prev.siteUrgency[s] : urgency;
    const u = prevUrgency + (urgency - prevUrgency) * f;
    layer.glyphs.getMatrixAt(s, m4);
    p3.setFromMatrixPosition(m4);
    q4.identity();
    s3.set(1, 0.8 + u * 0.6, 1);
    m4.compose(p3, q4, s3);
    layer.glyphs.setMatrixAt(s, m4);
    layer.glyphs.setColorAt(s, c3.setHex(SITE_STATUS_COLORS[status] ?? SITE_STATUS_COLORS[0] ?? PROC_STATUS_COLORS[0]));
  }
  layer.glyphs.instanceMatrix.needsUpdate = true;
  if (layer.glyphs.instanceColor !== null) layer.glyphs.instanceColor.needsUpdate = true;

  const anchors = (layer as SiteLayer & { anchors?: TankAnchor[] }).anchors ?? [];
  for (let t = 0; t < anchors.length && (t + 1) * 4 <= snap.tanks.length; t++) {
    const fill = snap.tanks[4 * t];
    const prevFill = prev !== null && (t + 1) * 4 <= prev.tanks.length ? prev.tanks[4 * t] : fill;
    const fi = Math.max(0.02, prevFill + (fill - prevFill) * f);
    layer.tanks.setMatrixAt(t, tankMatrix(anchors[t], fi));
  }
  layer.tanks.instanceMatrix.needsUpdate = true;
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
const c3 = new THREE.Color();
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
