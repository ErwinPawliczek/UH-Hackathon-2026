// TopBar markup: engine chrome is gone entirely — no backend selector, no URL
// field — while the rest of the visitor chrome stays put.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { CHAIN_DEPTH, CHAIN_PERIOD, TopBar, scenarioButtonLabel } from './TopBar';

describe('scenarioButtonLabel', () => {
  const scenarios = [
    { key: 'a', label: 'Cracker trip (5 days)', group: 'plants' as const, site: 'X', command: {} },
    { key: 'b', label: 'Refinery down (7 days)', group: 'plants' as const, site: 'Y', command: {} },
  ];
  it('is the control\'s own name until something is triggered', () => {
    expect(scenarioButtonLabel(scenarios, [])).toBe('Scenario');
  });
  it('shows the latest triggered scenario, and how many more are running', () => {
    expect(scenarioButtonLabel(scenarios, ['a'])).toBe('Cracker trip (5 days)');
    expect(scenarioButtonLabel(scenarios, ['a', 'b'])).toBe('Refinery down (7 days) +1');
  });
});

describe('TopBar markup', () => {
  const html = renderToStaticMarkup(<TopBar />);

  it('has no engine controls and no replacement UI', () => {
    expect(html).not.toContain('data-testid="backend-select"');
    expect(html).not.toContain('data-testid="base-url-input"');
    expect(html).not.toContain('>Engine<');
    expect(html).not.toContain('>URL<');
    expect(html).not.toContain('In-page stub');
    expect(html).not.toContain('Hosted');
  });

  it('keeps the rest of the chrome intact', () => {
    expect(html).toContain('data-testid="wordmark"');
    expect(html).toContain('data-testid="clock"');
    expect(html).toContain('data-testid="play-pause"');
    expect(html).toContain('data-testid="speed-control"');
    expect(html).not.toContain('data-testid="seed-input"'); // the seed has no UI
    expect(html).not.toContain('>Seed<');
    expect(html).toContain('data-testid="scenario-select"');
  });

  it('stacks above the floating windows, so its menus open over them', () => {
    const z = Number(/data-testid="top-bar"/.test(html) ? (/z-\[(\d+)\]/.exec(html)?.[1] ?? 0) : 0);
    expect(z).toBeGreaterThan(20 + 30); // windows start at 20 and take one step each
  });

  it('has one speed control with an editable number and no preset speed buttons', () => {
    expect(html).toContain('data-testid="speed-control"');
    expect(html).toMatch(/Speed:<\/span><input[^>]*id="speed-input"[^>]*name="speed"/);
    expect(html).toMatch(/id="speed-input"[^>]*value="1"/);
    expect(html).not.toMatch(/>(0\.5|1|4|16|64)×</);
  });

  it('draws its bottom edge as a 120 degree zigzag, with no straight border', () => {
    expect(html).toContain('data-testid="chain-edge"');
    expect(html).not.toContain('border-b');
    // 30 degree edges: depth = period / (2 * sqrt 3), so every bend is 120 degrees
    const bend = 180 - 2 * (Math.atan2(CHAIN_DEPTH, CHAIN_PERIOD / 2) * 180) / Math.PI;
    expect(bend).toBeCloseTo(120, 6);
    expect(CHAIN_DEPTH).toBeGreaterThan(5);
    expect(CHAIN_DEPTH).toBeLessThan(6);
  });

  it('names the scenario control on the control itself, with no separate label or native select', () => {
    expect(html).toMatch(/data-testid="scenario-select"[^>]*>.*?Scenario/s);
    expect(html).not.toContain('<select');
    expect(html).not.toMatch(/<span class="label">Scenario<\/span>/);
  });
});
