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
    ]);
    const sixsite = worldWithKeys(['GAS_FIELD', 'GAS_PLANT', 'STEAM_CRACKER']);
    expect(scenariosFor(sixsite).map((s) => s.key)).toEqual(['steam_cracker_compressor', 'gas_field_half_output']);
  });

  it('every scenario is a complete engine command for its own site', () => {
    for (const s of ENGINE_SCENARIOS) {
      expect(s.command.site).toBe(s.site);
      expect(typeof s.command.duration_h).toBe('number');
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
