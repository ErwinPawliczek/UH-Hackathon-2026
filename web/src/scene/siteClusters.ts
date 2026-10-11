// Site layer: every site drawn FROM ITS UNITS — one raised hexagonal pad per
// process unit, arranged in a compact hex cluster at the site position, each
// carrying the unit's glyph. Colour follows the v3 site states (fill + hex
// outline); unknown server glyphs fall back to a small hexagon marker.
// Sites with no units (some sources/sinks) render one hexagon marker.

import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { sampleHeight, siteRanges, type WorldSpec } from '../engine/world';
import type { Snapshot } from '../engine/snapshot';
import { V3, materialColor, siteStateStyle } from './palette';
import { hexCenter, hexSpiral } from './hexGrid';
import { SCALE, hexPrismGeometry, terrainYAt } from './terrainMesh';

/** Marker pad dimensions, in world units (1 unit = 10 km). */
export const PAD_RADIUS = 0.3;
export const PAD_HEIGHT = 0.26;
/** Axial "size" for the cluster layout — neighbours land √3·spacing apart. */
const CLUSTER_SPACING = 0.45;
/** How far pads embed below the smooth terrain height (board tops sit lower). */
const PAD_EMBED = 0.06;

/**
 * Tank level bars: thin bars in a compact block beside the site (a small bar
 * chart of its tanks), on the side with the most room — clear of neighbouring
 * sites and their labels, and on land.
 */
const BAR_SIZE = 0.18;
const BAR_PITCH = 0.27;
const BAR_MIN_HEIGHT = 0.05;
const BAR_FULL_HEIGHT = 0.55;
const BARS_PER_ROW = 4;
/** Sides a block may take, as map directions (x east, y south), in order of preference. */
const BAR_SIDES: [number, number][] = [
  [1, 0], [-1, 0], [0.71, -0.71], [-0.71, -0.71], [0.71, 0.71], [-0.71, 0.71], [0, -1],
];

/**
 * Where each site's block of tank bars goes: the centre of the block in map
 * km, per site. Picks, among the sides, the one whose block centre is
 * furthest from every other site (and not on water).
 */
