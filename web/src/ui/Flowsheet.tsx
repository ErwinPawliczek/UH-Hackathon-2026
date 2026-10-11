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
  const loadPct = Math.round(live.load * 100);
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
      data-alarm={live.alarm ? 'true' : undefined}
    >
      <div className="flex items-baseline justify-between gap-1">
        <span className="whitespace-nowrap font-mono text-[11px] font-semibold leading-tight text-ink">{node.unit.key}</span>
        <span className="whitespace-nowrap font-mono text-[10px] leading-tight tabular-nums" style={{ color: live.trainsOnline < live.trains ? 'var(--alarm)' : 'var(--muted)' }}>
          {live.trainsOnline}/{live.trains} {live.trains === 1 ? 'train' : 'trains'}
        </span>
      </div>
      <div className="truncate text-[10px] leading-tight text-muted">{node.unit.name}</div>
      <div className="mt-1 flex items-center gap-1.5" title={`Taking ${fmtTph(live.inletTph)} t/h of the ${fmtTph(live.capacityTph)} t/h its online trains can take`}>
        <div className="h-1.5 flex-1 overflow-hidden rounded-sm bg-line-2">
          <div className="h-full" style={{ width: `${Math.min(100, loadPct)}%`, backgroundColor: live.alarm ? 'var(--alarm)' : 'var(--blue)' }} />
        </div>
        <span className="font-mono text-[10px] leading-none tabular-nums text-ink">{live.capacityTph > 0 ? `${loadPct}%` : 'down'}</span>
      </div>
      {node.notes.map((n) => (
        <div key={`${n.dir}-${n.key}`} className="truncate text-[10px] leading-[12px] text-muted">{noteText(n, live.rate)}</div>
      ))}
      {onAskFail !== null && (
        <button
          type="button"
          className="mt-auto self-start text-[10px] font-medium text-blue underline decoration-dotted underline-offset-2 hover:text-blue-strong"
          onClick={onAskFail}
          data-testid={`pfd-fail-${node.unit.key}`}
        >
          Fail unit…
        </button>
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
  const [trains, setTrains] = useState(max);
  const [hours, setHours] = useState(24);
  return (
    <div
      className="chamfer chamfer-sm absolute z-10 flex items-center gap-1.5 px-2 py-1.5 text-[11px]"
      style={{ left: node.x, top: node.y + node.h + 4, ...css({ '--chamfer-fill': 'var(--white)', '--chamfer-line': 'var(--ink)' }) }}
      data-testid={`pfd-fail-form-${node.unit.key}`}
    >
      <span className="text-muted">Take down</span>
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
      <input
        id={`fail-hours-${node.unitIndex}`}
        name="fail-hours"
        type="number"
        min={1}
        value={hours}
        onChange={(e) => setHours(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
        className="field w-14 px-1 py-0.5"
        aria-label={`Hours ${node.unit.key} stays down`}
      />
      <span className="text-muted">h</span>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => onFail(trains, hours)} data-testid={`pfd-fail-confirm-${node.unit.key}`}>
        Fail unit
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
  /** take `trains` trains of a unit down for `hours`; null when the run cannot be commanded */
  onFailUnit: ((unitKey: string, trains: number, hours: number) => void) | null;
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
    <div className="relative" style={{ width: sheet.width, height: sheet.height + (failingNode !== undefined ? 44 : 0) }} data-testid="pfd">
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

      {failingNode !== undefined && onFailUnit !== null && (
        <FailForm
          key={failingNode.id}
          node={failingNode}
          onCancel={() => setFailing(null)}
          onFail={(trains, hours) => {
            onFailUnit(failingNode.unit.key, trains, hours);
            setFailing(null);
          }}
        />
      )}
    </div>
  );
}
