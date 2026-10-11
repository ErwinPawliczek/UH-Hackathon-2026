// Engine scenarios: offered per world by site key, and triggered through the
// live session's command channel exactly once per run.

import { beforeEach, describe, expect, it } from 'vitest';
import { ENGINE_SCENARIOS, scenariosFor, scenarioSite } from './scenarios';
import { stubWorld, type WorldSpec } from './world';
import { useSim } from '../store/sim';

function worldWithKeys(keys: string[]): WorldSpec {
  const base = stubWorld(1);
  return {
    ...base,
    sites: keys.map((key, i) => ({ ...base.sites[i % base.sites.length], key, name: key })),
  };
}

describe('scenariosFor', () => {
  it('offers nothing on a world without site keys (the stub)', () => {
    expect(scenariosFor(stubWorld(1))).toEqual([]);
    expect(scenariosFor(null)).toEqual([]);
  });

  it('offers the scenarios whose target site the world has', () => {
    const map = worldWithKeys(['GAS_FIELD', 'REFINERY', 'CRACKER_ETHANE', 'CRACKER_FLEX', 'CHLOR_ALKALI']);
    expect(scenariosFor(map).map((s) => s.key)).toEqual([
      'ethane_cracker_compressor',
      'refinery_crude_unit',
      'chlor_alkali_cell_room',
      'flex_cracker_furnaces',
      'gas_field_half_output',
      'hurricane',
      'water_restriction',
    ]);
    const sixsite = worldWithKeys(['GAS_FIELD', 'GAS_PLANT', 'STEAM_CRACKER']);
    expect(scenariosFor(sixsite).map((s) => s.key)).toEqual(['steam_cracker_compressor', 'gas_field_half_output', 'hurricane', 'water_restriction']);
  });

  it('offers a route closure only where that route index exists with the expected mode', () => {
    const base = worldWithKeys(['REFINERY']);
    const route = (mode: 'road' | 'river' | 'sea') => ({ mode, ends: ['A', 'B'] as [string, string], sites: [null, null] as [null, null], points: [] });
    // a map whose routes 29, 43 and 78 are a road, a river lane and a sea lane, as on the default world
    const routes = Array.from({ length: 80 }, (_, i) => route(i === 43 ? 'river' : i === 78 ? 'sea' : 'road'));
    const keysOf = (w: WorldSpec) => scenariosFor(w).filter((s) => s.group === 'routes').map((s) => s.key);
    expect(keysOf({ ...base, routes })).toEqual(['river_closed_salt', 'sea_lane_closed_fuel_depot', 'road_closed_vinyls']);
    // a re-exported map where index 43 is now a road: the river closure is not offered
    const moved = routes.map((r, i) => (i === 43 ? route('road') : r));
    expect(keysOf({ ...base, routes: moved })).toEqual(['sea_lane_closed_fuel_depot', 'road_closed_vinyls']);
    // a small world with no such indices: none of them
    expect(keysOf({ ...base, routes: routes.slice(0, 6) })).toEqual([]);
    // plant scenarios are unaffected, and come first
    const all = scenariosFor({ ...base, routes });
    expect(all[0].group).toBe('plants');
    expect(all.findIndex((s) => s.group === 'routes')).toBe(all.filter((s) => s.group === 'plants').length);
  });

  it('every scenario is a complete engine command for what it targets', () => {
    for (const s of ENGINE_SCENARIOS) {
      expect(typeof s.command.duration_h).toBe('number');
      if (s.route !== undefined) {
        expect(s.command).toMatchObject({ type: 'route_break', edge: s.route.edge });
        expect(s.site).toBeNull();
        expect(s.group).toBe('routes');
        continue;
      }
      if (s.group === 'network') {
        // the whole network: no site, no route
        expect(s.site).toBeNull();
        expect(['hurricane', 'water_restriction']).toContain(s.command.type);
        continue;
      }
      expect(s.command.site).toBe(s.site);
      if (s.command.type === 'unit_outage') {
        expect(typeof s.command.unit).toBe('string');
        expect(Number.isInteger(s.command.trains)).toBe(true);
      } else {
        expect(s.command.type).toBe('supply_shock');
        expect(typeof s.command.multiplier).toBe('number');
      }
    }
  });
});

describe('triggerScenario', () => {
  const map = worldWithKeys(['GAS_FIELD', 'CRACKER_ETHANE']);
  const scenario = ENGINE_SCENARIOS.find((s) => s.key === 'ethane_cracker_compressor')!;
  let sent: Record<string, unknown>[] = [];

  beforeEach(() => {
    sent = [];
    useSim.setState({
      world: map,
      events: [],
      triggered: [],
      error: null,
      lastSeq: 7,
      sendCommand: async (cmd) => {
        sent.push(cmd);
        return { ok: true };
      },
    });
  });

  it('sends the command, marks the scenario and notes it on the timeline', async () => {
    await useSim.getState().triggerScenario(scenario);
    expect(sent).toEqual([scenario.command]);
    const s = useSim.getState();
    expect(s.triggered).toEqual([scenario.key]);
    expect(s.events).toHaveLength(1);
    expect(s.events[0]).toMatchObject({ type: 'scenario', text: scenario.label, site: scenarioSite(map, scenario) });
    expect(s.events[0].seq).toBeLessThan(0); // never collides with the engine log
    expect(s.lastSeq).toBe(7); // the engine cursor is untouched
  });

  it('runs a scenario once per session', async () => {
    await useSim.getState().triggerScenario(scenario);
    await useSim.getState().triggerScenario(scenario);
    expect(sent).toHaveLength(1);
  });

  it('surfaces a rejection and leaves the scenario available', async () => {
    useSim.setState({ sendCommand: async () => ({ ok: false, error: 'event: unresolvable site' }) });
    await useSim.getState().triggerScenario(scenario);
    const s = useSim.getState();
    expect(s.triggered).toEqual([]);
    expect(s.events).toEqual([]);
    expect(s.error).toContain('unresolvable site');
  });
});

describe('activeScenarios', () => {
  it("drops a scenario once its duration has passed, so it can be run again", async () => {
    const { ENGINE_SCENARIOS, activeScenarios, scenarioTicks } = await import('./scenarios');
    const refinery = ENGINE_SCENARIOS.find((x) => x.key === 'refinery_crude_unit')!;
    expect(scenarioTicks(refinery)).toBe(168 * 4);
    const at = { refinery_crude_unit: 100 };
    expect(activeScenarios(ENGINE_SCENARIOS, ['refinery_crude_unit'], at, 100 + 671)).toEqual(['refinery_crude_unit']);
    expect(activeScenarios(ENGINE_SCENARIOS, ['refinery_crude_unit'], at, 100 + 672)).toEqual([]);
    expect(activeScenarios(ENGINE_SCENARIOS, [], {}, 5)).toEqual([]);
  });
});
