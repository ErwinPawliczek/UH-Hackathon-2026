// Site inspector: header, disruption urgency, fed-by/feeds neighbour lists,
// one ProcessCard per process (recipe flows, per-unit trains, fail control),
// then tanks with level and days of cover. All live numbers slice the
// snapshot arrays via the site's flattened index ranges. The chrome restyle
// (old Tailwind classes here) lands with the parallel v3-light-chrome PR — new
// components use the v3 CSS variables.

import { SiteBadge } from './SiteIcon';
import { presetLabel } from './siteIcons';
import type { CSSProperties } from 'react';
import { siteRanges } from '../engine/world';
import { useSim, type SimState } from '../store/sim';
import type { Snapshot } from '../engine/snapshot';
import type { WorldSpec } from '../engine/world';
import { fmtDaysOfCover, fmtPct, hoursOfCover } from './format';
import { buildProcessCards, siteNeighbors, type ProcessCardUnit } from './processCardModel';
import { ProcessCard } from './ProcessCard';

const nbLabel: CSSProperties = {
  fontFamily: 'var(--f-mono)',
  fontSize: 10,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--muted)',
};

const nbValue: CSSProperties = {
  fontFamily: 'var(--f-mono)',
  fontVariantNumeric: 'tabular-nums',
  fontSize: 11,
  color: 'var(--ink)',
};

function NeighborList({ title, rows, testid }: {
  title: string;
  rows: { key: string; name: string; materials: string[] }[];
  testid: string;
}) {
  return (
    <div data-testid={testid} style={{ marginBottom: 6 }}>
      <div style={nbLabel}>{title}</div>
      {rows.length === 0 ? (
        <div style={{ ...nbValue, color: 'var(--dim)' }}>—</div>
      ) : (
        rows.map((r) => (
          <div key={r.key} style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span style={nbValue}>{r.name}</span>
            <span style={{ ...nbValue, color: 'var(--muted)' }}>{r.materials.join(' · ')}</span>
          </div>
        ))
      )}
    </div>
  );
}

/**
 * Pure presentational inspector: props in, markup out (render-testable without
 * a DOM). The store-connected SiteInspector below feeds it live state.
 */
export function SiteInspectorView({ siteIdx, world, snap, sendCommand }: {
  siteIdx: number;
  world: WorldSpec;
  snap: Snapshot;
  sendCommand: SimState['sendCommand'];
}) {
  const site = world.sites[siteIdx];
  if (site === undefined) return null;

  const ranges = siteRanges(world)[siteIdx];
  const urgency = snap.siteUrgency[siteIdx] ?? 0;
  // Site-wide rate factor for days-of-cover: mean process rate ÷ design.
  let procRateSum = 0;
  for (let k = 0; k < ranges.procCount; k++) procRateSum += snap.procRate[ranges.procStart + k] ?? 0;
  const rateFactor = ranges.procCount > 0 ? procRateSum / ranges.procCount : 0;

  const cards = buildProcessCards(world, snap, siteIdx, ranges);
  const neighbors = siteNeighbors(world, siteIdx);
  const fedBy = neighbors
    .filter((n) => n.feedsMe.length > 0)
    .map((n) => ({ key: `${n.site}-${n.name}`, name: n.name, materials: n.feedsMe }));
  const feeds = neighbors
    .filter((n) => n.iFeed.length > 0)
    .map((n) => ({ key: `${n.site}-${n.name}`, name: n.name, materials: n.iFeed }));

  const failUnit = (unit: ProcessCardUnit, trainsDown: number, durationHours: number) => {
    if (sendCommand === null) return;
    void sendCommand({ type: 'unit_outage', site: siteIdx, unit: unit.key, trains: trainsDown, duration_h: durationHours })
      .then((res) => {
        const r = res as { ok?: boolean; error?: string } | null;
        if (r !== null && typeof r === 'object' && r.ok === false) console.error('unit_outage rejected:', r.error);
      })
      .catch((err: unknown) => console.error('unit_outage failed', err));
  };

  return (
    <section className="panel pointer-events-auto max-h-[calc(100vh-9rem)] w-80 overflow-y-auto p-4 text-xs" data-testid="site-inspector">
      <header className="mb-2 flex items-center gap-2">
        <SiteBadge preset={site.preset} icon={18} down={snap.siteStatus[siteIdx] === 3} />
        <h2 className="min-w-0 flex-1 truncate font-body text-base font-semibold text-ink">{site.name}</h2>
        <span className="label shrink-0" title={site.preset}>{presetLabel(site.preset)}</span>
      </header>

      <div className="mb-4">
        <div className="mb-2 flex justify-between">
          <span className="label">Disruption urgency</span>
          <span className="data">{fmtPct(urgency)}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-sm bg-line-2">
          <div className="h-full rounded-sm bg-alarm" style={{ width: `${urgency * 100}%` }} />
        </div>
      </div>

      <NeighborList title="fed by" rows={fedBy} testid="site-fed-by" />
      <NeighborList title="feeds" rows={feeds} testid="site-feeds" />

      <h3 className="label mb-2">Processes</h3>
      <div className="mb-3 grid gap-2" data-testid="process-cards">
        {cards.map((card) => (
          <ProcessCard key={card.key} card={card} onFailUnit={failUnit} />
        ))}
      </div>

      <h3 className="label mb-2">Tanks</h3>
      <ul className="space-y-2">
        {ranges.tankIndices.map((tIdx, k) => {
          const tank = world.tanks[tIdx];
          const fill = snap.tanks[4 * tIdx] ?? 0;
          const hours = hoursOfCover(fill, tank.capacityT, tank.drawTph, rateFactor);
          return (
            <li key={`${tank.material}-${k}`} className="flex items-center gap-2">
              <span className="w-20 shrink-0 truncate text-ink">{tank.material}</span>
              <div className="h-2 flex-1 overflow-hidden rounded-sm bg-line-2">
                <div
                  className="h-full rounded-sm bg-blue-light"
                  style={{ width: `${Math.min(100, fill * 100)}%` }}
                />
              </div>
              <span className="data w-24 text-right text-muted" data-testid="tank-cover">
                {fmtPct(fill)} · {fmtDaysOfCover(hours)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Store-connected inspector: feeds live state into the pure view. */
export function SiteInspector({ siteIdx }: { siteIdx: number }) {
  const world = useSim((s) => s.world);
  const snap = useSim((s) => s.snap);
  const sendCommand = useSim((s) => s.sendCommand);
  if (world === null || snap === null) return null;
  return <SiteInspectorView siteIdx={siteIdx} world={world} snap={snap} sendCommand={sendCommand} />;
}
