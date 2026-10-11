// TopBar markup: engine chrome is gone entirely — no backend selector, no URL
// field — while the rest of the visitor chrome stays put.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TopBar } from './TopBar';

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
});
