// The site window: click a plant and see what is going on inside it.
//
//   1. Header — the plant's icon, name and state in words. It is the window's
//      title bar: there is no separate title strip above it.
//   2. Process flow diagram — tanks, units and the streams between them, with
//      live numbers on every one (Flowsheet.tsx); it scrolls sideways for a
//      big site and can be widened with the Widen button.
//   3. Analytics, with a two-way switch:
//        Plant — the site as a whole: the headline numbers now, then two
//                charts over the chosen time window (24 h, 7 days, all):
//                "Into the plant" and "Out of the plant", each with a line
//                per chemical in shades of blue (largest flow darkest) and
//                their sum as a heavier black line. They are stacked at the
//                window's default width and side by side once it is widened;
//                a customer or a source has only the one that applies. Then
//                every stream and tank as a list; pick a tank to chart its
//                level.
//        Units — inside the process: each unit's throughput, load against
//                the capacity of its trains, heat and power. Pick a row to
//                chart it.
//
// A draggable window that follows the selection: it opens when a site is
// picked and closing it clears the selection.
//
// History comes from the engine's hourly series (a process's rate and a
// tank's fill); everything in t/h is that rate times a design figure from
// the world's flowsheet data. Series are fetched when the window opens, when
// a new simulated day begins (at most every 1.5 s), and after going back in
// time; between fetches each chart is extended with the live value.

import { useEffect, useMemo, useRef, useState } from 'react';
import type { Snapshot } from '../engine/snapshot';
import type { WorldSpec } from '../engine/world';
import { useSim } from '../store/sim';
import { LineChart } from './charts/LineChart';
import { Sparkline } from './charts/Sparkline';
import { TICKS_PER_DAY } from './charts/scale';
import { DraggableWindow } from './DraggableWindow';
import { openSupplyOptions } from './economyView';
import { FlowsheetView } from './Flowsheet';
import { SiteBadge } from './SiteIcon';
import {
  buildFlowsheet, fmtHours, fmtTph, streamLabel, unitLive, type FlowUnitNode, type Flowsheet,
} from './flowsheet';
import { presetLabel } from './siteIcons';
import {
  WINDOWS, flowLines, headline, plantRows, since, unitRows, type AnalyticsRow, type Histories, type History,
} from './siteSeries';

export const SITE_WINDOW_ID = 'site';
const WIDTH = 640;
/** Least width (px) at which a flow chart with its legend is still legible; below twice this the two are stacked. */
const FLOW_CHART_MIN = 430;
/** Gap between the two flow charts when they sit side by side, and what the window adds around its content. */
const FLOW_CHART_GAP = 16;
const WINDOW_CHROME = 44;
/** Width of a window whose two flow charts sit side by side. */
const SIDE_BY_SIDE_WIDTH = 2 * FLOW_CHART_MIN + FLOW_CHART_GAP + WINDOW_CHROME;
/** Axis and readout numbers for flows: t/h, with a plain 0 at the foot of the axis. */
const fmtFlow = (v: number) => (v === 0 ? '0' : fmtTph(v));
/** Real milliseconds at least between two history refreshes while the run races ahead. */
const REFRESH_MIN_MS = 1500;

/** The plant's state in a few words, and whether something is wrong. */
export function stateWords(sheet: Flowsheet | null, world: WorldSpec, snap: Snapshot, siteIdx: number): { text: string; alarm: boolean } {
  const site = world.sites[siteIdx];
  const procs = (site?.processes ?? []).filter((p) => p.index !== undefined);
  const named = (status: number) => procs.filter((p) => snap.procStatus[p.index as number] === status).map((p) => p.name);
  const shut = named(2);
  const restarting = named(3);
  const holding = named(1);
  const hurt = sheet === null
    ? 0
    : sheet.nodes.filter((n): n is FlowUnitNode => n.kind === 'unit').filter((u) => {
      const live = unitLive(snap, u);
      return live.trainsOnline < live.trains;
    }).length;
  const tail = hurt > 0 ? ` · ${hurt} unit${hurt === 1 ? '' : 's'} with trains down` : '';
  if (shut.length > 0) return { text: `Shut down: ${shut.join(', ')}${tail}`, alarm: true };
  if (restarting.length > 0) return { text: `Restarting: ${restarting.join(', ')}${tail}`, alarm: true };
  if (holding.length > 0) return { text: `Holding at minimum rate: ${holding.join(', ')}${tail}`, alarm: hurt > 0 };
  if (sheet === null) return { text: 'Running', alarm: false };
  return { text: `Running at ${Math.round(headline(sheet, world, snap).throughput * 100)}% of design${tail}`, alarm: hurt > 0 };
}

