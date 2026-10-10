// Draped polyline lines: routes (roads, rivers, sea lanes) render as static
// dashed lines, pipelines as flow-animated dashes. Both share one shader whose
// dash phase runs on cumulative arc length, so dashes keep a constant world
// size regardless of zoom.

import * as THREE from 'three';
import { HEIGHT_SCALE, mapToWorld } from './terrainMesh';
import { sampleHeight, type TerrainGrid } from '../engine/world';

const VERT = /* glsl */ `
attribute float aDist;
varying float vDist;
void main() {
  vDist = aDist;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform vec3 uColor;
uniform float uTime;
uniform float uSpeed;
uniform float uDash;
uniform float uGap;
uniform float uOpacity;
varying float vDist;
void main() {
  float ph = mod(vDist - uTime * uSpeed, uDash + uGap);
  if (ph > uDash) discard;
  gl_FragColor = vec4(uColor, uOpacity);
}`;

export interface FlowLine {
  line: THREE.Line;
  material: THREE.ShaderMaterial;
  /** animation speed multiplier (0 = static dash) */
  speed: number;
}

export interface FlowLineOptions {
  color: number;
  /** dash length in world units */
  dash: number;
  gap: number;
  /** world units per second of dash motion; 0 for a static dashed line */
  speed?: number;
  opacity?: number;
  /** metres above terrain */
  lift?: number;
}

/** Draped, dashed line along map-km points, following sampled terrain height. */
export function buildFlowLine(points: [number, number][], grid: TerrainGrid, opts: FlowLineOptions): FlowLine {
  const positions = new Float32Array(points.length * 3);
  const dists = new Float32Array(points.length);
  let dist = 0;
  points.forEach(([xKm, yKm], i) => {
    const hM = sampleHeight(grid, xKm, yKm);
    const [x, z] = mapToWorld(xKm, yKm);
    positions.set([x, (hM - grid.seaLevelM) * HEIGHT_SCALE + (opts.lift ?? 0.05), z], i * 3);
    if (i > 0) {
      const [px, pz] = mapToWorld(points[i - 1][0], points[i - 1][1]);
      dist += Math.hypot(x - px, z - pz);
    }
    dists[i] = dist;
  });
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geo.setAttribute('aDist', new THREE.BufferAttribute(dists, 1));
  const material = new THREE.ShaderMaterial({
    vertexShader: VERT,
    fragmentShader: FRAG,
    uniforms: {
      uColor: { value: new THREE.Color(opts.color) },
      uTime: { value: 0 },
      uSpeed: { value: 0 },
      uDash: { value: opts.dash },
      uGap: { value: opts.gap },
      uOpacity: { value: opts.opacity ?? 0.9 },
    },
    transparent: true,
  });
  return { line: new THREE.Line(geo, material), material, speed: opts.speed ?? 0 };
}

/** Advance flow animation; call once per frame with elapsed seconds. */
export function tickFlowLines(lines: FlowLine[], dtSec: number): void {
  for (const l of lines) {
    if (l.speed === 0) continue;
    l.material.uniforms.uTime.value += dtSec * l.speed;
  }
}
