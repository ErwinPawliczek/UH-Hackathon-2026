// The Disruption impact tab, rendered from a forecast.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import type { ForecastReply } from '../engine/api';
import { EconomyWindow, ImpactView } from './EconomyWindow';

const totals = { demand_t: 573279.8, unmet_t: 0, unmet_usd: 0, freight_usd: 3.4e6, energy_usd: 1.19e7, inventory_usd: 1.45e8, inventory_change_usd: 0, service: 1, shutdown_h: 0 };
const customer = { site: 'GAS_GRID', site_index: 14, name: 'Gas grid', process: 'GAS_GRID_METHANE', process_name: 'Gas grid city demand', material: 'METHANE', demand_t: 10000, served_t: 9200, service: 0.92, dry_at_start: false, first_dry_tick: 2000 };
const broken: ForecastReply = {
  tick: 1440, to_tick: 4320, days: 30, disruptions: 1,
  with: { from_tick: 1440, to_tick: 4320, totals: { ...totals, unmet_t: 172.9, unmet_usd: 207516, service: 0.9997, shutdown_h: 479.25 }, customers: [customer], plants: [] },
  without: { from_tick: 1440, to_tick: 4320, totals, customers: [{ ...customer, served_t: 10000, service: 1 }], plants: [] },
  delta: { cost_usd: 5838892.78, unmet_usd: 207516.12, freight_usd: -34340.56, energy_usd: -875294.75, inventory_usd: -6541011.97, unmet_t: 172.93, service: -0.0003, shutdown_h: 479.25 },
  countdown: [
    { site: 'CRACKER_ETHANE', site_index: 6, name: 'Steam cracker (ethane)', kind: 'shuts_down', what: 'Olefins (ethane)', tick: 1441, hours_from_now: 0.25, already: true },
    { site: 'POLYETHYLENE', site_index: 9, name: 'Polyethylene', kind: 'shuts_down', what: 'Polyethylene polymerisation', tick: 2088, hours_from_now: 162, already: false },
  ],
};
const text = (html: string) => html.replace(/<[^>]+>/g, ' ').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');

describe('ImpactView', () => {
  it('leads with what the disruption will cost and itemises it in plain words', () => {
    const out = text(renderToStaticMarkup(<ImpactView f={broken} presetOf={() => 'POLYETHYLENE'} />));
    expect(out).toContain('1 disruption active');
    expect(out).toMatch(/This will cost\s+\$5\.8 M\s+over the next 30 days/);
    expect(out).toContain('Lost sales');
    expect(out).toContain('customers go without 173 t they ordered');
    expect(out).toContain('Stock run down');
    expect(out).toContain('+$6.5 M');
    expect(out).toContain('Energy not used');
    expect(out).toContain('-$875 K');
  });

  it('lists what stops next, and the customers that go short', () => {
    const html = renderToStaticMarkup(<ImpactView f={broken} presetOf={() => 'POLYETHYLENE'} />);
    const out = text(html);
    expect(out).toContain('Steam cracker (ethane) is already shut down');
    expect(out).toContain('Polyethylene shuts down in 6 days 18 hours');
    expect(html.match(/data-testid="economy-impact-countdown-row"/g)).toHaveLength(2);
    expect(out).toContain('Customers served');
    expect(out).toContain('99.9%');
    expect(out).toContain('100% with nothing broken');
    expect(out).toMatch(/Gas grid .* gets 92% · short 800 t/);
  });

  it('says so plainly when nothing is broken', () => {
    const quiet: ForecastReply = { ...broken, disruptions: 0, countdown: [], with: broken.without, delta: { cost_usd: 0, unmet_usd: 0, freight_usd: 0, energy_usd: 0, inventory_usd: 0, unmet_t: 0, service: 0, shutdown_h: 0 } };
    const out = text(renderToStaticMarkup(<ImpactView f={quiet} presetOf={() => ''} />));
    expect(out).toContain('Nothing is broken.');
    expect(out).not.toContain('This will cost');
    expect(out).not.toContain('with nothing broken');
  });
});

describe('EconomyWindow', () => {
  it('renders nothing while it is closed', () => {
    expect(renderToStaticMarkup(<EconomyWindow />)).toBe('');
  });
});
