// Catalog join for process cards. The recipes live with the engine
// (engine/data/catalog/processes/*.json) and are imported straight from there —
// one source of truth, no server data routes: `vite build` bundles the JSON and
// the dev server serves it via server.fs.allow (see vite.config.ts). If a
// future toolchain change makes that import fight, the fallback is a synced
// copy under web/src/catalog/ with a header comment naming this file's source
// of truth — never an HTTP fetch.
//
// Terminology (§3 catalog): a process type's `internal` list names the
// intermediates its own units chain between (resid, treated, reformate, …).
// Those never trade, so the cards fade them as "internal flow". `LOSS` is
// vanished mass (heat, flue) — also never a tradable flow, faded the same way.
// Sources and sinks have one-sided recipes (in {} or out {}); both render fine.

import p1 from '../../../engine/data/catalog/processes/p1_gas_plant.json';
import p2 from '../../../engine/data/catalog/processes/p2_refinery.json';
import p3 from '../../../engine/data/catalog/processes/p3_steam_cracker.json';
import p4 from '../../../engine/data/catalog/processes/p4_chlor_alkali.json';
import p5 from '../../../engine/data/catalog/processes/p5_polyethylene.json';
import p6 from '../../../engine/data/catalog/processes/p6_polypropylene.json';
import p7 from '../../../engine/data/catalog/processes/p7_vinyls.json';
import p8 from '../../../engine/data/catalog/processes/p8_styrenics.json';
import sources from '../../../engine/data/catalog/processes/sources.json';
import sinks from '../../../engine/data/catalog/processes/sinks.json';

export const LOSS_KEY = 'LOSS';

export interface Recipe {
  in: Record<string, number>;
  out: Record<string, number>;
}

export interface CatalogUnit {
  key: string;
  name: string;
  trains: number;
  recipes: Recipe[];
}

export interface ProcessType {
  key: string;
  name: string;
  internal: string[];
  units: CatalogUnit[];
}

/** A recipe material with its mass share (0..1) and whether it renders faded. */
export interface FlowMaterial {
  key: string;
  share: number;
  /** true for process-internal intermediates and LOSS — fade in the UI */
  faded: boolean;
}

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null;
}

/** Shares map: string keys, finite numbers. Anything else invalidates the recipe. */
function toShares(x: unknown): Record<string, number> | undefined {
  if (!isRecord(x)) return undefined;
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(x)) {
    if (typeof v !== 'number' || !Number.isFinite(v)) return undefined;
    out[k] = v;
  }
  return out;
}

/**
 * Defensive runtime shape check — the JSON is authored data with no schema
 * gate on the client side; a malformed entry drops out of the join (and the
 * UI shows the bare key) instead of throwing during render.
 */
function toProcessType(raw: unknown): ProcessType | undefined {
  if (!isRecord(raw)) return undefined;
  const { key, name, internal, units } = raw;
  if (typeof key !== 'string' || key === '' || typeof name !== 'string') return undefined;
  if (!Array.isArray(internal) || internal.some((k) => typeof k !== 'string')) return undefined;
  if (!Array.isArray(units)) return undefined;
  const parsedUnits: CatalogUnit[] = [];
  for (const u of units) {
    if (!isRecord(u)) return undefined;
    const { key: uk, name: un, trains, recipes } = u;
    if (typeof uk !== 'string' || uk === '' || typeof un !== 'string') return undefined;
    if (typeof trains !== 'number' || !Number.isInteger(trains) || trains < 0) return undefined;
    if (!Array.isArray(recipes)) return undefined;
    const parsedRecipes: Recipe[] = [];
    for (const r of recipes) {
      if (!isRecord(r)) return undefined;
      const inMap = toShares(r.in);
      const outMap = toShares(r.out);
      if (inMap === undefined || outMap === undefined) return undefined;
      parsedRecipes.push({ in: inMap, out: outMap });
    }
    parsedUnits.push({ key: uk, name: un, trains, recipes: parsedRecipes });
  }
  return { key, name, internal: [...internal], units: parsedUnits };
}

// Each catalog file holds an array of process types; flatten defensively in
// case a file ever ships a single bare object.
const RAW_FILES: unknown[] = [p1, p2, p3, p4, p5, p6, p7, p8, sources, sinks];
const RAW: unknown[] = RAW_FILES.flatMap((file) => (Array.isArray(file) ? file : [file]));

const ALL: ProcessType[] = RAW.flatMap((raw) => {
  const pt = toProcessType(raw);
  return pt === undefined ? [] : [pt];
});

const byKey = new Map(ALL.map((pt) => [pt.key, pt]));

/** Catalog entry for a process key, or undefined for unknown keys (never throws). */
export function processType(key: string): ProcessType | undefined {
  return byKey.get(key);
}

/** True when `material` never trades: a process-internal intermediate or LOSS. */
export function isInternalFlow(internal: readonly string[], material: string): boolean {
  return material === LOSS_KEY || internal.includes(material);
}

/**
 * External flows for a card: the union of every unit recipe's materials minus
 * the process's internal intermediates, minus LOSS. Order follows first
 * appearance in the catalog (unit order, then recipe order) so cards render
 * deterministically.
 */
export function externalFlows(pt: ProcessType): { needs: string[]; makes: string[] } {
  const needs: string[] = [];
  const makes: string[] = [];
  for (const unit of pt.units) {
    for (const r of unit.recipes) {
      for (const k of Object.keys(r.in)) {
        if (!isInternalFlow(pt.internal, k) && !needs.includes(k)) needs.push(k);
      }
      for (const k of Object.keys(r.out)) {
        if (!isInternalFlow(pt.internal, k) && !makes.includes(k)) makes.push(k);
      }
    }
  }
  return { needs, makes };
}

/** A unit's recipes with shares and faded flags, or undefined for unknown units. */
export function unitRecipeFlows(
  pt: ProcessType,
  unitKey: string,
): { in: FlowMaterial[]; out: FlowMaterial[] }[] | undefined {
  const unit = pt.units.find((u) => u.key === unitKey);
  if (unit === undefined) return undefined;
  return unit.recipes.map((r) => ({
    in: Object.entries(r.in).map(([k, share]) => ({ key: k, share, faded: isInternalFlow(pt.internal, k) })),
    out: Object.entries(r.out).map(([k, share]) => ({ key: k, share, faded: isInternalFlow(pt.internal, k) })),
  }));
}