export function tankBlockCentres(
  sites: { x: number; y: number }[],
  clusterRKm: number[],
  blockRadiusKm: number[],
  isWater: (xKm: number, yKm: number) => boolean,
): { x: number; y: number }[] {
  return sites.map((site, s) => {
    let best = { x: site.x, y: site.y };
    let bestScore = -Infinity;
    BAR_SIDES.forEach(([dx, dy], rank) => {
      const reach = clusterRKm[s] + blockRadiusKm[s] + 2.5;
      const c = { x: site.x + dx * reach, y: site.y + dy * reach };
      let room = 80;
      sites.forEach((other, o) => {
        if (o === s) return;
        // a neighbour's label sits above (north of) its cluster: keep clear of that too
        const toSite = Math.hypot(other.x - c.x, other.y - c.y) - clusterRKm[o];
        const toLabel = Math.hypot(other.x - c.x, other.y - 9 - c.y) - 6;
        room = Math.min(room, toSite, toLabel);
      });
      const score = room - blockRadiusKm[s] - rank * 1.5 - (isWater(c.x, c.y) ? 60 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    });
    return best;
  });
}

export interface TankAnchor {
  x: number;
  z: number;
  groundY: number;
}

/** Per-site anchor used for picking, the selection ring and labels. */
export interface SiteAnchor {
  x: number;
  z: number;
  /** smooth terrain height at the site centre */
  groundY: number;
  /** pad-top world Y */
  topY: number;
  /** cluster radius in world units */
  clusterR: number;
}

export interface SiteLayer {
  /** one raised hex prism per unit marker */
  pads: THREE.InstancedMesh;
  /** one flat hex outline per marker (the v3 state outline) */
  rings: THREE.InstancedMesh;
  /** one instanced mesh per glyph kind */
  glyphs: THREE.InstancedMesh[];
  /** tank level bars, one instance per tank */
  tanks: THREE.InstancedMesh;
  /** pad instanceId → site index */
  glyphSite: number[];
  /** world-space anchor per tank, in tank order */
  anchors: TankAnchor[];
  /** per-site anchors in site order */
  siteAnchors: SiteAnchor[];
  /** per marker: index into `glyphs` and instance slot within that mesh */
  markerGlyphMesh: number[];
  markerGlyphSlot: number[];
}

/** Glyph kinds the client renders; anything else falls back to a hexagon. */
const KNOWN_GLYPHS = new Set([
  'column', 'furnace', 'reactor', 'compressor_house', 'extruder_hall', 'tank',
  'flare', 'jetty', 'pipe_rack', 'truck_rack', 'silo', 'cell_room', 'exchanger_bank',
]);

const FALLBACK_GLYPH = '__hex__';

let fallbackGeometry: THREE.BufferGeometry | null = null;

/**
 * Geometry for one unit glyph, base at y=0, sized for a PAD_RADIUS pad.
 * Unknown glyph names (the server may send any) resolve to a small hexagon —
 * the brand shape — so every unit renders something clean.
 */
export function glyphGeometry(kind: string): THREE.BufferGeometry {
  switch (kind) {
    case 'column':
      return mergeGeometries([
        new THREE.CylinderGeometry(0.055, 0.075, 0.42, 10).translate(0, 0.25, 0),
        new THREE.CylinderGeometry(0.1, 0.1, 0.04, 10).translate(0, 0.02, 0),
      ]);
    case 'furnace':
      return mergeGeometries([
        new THREE.BoxGeometry(0.24, 0.18, 0.24).translate(0, 0.09, 0),
        new THREE.CylinderGeometry(0.028, 0.028, 0.12, 8).translate(0.07, 0.24, 0.07),
      ]);
    case 'reactor':
      return mergeGeometries([
        new THREE.CylinderGeometry(0.11, 0.11, 0.2, 12).translate(0, 0.1, 0),
        new THREE.SphereGeometry(0.11, 10, 8).scale(1, 0.5, 1).translate(0, 0.2, 0),
      ]);
    case 'compressor_house':
      return mergeGeometries([
        new THREE.BoxGeometry(0.3, 0.14, 0.2).translate(0, 0.07, 0),
        new THREE.BoxGeometry(0.12, 0.08, 0.12).translate(0, 0.18, 0),
      ]);
    case 'extruder_hall':
      return mergeGeometries([
        new THREE.BoxGeometry(0.38, 0.12, 0.18).translate(0, 0.06, 0),
        new THREE.BoxGeometry(0.34, 0.05, 0.14).translate(0, 0.145, 0),
      ]);
    case 'tank':
      return mergeGeometries([
        new THREE.CylinderGeometry(0.14, 0.14, 0.16, 12).translate(0, 0.08, 0),
        new THREE.ConeGeometry(0.14, 0.06, 12).translate(0, 0.19, 0),
      ]);
    case 'flare':
      return mergeGeometries([
        new THREE.CylinderGeometry(0.02, 0.02, 0.4, 6).translate(0, 0.2, 0),
        new THREE.SphereGeometry(0.035, 8, 6).translate(0, 0.42, 0),
      ]);
    case 'jetty':
      return mergeGeometries([
        new THREE.BoxGeometry(0.4, 0.03, 0.12).translate(0, 0.12, 0),
        new THREE.BoxGeometry(0.03, 0.12, 0.03).translate(-0.14, 0.06, 0),
        new THREE.BoxGeometry(0.03, 0.12, 0.03).translate(0.14, 0.06, 0),
      ]);
    case 'pipe_rack':
      return mergeGeometries([
        new THREE.BoxGeometry(0.03, 0.16, 0.03).translate(-0.12, 0.08, 0),
        new THREE.BoxGeometry(0.03, 0.16, 0.03).translate(0.12, 0.08, 0),
        new THREE.BoxGeometry(0.32, 0.03, 0.12).translate(0, 0.175, 0),
        new THREE.CylinderGeometry(0.024, 0.024, 0.3, 8).rotateZ(Math.PI / 2).translate(0, 0.215, 0),
        new THREE.CylinderGeometry(0.024, 0.024, 0.3, 8).rotateZ(Math.PI / 2).translate(0, 0.265, 0),
      ]);
    case 'truck_rack':
      return mergeGeometries([
        new THREE.BoxGeometry(0.34, 0.04, 0.22).translate(0, 0.02, 0),
        new THREE.BoxGeometry(0.09, 0.06, 0.06).translate(-0.08, 0.07, 0),
        new THREE.BoxGeometry(0.09, 0.06, 0.06).translate(0.08, 0.07, 0),
      ]);
    case 'silo':
      return mergeGeometries([
        new THREE.CylinderGeometry(0.12, 0.12, 0.22, 12).translate(0, 0.11, 0),
        new THREE.ConeGeometry(0.12, 0.1, 12).translate(0, 0.27, 0),
      ]);
    case 'cell_room':
      return mergeGeometries([
        new THREE.BoxGeometry(0.3, 0.16, 0.22).translate(0, 0.08, 0),
        new THREE.BoxGeometry(0.2, 0.06, 0.16).translate(0, 0.19, 0),
      ]);
    case 'exchanger_bank':
      return mergeGeometries([
        new THREE.BoxGeometry(0.26, 0.04, 0.14).translate(0, 0.02, 0),
        new THREE.CylinderGeometry(0.05, 0.05, 0.3, 8).rotateZ(Math.PI / 2).translate(0, 0.1, 0),
        new THREE.CylinderGeometry(0.05, 0.05, 0.3, 8).rotateZ(Math.PI / 2).translate(0, 0.22, 0),
      ]);
    case FALLBACK_GLYPH:
      fallbackGeometry ??= new THREE.CylinderGeometry(0.16, 0.16, 0.09, 6).translate(0, 0.045, 0);
      return fallbackGeometry;
    default:
      return glyphGeometry(FALLBACK_GLYPH);
  }
}

/** A unit marker's glyph kind — unknown server names fall back to the hexagon. */
export function markerGlyphKind(glyph: string): string {
  return KNOWN_GLYPHS.has(glyph) ? glyph : FALLBACK_GLYPH;
}

interface MarkerSpec {
  site: number;
  glyph: string; // resolved kind
  x: number;
  z: number;
  baseY: number;
}

/** Build every site from its units: pads, outlines, glyphs, tanks, anchors. */
export function buildSiteLayer(world: WorldSpec): SiteLayer {
  const markers: MarkerSpec[] = [];
  const siteAnchors: SiteAnchor[] = [];

  world.sites.forEach((site, s) => {
    const [wx, wz] = [site.x * SCALE, site.y * SCALE];
    const groundY = terrainYAt(world, site.x, site.y);
    const units = site.processes.flatMap((p) => p.units);
    const offsets = hexSpiral(Math.max(1, units.length));
    let clusterR = PAD_RADIUS;
    offsets.forEach((off, u) => {
      const [ox, oz] = hexCenter(off.q, off.r, CLUSTER_SPACING);
      const dist = Math.hypot(ox, oz) + PAD_RADIUS;
      if (dist > clusterR) clusterR = dist;
      const glyph = units.length === 0 ? FALLBACK_GLYPH : markerGlyphKind(units[u].glyph);
      markers.push({ site: s, glyph, x: wx + ox, z: wz + oz, baseY: groundY - PAD_EMBED });
    });
    siteAnchors.push({
      x: wx, z: wz, groundY,
      topY: groundY - PAD_EMBED + PAD_HEIGHT,
      clusterR,
    });
  });

  const pads = new THREE.InstancedMesh(
    hexPrismGeometry(0.902), // 0xe6e9ec walls against a white top
    new THREE.MeshBasicMaterial({ vertexColors: true, color: 0xffffff }),
    markers.length,
  );
  const rings = new THREE.InstancedMesh(
    hexRingGeometry(),
    new THREE.MeshBasicMaterial({ color: 0xffffff }),
    markers.length,
  );

  const glyphSite: number[] = [];
  const m = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const pos = new THREE.Vector3();
  const scl = new THREE.Vector3();
  markers.forEach((mk, i) => {
    pos.set(mk.x, mk.baseY + PAD_HEIGHT / 2, mk.z);
    scl.set(PAD_RADIUS * 0.97, PAD_HEIGHT, PAD_RADIUS * 0.97);
    m.compose(pos, q, scl);
    pads.setMatrixAt(i, m);
    pos.y = mk.baseY + PAD_HEIGHT + 0.012;
    scl.set(PAD_RADIUS * 1.04, 1, PAD_RADIUS * 1.04);
    m.compose(pos, q, scl);
    rings.setMatrixAt(i, m);
    glyphSite.push(mk.site);
  });
  pads.instanceMatrix.needsUpdate = true;
  rings.instanceMatrix.needsUpdate = true;

  // one instanced mesh per glyph kind; markers remember their mesh + slot
  const byKind = new Map<string, number[]>();
  markers.forEach((mk, i) => {
    const list = byKind.get(mk.glyph) ?? [];
    list.push(i);
    byKind.set(mk.glyph, list);
  });
  const glyphs: THREE.InstancedMesh[] = [];
  const markerGlyphMesh: number[] = new Array(markers.length).fill(0);
  const markerGlyphSlot: number[] = new Array(markers.length).fill(0);
  for (const [kind, markerIdxs] of byKind) {
    const mesh = new THREE.InstancedMesh(
      glyphGeometry(kind),
      new THREE.MeshBasicMaterial({ color: 0xffffff }),
      markerIdxs.length,
    );
    markerIdxs.forEach((markerIdx, slot) => {
      placeGlyph(markers[markerIdx], mesh, slot, m);
      markerGlyphMesh[markerIdx] = glyphs.length;
      markerGlyphSlot[markerIdx] = slot;
    });
    mesh.instanceMatrix.needsUpdate = true;
    glyphs.push(mesh);
  }

  // Tank specs have no position — each site's tanks stand as a compact block
  // of thin level bars beside its unit cluster.
  const anchors: TankAnchor[] = [];
  const tanks = new THREE.InstancedMesh(
    barGeometry(),
    new THREE.MeshBasicMaterial({ vertexColors: true, color: 0xffffff }),
    Math.max(1, world.tanks.length),
  );
  tanks.count = world.tanks.length;
  const ranges = siteRanges(world);
  const blockDims = world.sites.map((_, s) => {
    const count = Math.max(1, ranges[s].tankIndices.length);
    const cols = Math.min(count, BARS_PER_ROW);
    const rows = Math.ceil(count / BARS_PER_ROW);
    return { cols, rows, radiusKm: (Math.hypot(cols, rows) * BAR_PITCH) / 2 / SCALE };
  });
  const centres = tankBlockCentres(
    world.sites,
    siteAnchors.map((a) => a.clusterR / SCALE),
    blockDims.map((d) => d.radiusKm),
    (x, y) => sampleHeight(world.terrain, x, y) < world.terrain.seaLevelM,
  );
  world.tanks.forEach((tank, t) => {
    const k = Math.max(0, ranges[tank.site].tankIndices.indexOf(t));
    const { cols, rows } = blockDims[tank.site];
    const col = k % BARS_PER_ROW;
    const row = Math.floor(k / BARS_PER_ROW);
    const x = centres[tank.site].x + ((col - (cols - 1) / 2) * BAR_PITCH) / SCALE;
    const y = centres[tank.site].y + ((row - (rows - 1) / 2) * BAR_PITCH) / SCALE;
    const anchor: TankAnchor = { x: x * SCALE, z: y * SCALE, groundY: terrainYAt(world, x, y) };
    anchors.push(anchor);
    tanks.setMatrixAt(t, tankMatrix(anchor, 0.3));
    tanks.setColorAt(t, barColor(tank.material));
  });
  tanks.instanceMatrix.needsUpdate = true;

  return { pads, rings, glyphs, tanks, glyphSite, anchors, siteAnchors, markerGlyphMesh, markerGlyphSlot };
}

/** Place one glyph instance on its pad. */
function placeGlyph(
  mk: MarkerSpec,
  mesh: THREE.InstancedMesh,
  slot: number,
  m: THREE.Matrix4,
): void {
  m.makeTranslation(mk.x, mk.baseY + PAD_HEIGHT, mk.z);
  mesh.setMatrixAt(slot, m);
}

/** A unit box whose sides are a shade darker than its top, so bars standing together read apart. */
function barGeometry(): THREE.BufferGeometry {
  const geo = new THREE.BoxGeometry(1, 1, 1).toNonIndexed();
  const normal = geo.getAttribute('normal');
  const tones = new Float32Array(normal.count * 3);
  for (let i = 0; i < normal.count; i++) {
    const tone = normal.getY(i) > 0.9 ? 1 : normal.getZ(i) > 0.9 ? 0.82 : 0.66;
    tones.set([tone, tone, tone], 3 * i);
  }
  geo.setAttribute('color', new THREE.BufferAttribute(tones, 3));
  return geo;
}

/** Ink bars are drawn a shade off black, so their darker sides still show against their tops. */
const INK_BAR = new THREE.Color(0x33373c);

/** A tank bar's colour: its material's class colour (see palette.ts). */
function barColor(material: string): THREE.Color {
  const color = materialColor(material);
  return color.getHex() === V3.ink ? INK_BAR : color;
}

function tankMatrix(anchor: TankAnchor, fill: number): THREE.Matrix4 {
  const height = BAR_MIN_HEIGHT + Math.min(1, Math.max(0, fill)) * BAR_FULL_HEIGHT;
  return new THREE.Matrix4().compose(
    new THREE.Vector3(anchor.x, anchor.groundY + height / 2, anchor.z),
    new THREE.Quaternion(),
    new THREE.Vector3(BAR_SIZE, height, BAR_SIZE),
  );
}

/** Flat hex ring geometry (the marker outline), lying in the XZ plane. */
function hexRingGeometry(): THREE.BufferGeometry {
  const shape = hexPath(new THREE.Shape(), 1);
  shape.holes.push(hexPath(new THREE.Shape(), 0.8));
  const geo = new THREE.ShapeGeometry(shape);
  geo.rotateX(-Math.PI / 2);
  return geo;
}

function hexPath<T extends THREE.Path>(target: T, radius: number): T {
  for (let i = 0; i <= 6; i++) {
    const a = (Math.PI / 180) * (60 * i + 30);
    const x = radius * Math.cos(a);
    const y = radius * Math.sin(a);
    if (i === 0) target.moveTo(x, y);
    else target.lineTo(x, y);
  }
  return target;
}

const colorTmp = new THREE.Color();

/**
 * Recolour pads, outlines and glyphs from the snapshot's site status and the
 * current selection; update tank fill bars. `f` interpolates tank fills.
 */
export function updateInstances(
  layer: SiteLayer,
  snap: Snapshot,
  prev: Snapshot | null,
  f: number,
  selectedSite: number | null,
): void {
  for (let i = 0; i < layer.glyphSite.length; i++) {
    const site = layer.glyphSite[i];
    const status = snap.siteStatus[site] ?? 0;
    const style = siteStateStyle(status, site === selectedSite);
    layer.pads.setColorAt(i, colorTmp.setHex(style.fill));
    layer.rings.setColorAt(i, colorTmp.setHex(style.outline));
    const mesh = layer.glyphs[layer.markerGlyphMesh[i]];
    if (mesh !== undefined) mesh.setColorAt(layer.markerGlyphSlot[i], colorTmp.setHex(style.glyph));
  }
  if (layer.pads.instanceColor !== null) layer.pads.instanceColor.needsUpdate = true;
  if (layer.rings.instanceColor !== null) layer.rings.instanceColor.needsUpdate = true;
  for (const g of layer.glyphs) if (g.instanceColor !== null) g.instanceColor.needsUpdate = true;

  const anchors = layer.anchors;
  for (let t = 0; t < anchors.length && (t + 1) * 4 <= snap.tanks.length; t++) {
    const fill = snap.tanks[4 * t];
    const prevFill = prev !== null && (t + 1) * 4 <= prev.tanks.length ? prev.tanks[4 * t] : fill;
    const fi = Math.max(0.02, prevFill + (fill - prevFill) * f);
    layer.tanks.setMatrixAt(t, tankMatrix(anchors[t], fi));
  }
  layer.tanks.instanceMatrix.needsUpdate = true;
}
