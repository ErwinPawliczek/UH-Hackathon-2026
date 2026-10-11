// Economy window, Prices tab: what each traded chemical is paid for against
// its base price, over time, and what every seller of it asks right now.
//
// One chart with a zero line (the base price): a chemical above the line
// costs more than base, below it less. The table repeats the figures and adds
// each seller's asking price, worked out here from how full its tank is.
// Pipeline chemicals are listed underneath: they are never ordered, so they
// have no price.

import { useMemo, useState } from 'react';
import type { EconomyReply } from '../engine/api';
import { useSim } from '../store/sim';
import { LineChart } from './charts/LineChart';
import { CHART_COLORS, CHART_OTHER } from './charts/palette';
import { linePath, linear } from './charts/scale';
import { SLOT_COUNT, toggleSlot } from './economyData';
import { fmtClock } from './format';
import {
  PRICE_BUCKET_H, bucketMidTicks, defaultPriceSlots, drawable, fmtSigned, pctReach, pipedOnly, priceRows, sellerAsks,
  usePriceHistory, type PriceRow,
} from './pricesData';

const CHART_WIDTH = 688;
const usd = (v: number) => `$${Math.round(v).toLocaleString('en-US')}`;

/** A row's % series in miniature, with the base price as a hairline across it. */
function PctSpark({ values, x, reach, color }: { values: number[]; x: number[]; reach: number; color: string }) {
  const width = 96;
  const height = 18;
  if (x.length < 2) return <svg width={width} height={height} aria-hidden="true" />;
  const sx = linear(x[0], x[x.length - 1], 2, width - 4);
  const sy = linear(-reach, reach, height - 2, 2);
  let last = -1;
  for (let i = values.length - 1; i >= 0; i--) if (Number.isFinite(values[i])) { last = i; break; }
  return (
    <svg width={width} height={height} aria-hidden="true" className="shrink-0">
      <line x1={2} x2={width - 4} y1={sy(0)} y2={sy(0)} stroke="var(--line-2)" strokeWidth={1} />
      <path d={linePath(x, values.map((v) => Math.max(-reach, Math.min(reach, v))), sx, sy)} fill="none" stroke={color} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
      {last >= 0 && <circle cx={sx(x[last])} cy={sy(Math.max(-reach, Math.min(reach, values[last])))} r={2.2} fill={color} />}
    </svg>
  );
}

export function PricesView({ reply }: { reply: EconomyReply }) {
  const epoch = useSim((s) => s.runEpoch);
  const world = useSim((s) => s.world);
  const snap = useSim((s) => s.snap);
  const select = useSim((s) => s.select);
  const [picked, setPicked] = useState<{ epoch: number; slots: Map<string, number> } | null>(null);

  const rows = useMemo(() => priceRows(reply), [reply]);
  const x = useMemo(() => bucketMidTicks(reply), [reply]);
  // drawn unless the reader picks: the chemicals paid furthest from base now
  const slots = picked !== null && picked.epoch === epoch ? picked.slots : defaultPriceSlots(rows);
  const drawn = rows.filter((r) => slots.has(r.key));
  const reach = pctReach(drawn.flatMap((r) => r.pct));
  const half = (reply.bucketH * 4) / 2;
  const full = slots.size >= SLOT_COUNT;
  const piped = world === null ? [] : pipedOnly(world, reply);

  if (rows.every((r) => r.paidBucket < 0)) {
    return <p className="px-4 py-6 text-sm text-muted" data-testid="economy-prices-empty">Nothing has been ordered yet, so nothing has a price. Start the simulation and the first orders appear within the hour.</p>;
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-3" data-testid="economy-prices">
      <p className="text-sm leading-snug text-ink" data-testid="economy-prices-rule">
        A seller asks less as its tank fills and more as it empties; a buyer running short bids more; an order is
        booked where the two meet in the middle.
      </p>

      <LineChart
        title="Price paid against base price"
        unit={`each ${PRICE_BUCKET_H} hours`}
        series={drawn.map((r) => ({ label: r.label, ...drawable(x, r.pct, half), color: CHART_COLORS[slots.get(r.key) ?? 0] }))}
        width={CHART_WIDTH}
        height={230}
        yMin={-reach}
        yMax={reach}
        refLines={[{ value: 0, label: 'base' }]}
        format={fmtSigned}
        testId="economy-prices-chart"
      />
      <p className="-mt-2 text-xs text-muted">
        The level line is the base price: above it a chemical costs more, below it less. A line stops where
        nothing was ordered in those {PRICE_BUCKET_H} hours.
      </p>

      <table className="w-full text-xs" data-testid="economy-prices-table">
        <caption className="label mb-1 text-left">Chemicals: pick up to {SLOT_COUNT} to draw</caption>
        <thead>
          <tr className="text-muted">
            <th scope="col" className="py-1 text-left font-normal">Chemical</th>
            <th scope="col" className="py-1 text-right font-normal">Base</th>
            <th scope="col" className="py-1 pl-2 text-right font-normal" title="The latest six hours in which any was ordered">Paid now</th>
            <th scope="col" className="py-1 pl-3 text-left font-normal" title="From how full each seller's tank is at this moment">Sellers ask now, cheapest first</th>
            <th scope="col" className="py-1 pl-2 text-left font-normal">Against base</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const slot = slots.get(r.key);
            const shown = slot !== undefined;
            const color = shown ? CHART_COLORS[slot] : CHART_OTHER;
            const asks = world === null || snap === null ? [] : sellerAsks(world, snap, r.key, r.baseUsdT);
            return (
              <PriceTableRow
                key={r.key}
                row={r}
                x={x}
                reach={reach}
                shown={shown}
                color={color}
                full={full}
                asks={asks}
                paidAt={r.paidBucket >= 0 ? fmtClock(r.paidBucket * reply.bucketH * 4) : null}
                onToggle={() => setPicked({ epoch, slots: toggleSlot(slots, r.key) })}
                onSeller={(site) => select({ kind: 'site', index: site })}
              />
            );
          })}
        </tbody>
      </table>

      {piped.length > 0 && (
        <p className="text-xs text-muted" data-testid="economy-prices-piped">
          Moved by pipeline, not traded, so they have no price: {piped.join(', ')}.
        </p>
      )}
    </div>
  );
}

