// The process flow diagram of one site, drawn from the layout in
// flowsheet.ts: tanks and units as blocks, streams as lines between them,
// every number live. Blocks are HTML laid over an SVG of the streams, so text
// stays crisp and the "Fail unit" control on a unit block is a real control.
//
// What each part shows:
//   stream — its name and t/h right now (design t/h × its process's rate);
//   unit   — key and name, trains online of total, a bar of its load against
//            the capacity of the trains online, its utilities, heat and
//            power as small notes; red when trains are down or its process
//            is shut or restarting;
//   tank   — material, fill, and days of cover (feed side) or of room
//            (product side).

import { useState } from 'react';
import type { Snapshot } from '../engine/snapshot';
import type { WorldSpec } from '../engine/world';
import {
  LABEL_CHAR_PX, edgePath, fmtHours, fmtTph, rateOf, streamLabel, tankLive, unitLive,
  type FlowNote, type FlowTankNode, type FlowUnitNode, type Flowsheet,
} from './flowsheet';
import { materialName } from './materials';

const css = (vars: Record<string, string | number>) => vars as React.CSSProperties;

function noteText(n: FlowNote, rate: number): string {
  const v = n.value * rate;
  const value = v >= 100 ? Math.round(v).toString() : (Math.round(v * 10) / 10).toString();
  if (n.dir === 'duty') return `${n.key} ${value} ${n.unit}`;
  return `${n.dir === 'in' ? '+' : '→'} ${materialName(n.key)} ${value} ${n.unit}`;
}

function TankBlock({
  node, world, snap, onSupplyOptions,
}: {
  node: FlowTankNode;
  world: WorldSpec;
  snap: Snapshot;
  onSupplyOptions: ((tank: number) => void) | null;
}) {
  const live = tankLive(world, snap, node);
  const low = node.role !== 'product' && live.fill < 0.1;
  const full = node.role !== 'feed' && live.fill > 0.95;
  // the side that matters: how long the feed lasts, how long until a product tank is full
  const line = node.role === 'product'
    ? (live.roomH === null ? 'not filling' : `room ${fmtHours(live.roomH)}`)
    : (live.coverH === null ? 'not drawn' : `cover ${fmtHours(live.coverH)}`);
  return (
    <div
      className="chamfer absolute px-2 py-1"
      style={{
        left: node.x, top: node.y, width: node.w, height: node.h,
        ...css({ '--cut': '5px', '--chamfer-fill': 'var(--white)', '--chamfer-line': low || full ? 'var(--alarm)' : 'var(--line-2)' }),
      }}
      title={`${streamLabel(node.material)} tank — ${Math.round(live.fill * 100)}% full of ${Math.round(world.tanks[node.tank]?.capacityT ?? 0).toLocaleString('en-US')} t`}
      data-testid={`pfd-tank-${node.id}`}
    >
      <div className="truncate text-[11px] font-semibold leading-tight text-ink">{streamLabel(node.material)}</div>
      <div className="mt-0.5 flex items-center gap-1.5">
        <div className="h-1.5 flex-1 overflow-hidden rounded-sm bg-line">
          <div className="h-full" style={{ width: `${Math.min(100, live.fill * 100)}%`, backgroundColor: low || full ? 'var(--alarm)' : 'var(--blue)' }} />
        </div>
        <span className="font-mono text-[10px] leading-none tabular-nums text-ink">{Math.round(live.fill * 100)}%</span>
      </div>
      <div className="mt-0.5 text-[10px] leading-tight text-muted">{line}</div>
      {node.buys && onSupplyOptions !== null && (
        <button
          type="button"
          className="text-[10px] font-medium leading-tight text-blue underline decoration-dotted underline-offset-2 hover:text-blue-strong"
          onClick={() => onSupplyOptions(node.tank)}
          data-testid={`pfd-supply-${node.tank}`}
        >
          Supply options
        </button>
      )}
    </div>
  );
}

