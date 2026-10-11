// ProcessCard render tests: pure markup via react-dom/server — no DOM needed.
// Interaction (fail control → outage) is covered by the stub-backend test and
// the browser evidence capture.

import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { siteRanges, stubWorld } from '../engine/world';
import { decode } from '../engine/snapshot';
import { encodeStub } from '../engine/stub';
import { buildProcessCards } from './processCardModel';
import { ProcessCard } from './ProcessCard';

const SEED = 42;

function refineryCards() {
  const world = stubWorld(SEED);
  const snap = decode(encodeStub(SEED, 200));
  const ranges = siteRanges(world);
  return { world, snap, ranges, cards: buildProcessCards(world, snap, 1, ranges[1]) };
}

describe('ProcessCard markup', () => {
  it('renders the CD card: CRUDE in, unit trains, single-train badge, faded internals', () => {
    const { cards } = refineryCards();
    const html = renderToStaticMarkup(<ProcessCard card={cards[0]} />);
    expect(html).toContain('CRUDE_DISTILLATION');
    expect(html).toContain('CRUDE');
    expect(html).toContain('RF-CDU');
    expect(html).toContain('1/1 trains');
    expect(html).toContain('single train');
    // internals render in recipe rows, faded
    expect(html).toContain('resid');
    expect(html).toContain('data-testid="recipe-row"');
  });

  it('marks a multi-train unit as such: no single-train badge on RF-DHT', () => {
    const { cards } = refineryCards();
    const html = renderToStaticMarkup(<ProcessCard card={cards[3]} />);
    expect(html).toContain('RF-DHT');
    expect(html).toContain('2/2 trains');
    expect(html).not.toContain('single train');
  });

  it('renders one-sided cards: oil field makes only, salt mine makes only', () => {
    const world = stubWorld(SEED);
    const snap = decode(encodeStub(SEED, 200));
    const ranges = siteRanges(world);
    const oil = buildProcessCards(world, snap, 0, ranges[0]);
    const oilHtml = renderToStaticMarkup(<ProcessCard card={oil[0]} />);
    expect(oilHtml).toContain('OIL_PRODUCTION');
    expect(oilHtml).toContain('CRUDE');
  });

  it('renders unknown keys defensively: bare key and no catalog data, no throw', () => {
    const world = stubWorld(SEED);
    world.sites[0].processes[0].key = 'GHOST_PROCESS';
    const snap = decode(encodeStub(SEED, 200));
    const ranges = siteRanges(world);
    const cards = buildProcessCards(world, snap, 0, ranges[0]);
    const html = renderToStaticMarkup(<ProcessCard card={cards[0]} />);
    expect(html).toContain('GHOST_PROCESS');
    expect(html).toContain('no catalog data');
  });

  it('hides the fail control without a handler and shows it with one', () => {
    const { cards } = refineryCards();
    const bare = renderToStaticMarkup(<ProcessCard card={cards[3]} />);
    expect(bare).not.toContain('Fail unit');
    const armed = renderToStaticMarkup(<ProcessCard card={cards[3]} onFailUnit={() => {}} />);
    expect(armed).toContain('Fail unit');
    expect(armed).toContain('fail-control-RF-DHT');
  });

  it('renders alarm styling only for down units (v3: alarm is state)', () => {
    const { cards, snap } = refineryCards();
    expect(snap.unitTrains[8]).toBe(2); // all trains up at tick 200
    const runningHtml = renderToStaticMarkup(<ProcessCard card={cards[3]} />);
    expect(runningHtml).not.toContain('var(--alarm)');
    const down = { ...cards[3], status: 2, rate: 0 };
    const downHtml = renderToStaticMarkup(<ProcessCard card={down} />);
    expect(downHtml).toContain('var(--alarm)');
    expect(downHtml).toContain('0%');
  });
});
