// What the visitor did, written down for the Log. The engine's event log
// records what the simulation does; it does not say who caused it. So every
// command the client sends on the visitor's behalf — a unit failed from a
// site window, an order placed by hand, a route closed — leaves a note here,
// built from the command itself, and so does going back in time. Notes are
// ordinary log entries with a negative sequence number, which is what marks
// an entry as the visitor's own (the engine numbers its entries from zero).

import type { SimEvent } from '../engine/api';
import type { ProcessSpec, UnitSpec, WorldSpec } from '../engine/world';
import { VEHICLE_CLASSES, type VehicleClassKey } from '../engine/world';
import { materialName } from '../ui/materials';

/** Entry types the client writes: a triggered scenario, a disruption, a hand-placed order, a rewind. */
export type UserNoteType = 'scenario' | 'user_outage' | 'user_order' | 'user_action' | 'rewind';

let nextSeq = -1;

/** A fresh sequence number for a client-written entry: negative and never reused. */
export function userSeq(): number {
  return nextSeq--;
}

/** True for an entry the client wrote on the visitor's behalf, false for one from the engine's log. */
export function isUserEvent(e: Pick<SimEvent, 'seq'>): boolean {
  return e.seq < 0;
}

const TICKS_PER_DAY = 96;

/** "Day 3, 00:00" for a tick. */
export function momentWords(tick: number): string {
  const day = Math.floor(tick / TICKS_PER_DAY) + 1;
  const minutes = (tick % TICKS_PER_DAY) * 15;
  return `Day ${day}, ${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function siteOf(world: WorldSpec | null, ref: unknown): { index: number | undefined; name: string } {
  if (world !== null) {
    const index = typeof ref === 'number' ? ref : world.sites.findIndex((s) => s.key === ref);
    const site = world.sites[index];
    if (site !== undefined) return { index, name: site.name };
  }
  return { index: undefined, name: typeof ref === 'string' ? ref : 'a site' };
}

/**
 * The unit a unit_outage is aimed at, with its process and site: by the
 * unit's global index when the command carries one (`unit_index`, which is
 * what the engine goes by too), else by key — but only where the site has
 * one unit of that key. A fuel depot has four "FD-OUT", one per fuel, so a
 * key alone does not say which one.
 */
function unitOf(
  world: WorldSpec | null,
  siteIndex: number | undefined,
  cmd: Record<string, unknown>,
): { unit: UnitSpec; process: ProcessSpec; site: number } | null {
  if (world === null) return null;
  const all = world.sites.flatMap((s, site) =>
    (s.processes ?? []).flatMap((process) => process.units.map((unit) => ({ unit, process, site }))));
  if (typeof cmd.unit_index === 'number') return all.find((x) => x.unit.index === cmd.unit_index) ?? null;
  const byKey = all.filter((x) => x.site === siteIndex && x.unit.key === cmd.unit);
  return byKey.length === 1 ? byKey[0] : null;
}

/**
 * What an outage took down, in words: the process when the outage stops the
 * only unit it has ("City jet fuel demand"), else the unit with its process
 * ("RF-CDU (Crude distillation)"), with the train count when only some of
 * its trains go ("3 of 6 trains of CA-CELL (Chlor-alkali electrolysis)").
 */
function outageWords(found: { unit: UnitSpec; process: ProcessSpec } | null, cmd: Record<string, unknown>): string {
  const n = typeof cmd.trains === 'number' ? cmd.trains : 1;
  if (found === null) return `${n} train${n === 1 ? '' : 's'} of ${String(cmd.unit ?? 'a unit')}`;
  const { unit, process } = found;
  const whole = n >= unit.trains;
  if (whole && process.units.length === 1) return process.name;
  return `${whole ? '' : `${n} of ${unit.trains} trains of `}${unit.key} (${process.name})`;
}

const hoursWords = (h: unknown) => {
  if (typeof h !== 'number' || !(h > 0)) return '';
  return h % 24 === 0 ? ` for ${h / 24} day${h === 24 ? '' : 's'}` : ` for ${h} h`;
};

/**
 * The note a command leaves in the log, from the command's own fields. Null
 * for a command that changes nothing a visitor would call an action.
 */
export function describeCommand(
  world: WorldSpec | null,
  cmd: Record<string, unknown>,
): { type: UserNoteType; text: string; site?: number } | null {
  const site = siteOf(world, cmd.site);
  switch (cmd.type) {
    case 'unit_outage': {
      const found = unitOf(world, site.index, cmd);
      // the unit's own site, when the command names the unit by index: that is the one the engine acts on
      const at = found === null ? site : siteOf(world, found.site);
      return {
        type: 'user_outage', site: at.index,
        text: `You took down ${outageWords(found, cmd)} at ${at.name}${hoursWords(cmd.duration_h)}`,
      };
    }
    case 'site_shutdown':
      return { type: 'user_outage', site: site.index, text: `You shut down ${site.name}${hoursWords(cmd.duration_h)}` };
    case 'supply_shock':
    case 'demand_shock': {
      const pct = typeof cmd.multiplier === 'number' ? `${Math.round(cmd.multiplier * 100)}%` : 'a new level';
      const what = cmd.type === 'supply_shock' ? 'output' : 'demand';
      return { type: 'user_outage', site: site.index, text: `You set ${site.name}'s ${what} to ${pct}${hoursWords(cmd.duration_h)}` };
    }
    case 'route_break': {
      const route = world !== null && typeof cmd.edge === 'number' ? world.routes[cmd.edge] : undefined;
      const where = route === undefined ? 'a route' : `the ${route.mode === 'road' ? 'road' : route.mode === 'river' ? 'river lane' : 'sea lane'} ${route.ends[0] === route.ends[1] ? route.ends[0] : `between ${route.ends[0]} and ${route.ends[1]}`}`;
      return { type: 'user_outage', text: `You closed ${where}${hoursWords(cmd.duration_h)}` };
    }
    case 'place_order': {
      const seller = siteOf(world, cmd.seller ?? cmd.from);
      const cls = VEHICLE_CLASSES[cmd.cls as VehicleClassKey]?.label.toLowerCase();
      const t = typeof cmd.tonnes === 'number' ? `${Math.round(cmd.tonnes * 10) / 10} t of ` : '';
      return {
        type: 'user_order', site: site.index,
        text: `You ordered ${t}${materialName(String(cmd.material ?? 'material'))} from ${seller.name} for ${site.name}${cls === undefined ? '' : `, by ${cls}`}`,
      };
    }
    default:
      return null;
  }
}
