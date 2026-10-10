// Site inspector: process block list with per-unit train status and tanks
// with level + days of cover. All live numbers slice the snapshot arrays via
// the site's flattened index ranges.

import { siteRanges } from '../engine/world';
import { useSim } from '../store/sim';
import { PROC_STATUS_LABELS } from '../scene/palette';
import { fmtDaysOfCover, fmtPct, hoursOfCover } from './format';

const STATUS_DOT: Record<number, string> = {
  0: 'bg-emerald-400',
  1: 'bg-amber-400',
  2: 'bg-orange-400',
  3: 'bg-red-400',
  4: 'bg-blue-400',
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
    <section className="panel pointer-events-auto max-h-[calc(100vh-9rem)] w-80 overflow-y-auto p-3 text-xs" data-testid="site-inspector">
      <header className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-100">{site.name}</h2>
        <span className="text-slate-500">{site.preset}</span>
      </header>

      <div className="mb-3">
        <div className="mb-1 flex justify-between text-slate-400">
          <span>Disruption urgency</span>
          <span>{fmtPct(urgency)}</span>
        </div>
        <div className="h-1.5 overflow-hidden rounded bg-slate-700">
          <div className="h-full rounded bg-gradient-to-r from-emerald-400 via-amber-400 to-red-400" style={{ width: `${urgency * 100}%` }} />
        </div>
      </div>

      <h3 className="mb-1 font-semibold text-slate-300">Processes</h3>
      <ul className="mb-3 space-y-2">
        {site.processes.map((proc, k) => {
          const procIdx = ranges.procStart + k;
          const rate = snap.procRate[procIdx] ?? 0;
          const status = snap.procStatus[procIdx] ?? 0;
          return (
            <li key={proc.key} className="rounded border border-slate-700/70 bg-slate-800/60 p-2">
              <div className="flex items-center justify-between">
                <span className="font-medium text-slate-200">{proc.key}</span>
                <span className="flex items-center gap-1.5 text-slate-300">
                  <span className={`inline-block h-2 w-2 rounded-full ${STATUS_DOT[status] ?? 'bg-slate-400'}`} />
                  {PROC_STATUS_LABELS[status] ?? `status ${status}`}
                </span>
              </div>
              <div className="mt-1 flex items-center gap-2">
                <div className="h-1.5 flex-1 overflow-hidden rounded bg-slate-700">
                  <div className="h-full rounded bg-cyan-400" style={{ width: `${rate * 100}%` }} />
                </div>
                <span className="w-10 text-right text-slate-400">{fmtPct(rate)}</span>
              </div>
              <ul className="mt-1.5 space-y-0.5 text-slate-400">
                {proc.units.map((unit, u) => {
                  const trains = snap.unitTrains[ranges.unitStart + u] ?? 0;
                  return (
                    <li key={unit.key} className="flex justify-between">
                      <span>{unit.key}</span>
                      <span className="font-mono" data-testid="unit-trains">
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

      <h3 className="mb-1 font-semibold text-slate-300">Tanks</h3>
      <ul className="space-y-1.5">
        {ranges.tankIndices.map((tIdx, k) => {
          const tank = world.tanks[tIdx];
          const fill = snap.tanks[4 * tIdx] ?? 0;
          const hours = hoursOfCover(fill, tank.capacityT, tank.drawTph, rateFactor);
          return (
            <li key={`${tank.material}-${k}`} className="flex items-center gap-2">
              <span className="w-20 shrink-0 truncate text-slate-300">{tank.material}</span>
              <div className="h-2 flex-1 overflow-hidden rounded bg-slate-700">
                <div
                  className="h-full rounded bg-gradient-to-r from-cyan-500 to-cyan-300"
                  style={{ width: `${Math.min(100, fill * 100)}%` }}
                />
              </div>
              <span className="w-24 text-right text-slate-400" data-testid="tank-cover">
                {fmtPct(fill)} · {fmtDaysOfCover(hours)}
              </span>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
