// Economy window, Procurement tab: what the plants have bought so far.
//
// One chart of spend (or tonnes) per chemical over time, per day or as a
// running total, with the chemicals table below it doing three jobs at once:
// it is the legend, it chooses which chemicals get a line of their own (seven
// at most; the rest fold into "Other"), and it is the table of the numbers
// behind the chart. A second chart splits freight by vehicle type.
//
// A chemical keeps its colour for as long as it is shown: picking or
// dropping another never repaints it.

import { useMemo, useState } from 'react';
import type { EconomyReply } from '../engine/api';
import { useSim } from '../store/sim';
import { LineChart } from './charts/LineChart';
import { Sparkline } from './charts/Sparkline';
import { CHART_COLORS, CHART_OTHER } from './charts/palette';
import {
  SLOT_COUNT, bucketDays, classSeries, defaultSlots, fmtAxisMoney, fmtAxisTonnes, fmtMoney, fmtTonnes,
  elapsedDaysWords, fullBuckets, materialRows, procurementSeries, sum, toggleSlot, type Measure, type Span,
} from './economyData';

const CHART_WIDTH = 688;

function Switch<T extends string>({ value, options, onChange, label }: {
  value: T;
  options: { key: T; label: string }[];
  onChange: (v: T) => void;
  label: string;
}) {
  return (
    <span className="inline-flex gap-1" role="group" aria-label={label}>
      {options.map((o) => (
        <button
          key={o.key}
          className={`btn ${value === o.key ? 'btn-active' : ''}`}
          aria-pressed={value === o.key}
          onClick={() => onChange(o.key)}
          data-testid={`economy-switch-${o.key}`}
        >
          {o.label}
        </button>
      ))}
    </span>
  );
}

function Card({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="chamfer chamfer-sm min-w-0 flex-1 px-3 py-1.5" style={{ '--chamfer-fill': 'var(--white)' } as React.CSSProperties}>
      <div className="label">{label}</div>
      {children}
    </div>
  );
}

/** Price against par as "+8%" / "-12%" / "par". */
function priceWords(index: number | null): string {
  if (index === null) return '—';
  const pct = Math.round((index - 1) * 100);
  return pct === 0 ? 'par' : `${pct > 0 ? '+' : ''}${pct}%`;
}

