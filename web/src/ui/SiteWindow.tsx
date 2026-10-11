// The site window: click a plant and see what is going on inside it.
//
//   1. Header — the plant's icon, name and state in words.
//   2. Process flow diagram — tanks, units and the streams between them, with
//      live numbers on every one (Flowsheet.tsx); it scrolls sideways for a
//      big site and can be widened with the expand button.
//   3. Analytics, with a two-way switch:
//        Plant — the site as a whole: every material going in and coming out
//                in t/h, every tank's level, and the headline numbers now;
//        Units — inside the process: each unit's throughput, load against
//                the capacity of its trains, heat and power.
//      Pick a row to chart it over the chosen time window (24 h, 7 days, all).
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
import { FlowsheetView } from './Flowsheet';
import { SiteBadge } from './SiteIcon';
import {
  buildFlowsheet, fmtHours, fmtTph, streamLabel, unitLive, type FlowUnitNode, type Flowsheet,
} from './flowsheet';
import { presetLabel } from './siteIcons';
import {
  WINDOWS, headline, plantRows, since, unitRows, type AnalyticsRow, type Histories, type History,
} from './siteSeries';

export const SITE_WINDOW_ID = 'site';
const WIDTH = 640;
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
  rows, groups, chosen, onChoose, fromTick, unitsMode,
}: {
  rows: AnalyticsRow[];
  groups: { key: AnalyticsRow['group']; title: string }[];
  chosen: string | null;
  onChoose: (id: string) => void;
  fromTick: number;
  unitsMode: boolean;
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
                  className={`cursor-pointer border-t border-line hover:bg-panel-2 ${chosen === r.id ? 'bg-blue-soft' : ''}`}
                  onClick={() => onChoose(r.id)}
                  aria-selected={chosen === r.id}
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

function Analytics({ sheet, world, snap, hist }: { sheet: Flowsheet; world: WorldSpec; snap: Snapshot; hist: Histories }) {
  const [mode, setMode] = useState<'plant' | 'units'>('plant');
  const [windowKey, setWindowKey] = useState('7d');
  const [chosenPlant, setChosenPlant] = useState<string | null>(null);
  const [chosenUnit, setChosenUnit] = useState<string | null>(null);

  const now = Number(snap.tick);
  const span = WINDOWS.find((w) => w.key === windowKey)?.ticks ?? null;
  const fromTick = span === null ? 0 : Math.max(0, now - span);

  const rows = mode === 'plant' ? plantRows(sheet, world, snap, hist, streamLabel) : unitRows(sheet, snap, hist);
  const chosenId = mode === 'plant' ? chosenPlant : chosenUnit;
  const chosen = rows.find((r) => r.id === chosenId) ?? rows[0];
  const head = headline(sheet, world, snap);

  const series = chosen === undefined ? null : since(chosen.series, fromTick);
  const refs = chosen === undefined || chosen.unit === '%'
    ? []
    : [
      ...(chosen.design !== null ? [{ value: chosen.design, label: 'design' }] : []),
      ...(chosen.capacity !== undefined && chosen.capacity > 0 && Math.abs(chosen.capacity - (chosen.design ?? 0)) > 1e-6
        ? [{ value: chosen.capacity, label: 'capacity' }]
        : []),
    ];

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
        <div className="mb-3 flex gap-2" data-testid="site-headline">
          <Tile label="Throughput" value={`${Math.round(head.throughput * 100)}%`} note="of design, now" />
          <Tile label="Feed cover" value={fmtHours(head.feedCoverH)} note={head.feedTank === null ? 'nothing drawn' : `${streamLabel(head.feedTank)} runs out first`} />
          <Tile label="Product room" value={fmtHours(head.productRoomH)} note={head.productTank === null ? 'nothing made' : `${streamLabel(head.productTank)} fills first`} />
        </div>
      )}

      {chosen !== undefined && series !== null && (
        <div className="mb-3">
          <LineChart
            title={chartTitle(chosen)}
            unit={chosen.unit}
            width={WIDTH - 40}
            height={170}
            series={[{ label: chosen.label, values: series.values, x: series.ticks }]}
            refLines={refs}
            yMax={chosen.unit === '%' ? 100 : undefined}
            area
            format={(v) => (chosen.unit === '%' ? `${Math.round(v)}` : fmtTph(v))}
            testId="analytics-chart"
          />
        </div>
      )}

      <RowTable
        rows={rows}
        groups={mode === 'plant'
          ? [{ key: 'in', title: 'Going in' }, { key: 'out', title: 'Coming out' }, { key: 'level', title: 'Tank levels' }]
          : [{ key: 'unit', title: 'Units' }]}
        chosen={chosen?.id ?? null}
        onChoose={mode === 'plant' ? setChosenPlant : setChosenUnit}
        fromTick={fromTick}
        unitsMode={mode === 'units'}
      />
      <p className="mt-2 text-[11px] text-muted">
        {mode === 'plant'
          ? 'Each flow is the sum over the plant\'s processes of their rate times that stream\'s design t/h. Click a row to chart it.'
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

  const site = world === null || siteIdx === null ? undefined : world.sites[siteIdx];
  if (world === null || snap === null || siteIdx === null || site === undefined) return null;

  const state = stateWords(sheet, world, snap, siteIdx);
  const viewport = typeof window === 'undefined' ? 1366 : window.innerWidth;
  const width = wide && sheet !== null ? Math.max(WIDTH, Math.min(viewport - 32, sheet.width + 44)) : WIDTH;

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
      title={presetLabel(site.preset)}
      width={width}
      maxHeight="calc(100vh - 80px)"
      open
      onClose={() => select(null)}
      at={{ x: Math.max(16, viewport - WIDTH - 16), y: 64 }}
      actions={sheet !== null && sheet.width + 44 > WIDTH ? (
        <button type="button" className="btn" onClick={() => setWide(!wide)} aria-pressed={wide} data-testid="site-window-wide">
          {wide ? 'Narrow' : 'Widen'}
        </button>
      ) : undefined}
    >
      <div className="flex flex-col gap-3 p-3 text-xs" data-testid="site-window">
        <header className="flex items-center gap-2.5">
          <SiteBadge preset={site.preset} icon={22} down={snap.siteStatus[siteIdx] === 3} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate font-body text-base font-semibold leading-tight text-ink">{site.name}</h2>
            <p className="truncate" style={{ color: state.alarm ? 'var(--alarm)' : 'var(--muted)' }} data-testid="site-state">{state.text}</p>
          </div>
        </header>

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
                <div className="chamfer-body overflow-x-auto" data-testid="pfd-scroll">
                  {/* TODO(supply options): pass onSupplyOptions={(tank) => …} to open the Economy
                      window's "Supply options" tab on that tank, once its store call exists; the
                      link then appears on every tank this site buys by vehicle (FlowTankNode.buys). */}
                  <FlowsheetView sheet={sheet} world={world} snap={snap} onFailUnit={failUnit} />
                </div>
              </div>
              {failure !== null && <p className="mt-1 text-alarm" role="alert">{failure}</p>}
            </section>
            <Analytics sheet={sheet} world={world} snap={snap} hist={hist} />
          </>
        )}
      </div>
    </DraggableWindow>
  );
}
