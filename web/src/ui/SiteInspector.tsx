// Site inspector: process block list with per-unit train status and tanks
// with level + days of cover. All live numbers slice the snapshot arrays via
// the site's flattened index ranges.

import { siteRanges } from '../engine/world';
import { useSim } from '../store/sim';
import { PROC_STATUS_LABELS } from '../scene/palette';
import { fmtDaysOfCover, fmtPct, hoursOfCover } from './format';

const STATUS_DOT: Record<number, string> = {
  0: 'bg-blue',
  1: 'bg-blue-light',
  2: 'bg-blue',
  3: 'bg-alarm',
  4: 'bg-white ring-2 ring-alarm',
};

export function SiteInspector({ siteIdx }: { siteIdx: number }) {
  const world = useSim((s) => s.world);
  const snap = useSim((s) => s.snap);
  if (world === null || snap === null) return null;
  const site = world.sites[siteIdx];
  if (site === undefined) return null;

  const ranges = siteRanges(world)[siteIdx];
  const urgency = snap.siteUrgency[siteIdx] ?? 0;
  // Site-wide rate factor for days-of-cover: mean process rate ÷ design.
  let procRateSum = 0;
  for (let k = 0; k < ranges.procCount; k++) procRateSum += snap.procRate[ranges.procStart + k] ?? 0;
  const rateFactor = ranges.procCount > 0 ? procRateSum / ranges.procCount : 0;

  return (
    <section className="panel pointer-events-auto max-h-[calc(100vh-9rem)] w-80 overflow-y-auto p-4 text-xs" data-testid="site-inspector">
      <header className="mb-2 flex items-center justify-between">
        <h2 className="font-body text-base font-semibold text-ink">{site.name}</h2>
        <span className="label">{site.preset}</span>
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

      <h3 className="label mb-2">Processes</h3>
      <ul className="mb-4 space-y-2">
        {site.processes.map((proc, k) => {
          const procIdx = ranges.procStart + k;
          const rate = snap.procRate[procIdx] ?? 0;
          const status = snap.procStatus[procIdx] ?? 0;
          return (
            <li key={proc.key} className="rounded-sm border border-line bg-panel-2 p-2">
              <div className="flex items-center justify-between">
                <span className="font-medium text-ink">{proc.key}</span>
                <span className="flex items-center gap-2 text-muted">
                  <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[status] ?? 'bg-dim'}`} />
                  {PROC_STATUS_LABELS[status] ?? `status ${status}`}
                </span>
              </div>
              <div className="mt-2 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded-sm bg-line-2">
                  <div className="h-full rounded-sm bg-blue" style={{ width: `${rate * 100}%` }} />
                </div>
                <span className="data w-10 text-right text-muted">{fmtPct(rate)}</span>
              </div>
              <ul className="mt-2 space-y-1 text-muted">
                {proc.units.map((unit, u) => {
                  const trains = snap.unitTrains[ranges.unitStart + u] ?? 0;
                  return (
                    <li key={unit.key} className="flex justify-between">
                      <span>{unit.key}</span>
                      <span className="data" data-testid="unit-trains">
                        {trains}/{unit.trains} trains
                      </span>
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>

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
