// Disruption scenarios for the hosted engine: each one is a real §7.2 engine
// command, sent to the live session the moment the visitor picks it. A
// scenario is offered only on a world that has the site it targets, so the
// same list serves the hand-drawn map and the built-in six-site world.
//
// Command fields follow engine/src/sim/events.cpp: `site` is a site key,
// `unit` a unit key within that site, `trains` how many trains go down,
// `multiplier` a source's output factor, `duration_h` hours until repair.

import type { WorldSpec } from './world';

export interface EngineScenario {
  key: string;
  /** dropdown label */
  label: string;
  /** engine site key the command targets */
  site: string;
  command: Record<string, unknown>;
}

const DAY_H = 24;

export const ENGINE_SCENARIOS: readonly EngineScenario[] = [
  {
    key: 'ethane_cracker_compressor',
    label: 'Ethane cracker compressor trip (5 days)',
    site: 'CRACKER_ETHANE',
    command: { type: 'unit_outage', site: 'CRACKER_ETHANE', unit: 'SC-CGC', trains: 1, duration_h: 5 * DAY_H },
  },
  {
    key: 'refinery_crude_unit',
    label: 'Refinery crude unit down (7 days)',
    site: 'REFINERY',
    command: { type: 'unit_outage', site: 'REFINERY', unit: 'RF-CDU', trains: 1, duration_h: 7 * DAY_H },
  },
  {
    key: 'chlor_alkali_cell_room',
    label: 'Chlor-alkali cell room trip (4 days)',
    site: 'CHLOR_ALKALI',
    command: { type: 'unit_outage', site: 'CHLOR_ALKALI', unit: 'CA-CELL', trains: 6, duration_h: 4 * DAY_H },
  },
  {
    key: 'flex_cracker_furnaces',
    label: 'Flex cracker furnaces down (5 days)',
    site: 'CRACKER_FLEX',
    command: { type: 'unit_outage', site: 'CRACKER_FLEX', unit: 'SC-FURN', trains: 8, duration_h: 5 * DAY_H },
  },
  {
    // the built-in six-site world's one cracker
    key: 'steam_cracker_compressor',
    label: 'Steam cracker compressor trip (5 days)',
    site: 'STEAM_CRACKER',
    command: { type: 'unit_outage', site: 'STEAM_CRACKER', unit: 'SC-CGC', trains: 1, duration_h: 5 * DAY_H },
  },
  {
    key: 'gas_field_half_output',
    label: 'Gas field at half output (10 days)',
    site: 'GAS_FIELD',
    command: { type: 'supply_shock', site: 'GAS_FIELD', multiplier: 0.5, duration_h: 10 * DAY_H },
  },
];

/** The scenarios this world can run: those whose target site it has. */
export function scenariosFor(world: WorldSpec | null): EngineScenario[] {
  if (world === null) return [];
  const keys = new Set(world.sites.map((s) => s.key).filter((k): k is string => k !== undefined));
  return ENGINE_SCENARIOS.filter((s) => keys.has(s.site));
}

/** Site index a scenario targets in this world, or undefined when absent. */
export function scenarioSite(world: WorldSpec, scenario: EngineScenario): number | undefined {
  const i = world.sites.findIndex((s) => s.key === scenario.site);
  return i >= 0 ? i : undefined;
}
