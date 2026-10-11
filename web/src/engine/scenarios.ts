// Disruption scenarios for the hosted engine: each one is a real §7.2 engine
// command, sent to the live session the moment the visitor picks it. A
// scenario is offered only on a world that has what it targets — the site
// for a plant scenario; for a route closure, a route at that index of the
// expected mode — so the same list serves the hand-drawn map and the
// built-in six-site world, and a re-exported map can never close the wrong
// route silently.
//
// Command fields follow engine/src/sim/events.cpp: `site` is a site key,
// `unit` a unit key within that site, `trains` how many trains go down,
// `multiplier` a source's output factor, `duration_h` hours until repair.
// A route closure is `route_break` with `edge`, the route's index in the
// world JSON's `routes` array.

import type { RouteMode, WorldSpec } from './world';

export interface EngineScenario {
  key: string;
  /** dropdown label */
  label: string;
  /** which part of the menu it is listed under */
  group: 'plants' | 'routes';
  /** engine site key the command targets; null for a route closure */
  site: string | null;
  /** route closures: the route's index in world.routes and the mode it must have there */
  route?: { edge: number; mode: RouteMode };
  command: Record<string, unknown>;
}

const DAY_H = 24;

export const ENGINE_SCENARIOS: readonly EngineScenario[] = [
  {
    key: 'ethane_cracker_compressor',
    label: 'Ethane cracker compressor trip (5 days)',
    group: 'plants',
    site: 'CRACKER_ETHANE',
    command: { type: 'unit_outage', site: 'CRACKER_ETHANE', unit: 'SC-CGC', trains: 1, duration_h: 5 * DAY_H },
  },
  {
    key: 'refinery_crude_unit',
    label: 'Refinery crude unit down (7 days)',
    group: 'plants',
    site: 'REFINERY',
    command: { type: 'unit_outage', site: 'REFINERY', unit: 'RF-CDU', trains: 1, duration_h: 7 * DAY_H },
  },
  {
    key: 'chlor_alkali_cell_room',
    label: 'Chlor-alkali cell room trip (4 days)',
    group: 'plants',
    site: 'CHLOR_ALKALI',
    command: { type: 'unit_outage', site: 'CHLOR_ALKALI', unit: 'CA-CELL', trains: 6, duration_h: 4 * DAY_H },
  },
  {
    key: 'flex_cracker_furnaces',
    label: 'Flex cracker furnaces down (5 days)',
    group: 'plants',
    site: 'CRACKER_FLEX',
    command: { type: 'unit_outage', site: 'CRACKER_FLEX', unit: 'SC-FURN', trains: 8, duration_h: 5 * DAY_H },
  },
  {
    // the built-in six-site world's one cracker
    key: 'steam_cracker_compressor',
    label: 'Steam cracker compressor trip (5 days)',
    group: 'plants',
    site: 'STEAM_CRACKER',
    command: { type: 'unit_outage', site: 'STEAM_CRACKER', unit: 'SC-CGC', trains: 1, duration_h: 5 * DAY_H },
  },
  {
    key: 'gas_field_half_output',
    label: 'Gas field at half output (10 days)',
    group: 'plants',
    site: 'GAS_FIELD',
    command: { type: 'supply_shock', site: 'GAS_FIELD', multiplier: 0.5, duration_h: 10 * DAY_H },
  },
  // Route closures on the hand-drawn map, by route index. Each is offered
  // only where that index is a route of the stated mode.
  {
    // the salt mine's river lane: trucks take the salt, chlor-alkali dips for a day
    key: 'river_closed_salt',
    label: 'River closed to salt barges (5 days)',
    group: 'routes',
    site: null,
    route: { edge: 43, mode: 'river' },
    command: { type: 'route_break', edge: 43, duration_h: 5 * DAY_H },
  },
  {
    // the fuel depot runs dry, then recovers
    key: 'sea_lane_closed_fuel_depot',
    label: 'Sea lane to the fuel depot closed (10 days)',
    group: 'routes',
    site: null,
    route: { edge: 78, mode: 'sea' },
    command: { type: 'route_break', edge: 78, duration_h: 10 * DAY_H },
  },
  {
    // vinyls starves of chlorine, which only travels by road
    key: 'road_closed_vinyls',
    label: 'Road to vinyls closed (10 days)',
    group: 'routes',
    site: null,
    route: { edge: 29, mode: 'road' },
    command: { type: 'route_break', edge: 29, duration_h: 10 * DAY_H },
  },
];

/**
 * The scenarios this world can run: plant scenarios whose target site it
 * has, and route closures whose route index exists here with the expected
 * mode.
 */
export function scenariosFor(world: WorldSpec | null): EngineScenario[] {
  if (world === null) return [];
  const keys = new Set(world.sites.map((s) => s.key).filter((k): k is string => k !== undefined));
  return ENGINE_SCENARIOS.filter((s) => {
    if (s.route !== undefined) return world.routes[s.route.edge]?.mode === s.route.mode;
    return s.site !== null && keys.has(s.site);
  });
}

/** Ticks a scenario lasts once triggered (its command's duration; forever when it has none). */
export function scenarioTicks(scenario: EngineScenario): number {
  const h = scenario.command.duration_h;
  return typeof h === 'number' && h > 0 ? h * 4 : Infinity;
}

/**
 * The triggered scenarios still running at `tick`, in the order triggered.
 * One whose duration has passed is over: its entry can be picked again and
 * it no longer names the Scenario button.
 */
export function activeScenarios(
  scenarios: readonly EngineScenario[],
  triggered: string[],
  triggeredAt: Record<string, number>,
  tick: number,
): string[] {
  return triggered.filter((key) => {
    const s = scenarios.find((x) => x.key === key);
    return s !== undefined && tick < (triggeredAt[key] ?? 0) + scenarioTicks(s);
  });
}

/** Site index a scenario targets in this world, or undefined when absent. */
export function scenarioSite(world: WorldSpec, scenario: EngineScenario): number | undefined {
  if (scenario.site === null) return undefined; // a route closure belongs to no one site
  const i = world.sites.findIndex((s) => s.key === scenario.site);
  return i >= 0 ? i : undefined;
}
