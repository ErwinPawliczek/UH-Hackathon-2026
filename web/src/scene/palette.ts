// Scene colours for the v3 style (design/v3/simulation-style.md): black ink on
// a white page, one blue, red only when something is wrong. Transport modes
// are told apart by line style, not colour; flow colour encodes material class.

import * as THREE from 'three';
import type { RouteMode, WorldSpec } from '../engine/world';
import type { TerrainClass } from './hexGrid';

/** v3 colour tokens as hex numbers for three.js materials. */
export const V3 = {
  blue: 0x1764d6,
  blueStrong: 0x0f54ba,
  blueLight: 0x79aef2,
  blueSoft: 0xe8f0fc,
  ink: 0x0a0a0a,
  muted: 0x5f656c,
  dim: 0x9aa0a6,
  white: 0xffffff,
  panel: 0xf7f8f9,
  panel2: 0xf0f2f4,
  line: 0xe4e7ea,
  line2: 0xcdd2d7,
  alarm: 0xd1372f,
  land: 0xf1f3f5,
  river: 0x9dc3ef,
  lane: 0xb9bec4,
  /** water tiles: the water token at about one third strength on white */
  waterTile: 0xdde9f8,
} as const;

/** Process status labels, index = §4.3 ProcStatus enum — used by the inspector. */
export const PROC_STATUS_LABELS = ['Running', 'Hold min', 'Hold max', 'Shutdown', 'Restarting'] as const;

/**
 * Board fill per terrain class — land #f1f3f5, water a light tint of the
 * water token. (The v3 guide leaves the sea white like the page; on a
 * hand-drawn map the sea and rivers sit inside the board, so untinted water
 * reads as missing tiles.)
 */
export function terrainHexColor(cls: TerrainClass): number {
  return cls === 'water' ? V3.waterTile : V3.land;
}

/**
 * Flow colour by material class (§ v3 "Colour in the map"): gas and NGL
 * blue-light, olefins blue, crude and liquid fuels ink, polymers and other
 * solids dim; anything else (export/import lanes, unclassified) lane grey.
 */
const FLOW_CLASS: Record<string, 'gas' | 'olefin' | 'fuel' | 'solid'> = {
  RAW_GAS: 'gas', METHANE: 'gas', ETHANE: 'gas', LPG: 'gas', CHLORINE: 'gas',
  ETHYLENE: 'olefin', PROPYLENE: 'olefin', STYRENE: 'olefin', VCM: 'olefin',
  CRUDE: 'fuel', NAPHTHA: 'fuel', GASOLINE: 'fuel', JET: 'fuel', DIESEL: 'fuel', FUEL_OIL: 'fuel',
  HEAVY_NAPHTHA: 'fuel', GASOIL: 'fuel', VGO: 'fuel', BENZENE: 'fuel', SOLVENT: 'fuel',
  SALT: 'solid', PE: 'solid', PP: 'solid', PVC: 'solid', PS: 'solid', CAUSTIC: 'solid',
};

export function flowColor(material: string): number {
  switch (FLOW_CLASS[material]) {
    case 'gas': return V3.blueLight;
    case 'olefin': return V3.blue;
    case 'fuel': return V3.ink;
    case 'solid': return V3.dim;
    default: return V3.lane;
  }
}

/**
 * Line style per transport mode (§ v3): pipeline solid and thin, barge long
 * dash, ship dotted, road short dash. Pipeline solid = gap 0, set by the caller.
 */
export const MODE_LINE_STYLE: Record<RouteMode, { dash: number; gap: number; width: number }> = {
  road: { dash: 0.5, gap: 0.3, width: 1.6 },
  river: { dash: 1.6, gap: 0.6, width: 2.2 },
  sea: { dash: 0.16, gap: 0.34, width: 2.2 },
};

/** Pipeline line width in screen pixels — solid, the heaviest line on the map. */
export const PIPELINE_WIDTH = 2.6;

/**
 * Route line colour: river routes are the river itself (hydrography token);
 * sea lanes a lighter blue, dotted; road routes take the flow colour of the
 * first vehicle assigned to them (stub worlds), or road grey when none —
 * on engine worlds every road is shared, so every road is grey.
 */
export function routeLineColor(world: WorldSpec, routeIndex: number): number {
  const route = world.routes[routeIndex];
  if (route === undefined) return V3.lane;
  if (route.mode === 'river') return V3.river;
  if (route.mode === 'sea') return V3.blueLight;
  const veh = world.vehicles.find((v) => v.route === routeIndex);
  if (veh !== undefined) return flowColor(veh.cargo);
  return V3.dim;
}

/** Fill / outline / glyph colours for one site marker state (§ v3 site states). */
export interface SiteStateStyle {
  fill: number;
  outline: number;
  glyph: number;
}

/**
 * Site state → marker colours, index = SiteStatus enum order (§4.3):
 * ok, warn (hold min), impact (hold max), down, offline (restarting).
 * Selection overrides every state: blue outline on blue-soft fill.
 */
export function siteStateStyle(status: number, selected: boolean): SiteStateStyle {
  if (selected) return { fill: V3.blueSoft, outline: V3.blue, glyph: V3.ink };
  switch (status) {
    case 1: // holding at minimum — running reduced
    case 2: // holding at maximum — reduced throughput
      return { fill: V3.blueLight, outline: V3.ink, glyph: V3.ink };
    case 3: // shut down
      return { fill: V3.alarm, outline: V3.alarm, glyph: V3.white };
    case 4: // restarting
      return { fill: V3.white, outline: V3.alarm, glyph: V3.ink };
    default: // running at rate
      return { fill: V3.white, outline: V3.ink, glyph: V3.ink };
  }
}

const materialCache = new Map<string, THREE.Color>();

/** Stable class colour per material name — tank tinting and inspector chips. */
export function materialColor(material: string): THREE.Color {
  const cached = materialCache.get(material);
  if (cached !== undefined) return cached;
  const color = new THREE.Color(flowColor(material));
  materialCache.set(material, color);
  return color;
}
