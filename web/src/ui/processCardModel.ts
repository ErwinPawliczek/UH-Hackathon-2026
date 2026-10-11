// Pure model behind the process cards: joins the world spec (sites, units,
// trains), the live snapshot (proc rate/status, trains online, tank fills) and
// the bundled catalog (recipes) into presentable card data. No React and no
// store access — Vitest runs it in node, and ProcessCard.tsx stays purely
// presentational.
//
// Fed-by / Feeds are computed from the world payload's route graph (§7.3):
// pipelines are directed (fromSite → toSite with a material); road/river/sea
// routes are undirected in the payload, so their direction is inferred per
// material from the catalog — the end that can make (or needs) the material
// decides. A material whose direction can't be inferred (neither end makes it,
// e.g. transit or import lanes) is listed as "exchanged" rather than guessed.

import type { SiteRanges, WorldSpec } from '../engine/world';
import type { Snapshot } from '../engine/snapshot';
import { externalFlows, processType, unitRecipeFlows, type FlowMaterial } from '../catalog/processes';

export interface UnitRecipeRow {
  in: FlowMaterial[];
  out: FlowMaterial[];
}

export interface ProcessCardUnit {
  key: string;
  name: string;
  /** design train count from the world spec */
  trains: number;
  /** trains currently online from the snapshot (design − down) */
  trainsOnline: number;
  /** single-train unit: losing its one train stops the whole process */
  singleTrain: boolean;
  /** per-recipe in → out rows; [] when the catalog has no unit with this key */
  recipes: UnitRecipeRow[];
}

export interface ProcessCardData {
  key: string;
  name: string;
  /** process key found in the bundled catalog; false → bare-key card, no flows */
  known: boolean;
  /** §4.3 ProcStatus enum value from the snapshot */
  status: number;
  /** live rate as a fraction of design (0..1) */
  rate: number;
  /** external (tradable) inputs and outputs; [] when unknown */
  needs: string[];
  makes: string[];
  /** internal intermediates, faded in the UI */
  internals: string[];
  units: ProcessCardUnit[];
}

/** Site-external needs/makes, aggregating the site's processes' catalog flows. */
export function siteFlows(world: WorldSpec, siteIdx: number): { needs: string[]; makes: string[] } {
  const needs = new Set<string>();
  const makes = new Set<string>();
  for (const proc of world.sites[siteIdx]?.processes ?? []) {
    const pt = processType(proc.key);
    if (pt === undefined) continue;
    const flows = externalFlows(pt);
    flows.needs.forEach((k) => needs.add(k));
    flows.makes.forEach((k) => makes.add(k));
  }
  return { needs: [...needs], makes: [...makes] };
}

export interface SiteNeighbor {
  /** neighbour site index, or null for an off-map end (e.g. Overseas) */
  site: number | null;
  name: string;
  /** transport modes on this link: road | river | sea | pipeline */
  modes: string[];
  /** materials the neighbour sends to this site */
  feedsMe: string[];
  /** materials this site sends to the neighbour */
  iFeed: string[];
  /** materials flowing on the link whose direction the payload doesn't imply */
  exchanged: string[];
}

class NeighborTable {
  private readonly bySite = new Map<number | null, SiteNeighbor>();

  get(site: number | null, name: string): SiteNeighbor {
    let n = this.bySite.get(site);
    if (n === undefined) {
      n = { site, name, modes: [], feedsMe: [], iFeed: [], exchanged: [] };
      this.bySite.set(site, n);
    }
    return n;
  }

  list(): SiteNeighbor[] {
    return [...this.bySite.values()];
  }
}

function pushUnique(list: string[], x: string): void {
  if (!list.includes(x)) list.push(x);
}

/**
 * Neighbours of one site from the world payload's route graph. Direction:
 * pipelines are directed; route materials come from the vehicles that use the
 * route and are inferred from catalog needs/makes — the maker end feeds the
 * other; unresolvable materials land in `exchanged`.
 */
