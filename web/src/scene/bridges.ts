// Road bridges: wherever a road runs over water it is carried on a small
// bridge — a deck at road height with low parapets, on piers standing in
// the water, running a little way onto each bank so it meets the land road.
// Roads only: pipelines and water lanes are plain lines.
//
// The bridge is drawn after the route lines and before sites and vehicles,
// and does not write depth: a truck on the deck and a vessel passing below
// are both drawn over it, so neither is hidden where a lane crosses.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { WorldSpec } from '../engine/world';
import { mapToWorld, SCALE } from './terrainMesh';

type Pt = [number, number];

/** Deck width, km (a truck is about 2 km wide at map scale). */
export const BRIDGE_WIDTH_KM = 4.4;
/** How far a bridge runs onto each bank, km. */
export const BRIDGE_RAMP_KM = 3;
/** Distance between piers, km. */
export const PIER_SPACING_KM = 6;
/** A wet stretch shorter than this is shoreline noise, not a crossing. */
const MIN_CROSSING_KM = 2;
/** Two wet stretches whose ramps would meet are one crossing (a sandbar or islet under the bridge). */
const JOIN_GAP_KM = 2 * BRIDGE_RAMP_KM + 0.5;
const STEP_KM = 0.5;

const DECK_TOP = 0.03; // world units above the road height
const DECK_THICK = 0.05;
const PARAPET_HEIGHT = 0.05;
const PARAPET_WIDTH = 0.035;

const DECK_COLOR = 0xc3c8cd;
const PARAPET_COLOR = 0x8b9198;
const PIER_COLOR = 0xa9afb5;

/** A stretch of one road polyline carried on a bridge, as arc lengths in km (ramps included). */
export interface BridgeSpan {
  s0: number;
  s1: number;
  /** the wet part inside it, where the piers stand */
  wet0: number;
  wet1: number;
}

function cumulative(points: Pt[]): number[] {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]));
  }
  return cum;
}

function pointAt(points: Pt[], cum: number[], s: number): { x: number; y: number; dirX: number; dirY: number } {
  const total = cum[cum.length - 1];
  const c = Math.min(total, Math.max(0, s));
  let i = 1;
  while (i < cum.length - 1 && cum[i] < c) i++;
  const seg = cum[i] - cum[i - 1];
  const t = seg > 0 ? (c - cum[i - 1]) / seg : 0;
  const [ax, ay] = points[i - 1];
  const [bx, by] = points[i];
  return {
    x: ax + (bx - ax) * t,
    y: ay + (by - ay) * t,
    dirX: seg > 0 ? (bx - ax) / seg : 1,
    dirY: seg > 0 ? (by - ay) / seg : 0,
  };
}

/** The crossings of one road: where it runs over water, each widened by a ramp onto either bank. */
export function bridgeSpans(points: Pt[], isWater: (xKm: number, yKm: number) => boolean): BridgeSpan[] {
  if (points.length < 2) return [];
  const cum = cumulative(points);
  const total = cum[cum.length - 1];
  const wet: [number, number][] = [];
  let start = -1;
  for (let s = 0; s <= total + 1e-9; s += STEP_KM) {
    const p = pointAt(points, cum, s);
    const w = isWater(p.x, p.y);
    if (w && start < 0) start = s;
    if (!w && start >= 0) {
      wet.push([start, s - STEP_KM]);
      start = -1;
    }
  }
  if (start >= 0) wet.push([start, total]);
  const joined: [number, number][] = [];
  for (const run of wet) {
    const last = joined[joined.length - 1];
    if (last !== undefined && run[0] - last[1] < JOIN_GAP_KM) last[1] = run[1];
    else joined.push([run[0], run[1]]);
  }
  return joined
    .filter(([a, b]) => b - a >= MIN_CROSSING_KM)
    .map(([a, b]) => ({ s0: Math.max(0, a - BRIDGE_RAMP_KM), s1: Math.min(total, b + BRIDGE_RAMP_KM), wet0: a, wet1: b }));
}