export function ProcurementView({ reply }: { reply: EconomyReply }) {
  const epoch = useSim((s) => s.runEpoch);
  const [measure, setMeasure] = useState<Measure>('usd');
  const [span, setSpan] = useState<Span>('total');
  const [other, setOther] = useState(true);
  const [picked, setPicked] = useState<{ epoch: number; slots: Map<string, number> } | null>(null);

  const rows = useMemo(() => materialRows(reply, measure), [reply, measure]);
  // colours are handed out once per run, to the biggest chemicals at that moment
  const slots = picked !== null && picked.epoch === epoch ? picked.slots : defaultSlots(rows);
  const days = useMemo(() => bucketDays(reply), [reply]);
  // per day, the day still running is left off: its total is not in yet
  const n = span === 'daily' ? fullBuckets(reply) : reply.buckets;
  const x = days.slice(0, n);
  const money = measure === 'usd';
  const format = money ? fmtAxisMoney : fmtAxisTonnes;
  const unit = span === 'daily' ? 'per day' : 'running total';

  const lines = procurementSeries(rows, slots, other, span).map((s) => ({
    label: s.label,
    values: s.values.slice(0, n),
    color: s.slot >= 0 ? CHART_COLORS[s.slot] : CHART_OTHER,
  }));
  const freight = classSeries(reply, measure, span).map((s) => ({ ...s, values: s.values.slice(0, n) }));
  const totalSpend = sum(reply.totals.spendUsd);
  const totalFreight = sum(reply.totals.freightUsd);
  const bySpend = [...rows].sort((a, b) => b.spendUsd - a.spendUsd);
  const full = slots.size >= SLOT_COUNT;
  const rest = rows.filter((r) => !slots.has(r.key)).length;

  if (reply.buckets === 0 || rows.length === 0) {
    return <p className="px-4 py-6 text-sm text-muted" data-testid="economy-procurement-empty">Nothing has been ordered yet. Start the simulation and the first orders appear within the hour.</p>;
  }

  return (
    <div className="flex flex-col gap-3 px-4 py-3" data-testid="economy-procurement">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <Switch label="Measure" value={measure} onChange={setMeasure} options={[{ key: 'usd', label: 'Dollars' }, { key: 't', label: 'Tonnes' }]} />
        <Switch label="Time" value={span} onChange={setSpan} options={[{ key: 'daily', label: 'Per day' }, { key: 'total', label: 'Running total' }]} />
      </div>

      <div className="flex gap-2">
        <Card label="Spent on chemicals">
          <div className="text-2xl font-semibold leading-tight text-ink" data-testid="economy-total-spend">{fmtMoney(totalSpend)}</div>
          <div className="text-xs text-muted">in {elapsedDaysWords(reply.tick)}, on {rows.length} chemicals</div>
        </Card>
        <Card label="Freight">
          <div className="text-2xl font-semibold leading-tight text-ink">{fmtMoney(totalFreight)}</div>
          <div className="text-xs text-muted">{totalSpend > 0 ? `${((totalFreight / totalSpend) * 100).toFixed(1)}% on top of the chemicals` : ' '}</div>
        </Card>
        <Card label="Biggest three">
          <ol className="text-xs leading-snug text-ink">
            {bySpend.slice(0, 3).map((r) => (
              <li key={r.key} className="flex justify-between gap-2">
                <span className="truncate">{r.label}</span>
                <span className="data">{fmtMoney(r.spendUsd)}</span>
              </li>
            ))}
          </ol>
        </Card>
      </div>

      <LineChart xUnit="days"
        title={money ? 'Money spent on chemicals' : 'Chemicals ordered'}
        unit={unit}
        x={x}
        series={lines}
        width={CHART_WIDTH}
        height={210}
        format={format}
        testId="economy-procurement-chart"
      />

      <table className="w-full text-xs" data-testid="economy-materials">
        <caption className="label mb-1 text-left">
          Chemicals: pick up to {SLOT_COUNT} to draw on their own
        </caption>
        <thead>
          <tr className="text-muted">
            <th scope="col" className="py-1 text-left font-normal">Chemical</th>
            <th scope="col" className="py-1 text-right font-normal">Spent</th>
            <th scope="col" className="py-1 text-right font-normal">Ordered</th>
            <th scope="col" className="py-1 text-right font-normal">Freight</th>
            <th scope="col" className="py-1 text-right font-normal" title="Latest price against the list price">Price</th>
            <th scope="col" className="py-1 pl-3 text-left font-normal">{money ? 'Spend' : 'Tonnes'} per day</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => {
            const slot = slots.get(r.key);
            const shown = slot !== undefined;
            const color = shown ? CHART_COLORS[slot] : CHART_OTHER;
            return (
              <tr key={r.key} className="border-t border-line">
                <th scope="row" className="py-0.5 text-left font-normal">
                  <button
                    className="flex w-full cursor-pointer items-center gap-2 py-0.5 text-left text-ink hover:bg-panel-2 disabled:cursor-default disabled:opacity-60"
                    aria-pressed={shown}
                    disabled={!shown && full}
                    title={shown ? 'Fold into Other' : full ? `${SLOT_COUNT} lines at most: fold one into Other first` : 'Draw on its own line'}
                    onClick={() => setPicked({ epoch, slots: toggleSlot(slots, r.key) })}
                    data-testid={`economy-material-${r.key}`}
                  >
                    <span
                      aria-hidden="true"
                      className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                      style={shown ? { backgroundColor: color } : { boxShadow: `inset 0 0 0 1.5px ${CHART_OTHER}` }}
                    />
                    <span className={shown ? 'font-medium' : ''}>{r.label}</span>
                  </button>
                </th>
                <td className="data py-0.5 text-right text-ink">{fmtMoney(r.spendUsd)}</td>
                <td className="data py-0.5 text-right text-ink">{fmtTonnes(r.orderedT)}</td>
                <td className="data py-0.5 text-right text-muted">{fmtMoney(r.freightUsd)}</td>
                <td className="data py-0.5 text-right text-muted">{priceWords(r.priceIndex)}</td>
                <td className="py-0.5 pl-3"><Sparkline values={r.perBucket} x={days} width={120} height={16} color={color} /></td>
              </tr>
            );
          })}
          {rest > 0 && (
            <tr className="border-t border-line">
              <th scope="row" colSpan={6} className="py-0.5 text-left font-normal">
                <button
                  className="flex cursor-pointer items-center gap-2 py-0.5 text-left text-ink hover:bg-panel-2"
                  aria-pressed={other}
                  onClick={() => setOther(!other)}
                  data-testid="economy-material-other"
                >
                  <span
                    aria-hidden="true"
                    className="inline-block h-2.5 w-2.5 shrink-0 rounded-sm"
                    style={other ? { backgroundColor: CHART_OTHER } : { boxShadow: `inset 0 0 0 1.5px ${CHART_OTHER}` }}
                  />
                  <span className={other ? 'font-medium' : ''}>Other: the {rest} not drawn on their own, added together</span>
                </button>
              </th>
            </tr>
          )}
        </tbody>
      </table>

      <LineChart xUnit="days"
        title={money ? 'Freight paid, by vehicle type' : 'Tonnes carried, by vehicle type'}
        unit={unit}
        x={x}
        series={freight}
        width={CHART_WIDTH}
        height={180}
        format={format}
        testId="economy-freight-chart"
      />

      <p className="text-xs text-muted">
        An order counts on the day it is booked; deliveries and freight count on the day they arrive. Day 1 is the
        opening stock-up. Per day, the day still running is left off.
      </p>
    </div>
  );
}
