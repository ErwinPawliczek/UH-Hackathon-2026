// The damage summary of a shared session: the run everyone played against
// the same run with no changes at all, then what broke and who broke it.
// Used on the host's big screen and, narrower, on a player's phone.

import type { RoomInfo, RoomSummary, SummarySite } from '../store/roomTypes';
import { ownedName, playerColor } from '../store/roomTypes';
import { fmtMoney } from './economyData';

const fmtT = (t: number) => (t >= 999_500 ? `${(t / 1e6).toFixed(1)} Mt` : t >= 1000 ? `${Math.round(t / 1000)} kt` : `${Math.round(t)} t`);
const fmtDays = (h: number) => (h >= 48 ? `${(h / 24).toFixed(1)} days` : `${Math.round(h)} h`);

/** What went wrong at a site, in a few words. */
function siteWords(s: SummarySite): string {
  const extra = s.stoppedHours - s.baselineStoppedHours;
  const lost = s.lostSalesUsd - s.baselineLostSalesUsd;
  if (lost > 0) return `went without ${fmtMoney(lost)} of product`;
  if (extra >= 6) return `stopped for ${fmtDays(extra)}`;
  if (s.baselineOutputT > 0) return `made ${Math.max(0, Math.round((1 - s.outputT / s.baselineOutputT) * 100))}% less`;
  return 'ran worse';
}

function Compare({ label, before, after, worse }: { label: string; before: string; after: string; worse: boolean }) {
  return (
    <tr className="border-t border-line">
      <th scope="row" className="py-2 pr-3 text-left text-sm font-medium text-ink">{label}</th>
      <td className="data py-2 pr-3 text-right text-sm text-ink">{before}</td>
      <td className={`data py-2 text-right text-sm font-semibold ${worse ? 'text-alarm' : 'text-ink'}`}>{after}</td>
    </tr>
  );
}

export function DamageSummary({ summary, room, me }: { summary: RoomSummary; room: RoomInfo; me?: string | null }) {
  const { actual, baseline, damageUsd } = summary.economy;
  const broken = summary.sites.filter((s) => s.broken)
    .sort((a, b) => (b.lostSalesUsd - b.baselineLostSalesUsd) - (a.lostSalesUsd - a.baselineLostSalesUsd) || (b.stoppedHours - b.baselineStoppedHours) - (a.stoppedHours - a.baselineStoppedHours));
  const pipes = summary.pipelines.filter((p) => p.broken);
  const players = [...summary.players].sort((a, b) => b.damageUsd - a.damageUsd);
  const nameOf = (site: number) => summary.sites.find((s) => s.site === site)?.name ?? `site ${site}`;
  const day = Math.floor(summary.tick / 96) + 1;
  return (
    <div className="flex flex-col gap-5" data-testid="damage-summary">
      <div>
        <div className="label">Damage to the economy · day {day}</div>
        <div className={`font-display text-5xl font-extrabold leading-none ${damageUsd > 0 ? 'text-alarm' : 'text-ink'}`} data-testid="damage-total">{fmtMoney(damageUsd)}</div>
        <p className="mt-1 text-sm text-muted">Sales customers lost because of this session's changes, against the same run with nothing changed.</p>
      </div>

      <table className="w-full border-collapse">
        <thead>
          <tr>
            <th />
            <th scope="col" className="label pb-1 pr-3 text-right">Nothing changed</th>
            <th scope="col" className="label pb-1 text-right">This session</th>
          </tr>
        </thead>
        <tbody>
          <Compare label="Customer sales lost" before={fmtMoney(baseline.lostSalesUsd)} after={fmtMoney(actual.lostSalesUsd)} worse={actual.lostSalesUsd > baseline.lostSalesUsd} />
          <Compare label="Delivered to customers" before={fmtT(baseline.deliveredT)} after={fmtT(actual.deliveredT)} worse={actual.deliveredT < baseline.deliveredT} />
          <Compare label="Plants stopped right now" before={String(baseline.plantsStoppedNow)} after={String(actual.plantsStoppedNow)} worse={actual.plantsStoppedNow > baseline.plantsStoppedNow} />
        </tbody>
      </table>

      <div>
        <div className="label mb-1">What broke</div>
        {broken.length === 0 && pipes.length === 0 && <p className="text-sm text-muted">Nothing yet: every site is running as it would have.</p>}
        <ul className="divide-y divide-line">
          {broken.map((s) => (
            <li key={s.site} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
              <span className="min-w-0 truncate font-medium" style={{ color: playerColor(room, s.owner) ?? undefined }}>{ownedName(s.ownerName, s.name)}</span>
              <span className="shrink-0 text-alarm">{siteWords(s)}</span>
            </li>
          ))}
          {pipes.map((p) => (
            <li key={`p${p.index}`} className="flex items-baseline justify-between gap-3 py-1.5 text-sm">
              <span className="min-w-0 truncate font-medium text-ink">{p.name}</span>
              <span className="shrink-0 text-alarm">carried {p.baselineMovedT > 0 ? Math.max(0, Math.round((1 - p.movedT / p.baselineMovedT) * 100)) : 0}% less</span>
            </li>
          ))}
        </ul>
      </div>

      <div>
        <div className="label mb-1">Who did it</div>
        {players.length === 0 && <p className="text-sm text-muted">Nobody joined.</p>}
        <ol className="divide-y divide-line">
          {players.map((p, i) => (
            <li key={p.id} className={`py-2 text-sm ${p.id === me ? 'bg-blue-soft' : ''}`} data-testid="damage-player">
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-semibold" style={{ color: playerColor(room, p.id) ?? undefined }}>
                  <span className="data mr-2 font-normal text-muted">{i + 1}</span>{p.site === null ? p.name : ownedName(p.name, nameOf(p.site))}
                </span>
                <span className={`data shrink-0 font-semibold ${p.damageUsd > 0 ? 'text-alarm' : 'text-ink'}`}>{fmtMoney(p.damageUsd)}</span>
              </div>
              <div className="text-xs text-muted">
                {p.moves === 0 ? 'made no changes' : p.tookDown.length === 0 ? `${p.moves} change${p.moves === 1 ? '' : 's'}, nothing broke because of them` : `broke ${p.tookDown.map(nameOf).join(', ')}`}
              </div>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}