/** A box lying along the segment a→b (world XZ), `width` across, between heights y0 (bottom) and y1 (top). */
function boxAlong(ax: number, az: number, bx: number, bz: number, width: number, y0a: number, y0b: number, thick: number, side = 0): THREE.BufferGeometry {
  const len = Math.hypot(bx - ax, bz - az);
  const geo = new THREE.BoxGeometry(width, thick, len + 0.02);
  const dirX = (bx - ax) / len;
  const dirZ = (bz - az) / len;
  // local +z along the segment, local +x across it
  const m = new THREE.Matrix4().makeBasis(
    new THREE.Vector3(dirZ, 0, -dirX),
    new THREE.Vector3(0, 1, 0),
    new THREE.Vector3(dirX, 0, dirZ),
  );
  m.setPosition((ax + bx) / 2 + dirZ * side, (y0a + y0b) / 2 + thick / 2, (az + bz) / 2 - dirX * side);
  return geo.applyMatrix4(m);
}

function mesh(parts: THREE.BufferGeometry[], color: number, order: number): THREE.Mesh | null {
  if (parts.length === 0) return null;
  const geo = mergeGeometries(parts);
  if (geo === null) return null;
  const out = new THREE.Mesh(
    geo,
    new THREE.MeshStandardMaterial({ color, roughness: 0.85, metalness: 0, depthWrite: false }),
  );
  out.renderOrder = order;
  out.frustumCulled = false;
  return out;
}

/**
 * Bridges for every road of a world that crosses water, or null when none
 * does. `deckAt` is the world Y a road is drawn at (the ground, sea level
 * over water) and `waterAt` the world Y of the water surface under it.
 */
export function buildBridges(
  world: WorldSpec,
  isWater: (xKm: number, yKm: number) => boolean,
  deckAt: (xKm: number, yKm: number) => number,
  waterAt: (xKm: number, yKm: number) => number,
): THREE.Group | null {
  const decks: THREE.BufferGeometry[] = [];
  const parapets: THREE.BufferGeometry[] = [];
  const piers: THREE.BufferGeometry[] = [];
  const width = BRIDGE_WIDTH_KM * SCALE;
  for (const route of world.routes) {
    if (route.mode !== 'road') continue;
    const cum = cumulative(route.points);
    for (const span of bridgeSpans(route.points, isWater)) {
      // the deck in short straight pieces, so it follows bends and the banks' slope
      const n = Math.max(1, Math.ceil((span.s1 - span.s0) / 1.5));
      let prev = pointAt(route.points, cum, span.s0);
      for (let k = 1; k <= n; k++) {
        const cur = pointAt(route.points, cum, span.s0 + ((span.s1 - span.s0) * k) / n);
        const [ax, az] = mapToWorld(prev.x, prev.y);
        const [bx, bz] = mapToWorld(cur.x, cur.y);
        if (Math.hypot(bx - ax, bz - az) > 1e-6) {
          const ya = deckAt(prev.x, prev.y) + DECK_TOP - DECK_THICK;
          const yb = deckAt(cur.x, cur.y) + DECK_TOP - DECK_THICK;
          decks.push(boxAlong(ax, az, bx, bz, width, ya, yb, DECK_THICK));
          for (const sign of [-1, 1]) {
            parapets.push(
              boxAlong(ax, az, bx, bz, PARAPET_WIDTH, ya + DECK_THICK, yb + DECK_THICK, PARAPET_HEIGHT, (sign * (width - PARAPET_WIDTH)) / 2),
            );
          }
        }
        prev = cur;
      }
      // piers, evenly spaced over the wet part
      const wetLen = span.wet1 - span.wet0;
      const count = Math.max(1, Math.round(wetLen / PIER_SPACING_KM));
      for (let k = 0; k < count; k++) {
        const at = pointAt(route.points, cum, span.wet0 + (wetLen * (k + 0.5)) / count);
        const top = deckAt(at.x, at.y) + DECK_TOP - DECK_THICK;
        const bottom = waterAt(at.x, at.y) - 0.02;
        if (top - bottom < 0.04) continue;
        const [x, z] = mapToWorld(at.x, at.y);
        const half = 0.045;
        piers.push(
          boxAlong(x - at.dirX * half, z - at.dirY * half, x + at.dirX * half, z + at.dirY * half, width * 0.72, bottom, bottom, top - bottom),
        );
      }
    }
  }
  const group = new THREE.Group();
  // after the route lines (-1), before sites and vehicles (0); piers, then deck, then parapets
  for (const part of [mesh(piers, PIER_COLOR, -0.6), mesh(decks, DECK_COLOR, -0.55), mesh(parapets, PARAPET_COLOR, -0.5)]) {
    if (part !== null) group.add(part);
  }
  return group.children.length > 0 ? group : null;
}
