// SiteInspector render test: renders the pure SiteInspectorView with the stub
// world and a real encoded snapshot. (Store-connected rendering isn't testable
// via react-dom/server — zustand v5's server snapshot is getInitialState — so
// the view is props-driven and the wrapper stays thin.) Click-interaction
// evidence is captured in the browser; the command path is covered by
// stubBackend.test.ts.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { stubWorld } from '../engine/world';
import { decode } from '../engine/snapshot';
import { encodeStub } from '../engine/stub';
import { SiteInspectorView } from './SiteInspector';

const SEED = 42;

function viewProps() {
  const world = stubWorld(SEED);
  const snap = decode(encodeStub(SEED, 200));
  return { world, snap };
}

describe('SiteInspector markup', () => {
  it('renders process cards with recipe data for the refinery', () => {
    const { world, snap } = viewProps();
    const html = renderToStaticMarkup(<SiteInspectorView siteIdx={1} world={world} snap={snap} sendCommand={null} />);
    expect(html).toContain('data-testid="site-inspector"');
    expect(html).toContain('data-testid="process-cards"');
    expect(html).toContain('CRUDE_DISTILLATION');
    expect(html).toContain('CRUDE');
    expect(html).toContain('RF-CDU');
    expect(html).toContain('single train');
    // per-process fail controls are armed inside the inspector
    expect(html).toContain('Fail unit');
    // tanks keep level and days of cover
    expect(html).toContain('data-testid="tank-cover"');
  });

  it('lists real neighbours in fed-by / feeds for the refinery', () => {
    const { world, snap } = viewProps();
    const html = renderToStaticMarkup(<SiteInspectorView siteIdx={1} world={world} snap={snap} sendCommand={null} />);
    expect(html).toContain('data-testid="site-fed-by"');
    expect(html).toContain('data-testid="site-feeds"');
    // the oil field really is a named neighbour of the refinery in the stub world
    const oilField = world.sites[0].name;
    expect(html).toContain(oilField);
  });

  it('renders source sites with an empty fed-by row', () => {
    const { world, snap } = viewProps();
    const html = renderToStaticMarkup(<SiteInspectorView siteIdx={0} world={world} snap={snap} sendCommand={null} />);
    expect(html).toContain('OIL_PRODUCTION');
    // oil field: makes only — fed-by shows the em-dash placeholder
    expect(html).toMatch(/site-fed-by[\s\S]*?—/);
  });

  it('never throws for unknown process keys', () => {
    const { world, snap } = viewProps();
    world.sites[1].processes[0].key = 'GHOST_PROCESS';
    const html = renderToStaticMarkup(<SiteInspectorView siteIdx={1} world={world} snap={snap} sendCommand={null} />);
    expect(html).toContain('GHOST_PROCESS');
    expect(html).toContain('no catalog data');
  });
});
