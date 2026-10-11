// Catalog join tests: aggregation excludes internal intermediates and LOSS,
// one-sided source/sink recipes resolve, unknown keys return undefined.

import { describe, expect, it } from 'vitest';
import { externalFlows, isInternalFlow, LOSS_KEY, processType, unitRecipeFlows } from './processes';

describe('processType', () => {
  it('joins every plant preset, source and sink by key', () => {
    // 8 plant presets + 3 sources + 14 sinks = 25 catalog process types
    const keys = [
      'CRUDE_DISTILLATION', 'DIESEL_HDT', 'OLEFINS_FLEX', 'OLEFINS_GAS',
      'OIL_PRODUCTION', 'GAS_PRODUCTION', 'SALT_MINING',
      'FUEL_DEPOT_GASOLINE', 'FUEL_DEPOT_DIESEL', 'PORT_BUNKER_FUEL_OIL',
    ];
    for (const k of keys) expect(processType(k), k).toBeDefined();
  });

  it('returns undefined for unknown keys instead of throwing', () => {
    expect(processType('NOT_A_PROCESS')).toBeUndefined();
    expect(processType('')).toBeUndefined();
  });
});

describe('externalFlows — CRUDE_DISTILLATION', () => {
  const cd = processType('CRUDE_DISTILLATION');
  it('needs CRUDE only', () => {
    expect(cd).toBeDefined();
    expect(externalFlows(cd!).needs).toEqual(['CRUDE']);
  });
  it('makes the traded cuts with resid excluded as internal', () => {
    const { makes } = externalFlows(cd!);
    expect(makes).toContain('LPG');
    expect(makes).toContain('NAPHTHA');
    expect(makes).toContain('JET');
    expect(makes).toContain('GASOIL');
    expect(makes).not.toContain('resid');
    expect(makes).not.toContain(LOSS_KEY);
  });
  it('fades resid in the unit recipe rows', () => {
    const rows = unitRecipeFlows(cd!, 'RF-CDU');
    expect(rows).toHaveLength(1);
    const outs = rows![0].out;
    const resid = outs.find((m) => m.key === 'resid');
    expect(resid).toBeDefined();
    expect(resid!.faded).toBe(true);
    const lpg = outs.find((m) => m.key === 'LPG');
    expect(lpg!.faded).toBe(false);
    expect(lpg!.share).toBeCloseTo(0.02, 5);
  });
});

describe('externalFlows — reforming chain internals fade', () => {
  const ref = processType('REFORMING');
  it('excludes treated and reformate from external flows', () => {
    const flows = externalFlows(ref!);
    expect(flows.needs).toEqual(['HEAVY_NAPHTHA']);
    expect(flows.makes).toContain('GASOLINE');
    expect(flows.makes).toContain('SOLVENT');
    expect(flows.makes).toContain('BENZENE');
    expect(flows.makes).not.toContain('treated');
    expect(flows.makes).not.toContain('reformate');
  });
  it('marks LOSS faded in the NHT recipe row', () => {
    const rows = unitRecipeFlows(ref!, 'RF-NHT');
    const loss = rows![0].out.find((m) => m.key === LOSS_KEY);
    expect(loss!.faded).toBe(true);
  });
});

describe('one-sided presets', () => {
  it('a salt mine makes SALT only and needs nothing', () => {
    const salt = processType('SALT_MINING');
    expect(externalFlows(salt!)).toEqual({ needs: [], makes: ['SALT'] });
  });
  it('a gasoline fuel depot needs only and makes nothing', () => {
    const depot = processType('FUEL_DEPOT_GASOLINE');
    expect(externalFlows(depot!)).toEqual({ needs: ['GASOLINE'], makes: [] });
  });
  it('renders one-sided recipe rows without throwing', () => {
    const salt = unitRecipeFlows(processType('SALT_MINING')!, 'SALT-MINE');
    expect(salt![0].in).toEqual([]);
    expect(salt![0].out.map((m) => m.key)).toEqual(['SALT']);
  });
});

describe('isInternalFlow', () => {
  it('fades LOSS and named internals only', () => {
    expect(isInternalFlow(['resid'], 'resid')).toBe(true);
    expect(isInternalFlow(['resid'], LOSS_KEY)).toBe(true);
    expect(isInternalFlow(['resid'], 'CRUDE')).toBe(false);
  });
});
