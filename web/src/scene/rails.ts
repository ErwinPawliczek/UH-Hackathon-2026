// Rail lines, drawn as small train tracks: two thin rails with evenly spaced
// sleepers following each drawn strip, on a pale deck where a strip crosses
// water. Display only — the engine has no rail mode, so nothing runs on them.
//
// Rails and sleepers are fat line segments (widths in screen pixels, like the
// route lines), so the tracks stay visible at map scale; gauge and sleeper
// spacing are in world units, so they open up into a proper ladder as the
// camera comes closer.

import * as THREE from 'three';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import type { WorldSpec } from '../engine/world';
import { V3 } from './palette';
import { LINE_RENDER_ORDER } from './renderOrder';
import { mapToWorld } from './terrainMesh';

/** Distance between the two rails, km. */
export const RAIL_GAUGE_KM = 1.5;
/** Sleeper length and spacing along the track, km. */
export const SLEEPER_LENGTH_KM = 2.6;
export const SLEEPER_SPACING_KM = 2.4;
/** Rail steel: between the muted and dim greys of the v3 palette. */
const RAIL_COLOR = 0x7c838a;
/** World units the track sits above the surface it is drawn on. */
const LIFT = 0.07;

export interface RailLayer {
  group: THREE.Group;
  materials: LineMaterial[];
}

type Pt = [number, number];

/** The track geometry of one strip, in map km: rail segments and sleeper segments (pairs of points). */
export function trackSegments(strip: Pt[]): { rails: [Pt, Pt][]; sleepers: [Pt, Pt][] } {
  const rails: [Pt, Pt][] = [];
  const sleepers: [Pt, Pt][] = [];
  const pts = strip.filter((p, i) => i === 0 || Math.hypot(p[0] - strip[i - 1][0], p[1] - strip[i - 1][1]) > 1e-6);
  if (pts.length < 2) return { rails, sleepers };
  // unit normals per segment, then a mitred normal per vertex so the two rails stay parallel round bends
  const normals: Pt[] = [];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    const len = Math.hypot(dx, dy);
    normals.push([-dy / len, dx / len]);
  }
  const half = RAIL_GAUGE_KM / 2;
  const side = (sign: number): Pt[] =>
    pts.map((p, i) => {
      const a = normals[Math.max(0, i - 1)];
      const b = normals[Math.min(normals.length - 1, i)];
      let nx = a[0] + b[0];
      let ny = a[1] + b[1];
      const len = Math.hypot(nx, ny);
      if (len < 1e-6) {
        nx = a[0];
        ny = a[1];
      } else {
        // lengthen at a bend so the offset stays `half` from both segments (capped at sharp corners)
        const scale = Math.min(2.5, 1 / Math.max(1e-6, (nx / len) * a[0] + (ny / len) * a[1])) / len;
        nx *= scale;
        ny *= scale;
      }
      return [p[0] + sign * half * nx, p[1] + sign * half * ny];
    });
  for (const rail of [side(1), side(-1)]) {
    for (let i = 1; i < rail.length; i++) rails.push([rail[i - 1], rail[i]]);
  }
  // sleepers at even spacing along the whole strip, square to the track
  let carried = SLEEPER_SPACING_KM / 2;
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0];
    const dy = pts[i][1] - pts[i - 1][1];
    const len = Math.hypot(dx, dy);
    const [nx, ny] = normals[i - 1];
    let at = carried;
    while (at <= len) {
      const x = pts[i - 1][0] + (dx / len) * at;
      const y = pts[i - 1][1] + (dy / len) * at;
      const h = SLEEPER_LENGTH_KM / 2;
      sleepers.push([[x - nx * h, y - ny * h], [x + nx * h, y + ny * h]]);
      at += SLEEPER_SPACING_KM;
    }
    carried = at - len;
  }
  return { rails, sleepers };
}

function segmentsObject(segments: [Pt, Pt][], heightAt: (x: number, y: number) => number, color: number, width: number, order: number) {
  const positions: number[] = [];
  for (const [a, b] of segments) {
    for (const p of [a, b]) {
      const [x, z] = mapToWorld(p[0], p[1]);
      positions.push(x, heightAt(p[0], p[1]) + LIFT, z);
    }
  }
  const geometry = new LineSegmentsGeometry();
  geometry.setPositions(positions);
  const material = new LineMaterial({ color, linewidth: width, worldUnits: false, depthTest: false, depthWrite: false });
  const object = new LineSegments2(geometry, material);
  object.renderOrder = order;
  object.frustumCulled = false;
  return { object, material };
}

/**
 * All rail strips of a world as one layer, or null when it has none.
 * `deckAt` is the world Y a track is drawn at (the ground, or sea level over
 * water); `isWater` tells where a strip needs its deck.
 */
export function buildRails(
  world: WorldSpec,
  deckAt: (xKm: number, yKm: number) => number,
  isWater: (xKm: number, yKm: number) => boolean,
): RailLayer | null {
  const strips = (world.rails ?? []).filter((s) => s.length >= 2);
  if (strips.length === 0) return null;
  const rails: [Pt, Pt][] = [];
  const sleepers: [Pt, Pt][] = [];
  const deck: number[] = [];
  for (const strip of strips) {
    const track = trackSegments(strip);
    rails.push(...track.rails);
    sleepers.push(...track.sleepers);
    // a pale deck under each sleeper that stands over water: reads as a low bridge
    const w = SLEEPER_LENGTH_KM * 0.75;
    const l = SLEEPER_SPACING_KM * 0.55;
    for (const [a, b] of track.sleepers) {
      const mx = (a[0] + b[0]) / 2;
      const my = (a[1] + b[1]) / 2;
      if (!isWater(mx, my)) continue;
      const nx = (b[0] - a[0]) / SLEEPER_LENGTH_KM;
      const ny = (b[1] - a[1]) / SLEEPER_LENGTH_KM;
      const tx = -ny;
      const ty = nx;
      const corner = (sn: number, st: number): number[] => {
        const [x, z] = mapToWorld(mx + nx * w * sn + tx * l * st, my + ny * w * sn + ty * l * st);
        return [x, deckAt(mx, my) + LIFT - 0.02, z];
      };
      deck.push(
        ...corner(-1, -1), ...corner(1, -1), ...corner(1, 1),
        ...corner(-1, -1), ...corner(1, 1), ...corner(-1, 1),
      );
    }
  }
  const group = new THREE.Group();
  const materials: LineMaterial[] = [];
  if (deck.length > 0) {
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(deck, 3));
    const mesh = new THREE.Mesh(
      geo,
      new THREE.MeshBasicMaterial({ color: V3.white, side: THREE.DoubleSide, depthTest: false, depthWrite: false }),
    );
    mesh.renderOrder = LINE_RENDER_ORDER + 0.1;
    mesh.frustumCulled = false;
    group.add(mesh);
  }
  // quieter than roads and pipelines: nothing runs here yet
  const ties = segmentsObject(sleepers, deckAt, V3.lane, 1.3, LINE_RENDER_ORDER + 0.2);
  const steel = segmentsObject(rails, deckAt, RAIL_COLOR, 1, LINE_RENDER_ORDER + 0.3);
  group.add(ties.object, steel.object);
  materials.push(ties.material, steel.material);
  return { group, materials };
}

/** Tell the rail lines the canvas size — their widths are in screen pixels. */
export function resizeRails(layer: RailLayer | null, width: number, height: number): void {
  if (layer === null) return;
  for (const m of layer.materials) m.resolution.set(width, height);
}