function PriceTableRow({ row: r, x, reach, shown, color, full, asks, paidAt, onToggle, onSeller }: {
  row: PriceRow;
  x: number[];
  reach: number;
  shown: boolean;
  color: string;
  full: boolean;
  asks: ReturnType<typeof sellerAsks>;
  paidAt: string | null;
  onToggle: () => void;
  onSeller: (site: number) => void;
}) {
  const never = r.paidBucket < 0;
  return (
    <tr className="border-t border-line align-top" data-testid={`economy-price-row-${r.key}`}>
      <th scope="row" className="py-0.5 text-left font-normal">
        <button
          className="flex w-full cursor-pointer items-center gap-2 py-0.5 text-left text-ink hover:bg-panel-2 disabled:cursor-default disabled:opacity-60"
          aria-pressed={shown}
          disabled={never || (!shown && full)}
          title={never ? 'Not ordered yet' : shown ? 'Take off the chart' : full ? `${SLOT_COUNT} lines at most: take one off first` : 'Draw on the chart'}
          onClick={onToggle}
          data-testid={`economy-price-${r.key}`}
        >
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
            style={shown ? { backgroundColor: color } : { boxShadow: `inset 0 0 0 1.5px ${CHART_OTHER}` }}
          />
          <span className={shown ? 'font-medium' : ''}>{r.label}</span>
        </button>
      </th>
      <td className="data whitespace-nowrap py-1 text-right text-muted">{usd(r.baseUsdT)}</td>
      <td className="data whitespace-nowrap py-1 pl-2 text-right text-ink" title={paidAt === null ? undefined : `Orders booked in the ${PRICE_BUCKET_H} hours from ${paidAt}`} data-testid={`economy-price-paid-${r.key}`}>
        {r.paidUsdT === null || r.paidPct === null ? <span className="text-muted">not ordered yet</span> : (
          <>
            {usd(r.paidUsdT)} <span className="font-semibold">{fmtSigned(r.paidPct)}</span>
          </>
        )}
      </td>
      <td className="py-1 pl-3 text-ink">
        {asks.length === 0 ? <span className="text-muted">—</span> : (
          <span className="flex flex-wrap gap-x-3 gap-y-0.5">
            {asks.map((a) => (
              <button
                key={a.site}
                className="cursor-pointer whitespace-nowrap text-left underline decoration-dotted underline-offset-2 hover:text-blue"
                title={`Its ${r.label.toLowerCase()} tank is ${Math.round(a.fill * 100)}% full. Show ${a.name}`}
                onClick={() => onSeller(a.site)}
                data-testid={`economy-price-seller-${r.key}-${a.site}`}
              >
                {a.name} <span className="data">{usd(a.usdT)} ({fmtSigned(a.pct)})</span>
              </button>
            ))}
          </span>
        )}
      </td>
      <td className="py-1 pl-2"><PctSpark values={r.pct} x={x} reach={reach} color={color} /></td>
    </tr>
  );
}

export function EconomyPrices({ open }: { open: boolean }) {
  const { data, error, loading } = usePriceHistory(open);
  if (data === null) {
    return (
      <p className="px-4 py-6 text-sm text-muted" data-testid="economy-empty">
        {error !== null ? `The prices could not be loaded: ${error}` : loading ? 'Adding up the run so far…' : 'Start the simulation to see the prices.'}
      </p>
    );
  }
  return <div className={`transition-opacity ${loading ? 'opacity-60' : ''}`}><PricesView reply={data} /></div>;
}
