// Economy window, Production tab: how hard every plant has run, day by day.
//
// One small chart per plant process (small multiples, in site order): the
// day's average rate as a share of design, on a band from the day's lowest
// rate to its highest. Days a plant averaged below its lowest stable rate,
// or stood still, are marked red under its chart and counted in words.
// Above them, the network's own three lines: customers served, sales lost
// and plant time stopped, per day.

import { useMemo } from 'react';
import type { EconomyReply } from '../engine/api';
import { useSim } from '../store/sim';
import { LineChart } from './charts/LineChart';
import { bucketDays, fmtAxisMoney, plantCharts, type PlantChart } from './economyData';
import { niceCeil } from './charts/scale';

const SMALL = { width: 222, height: 104 };
/** LineChart's left and right margins, which the low-day strip lines up with. */
const PLOT_LEFT = 40;
const PLOT_RIGHT = 46;

const whole = (v: number) => `${Math.round(v)}`;
const days = (n: number) => `${n} day${n === 1 ? '' : 's'}`;

function PlantSmall({ plant, x }: { plant: PlantChart; x: number[] }) {
  const select = useSim((s) => s.select);
  const troubled = plant.stoppedDays + plant.belowMinDays > 0;
  return (
    <div className="min-w-0" data-testid="economy-plant">
      <LineChart xUnit="days"
        title={plant.title}
        unit="% of design"
        x={x}
        series={[{ label: 'Average rate', values: plant.mean, min: plant.min, max: plant.max }]}
        width={SMALL.width}
        height={SMALL.height}
        yMax={100}
        refLines={plant.turndownPct > 0 ? [{ value: plant.turndownPct, label: 'min' }] : []}
        format={whole}
      />
      {/* one cell per day, red where the plant averaged below its lowest stable rate or stood still */}
      <div className="flex h-1" style={{ marginLeft: PLOT_LEFT, marginRight: PLOT_RIGHT }} aria-hidden="true">
        {plant.low.map((low, i) => (
          <span key={i} className={`flex-1 ${low ? 'bg-alarm' : ''}`} />
        ))}
      </div>
      <button
        className="mt-0.5 flex w-full cursor-pointer items-center gap-1.5 text-left text-xs hover:underline"
        onClick={() => select({ kind: 'site', index: plant.siteIndex })}
        title="Show on the map"
      >
        {troubled ? (
          <>
            <span aria-hidden="true" className="inline-block h-2 w-2 shrink-0 rounded-full bg-alarm" />
            <span className="text-ink">
              {[
                plant.stoppedDays > 0 ? `stopped ${days(plant.stoppedDays)}` : null,
                plant.belowMinDays > 0 ? `below minimum ${days(plant.belowMinDays)}` : null,
              ].filter((s) => s !== null).join(', ')}
            </span>
          </>
        ) : (
          <span className="text-muted">ran every day</span>
        )}
      </button>
    </div>
  );
}

export function ProductionView({ reply }: { reply: EconomyReply }) {
  const x = useMemo(() => bucketDays(reply), [reply]);
  const plants = useMemo(() => plantCharts(reply), [reply]);
  if (reply.buckets === 0) {
    return <p className="px-4 py-6 text-sm text-muted" data-testid="economy-production-empty">No history yet. Start the simulation and the first day fills in.</p>;
  }
  const t = reply.totals;
  return (
    <div className="flex flex-col gap-3 px-4 py-3" data-testid="economy-production">
      <div>
        <div className="label mb-1">The whole network, per day</div>
        <div className="grid grid-cols-3 gap-x-2">
          <LineChart xUnit="days" title="Customers served" unit="% of demand" x={x} series={[{ label: 'Served', values: t.service.map((s) => s * 100) }]} {...SMALL} yMax={100} format={whole} testId="economy-network-service" />
          {/* a quiet run still gets a real axis: $0 to $1 K, not five marks all reading $0 */}
          <LineChart xUnit="days" title="Sales lost" unit="per day" x={x} series={[{ label: 'Lost', values: t.unmetUsd }]} {...SMALL} yMax={niceCeil(Math.max(1000, ...t.unmetUsd))} format={fmtAxisMoney} area />
          <LineChart xUnit="days" title="Plant time stopped" unit="hours per day" x={x} series={[{ label: 'Stopped', values: t.shutdownH }]} {...SMALL} yMax={niceCeil(Math.max(24, ...t.shutdownH))} format={whole} area />
        </div>
      </div>
      <div>
        <div className="label mb-1">Every plant, day by day</div>
        <p className="mb-2 max-w-[78ch] text-xs text-muted">
          The line is the day&apos;s average rate as a share of design; the band behind it runs from that day&apos;s lowest
          rate to its highest. A red mark under a chart is a day the plant stood still or averaged below the lowest
          rate it can hold (&quot;min&quot;).
        </p>
        <div className="grid grid-cols-3 gap-x-2 gap-y-3">
          {plants.map((p) => <PlantSmall key={p.key} plant={p} x={x} />)}
        </div>
      </div>
    </div>
  );
}
