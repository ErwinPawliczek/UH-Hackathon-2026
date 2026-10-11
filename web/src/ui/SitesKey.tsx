// The Sites key: a floating window listing every kind of plant on the map —
// its icon, its name and how many there are. Clicking a row selects a site of
// that kind (and the next one on the next click), which rings it on the map
// and opens its panel.

import { useRef } from 'react';
import type { WorldSpec } from '../engine/world';
import { useSim } from '../store/sim';
import { DraggableWindow } from './DraggableWindow';
import { SiteBadge } from './SiteIcon';
import { SITE_LIMITED } from './eventKinds';
import { SITE_ICON_ORDER, iconKey, presetLabel } from './siteIcons';

export const SITES_WINDOW_ID = 'sites';
/** Where the key first appears: under the top bar, right of centre. */
export const SITES_WINDOW_AT = { x: 320, y: 72 };

export interface SiteKind {
  /** canonical preset key the icon is filed under */
  preset: string;
  label: string;
  /** indices into world.sites, in world order */
  sites: number[];
}

/**
 * The kinds of site this world has, in key order (upstream to downstream;
 * kinds the icon set does not know go last, by name).
 */
export function siteKinds(world: WorldSpec | null): SiteKind[] {
  if (world === null) return [];
  const byKind = new Map<string, number[]>();
  world.sites.forEach((site, i) => {
    const key = iconKey(site.preset);
    byKind.set(key, [...(byKind.get(key) ?? []), i]);
  });
  const rank = (key: string) => {
    const at = SITE_ICON_ORDER.indexOf(key);
    return at >= 0 ? at : SITE_ICON_ORDER.length;
  };
  return [...byKind.entries()]
    .map(([preset, sites]) => ({ preset, label: presetLabel(preset), sites }))
    .sort((a, b) => rank(a.preset) - rank(b.preset) || a.label.localeCompare(b.label));
}

export function SitesKey() {
  const world = useSim((s) => s.world);
  const selected = useSim((s) => s.selected);
  const siteStatus = useSim((s) => s.snap?.siteStatus);
  const select = useSim((s) => s.select);
  const cursor = useRef(new Map<string, number>());

  const kinds = siteKinds(world);
  const selectedSite = selected !== null && selected.kind === 'site' ? selected.index : -1;

  const pick = (kind: SiteKind) => {
    // start at the first site; a second click on the same row moves to the next
    const at = kind.sites.includes(selectedSite) ? ((cursor.current.get(kind.preset) ?? 0) + 1) % kind.sites.length : 0;
    cursor.current.set(kind.preset, at);
    select({ kind: 'site', index: kind.sites[at] });
  };

  return (
    <DraggableWindow id={SITES_WINDOW_ID} title="Sites" width={280} maxHeight="70vh">
      <ul className="p-1" data-testid="sites-key">
        {kinds.map((kind) => {
          const down = kind.sites.some((i) => siteStatus?.[i] === 3);
          const limited = !down && kind.sites.some((i) => siteStatus?.[i] === SITE_LIMITED);
          const here = kind.sites.includes(selectedSite);
          return (
            <li key={kind.preset}>
              <button
                className={`flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-1 text-left text-xs hover:bg-panel-2 ${here ? 'bg-blue-soft' : ''}`}
                onClick={() => pick(kind)}
                title={world === null ? undefined : kind.sites.map((i) => world.sites[i].name).join(', ')}
                data-testid={`sites-key-${kind.preset}`}
              >
                <SiteBadge preset={kind.preset} down={down} limited={limited} />
                <span className="min-w-0 flex-1 truncate text-ink">{kind.label}</span>
                {limited && <span className="text-[11px] text-blue">limited</span>}
                {kind.sites.length > 1 && <span className="data text-muted">×{kind.sites.length}</span>}
              </button>
            </li>
          );
        })}
        {kinds.length === 0 && <li className="px-2 py-2 text-xs text-muted">No sites yet.</li>}
      </ul>
    </DraggableWindow>
  );
}