/**
 * Where to scroll a diagram `viewWidth` px wide so the first unit that is
 * down sits in the middle of the view; null when no unit is down.
 */
export function scrollToFirstAlarm(sheet: Flowsheet, snap: Snapshot, viewWidth: number): number | null {
  const down = sheet.nodes
    .filter((n): n is FlowUnitNode => n.kind === 'unit')
    .filter((u) => unitLive(snap, u).alarm)
    .sort((a, b) => a.x - b.x)[0];
  if (down === undefined) return null;
  return Math.max(0, Math.min(sheet.width - viewWidth, down.x + down.w / 2 - viewWidth / 2));
}

/** The hourly histories a site's analytics need, kept fresh while its window is open. */
function useHistories(sheet: Flowsheet | null, siteIdx: number | null): Histories {
  const fetchSeries = useSim((s) => s.fetchSeries);
  const runEpoch = useSim((s) => s.runEpoch);
  const day = useSim((s) => Math.floor(Number(s.snap?.tick ?? 0) / TICKS_PER_DAY));
  const [hist, setHist] = useState<{ owner: string; map: Histories }>({ owner: '', map: new Map() });
  const lastAt = useRef({ owner: '', at: 0 });
  const owner = `${siteIdx}:${runEpoch}`;

  useEffect(() => {
    if (sheet === null || siteIdx === null || fetchSeries === null) return;
    const now = performance.now();
    // a new site or a rewound run always fetches; a new day only if the last fetch is not too recent
    if (lastAt.current.owner === owner && now - lastAt.current.at < REFRESH_MIN_MS) return;
    lastAt.current = { owner, at: now };
    let stale = false;
    const wanted = new Map<string, [number, number]>(); // key → [series kind, id]
    for (const n of sheet.nodes) {
      if (n.kind === 'unit') wanted.set(`p${n.procIndex}`, [1, n.procIndex]);
      else wanted.set(`t${n.tank}`, [0, n.tank]);
    }
    void Promise.all(
      [...wanted].map(async ([key, [kind, id]]): Promise<[string, History] | null> => {
        try {
          const values = await fetchSeries(kind, id);
          // requests to a session run one at a time, so the snapshot in the
          // store is the tick the engine stood at when it answered
          return [key, { values, fetchedTick: Number(useSim.getState().snap?.tick ?? 0) }];
        } catch {
          return null; // a series that fails leaves its chart on live values only
        }
      }),
    ).then((got) => {
      if (stale) return;
      setHist({ owner, map: new Map(got.filter((g): g is [string, History] => g !== null)) });
    });
    return () => {
      stale = true;
    };
  }, [sheet, siteIdx, fetchSeries, owner, day]);

  // histories of another site, or of a future that was rewound away, are not shown
  return hist.owner === owner ? hist.map : EMPTY;
}
const EMPTY: Histories = new Map();

function Tile({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="chamfer chamfer-sm min-w-0 flex-1 px-3 py-2" style={{ '--chamfer-fill': 'var(--white)', '--chamfer-line': 'var(--line)' } as React.CSSProperties}>
      <div className="label">{label}</div>
      <div className="text-lg font-semibold leading-tight text-ink">{value}</div>
      {note !== undefined && <div className="truncate text-[11px] text-muted">{note}</div>}
    </div>
  );
}

const pct = (now: number, design: number | null) => (design !== null && design > 0 ? `${Math.round((now / design) * 100)}%` : '—');

