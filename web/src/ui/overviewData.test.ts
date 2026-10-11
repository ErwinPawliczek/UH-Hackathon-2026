import { describe, expect, it } from 'vitest';
import { fmtShare, plantsRunning, pricePressure, serviceNow } from './overviewData';
import { useEconomyView } from './economyView';

describe('overview', () => {
  it('reads customers served from the latest full day', () => {
    const r = { buckets: 3, bucketH: 24, tick: 250, totals: { service: [1, 0.93, 0.5] } } as never;
    expect(serviceNow(r)).toEqual({ now: 0.93, series: [1, 0.93] }); // day 3 is still running
    expect(serviceNow({ buckets: 0, bucketH: 24, tick: 0, totals: { service: [] } } as never)).toBeNull();
    expect(fmtShare(1)).toBe('100%');
    expect(fmtShare(0.9997)).toBe('99.9%');
    expect(fmtShare(0.934)).toBe('93%');
  });
  it('names the three chemicals furthest above base and the one furthest below', () => {
    const row = (key: string, paidPct: number | null) => ({ key, label: key, paidPct } as never);
    const p = pricePressure([row('A', 5), row('B', 42), row('C', -3), row('D', 12), row('E', 20), row('F', -11), row('G', null), row('H', 0.2)]);
    expect(p.above.map((r) => r.key)).toEqual(['B', 'E', 'D']);
    expect(p.below?.key).toBe('F');
    expect(pricePressure([row('A', 3)]).below).toBeNull();
  });
  it('counts the plants running normally and names the rest, shut down first', () => {
    const plants = [
      { site_index: 5, name: 'Refinery', process: 'CDU', process_name: 'Crude distillation', index: 0 },
      { site_index: 5, name: 'Refinery', process: 'FCC', process_name: 'Fluid catalytic cracking', index: 1 },
      { site_index: 9, name: 'Polyethylene', process: 'PE', process_name: 'Polyethylene polymerisation', index: 2 },
      { site_index: 4, name: 'Gas plant', process: 'NGL', process_name: 'NGL recovery', index: 3 },
    ];
    const p = plantsRunning({ plants } as never, { procStatus: new Uint8Array([2, 0, 1, 3]) });
    expect([p.running, p.total]).toEqual([1, 4]);
    expect(p.others.map((o) => `${o.name} ${o.words}`)).toEqual(['Refinery: Crude distillation shut down', 'Gas plant restarting', 'Polyethylene held at minimum']);
  });
  it('opens on the Overview; a tab closes any detail page', () => {
    expect(useEconomyView.getState()).toMatchObject({ tab: 'overview', detail: null });
    useEconomyView.getState().showDetail('plants');
    expect(useEconomyView.getState()).toMatchObject({ tab: 'overview', detail: 'plants' });
    useEconomyView.getState().setTab('prices');
    expect(useEconomyView.getState()).toMatchObject({ tab: 'prices', detail: null });
    useEconomyView.getState().setTab('overview');
  });
});
