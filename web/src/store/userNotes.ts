// What the visitor did, written down for the Log. The engine's event log
// records what the simulation does; it does not say who caused it. So every
// command the client sends on the visitor's behalf — a unit failed from a
// site window, an order placed by hand, a route closed — leaves a note here,
// built from the command itself, and so does going back in time. Notes are
// ordinary log entries with a negative sequence number, which is what marks
// an entry as the visitor's own (the engine numbers its entries from zero).

import type { SimEvent } from '../engine/api';
import type { WorldSpec } from '../engine/world';
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
    case 'unit_outage':
      return {
        type: 'user_outage', site: site.index,
        text: `You took down ${cmd.trains ?? 1} train${cmd.trains === 1 ? '' : 's'} of ${String(cmd.unit ?? 'a unit')} at ${site.name}${hoursWords(cmd.duration_h)}`,
      };
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