/** A table of analytics rows; the chosen row is the one charted. */
function RowTable({
  rows, groups, chosen, onChoose, fromTick, unitsMode, canChoose = () => true,
}: {
  rows: AnalyticsRow[];
  groups: { key: AnalyticsRow['group']; title: string }[];
  chosen: string | null;
  onChoose: (id: string) => void;
  fromTick: number;
  unitsMode: boolean;
  /** which rows can be picked for the chart; the rest are listed only */
  canChoose?: (row: AnalyticsRow) => boolean;
}) {
  return (
    <table className="w-full border-collapse text-[11px]" data-testid="analytics-table">
      <thead>
        <tr className="text-left">
          <th className="label px-2 py-1 font-normal">{unitsMode ? 'Unit' : 'Stream or tank'}</th>
          {unitsMode && <th className="label px-2 py-1 text-right font-normal">Trains</th>}
          <th className="label px-2 py-1 text-right font-normal">Now</th>
          <th className="label px-2 py-1 text-right font-normal">{unitsMode ? 'Load' : 'Of design'}</th>
          {unitsMode && <th className="label px-2 py-1 text-right font-normal">Heat</th>}
          {unitsMode && <th className="label px-2 py-1 text-right font-normal">Power</th>}
          <th className="label px-2 py-1 font-normal">Trend</th>
        </tr>
      </thead>
      {groups.map((g) => {
        const mine = rows.filter((r) => r.group === g.key);
        if (mine.length === 0) return null;
        return (
          <tbody key={g.key}>
            {!unitsMode && (
              <tr>
                <th colSpan={4} className="px-2 pb-0.5 pt-2 text-left text-[11px] font-semibold text-ink">{g.title}</th>
              </tr>
            )}
            {mine.map((r) => {
              const live = r.node !== undefined ? r : null;
              const s = since(r.series, fromTick);
              const heat = r.node?.unit.heatGjH ?? 0;
              const power = r.node?.unit.powerMw ?? 0;
              const rate = r.design !== null && r.design > 0 ? r.now / r.design : 0;
              return (
                <tr
                  key={r.id}
                  className={`border-t border-line ${canChoose(r) ? 'cursor-pointer hover:bg-panel-2' : ''} ${chosen === r.id ? 'bg-blue-soft' : ''}`}
                  onClick={canChoose(r) ? () => onChoose(r.id) : undefined}
                  aria-selected={canChoose(r) ? chosen === r.id : undefined}
                  data-testid={`analytics-row-${r.id}`}
                >
                  <td className="px-2 py-1 text-ink">
                    {unitsMode ? <span className="data font-semibold">{r.label}</span> : r.label}
                    {unitsMode && <span className="ml-1.5 text-muted">{r.node?.unit.name}</span>}
                  </td>
                  {unitsMode && (
                    <td className="data whitespace-nowrap px-2 py-1 text-right">
                      {live !== null && r.node !== undefined ? `${Math.round(r.capacity !== undefined && (r.node.unit.capPerTrainTph ?? 0) > 0 ? r.capacity / (r.node.unit.capPerTrainTph as number) : r.node.unit.trains)}/${r.node.unit.trains}` : ''}
                    </td>
                  )}
                  <td className="data whitespace-nowrap px-2 py-1 text-right text-ink">
                    {r.unit === '%' ? `${Math.round(r.now)}%` : `${fmtTph(r.now)} t/h`}
                  </td>
                  <td className="data whitespace-nowrap px-2 py-1 text-right text-muted">
                    {unitsMode
                      ? (r.capacity !== undefined && r.capacity > 0 ? `${Math.round((r.now / r.capacity) * 100)}%` : 'down')
                      : (r.unit === '%' ? '' : pct(r.now, r.design))}
                  </td>
                  {unitsMode && <td className="data whitespace-nowrap px-2 py-1 text-right text-muted">{heat > 0 ? `${fmtTph(heat * rate)} GJ/h` : '—'}</td>}
                  {unitsMode && <td className="data whitespace-nowrap px-2 py-1 text-right text-muted">{power > 0 ? `${fmtTph(power * rate)} MW` : '—'}</td>}
                  <td className="px-2 py-1">
                    <Sparkline values={s.values} x={s.ticks} max={r.unit === '%' ? 100 : Math.max(r.design ?? 0, r.capacity ?? 0)} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        );
      })}
    </table>
  );
}

function chartTitle(r: AnalyticsRow): string {
  if (r.group === 'in') return `${r.label} into the plant`;
  if (r.group === 'out') return `${r.label} out of the plant`;
  if (r.group === 'level') return `${r.label} level`;
  return `${r.label} throughput — ${r.node?.unit.name ?? ''}`;
}

/** Whether the site both takes materials in and sends materials out (a customer or a source does only one). */
export function hasBothFlows(sheet: Flowsheet): boolean {
  const tanks = sheet.nodes.filter((nd) => nd.kind === 'tank');
  return tanks.some((t) => t.role === 'feed') && tanks.some((t) => t.role === 'product');
}

/**
 * One of the two flow charts of the Plant view: every chemical going into
 * the plant, or every one coming out, in shades of blue (the largest flow
 * darkest), with their total as a heavier black line. Clicking a name in
 * the legend switches that line off and on.
 */
function FlowChart({
  title, sumLabel, rows, fromTick, width, testId,
}: {
  title: string;
  sumLabel: string;
  rows: AnalyticsRow[];
  fromTick: number;
  width: number;
  testId: string;
}) {
  const lines = flowLines(rows, sumLabel);
  const only = lines.length === 1 ? lines[0] : null;
  return (
    <LineChart
      title={only === null ? title : `${title}: ${only.label}`}
      unit="t/h"
      width={width}
      height={190}
      series={lines.map((l) => {
        const s = since(l.series, fromTick);
        return { label: l.label, color: l.color, width: l.width, values: s.values, x: s.ticks };
      })}
      refLines={only === null ? [] : [{ value: only.design, label: 'design' }]}
      format={fmtFlow}
      toggleable={only === null}
      testId={testId}
    />
  );
}

function Analytics({
  sheet, world, snap, hist, width,
}: {
  sheet: Flowsheet;
  world: WorldSpec;
  snap: Snapshot;
  hist: Histories;
  /** room for charts, in px: two flow charts sit side by side when it allows */
  width: number;
}) {
  const [mode, setMode] = useState<'plant' | 'units'>('plant');
  const [windowKey, setWindowKey] = useState('7d');
  const [chosenLevel, setChosenLevel] = useState<string | null>(null);
  const [chosenUnit, setChosenUnit] = useState<string | null>(null);

  const now = Number(snap.tick);
  const span = WINDOWS.find((w) => w.key === windowKey)?.ticks ?? null;
  const fromTick = span === null ? 0 : Math.max(0, now - span);

  const rows = mode === 'plant' ? plantRows(sheet, world, snap, hist, streamLabel) : unitRows(sheet, snap, hist);
  const head = headline(sheet, world, snap);
  const going = rows.filter((r) => r.group === 'in');
  const coming = rows.filter((r) => r.group === 'out');
  // Side by side when each chart still gets a legible width; stacked otherwise.
  const both = going.length > 0 && coming.length > 0;
  const sideBySide = both && width >= 2 * FLOW_CHART_MIN + FLOW_CHART_GAP;
  const flowWidth = sideBySide ? Math.floor((width - FLOW_CHART_GAP) / 2) : width;

  // the chart under the list: a picked tank level (Plant) or unit (Units)
  const chosen = mode === 'plant'
    ? rows.find((r) => r.id === chosenLevel && r.group === 'level')
    : rows.find((r) => r.id === chosenUnit) ?? rows[0];
  const series = chosen === undefined ? null : since(chosen.series, fromTick);
  const refs = chosen === undefined || chosen.unit === '%'
    ? []
    : [
      ...(chosen.design !== null ? [{ value: chosen.design, label: 'design' }] : []),
      ...(chosen.capacity !== undefined && chosen.capacity > 0 && Math.abs(chosen.capacity - (chosen.design ?? 0)) > 1e-6
        ? [{ value: chosen.capacity, label: 'capacity' }]
        : []),
    ];
  const picked = chosen === undefined || series === null ? null : (
    <LineChart
      title={chartTitle(chosen)}
      unit={chosen.unit}
      width={width}
      height={170}
      series={[{ label: chosen.label, values: series.values, x: series.ticks }]}
      refLines={refs}
      yMax={chosen.unit === '%' ? 100 : undefined}
      area
      format={(v) => (chosen.unit === '%' ? `${Math.round(v)}` : fmtFlow(v))}
      testId="analytics-chart"
    />
  );

  return (
    <section data-testid="site-analytics">
      {/* one row of controls scopes everything below it */}
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="label mr-auto">Analytics</h3>
        <div className="flex gap-1" role="group" aria-label="What to analyse">
          <button type="button" className={`btn ${mode === 'plant' ? 'btn-active' : ''}`} aria-pressed={mode === 'plant'} onClick={() => setMode('plant')} data-testid="analytics-plant">Plant</button>
          <button type="button" className={`btn ${mode === 'units' ? 'btn-active' : ''}`} aria-pressed={mode === 'units'} onClick={() => setMode('units')} data-testid="analytics-units">Units</button>
        </div>
        <div className="flex gap-1" role="group" aria-label="Time window">
          {WINDOWS.map((w) => (
            <button key={w.key} type="button" className={`btn ${windowKey === w.key ? 'btn-active' : ''}`} aria-pressed={windowKey === w.key} onClick={() => setWindowKey(w.key)} data-testid={`analytics-window-${w.key}`}>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      {mode === 'plant' && (
        <>
          <div className="mb-3 flex gap-2" data-testid="site-headline">
            <Tile label="Throughput" value={`${Math.round(head.throughput * 100)}%`} note="of design, now" />
            <Tile label="Feed cover" value={fmtHours(head.feedCoverH)} note={head.feedTank === null ? 'nothing drawn' : `${streamLabel(head.feedTank)} runs out first`} />
            <Tile label="Product room" value={fmtHours(head.productRoomH)} note={head.productTank === null ? 'nothing made' : `${streamLabel(head.productTank)} fills first`} />
          </div>
          {/* what goes in and what comes out, over the same time window; a customer or a source has only one of the two */}
          {/* side by side the two share a baseline, so their time axes line up whatever the legends take */}
          <div className={`mb-3 flex gap-4 ${sideBySide ? 'flex-row items-end' : 'flex-col'}`} data-testid="plant-flows" data-layout={sideBySide ? 'side-by-side' : 'stacked'}>
            {going.length > 0 && (
              <FlowChart title="Into the plant" sumLabel="Sum of all inputs" rows={going} fromTick={fromTick} width={flowWidth} testId="plant-in-chart" />
            )}
            {coming.length > 0 && (
              <FlowChart title="Out of the plant" sumLabel="Sum of all outputs" rows={coming} fromTick={fromTick} width={flowWidth} testId="plant-out-chart" />
            )}
          </div>
        </>
      )}

      {mode === 'units' && picked !== null && <div className="mb-3">{picked}</div>}

      <RowTable
        rows={rows}
        groups={mode === 'plant'
          ? [{ key: 'in', title: 'Going in' }, { key: 'out', title: 'Coming out' }, { key: 'level', title: 'Tank levels' }]
          : [{ key: 'unit', title: 'Units' }]}
        chosen={chosen?.id ?? null}
        onChoose={mode === 'plant' ? (id) => setChosenLevel(id === chosenLevel ? null : id) : setChosenUnit}
        fromTick={fromTick}
        unitsMode={mode === 'units'}
        canChoose={(r) => mode === 'units' || r.group === 'level'}
      />
      {mode === 'plant' && picked !== null && <div className="mt-3">{picked}</div>}
      <p className="mt-2 text-[11px] text-muted">
        {mode === 'plant'
          ? 'Each flow is the sum over the plant\'s processes of their rate times that stream\'s design t/h; shades run from the smallest stream (lightest) to the largest (darkest). Click a name in a chart to hide or show its line, and a tank level in the list to chart it.'
          : 'A unit\'s throughput is its process\'s rate times everything the unit takes in at design; load is that against the capacity of the trains online. Click a row to chart it.'}
      </p>
    </section>
  );
}

export function SiteWindow() {
  const selected = useSim((s) => s.selected);
  const world = useSim((s) => s.world);
  const snap = useSim((s) => s.snap);
  const sendCommand = useSim((s) => s.sendCommand);
  const select = useSim((s) => s.select);
  const [wide, setWide] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  const siteIdx = selected !== null && selected.kind === 'site' ? selected.index : null;
  const sheet = useMemo(() => (world === null || siteIdx === null ? null : buildFlowsheet(world, siteIdx)), [world, siteIdx]);
  const hist = useHistories(sheet, siteIdx);
  useEffect(() => setFailure(null), [siteIdx]);

  // When the window opens on a plant with a unit down, the diagram starts
  // scrolled to that unit (a big site's diagram is wider than the window);
  // otherwise it starts at the feed end. Only on opening: after that the
  // scroll position is the visitor's.
  const pfdScroll = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = pfdScroll.current;
    const now = useSim.getState().snap;
    if (el === null || sheet === null || now === null) return;
    const left = scrollToFirstAlarm(sheet, now, el.clientWidth);
    el.scrollLeft = left ?? 0;
    // `sheet` is rebuilt only when the site changes, so this runs once per site opened
  }, [sheet]);

  const site = world === null || siteIdx === null ? undefined : world.sites[siteIdx];
  if (world === null || snap === null || siteIdx === null || site === undefined) return null;

  const state = stateWords(sheet, world, snap, siteIdx);
  const viewport = typeof window === 'undefined' ? 1366 : window.innerWidth;
  // Widening makes room for the whole diagram and, for a plant with both
  // inputs and outputs, for its two flow charts side by side.
  const wideWidth = sheet === null ? WIDTH : Math.max(sheet.width + WINDOW_CHROME, hasBothFlows(sheet) ? SIDE_BY_SIDE_WIDTH : 0);
  const canWiden = wideWidth > WIDTH;
  const width = wide && canWiden ? Math.max(WIDTH, Math.min(viewport - 32, wideWidth)) : WIDTH;

  const failUnit = sendCommand === null
    ? null
    : (unitKey: string, trains: number, hours: number) => {
      void sendCommand({ type: 'unit_outage', site: siteIdx, unit: unitKey, trains, duration_h: hours })
        .then((reply) => {
          const r = (typeof reply === 'object' && reply !== null ? reply : {}) as { ok?: boolean; error?: string };
          setFailure(r.ok === false ? `The engine refused: ${r.error ?? 'unknown reason'}` : null);
        })
        .catch((err: unknown) => setFailure(err instanceof Error ? err.message : String(err)));
    };

  return (
    <DraggableWindow
      id={SITE_WINDOW_ID}
      title={`${site.name} (${presetLabel(site.preset)})`}
      width={width}
      // the title bar is the header: icon, name and state — and still the drag handle
      header={(
        <div className="flex items-center gap-2.5" data-testid="site-header">
          <SiteBadge preset={site.preset} icon={22} down={snap.siteStatus[siteIdx] === 3} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-base font-bold leading-tight text-ink">{site.name}</h2>
            <p className="truncate text-xs leading-tight" style={{ color: state.alarm ? 'var(--alarm)' : 'var(--muted)' }} data-testid="site-state">{state.text}</p>
          </div>
        </div>
      )}
      maxHeight="calc(100vh - 80px)"
      open
      onClose={() => select(null)}
      at={{ x: Math.max(16, viewport - WIDTH - 16), y: 64 }}
      actions={canWiden ? (
        <button type="button" className="btn" onClick={() => setWide(!wide)} aria-pressed={wide} data-testid="site-window-wide">
          {wide ? 'Narrow' : 'Widen'}
        </button>
      ) : undefined}
    >
      <div className="flex flex-col gap-3 p-3 text-xs" data-testid="site-window">
        {sheet === null ? (
          <p className="text-muted">This engine does not describe the process flows for this site, so there is no diagram to draw.</p>
        ) : (
          <>
            <section>
              <div className="mb-1 flex items-baseline justify-between">
                <h3 className="label">Process flow</h3>
                <span className="text-[11px] text-muted">streams in t/h, live</span>
              </div>
              <div
                className="chamfer chamfer-sm"
                style={{ '--chamfer-fill': 'var(--panel)', '--chamfer-line': 'var(--line)' } as React.CSSProperties}
              >
                <div ref={pfdScroll} className="chamfer-body overflow-x-auto" data-testid="pfd-scroll">
                  <FlowsheetView
                    sheet={sheet}
                    world={world}
                    snap={snap}
                    onFailUnit={failUnit}
                    // a tank this site buys by vehicle links to "who else can supply it"
                    onSupplyOptions={(tank) => {
                      const material = world.tanks[tank]?.material;
                      if (material !== undefined) openSupplyOptions(siteIdx, material);
                    }}
                  />
                </div>
              </div>
              {/* how to read the diagram's colours */}
              <p className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-0.5 text-[11px] text-muted" data-testid="pfd-legend">
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className="inline-block h-2.5 w-3.5 border" style={{ borderColor: 'var(--alarm)', backgroundColor: '#fbeceb' }} />
                  unit down (trains out, or its process shut)
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className="inline-block h-0.5 w-5" style={{ backgroundColor: 'var(--line-2)' }} />
                  not flowing
                </span>
                <span className="inline-flex items-center gap-1.5">
                  <span aria-hidden="true" className="inline-block h-0.5 w-5" style={{ backgroundColor: 'var(--muted)' }} />
                  flowing
                </span>
                {sheet.edges.some((e) => e.recycle) && (
                  <span className="inline-flex items-center gap-1.5">
                    <span aria-hidden="true" className="inline-block w-5 border-t border-dashed" style={{ borderColor: 'var(--muted)' }} />
                    recycle
                  </span>
                )}
              </p>
              {failure !== null && <p className="mt-1 text-alarm" role="alert">{failure}</p>}
            </section>
            <Analytics sheet={sheet} world={world} snap={snap} hist={hist} width={width - WINDOW_CHROME} />
          </>
        )}
      </div>
    </DraggableWindow>
  );
}
