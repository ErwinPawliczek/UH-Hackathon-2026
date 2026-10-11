// Draped polyline lines: routes (roads, rivers, sea lanes) and pipelines.
// Fat lines (Line2) so the network reads at map scale — WebGL's native lines
// are always one pixel — with widths in screen pixels and dashes in world
// units along the arc length, so dashes keep a constant size at any zoom.
//
// Lines are drawn over the hex board without depth testing (and before
// everything else, see renderOrder.ts), so a route can never disappear
// under a tile or behind a coast wall, while sites and vehicles still draw
// on top of it.

import * as THREE from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { mapToWorld } from './terrainMesh';
import { LINE_RENDER_ORDER } from './renderOrder';

export interface FlowLine {
  line: Line2;
  material: LineMaterial;
  /** dash drift in world units per second (0 = static) */
  speed: number;
  /** base colour, restored when a closed route reopens */
  color: number;
}

export interface FlowLineOptions {
  color: number;
  /** dash length in world units; 0 or gap 0 draws a solid line */
  dash: number;
  gap: number;
  /** line width in screen pixels */
  width?: number;
  /** world units per second of dash motion; 0 for a static line */
  speed?: number;
  opacity?: number;
  /** world units above the sampled surface */
  lift?: number;
}

/**
 * Draped line along map-km points. `heightAt` gives the world Y of the
 * surface under a point (ground for roads and pipelines, the water surface
 * for river and sea lanes).
 */
export function buildFlowLine(
  points: [number, number][],
  heightAt: (xKm: number, yKm: number) => number,
  opts: FlowLineOptions,
): FlowLine {
  const positions: number[] = [];
  for (const [xKm, yKm] of points) {
    const [x, z] = mapToWorld(xKm, yKm);
    positions.push(x, heightAt(xKm, yKm) + (opts.lift ?? 0.05), z);
  }
  // LineGeometry needs at least one segment; a degenerate route still builds.
  if (positions.length < 6) {
    while (positions.length < 6) positions.push(positions[0] ?? 0, positions[1] ?? 0, positions[2] ?? 0);
  }
  const geo = new LineGeometry();
  geo.setPositions(positions);
  const dashed = opts.dash > 0 && opts.gap > 0;
  const material = new LineMaterial({
    color: opts.color,
    linewidth: opts.width ?? 1.5,
    worldUnits: false,
    dashed,
    dashSize: dashed ? opts.dash : 1,
    gapSize: dashed ? opts.gap : 0,
    transparent: (opts.opacity ?? 1) < 1,
    opacity: opts.opacity ?? 1,
    depthTest: false,
    depthWrite: false,
  });
  const line = new Line2(geo, material);
  line.computeLineDistances();
  line.renderOrder = LINE_RENDER_ORDER;
  line.frustumCulled = false;
  return { line, material, speed: opts.speed ?? 0, color: opts.color };
}

/** Tell every line the canvas size — fat-line widths are in screen pixels. */
export function resizeFlowLines(lines: FlowLine[], width: number, height: number): void {
  for (const l of lines) l.material.resolution.set(width, height);
}

/** Advance dash drift; call once per frame with elapsed seconds. */
export function tickFlowLines(lines: FlowLine[], dtSec: number): void {
  for (const l of lines) {
    if (l.speed === 0) continue;
    l.material.dashOffset -= dtSec * l.speed;
  }
}

const colorTmp = new THREE.Color();

/** Recolour one line (closed routes turn alarm red, reopened ones go back). */
export function setFlowLineColor(line: FlowLine, color: number): void {
  if (line.material.color.getHex() === colorTmp.setHex(color).getHex()) return;
  line.material.color.setHex(color);
}