function UnitBlock({
  node, snap, onAskFail,
}: {
  node: FlowUnitNode;
  snap: Snapshot;
  onAskFail: (() => void) | null;
}) {
  const live = unitLive(snap, node);
  // against design: a plant running at design reads 100%, not its share of the spare capacity
  const loadPct = Math.round(live.ofDesign * 100);
  // a customer is not a plant unit: it is demand, said in plain words
  const demand = node.process.boundary === 'sink';
  const stopped = live.trainsOnline < live.trains;
  return (
    <div
      className="chamfer absolute flex flex-col px-2 py-1.5"
      style={{
        left: node.x, top: node.y, width: node.w, height: node.h,
        ...css({
          '--cut': '6px',
          '--chamfer-fill': live.alarm ? '#fbeceb' : 'var(--panel-2)',
          '--chamfer-line': live.alarm ? 'var(--alarm)' : 'var(--ink)',
        }),
      }}
      title={`${node.unit.name} — ${node.process.name}`}
      data-testid={`pfd-unit-${node.unit.key}`}
      // the key can repeat within a site (a fuel depot's four FD-OUT); the index never does
      data-unit-index={node.unitIndex}
      data-kind={demand ? 'demand' : 'unit'}
      data-alarm={live.alarm ? 'true' : undefined}
    >
      {demand ? (
        <>
          <div className="line-clamp-2 text-[11px] font-semibold leading-tight text-ink">{node.process.name}</div>
          <div className="text-[10px] leading-tight" style={{ color: stopped ? 'var(--alarm)' : 'var(--muted)' }}>
            {stopped ? 'stopped' : `taking ${fmtTph(live.inletTph)} t/h`}
          </div>
        </>
      ) : (
        <>
          <div className="flex items-baseline justify-between gap-1">
            <span className="whitespace-nowrap font-mono text-[11px] font-semibold leading-tight text-ink">{node.unit.key}</span>
            <span className="whitespace-nowrap font-mono text-[10px] leading-tight tabular-nums" style={{ color: stopped ? 'var(--alarm)' : 'var(--muted)' }}>
              {live.trainsOnline}/{live.trains} {live.trains === 1 ? 'train' : 'trains'}
            </span>
          </div>
          {/* a long name wraps to a second line rather than being cut */}
          <div className="line-clamp-2 text-[10px] leading-tight text-muted">{node.unit.name}</div>
        </>
      )}
      <div className="mt-1 flex items-center gap-1.5" title={`${fmtTph(live.inletTph)} t/h, ${loadPct}% of design; its online trains can take ${fmtTph(live.capacityTph)} t/h`}>
        <div className="h-1.5 flex-1 overflow-hidden rounded-sm bg-line-2">
          <div className="h-full" style={{ width: `${Math.min(100, loadPct)}%`, backgroundColor: live.alarm ? 'var(--alarm)' : 'var(--blue)' }} />
        </div>
        <span className="font-mono text-[10px] leading-none tabular-nums text-ink">{live.capacityTph > 0 ? `${loadPct}%` : 'down'}</span>
      </div>
      {!demand && node.notes.map((n) => (
        <div key={`${n.dir}-${n.key}`} className="truncate text-[10px] leading-[12px] text-muted">{noteText(n, live.rate)}</div>
      ))}
      {/* destructive, so red; a unit that already has trains down cannot be failed again */}
      {onAskFail !== null && (
        stopped ? (
          <button type="button" className="btn btn-sm mt-auto self-start" disabled data-testid={`pfd-fail-${node.unit.key}`}>
            {demand ? 'Stopped' : 'Failed'}
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-sm btn-danger mt-auto self-start"
            onClick={onAskFail}
            data-testid={`pfd-fail-${node.unit.key}`}
          >
            {demand ? 'Stop demand' : 'Fail unit'}
          </button>
        )
      )}
    </div>
  );
}