export function siteNeighbors(world: WorldSpec, siteIdx: number): SiteNeighbor[] {
  const table = new NeighborTable();
  const here = siteFlows(world, siteIdx);

  // pipelines are the only directed links in the payload
  for (const pipe of world.pipelines) {
    if (pipe.fromSite === pipe.toSite) continue;
    if (pipe.toSite === siteIdx) {
      const n = table.get(pipe.fromSite, world.sites[pipe.fromSite].name);
      if (!n.modes.includes('pipeline')) n.modes.push('pipeline');
      pushUnique(n.feedsMe, pipe.material);
    } else if (pipe.fromSite === siteIdx) {
      const n = table.get(pipe.toSite, world.sites[pipe.toSite].name);
      if (!n.modes.includes('pipeline')) n.modes.push('pipeline');
      pushUnique(n.iFeed, pipe.material);
    }
  }

  // routes: undirected; materials from the vehicles that shuttle them
  world.routes.forEach((route, rIdx) => {
    const myPos = route.sites[0] === siteIdx ? 0 : route.sites[1] === siteIdx ? 1 : -1;
    if (myPos < 0) return;
    const other = route.sites[1 - myPos];
    const name = other === null ? route.ends[1 - myPos] : world.sites[other].name;
    const n = table.get(other, name);
    if (!n.modes.includes(route.mode)) n.modes.push(route.mode);

    const materials = new Set(
      world.vehicles.filter((v) => v.route === rIdx).map((v) => v.cargo),
    );
    const otherFlows = other === null ? { needs: [], makes: [] } : siteFlows(world, other);
    for (const m of materials) {
      // The end that can make the material ships it to the one that can't
      // (covers sinks, which only need). When both or neither make it, the
      // payload doesn't imply a direction — record it as exchanged.
      const iMake = here.makes.includes(m);
      const otherMakes = otherFlows.makes.includes(m);
      if (iMake && !otherMakes) pushUnique(n.iFeed, m);
      else if (otherMakes && !iMake) pushUnique(n.feedsMe, m);
      else pushUnique(n.exchanged, m);
    }
  });

  return table.list();
}

/**
 * Card data for every process at one site. `ranges` is the site's flattened
 * snapshot index block (siteRanges(world)[siteIdx]) — the caller already holds
 * it, so the builder doesn't recompute it per process.
 */
export function buildProcessCards(
  world: WorldSpec,
  snap: Snapshot,
  siteIdx: number,
  ranges: SiteRanges,
): ProcessCardData[] {
  const site = world.sites[siteIdx];
  if (site === undefined) return [];
  // Snapshot units are flattened site-major (all units of process 0, then
  // process 1, …); keep a running base so each unit reads its own slot. The
  // previous inspector indexed per-process only, which mis-read units of the
  // second and later processes on multi-process sites.
  let unitBase = ranges.unitStart;
  return site.processes.map((proc, k) => {
    const procIdx = ranges.procStart + k;
    const pt = processType(proc.key);
    const units: ProcessCardUnit[] = proc.units.map((unit, u) => {
      const unitIdx = unitBase + u;
      // Worldgen can instantiate a preset's unit more than once; the catalog
      // join is by unit key, so every world unit with the same key shares that
      // unit type's recipes.
      const recipes = pt !== undefined ? (unitRecipeFlows(pt, unit.key) ?? []) : [];
      return {
        key: unit.key,
        name: unit.name,
        trains: unit.trains,
        trainsOnline: snap.unitTrains[unitIdx] ?? unit.trains,
        singleTrain: unit.trains === 1,
        recipes,
      };
    });
    unitBase += proc.units.length;
    const flows = pt !== undefined ? externalFlows(pt) : { needs: [], makes: [] };
    return {
      key: proc.key,
      name: proc.name,
      known: pt !== undefined,
      status: snap.procStatus[procIdx] ?? 0,
      rate: snap.procRate[procIdx] ?? 0,
      needs: flows.needs,
      makes: flows.makes,
      internals: pt !== undefined ? pt.internal.filter((m) => m !== '') : [],
      units,
    };
  });
}
