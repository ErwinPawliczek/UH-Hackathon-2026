// EngineErrorOverlay markup: hairline v3 panel, alert role, retry action.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { EngineErrorOverlay } from './EngineErrorOverlay';

function markup(message: string): string {
  return renderToStaticMarkup(<EngineErrorOverlay message={message} onRetry={() => {}} />);
}

describe('EngineErrorOverlay markup', () => {
  it('renders the unreachable-engine state with a retry action', () => {
    const html = markup('Cannot reach the hosted engine (Failed to fetch)');
    expect(html).toContain('data-testid="fatal-error"');
    expect(html).toContain('role="alert"');
    expect(html).toContain('Engine unavailable');
    expect(html).toContain('Cannot reach the hosted engine (Failed to fetch)');
    expect(html).toContain('data-testid="retry-engine"');
    expect(html).toContain('Try again');
    expect(html).not.toMatch(/stub|fallback/);
  });

  it('stays flat in the v3 style: hairline cut-corner panel, no shadows or gradients', () => {
    const html = markup('down');
    expect(html).toContain('class="chamfer'); // .chamfer = hairline outline + panel fill, corners cut at 45 degrees
    expect(html).not.toContain('shadow');
    expect(html).not.toContain('gradient');
  });
});