/** The small form that takes trains down on one unit for a number of hours. */
function FailForm({
  node, onFail, onCancel,
}: {
  node: FlowUnitNode;
  onFail: (trains: number, hours: number) => void;
  onCancel: () => void;
}) {
  const max = Math.max(1, node.unit.trains);
  const demand = node.process.boundary === 'sink';
  const [trains, setTrains] = useState(max);
  const [hours, setHours] = useState(24);
  return (
    // In the flow under the diagram and pinned to the left edge of what is
    // on screen, wrapping when the window is narrow: never cut off.
    <div
      className="chamfer chamfer-sm sticky left-0 mt-1 flex w-fit max-w-[560px] flex-wrap items-center gap-1.5 px-2 py-1.5 text-[11px]"
      style={css({ '--chamfer-fill': 'var(--white)', '--chamfer-line': 'var(--ink)' })}
      data-testid={`pfd-fail-form-${node.unit.key}`}
    >
      {demand ? (
        <span className="text-ink">Stop {node.process.name} for</span>
      ) : (
        <>
          <span className="text-ink">{node.unit.key}: take down</span>
          <input
            id={`fail-trains-${node.unitIndex}`}
            name="fail-trains"
            type="number"
            min={1}
            max={max}
            value={trains}
            onChange={(e) => setTrains(Math.min(max, Math.max(1, Number(e.target.value) || 1)))}
            className="field w-11 px-1 py-0.5"
            aria-label={`Trains to take down on ${node.unit.key}`}
          />
          <span className="text-muted">of {max} for</span>
        </>
      )}
      <input
        id={`fail-hours-${node.unitIndex}`}
        name="fail-hours"
        type="number"
        min={1}
        value={hours}
        onChange={(e) => setHours(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
        className="field w-14 px-1 py-0.5"
        aria-label={`Hours ${demand ? node.process.name : node.unit.key} stays down`}
      />
      <span className="text-muted">hours</span>
      <button type="button" className="btn btn-danger btn-sm" onClick={() => onFail(demand ? max : trains, hours)} data-testid={`pfd-fail-confirm-${node.unit.key}`}>
        {demand ? 'Stop demand' : 'Fail unit'}
      </button>
      <button type="button" className="btn btn-sm" onClick={onCancel}>Cancel</button>
    </div>
  );
}

export function FlowsheetView({
  sheet, world, snap, onFailUnit, onSupplyOptions = null,
}: {
  sheet: Flowsheet;
  world: WorldSpec;
  snap: Snapshot;
  /**
   * Take `trains` trains of a unit down for `hours`; null when the run
   * cannot be commanded. The unit is the block itself, not its key: a site
   * can have several units with the same key (a fuel depot's four "FD-OUT").
   */
  onFailUnit: ((unit: FlowUnitNode, trains: number, hours: number) => void) | null;
  /**
   * Open "who else can supply this tank" for a tank this site buys by
   * vehicle; the link is shown on those tanks only when this is given.
   */
  onSupplyOptions?: ((tank: number) => void) | null;
}) {
  const [failing, setFailing] = useState<string | null>(null);
  const failingNode = sheet.nodes.find((n): n is FlowUnitNode => n.kind === 'unit' && n.id === failing);
  // recycles swing under every block
  const under = Math.max(...sheet.nodes.map((n) => n.y + n.h));

  return (
    <div style={{ width: sheet.width }}>
    <div className="relative" style={{ width: sheet.width, height: sheet.height }} data-testid="pfd">
      <svg width={sheet.width} height={sheet.height} className="absolute left-0 top-0" aria-hidden="true">
        <defs>
          <marker id="pfd-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">
            <path d="M0 0.8L7 4L0 7.2z" fill="var(--muted)" />
          </marker>
        </defs>
        {sheet.edges.map((e) => {
          const live = e.tph * rateOf(snap, e.procIndex);
          const flowing = live > 1e-6;
          return (
            <path
              key={e.id}
              d={edgePath(e, under)}
              fill="none"
              stroke={flowing ? 'var(--muted)' : 'var(--line-2)'}
              strokeWidth={1.5}
              strokeDasharray={e.recycle ? '5 3' : undefined}
              markerEnd="url(#pfd-arrow)"
            />
          );
        })}
        {/* labels after every line, each beside the unit it leaves or enters, on a plate of the background so a crossing line cannot cut through it */}
        {sheet.edges.map((e) => {
          const live = e.tph * rateOf(snap, e.procIndex);
          const from = e.labelAt === 'from';
          const text = `${e.recycle ? '↺ ' : ''}${streamLabel(e.key)} ${fmtTph(live)}`;
          const w = text.length * LABEL_CHAR_PX + 4;
          const x = from ? e.x1 + 5 : e.x2 - 9;
          const y = (from ? e.y1 : e.y2) - 4;
          return (
            <g key={e.id}>
              <rect x={from ? x - 2 : x - w + 2} y={y - 9} width={w} height={11.5} fill="var(--panel)" />
              <text
                x={x}
                y={y}
                textAnchor={from ? 'start' : 'end'}
                fontSize={10}
                fontFamily="var(--f-mono)"
                fill={live > 1e-6 ? 'var(--ink)' : 'var(--dim)'}
                data-testid={`pfd-stream-${e.key}`}
              >
                {text}
              </text>
            </g>
          );
        })}
      </svg>

      {sheet.nodes.map((n) => (n.kind === 'tank'
        ? <TankBlock key={n.id} node={n} world={world} snap={snap} onSupplyOptions={onSupplyOptions} />
        : (
          <UnitBlock
            key={n.id}
            node={n}
            snap={snap}
            onAskFail={onFailUnit === null ? null : () => setFailing(failing === n.id ? null : n.id)}
          />
        )))}
    </div>

      {failingNode !== undefined && onFailUnit !== null && (
        <FailForm
          key={failingNode.id}
          node={failingNode}
          onCancel={() => setFailing(null)}
          onFail={(trains, hours) => {
            onFailUnit(failingNode, trains, hours);
            setFailing(null);
          }}
        />
      )}
    </div>
  );
}
