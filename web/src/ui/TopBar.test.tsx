// TopBar markup: engine chrome is gone entirely — no backend selector, no URL
// field — while the rest of the visitor chrome stays put.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TopBar, scenarioButtonLabel } from './TopBar';

describe('scenarioButtonLabel', () => {
  const scenarios = [
    { key: 'a', label: 'Cracker trip (5 days)', site: 'X', command: {} },
    { key: 'b', label: 'Refinery down (7 days)', site: 'Y', command: {} },
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
    expect(html).toContain('Simulation speed');
    expect(html).toContain('data-testid="seed-input"');
    expect(html).toContain('data-testid="scenario-select"');
  });

  it('names the scenario control on the control itself, with no separate label or native select', () => {
    expect(html).toMatch(/data-testid="scenario-select"[^>]*>.*?Scenario/s);
    expect(html).not.toContain('<select');
    expect(html).not.toMatch(/<span class="label">Scenario<\/span>/);
  });
});
