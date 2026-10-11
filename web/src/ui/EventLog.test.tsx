// The log's rows: clickable only where a click does something.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { LogRow } from './EventLog';

describe('LogRow', () => {
  it("is a button that opens the site for an entry that happened at one", () => {
    const html = renderToStaticMarkup(
      <LogRow event={{ seq: 4, tick: 100, type: 'unit_failed', site: 6, text: 'SC-CGC failed at Steam cracker (ethane)' }} onOpenSite={() => undefined} />,
    );
    expect(html).toMatch(/^<button/);
    expect(html).toContain('data-site="6"');
    expect(html).toContain('cursor-pointer');
    expect(html).toContain('hover:bg-panel-2');
    expect(html).toContain('SC-CGC failed at Steam cracker (ethane)');
  });

  it("is plain text, with no pointer or hover state, for an entry with no site", () => {
    for (const site of [undefined, -1, 'CRACKER_ETHANE' as unknown as number]) {
      const html = renderToStaticMarkup(
        <LogRow event={{ seq: -2, tick: 100, type: 'rewind', site, text: 'You went back to day 2, 01:00' }} onOpenSite={() => undefined} />,
      );
      expect(html).toMatch(/^<div/);
      expect(html).not.toContain('<button');
      expect(html).not.toContain('cursor-pointer');
      expect(html).not.toContain('hover:');
      expect(html).toContain('You went back to day 2, 01:00');
    }
  });

  it("opens site 0 too", () => {
    const html = renderToStaticMarkup(
      <LogRow event={{ seq: 1, tick: 4, type: 'stockout', site: 0, text: 'x' }} onOpenSite={() => undefined} />,
    );
    expect(html).toMatch(/^<button/);
    expect(html).toContain('data-site="0"');
  });
});
