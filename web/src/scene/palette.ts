// Colour decisions for the scene, in one place. Terrain ramp by elevation,
// process status colours (§4.3 order), and a stable per-material hue for
// cargo/tank tinting.

import * as THREE from 'three';

/** Process status colours, index = §4.3 ProcStatus enum. */
export const PROC_STATUS_COLORS = [
  0x34d399, // Running — emerald
  0xfbbf24, // HoldMin — amber
  0xf59e0b, // HoldMax — orange
  0xf87171, // Shutdown — red
  0x60a5fa, // Restarting — blue
] as const;

export const PROC_STATUS_LABELS = ['Running', 'Hold min', 'Hold max', 'Shutdown', 'Restarting'] as const;

export const EDGE_COLORS = {
  road: 0xd4a017,
  river: 0x38bdf8,
  sea: 0x22d3ee,
  pipeline: 0xfb923c,
} as const;

/** Site status colours, index = SiteStatus enum order (§4.3). */
export const SITE_STATUS = {
  ok: 0x34d399,
  warn: 0xfbbf24,
  impact: 0xf59e0b,
  down: 0xf87171,
  offline: 0x60a5fa,
} as const;

const materialCache = new Map<string, THREE.Color>();

/** Stable, deterministic colour per material name. */
export function materialColor(material: string): THREE.Color {
  const cached = materialCache.get(material);
  if (cached !== undefined) return cached;
  let hash = 0;
  for (let i = 0; i < material.length; i++) hash = (hash * 31 + material.charCodeAt(i)) >>> 0;
  const color = new THREE.Color().setHSL((hash % 360) / 360, 0.65, 0.55);
  materialCache.set(material, color);
  return color;
}

/** Terrain colour by elevation in metres; sea floor and shoreline included. */
export function terrainColor(heightM: number, seaLevelM: number): [number, number, number] {
  const c = new THREE.Color();
  if (heightM < seaLevelM) {
    const depth = Math.min(1, (seaLevelM - heightM) / 600); // 1 = deepest
    c.setHex(0x1d6f8f).lerp(new THREE.Color(0x0a2c4a), depth);
  } else if (heightM < seaLevelM + 25) {
    c.setHex(0xc9b98a); // shoreline sand
  } else {
    const up = Math.min(1, (heightM - seaLevelM - 25) / 1800);
    c.setHex(0x4d7c4f) // lowland green
      .lerp(new THREE.Color(0x8a9a5b), Math.min(1, up * 2.5))
      .lerp(new THREE.Color(0x9c8f72), Math.max(0, up * 1.8 - 1))
      .lerp(new THREE.Color(0xd8dee4), Math.max(0, up * 3.2 - 2.4)); // peaks
  }
  return [c.r, c.g, c.b];
}
