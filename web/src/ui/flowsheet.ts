// A site's process flow diagram as data: which tanks and units there are,
// which stream joins which, and where each block sits. Pure — no React, no
// DOM — so the layout and every number on the diagram are unit-tested.
//
// The diagram is built from the flowsheet data the engine puts in the world
// JSON (per unit: its in and out streams at design rate). A "material" stream
// joins a unit and a tank; an "internal" stream joins two units of one
// process by key; utilities are notes on the unit. Processes that share a
// tank (the refinery's four, through heavy naphtha, gasoil and VGO) therefore
// come out as one connected diagram. A tank a process both draws from and
// returns to (the flex cracker's LPG) appears twice, once as a feed and once
// as a product, so the diagram always reads left to right.
//
// Layout is layered: every block sits one column to the right of the last
// thing that feeds it; within a column blocks are ordered to keep streams
// short. Sizes are in CSS pixels.

import type { Snapshot } from '../engine/snapshot';
import type { ProcessSpec, StreamSpec, UnitSpec, WorldSpec } from '../engine/world';
import { materialTitle } from './materials';

export const UNIT_W = 150;
export const TANK_W = 104;
export const TANK_H = 50;
/** Extra height of a tank that buys by vehicle: room for its "Supply options" link. */
export const TANK_LINK_H = 13;
/** Room between columns, where the stream labels (name and t/h) sit: as wide as its longest label needs, within these limits. */
export const COL_GAP_MIN = 56;
export const COL_GAP_MAX = 150;
/** Width of one character of a stream label (10 px mono), and the room a label needs around it. */
export const LABEL_CHAR_PX = 6.1;
const LABEL_PAD_PX = 44;
const ROW_GAP = 16;
/** A lane is the slot a long stream takes through a column it passes: its height, and the room between two lanes. */
const LANE_H = 2;
const LANE_GAP = 9;
const PAD = 14;
/** Vertical room one stream port needs on a unit's side. */
const PORT_PITCH = 16;

export interface FlowNote {
  /** what it is: a utility stream key, "heat" or "power" */
  key: string;
  /** value at design rate */
  value: number;
  unit: 't/h' | 'GJ/h' | 'MW';
  dir: 'in' | 'out' | 'duty';
}

interface Box {
  layer: number;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface FlowTankNode extends Box {
  kind: 'tank';
  id: string;
  /** index into WorldSpec.tanks (and the snapshot's tank slots) */
  tank: number;
  material: string;
  /** where it stands in this site's flow: fed from outside, made and used here, or shipped out */
  role: 'feed' | 'mid' | 'product';
  /** design t/h this site's units put into it, and take out of it */
  inTph: number;
  outTph: number;
  /** global process index behind each of those flows, for live scaling */
  inBy: { proc: number; tph: number }[];
  outBy: { proc: number; tph: number }[];
  /**
   * This site buys the material in by vehicle: it is a feed here and no
   * pipeline delivers it. Such a tank is where "who else can supply me" matters.
   */
  buys: boolean;
}

export interface FlowUnitNode extends Box {
  kind: 'unit';
  id: string;
  unit: UnitSpec;
  process: ProcessSpec;
  /** global indices into the snapshot's process and unit arrays */
  procIndex: number;
  unitIndex: number;
  /** everything the unit takes in at design, t/h — what its capacity is quoted against */
  inletTph: number;
  notes: FlowNote[];
}

export type FlowNode = FlowTankNode | FlowUnitNode;

export interface FlowEdge {
  id: string;
  from: string;
  to: string;
  /** stream name: a material key, or an internal stream's key */
  key: string;
  /** t/h at design rate */
  tph: number;
  /** process whose rate scales it */
  procIndex: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** which end the label sits at — always beside a unit */
  labelAt: 'from' | 'to';
  /** a recycle: it runs from a later unit back to an earlier one, against the flow */
  recycle: boolean;
  /**
   * Straight run (px) the line makes beside its label before it starts to
   * bend, so the label sits on a level stretch of its own line.
   */
  run: number;
  /**
   * The columns it passes on the way, each as a level stretch from x0 to x1
   * at height y — a lane between the blocks of that column, so a long stream
   * goes past them in the open rather than behind them.
   */
  via: { x0: number; x1: number; y: number }[];
}

export interface Flowsheet {
  nodes: FlowNode[];
  edges: FlowEdge[];
  width: number;
  height: number;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

function unitNotes(unit: UnitSpec): FlowNote[] {
  const notes: FlowNote[] = [];
  const untanked = (s: StreamSpec) => s.kind === 'utility' || (s.kind === 'material' && s.tank === null);
  for (const s of unit.in ?? []) if (untanked(s)) notes.push({ key: s.key, value: s.tph, unit: 't/h', dir: 'in' });
  for (const s of unit.out ?? []) if (untanked(s)) notes.push({ key: s.key, value: s.tph, unit: 't/h', dir: 'out' });
  if ((unit.heatGjH ?? 0) > 0) notes.push({ key: 'heat', value: unit.heatGjH ?? 0, unit: 'GJ/h', dir: 'duty' });
  if ((unit.powerMw ?? 0) > 0) notes.push({ key: 'power', value: unit.powerMw ?? 0, unit: 'MW', dir: 'duty' });
  return notes;
}

/** Height a unit block needs: its text, its notes, and room for its ports. */
export function unitHeight(notes: number, portsIn: number, portsOut: number): number {
  const text = 74 + notes * 12 + 34; // key and a name of up to two lines, trains and load, notes, the Fail unit button
  const ports = (Math.max(portsIn, portsOut) + 1) * PORT_PITCH;
  return Math.max(text, ports);
}

/**
 * Build the diagram for one site, laid out. Null when the world carries no
 * flowsheet data for it (the in-page stub, or an older engine).
 */
export function buildFlowsheet(world: WorldSpec, siteIdx: number): Flowsheet | null {
  const site = world.sites[siteIdx];
  if (site === undefined) return null;

  // ---- units and raw stream links ----
  const units: FlowUnitNode[] = [];
  const links: { from: string; to: string; key: string; tph: number; proc: number }[] = [];
  for (const process of site.processes) {
    if (process.index === undefined) continue;
    for (const st of [...(process.in ?? []), ...(process.out ?? []), ...process.units.flatMap((u) => [...(u.in ?? []), ...(u.out ?? [])])]) {
      if (typeof st.name === 'string' && st.name !== '') STREAM_NAMES.set(st.key, st.name);
    }
    const makes = new Map<string, { id: string; tph: number }[]>();
    const takes = new Map<string, { id: string; tph: number }[]>();
    for (const unit of process.units) {
      if (unit.index === undefined || unit.in === undefined || unit.out === undefined) continue;
      const id = `u${unit.index}`;
      units.push({
        kind: 'unit', id, unit, process, procIndex: process.index, unitIndex: unit.index,
        // what goes through it: what it takes in, or for a source (a well, a mine), which takes nothing in, what it makes
        inletTph: unit.in.length > 0 ? sum(unit.in.map((s) => s.tph)) : sum(unit.out.map((s) => s.tph)), notes: unitNotes(unit),
        layer: 0, x: 0, y: 0, w: UNIT_W, h: 0,
      });
      for (const s of unit.in) {
        if (s.kind === 'material' && s.tank !== null) links.push({ from: `t${s.tank}`, to: id, key: s.key, tph: s.tph, proc: process.index });
        else if (s.kind === 'internal') takes.set(s.key, [...(takes.get(s.key) ?? []), { id, tph: s.tph }]);
      }
      for (const s of unit.out) {
        if (s.kind === 'material' && s.tank !== null) links.push({ from: id, to: `t${s.tank}`, key: s.key, tph: s.tph, proc: process.index });
        else if (s.kind === 'internal') makes.set(s.key, [...(makes.get(s.key) ?? []), { id, tph: s.tph }]);
      }
    }
    // an internal stream joins every unit that makes it to every unit that takes it
    for (const [key, makers] of makes) {
      for (const maker of makers) {
        const takers = takes.get(key) ?? [];
        for (const taker of takers) {
          links.push({ from: maker.id, to: taker.id, key, tph: takers.length > 1 ? taker.tph : maker.tph, proc: process.index });
        }
      }
    }
  }
  if (units.length === 0) return null;

  // ---- tanks: split one that a process both draws from and returns to ----
  const next = new Map<string, string[]>();
  for (const l of links) next.set(l.from, [...(next.get(l.from) ?? []), l.to]);
  const reaches = (start: string, goals: Set<string>, without: string): boolean => {
    const seen = new Set<string>([without]);
    const queue = [start];
    while (queue.length > 0) {
      const at = queue.pop() as string;
      if (goals.has(at)) return true;
      if (seen.has(at)) continue;
      seen.add(at);
      queue.push(...(next.get(at) ?? []));
    }
    return false;
  };
  const tankIds = [...new Set(links.flatMap((l) => [l.from, l.to]).filter((id) => id.startsWith('t')))];
  const tanks: FlowTankNode[] = [];
  for (const id of tankIds.sort((a, b) => Number(a.slice(1)) - Number(b.slice(1)))) {
    const tank = Number(id.slice(1));
    const spec = world.tanks[tank];
    const into = links.filter((l) => l.to === id);
    const outOf = links.filter((l) => l.from === id);
    const makers = new Set(into.map((l) => l.from));
    const loops = into.length > 0 && outOf.length > 0 && outOf.some((l) => reaches(l.to, makers, id));
    const piped = world.pipelines.some((p) => p.toSite === siteIdx && p.material === spec?.material);
    const node = (nodeId: string, role: FlowTankNode['role'], ins: typeof into, outs: typeof outOf): FlowTankNode => {
      const buys = role === 'feed' && !piped;
      return {
        kind: 'tank', id: nodeId, tank, material: spec?.material ?? '?', role, buys,
        inTph: sum(ins.map((l) => l.tph)), outTph: sum(outs.map((l) => l.tph)),
        inBy: ins.map((l) => ({ proc: l.proc, tph: l.tph })), outBy: outs.map((l) => ({ proc: l.proc, tph: l.tph })),
        layer: 0, x: 0, y: 0, w: TANK_W, h: buys ? TANK_H + TANK_LINK_H : TANK_H,
      };
    };
    if (loops) {
      // the same tank, drawn at both ends of the process; each copy carries the tank's whole balance
      tanks.push(node(`${id}f`, 'feed', into, outOf), node(`${id}p`, 'product', into, outOf));
      for (const l of links) {
        if (l.from === id) l.from = `${id}f`;
        if (l.to === id) l.to = `${id}p`;
      }
    } else {
      tanks.push(node(id, into.length === 0 ? 'feed' : outOf.length === 0 ? 'product' : 'mid', into, outOf));
    }
  }
  const nodes: FlowNode[] = [...tanks, ...units];
  const byId = new Map(nodes.map((nd) => [nd.id, nd]));

  // ---- recycles: a stream from a later unit back to an earlier one (an
  // internal recycle loop) runs against the flow; find those first, so the
  // rest is a plain left-to-right graph ----
  const recycle = new Set<number>();
  {
    const out = new Map<string, number[]>();
    links.forEach((l, i) => out.set(l.from, [...(out.get(l.from) ?? []), i]));
    const state = new Map<string, 'open' | 'done'>();
    const walk = (id: string): void => {
      state.set(id, 'open');
      for (const i of out.get(id) ?? []) {
        const to = links[i].to;
        if (state.get(to) === 'open') recycle.add(i); // closes a loop
        else if (state.get(to) === undefined) walk(to);
      }
      state.set(id, 'done');
    };
    // start from what nothing feeds (feed tanks, source units), then anything left
    const fed = new Set(links.map((l) => l.to));
    for (const nd of nodes) if (!fed.has(nd.id) && state.get(nd.id) === undefined) walk(nd.id);
    for (const nd of nodes) if (state.get(nd.id) === undefined) walk(nd.id);
  }

  // ---- layers: one column right of the last thing that feeds a block ----
  const preds = new Map<string, string[]>();
  const succs = new Map<string, string[]>();
  links.forEach((l, i) => {
    if (recycle.has(i)) return;
    preds.set(l.to, [...(preds.get(l.to) ?? []), l.from]);
    succs.set(l.from, [...(succs.get(l.from) ?? []), l.to]);
  });
  const depth = new Map<string, number>();
  const layerOf = (id: string): number => {
    const known = depth.get(id);
    if (known !== undefined) return known;
    const d = Math.max(-1, ...(preds.get(id) ?? []).map(layerOf)) + 1;
    depth.set(id, d);
    return d;
  };
  for (const nd of nodes) nd.layer = layerOf(nd.id);
  // a feed tank sits just left of the first unit that draws from it
  for (const t of tanks) {
    if (t.role !== 'feed') continue;
    const users = (succs.get(t.id) ?? []).map((id) => byId.get(id)?.layer ?? 1);
    t.layer = Math.max(0, Math.min(...users) - 1);
  }
  const nLayers = Math.max(...nodes.map((nd) => nd.layer)) + 1;

  // ---- lanes: a stream that skips columns gets a lane through each column
  // it passes, a slot of its own between the blocks there, so it runs past
  // them in the open instead of behind them ----
  interface Lane extends Box { kind: 'lane'; id: string; link: number }
  type Slot = FlowNode | Lane;
  const lanes: Lane[] = [];
  const lanesOf = new Map<number, Lane[]>();
  links.forEach((l, i) => {
    if (recycle.has(i)) return;
    const a = byId.get(l.from) as FlowNode;
    const b = byId.get(l.to) as FlowNode;
    const mine: Lane[] = [];
    for (let layer = a.layer + 1; layer < b.layer; layer++) {
      mine.push({ kind: 'lane', id: `v${i}_${layer}`, link: i, layer, x: 0, y: 0, w: 0, h: LANE_H });
    }
    if (mine.length > 0) {
      lanes.push(...mine);
      lanesOf.set(i, mine);
    }
  });
  // neighbours for ordering: each stream as a chain through its lanes
  const before = new Map<string, string[]>();
  const after = new Map<string, string[]>();
  links.forEach((l, i) => {
    if (recycle.has(i)) return;
    const chain = [l.from, ...(lanesOf.get(i) ?? []).map((v) => v.id), l.to];
    for (let k = 1; k < chain.length; k++) {
      before.set(chain[k], [...(before.get(chain[k]) ?? []), chain[k - 1]]);
      after.set(chain[k - 1], [...(after.get(chain[k - 1]) ?? []), chain[k]]);
    }
  });

  // ---- order within columns: a few barycentre sweeps keep streams short ----
  const columns: Slot[][] = Array.from({ length: nLayers }, () => []);
  for (const nd of nodes) columns[nd.layer].push(nd);
  for (const v of lanes) columns[v.layer].push(v);
  const rank = new Map<string, number>();
  const rerank = () => columns.forEach((col) => col.forEach((nd, i) => rank.set(nd.id, i / Math.max(1, col.length - 1) || 0)));
  rerank();
  const centre = (id: string, around: Map<string, string[]>): number | null => {
    const others = around.get(id) ?? [];
    return others.length === 0 ? null : sum(others.map((o) => rank.get(o) ?? 0)) / others.length;
  };
  for (let sweep = 0; sweep < 8; sweep++) {
    const around = sweep % 2 === 0 ? before : after;
    const order = sweep % 2 === 0 ? columns : [...columns].reverse();
    for (const col of order) {
      const key = new Map(col.map((nd, i) => [nd.id, centre(nd.id, around) ?? rank.get(nd.id) ?? i]));
      col.sort((a, b) => (key.get(a.id) as number) - (key.get(b.id) as number));
      rerank();
    }
  }

  // ---- sizes and positions ----
  for (const u of units) {
    u.h = unitHeight(u.notes.length, links.filter((l) => l.to === u.id).length, links.filter((l) => l.from === u.id).length);
  }
  // two lanes side by side need less room between them than two blocks
  const gapAfter = (a: Slot, b: Slot) => (a.kind === 'lane' && b.kind === 'lane' ? LANE_GAP : ROW_GAP);
  const colHeight = (col: Slot[]) => sum(col.map((nd, k) => nd.h + (k > 0 ? gapAfter(col[k - 1], nd) : 0)));
  const tallest = Math.max(...columns.map(colHeight));
  // each gap is as wide as the longest label written in it: a stream's label
  // sits beside its unit, to the right of the unit it leaves or to the left
  // of the unit it enters
  const gaps = new Array<number>(Math.max(0, nLayers - 1)).fill(COL_GAP_MIN);
  links.forEach((l, i) => {
    const a = byId.get(l.from) as FlowNode;
    const b = byId.get(l.to) as FlowNode;
    const gap = a.kind === 'unit' ? a.layer : b.layer - 1;
    if (gap < 0 || gap >= gaps.length) return; // a recycle's label hangs off the last column
    const chars = `${streamLabel(l.key)} ${fmtTph(l.tph)}`.length + (recycle.has(i) ? 2 : 0);
    gaps[gap] = Math.min(COL_GAP_MAX, Math.max(gaps[gap], chars * LABEL_CHAR_PX + LABEL_PAD_PX));
  });
  let x = PAD;
  columns.forEach((col, c) => {
    const w = Math.max(...col.map((nd) => nd.w));
    let y = PAD + (tallest - colHeight(col)) / 2;
    col.forEach((nd, k) => {
      if (k > 0) y += gapAfter(col[k - 1], nd);
      if (nd.kind === 'lane') {
        nd.x = x; // a lane spans its column
        nd.w = w;
      } else {
        nd.x = x + (w - nd.w) / 2;
      }
      nd.y = y;
      y += nd.h;
    });
    x += w + (gaps[c] ?? 0);
  });
  const width = x + PAD;
  const height = tallest + 2 * PAD + (recycle.size > 0 ? 26 : 0);

  // ---- stream geometry: ports spread down a unit's sides, one port per tank side ----
  const midY = (nd: Slot) => nd.y + nd.h / 2;
  // where a stream goes next from a block: its first lane if it has one, else the block at its other end
  const towards = (i: number, side: 'in' | 'out'): number => {
    const mine = lanesOf.get(i);
    if (mine !== undefined) return midY(side === 'out' ? mine[0] : mine[mine.length - 1]);
    return midY(byId.get(side === 'out' ? links[i].to : links[i].from) as FlowNode);
  };
  const portY = (nd: FlowNode, side: 'in' | 'out', link: number): number => {
    if (nd.kind === 'tank') return midY(nd);
    const mine = links
      .map((l, i) => ({ l, i }))
      .filter(({ l }) => (side === 'in' ? l.to === nd.id : l.from === nd.id))
      .sort((a, b) => towards(a.i, side) - towards(b.i, side) || a.l.key.localeCompare(b.l.key));
    const at = mine.findIndex((m) => m.i === link);
    return nd.y + (nd.h * (at + 1)) / (mine.length + 1);
  };
  const edges: FlowEdge[] = links.map((l, i) => {
    const a = byId.get(l.from) as FlowNode;
    const b = byId.get(l.to) as FlowNode;
    return {
      id: `e${i}`, from: l.from, to: l.to, key: l.key, tph: l.tph, procIndex: l.proc,
      x1: a.x + a.w, y1: portY(a, 'out', i), x2: b.x, y2: portY(b, 'in', i),
      labelAt: a.kind === 'unit' ? 'from' : 'to',
      recycle: recycle.has(i),
      run: labelWidth(l.key, l.tph) + 10,
      via: (lanesOf.get(i) ?? []).map((v) => ({ x0: v.x, x1: v.x + v.w, y: midY(v) })),
    };
  });

  return { nodes, edges, width, height };
}

/** Pixel width of a stream's label ("Heavy naphtha 41.8") in the diagram's 10 px mono. */
export function labelWidth(key: string, tph: number): number {
  return `${streamLabel(key)} ${fmtTph(tph)}`.length * LABEL_CHAR_PX;
}

/** Every stream leaves its source and enters its target level for at least this far (px). */
export const STRAIGHT = 14;
/** Least room (px) a bend is given between two level stretches. */
const MIN_BEND = 16;

/**
 * A connector between two ports, as SVG path data. Every bend is finished
 * before the line reaches anything: it leaves its source level and enters
 * its target level for at least STRAIGHT px, so an arrowhead is always
 * horizontal and sits flush on the edge it points at. Beside its label (at
 * the end the label sits at) the level stretch is as long as the label;
 * through each column it passes (`via`) it is level across the column; the
 * bends happen in the gaps between. A recycle leaves to the right, swings
 * under the blocks (to `under`, a y below them) and comes back into its
 * target from the left, level at both ends like any other stream.
 */
export function edgePath(
  e: Pick<FlowEdge, 'x1' | 'y1' | 'x2' | 'y2'> & Partial<Pick<FlowEdge, 'recycle' | 'run' | 'labelAt' | 'via'>>,
  under = 0,
): string {
  if (e.recycle === true) {
    const y = Math.max(under, e.y1, e.y2) + 18;
    const out = e.x1 + STRAIGHT;
    const into = e.x2 - STRAIGHT;
    return `M${e.x1} ${e.y1}L${out} ${e.y1}C${out + 34} ${e.y1} ${out + 34} ${y} ${out - 12} ${y}`
      + `L${into + 12} ${y}C${into - 34} ${y} ${into - 34} ${e.y2} ${into} ${e.y2}L${e.x2} ${e.y2}`;
  }
  const via = e.via ?? [];
  const run = e.run ?? 0;
  const bend = (ax: number, ay: number, bx: number, by: number) => {
    const dx = Math.max(12, (bx - ax) / 2);
    return `C${ax + dx} ${ay} ${bx - dx} ${by} ${bx} ${by}`;
  };
  // level out of the source: the label's length when the label sits here, never less than STRAIGHT
  let a = e.x1 + Math.max(STRAIGHT, e.labelAt === 'from' ? run : 0);
  // level into the target: likewise
  let b = e.x2 - Math.max(STRAIGHT, e.labelAt === 'to' ? run : 0);
  // a long label gives way before a bend is squeezed out; the STRAIGHT stretches never do
  const firstStop = via.length > 0 ? via[0].x0 : b;
  const lastStart = via.length > 0 ? via[via.length - 1].x1 : a;
  a = Math.max(e.x1 + STRAIGHT, Math.min(a, firstStop - MIN_BEND));
  b = Math.min(e.x2 - STRAIGHT, Math.max(b, (via.length > 0 ? lastStart : a) + MIN_BEND));

  let d = `M${e.x1} ${e.y1}L${a} ${e.y1}`;
  let cx = a;
  let cy = e.y1;
  for (const v of via) {
    d += `${bend(cx, cy, v.x0, v.y)}L${v.x1} ${v.y}`;
    cx = v.x1;
    cy = v.y;
  }
  return `${d}${bend(cx, cy, b, e.y2)}L${e.x2} ${e.y2}`;
}

// ---------------------------------------------------------------- live values

/** A process's rate as a share of its design rate, from the snapshot. */
export function rateOf(snap: Snapshot, procIndex: number): number {
  return snap.procRate[procIndex] ?? 0;
}

/** Engine ProcStatus values at which a process is not producing. */
export function isDown(status: number | undefined): boolean {
  return status === 2 || status === 3; // shut down, restarting
}

export interface UnitLive {
  trainsOnline: number;
  trains: number;
  /** what it is taking in now, t/h */
  inletTph: number;
  /** capacity of the trains that are online, t/h */
  capacityTph: number;
  /** inlet over online capacity, 0..1+ ; 0 when nothing is online */
  load: number;
  /** throughput as a share of design, 0..1: a unit at design reads 100% (its trains carry some spare above that) */
  ofDesign: number;
  /** trains are down, or its process is shut or restarting */
  alarm: boolean;
  rate: number;
}

export function unitLive(snap: Snapshot, node: FlowUnitNode): UnitLive {
  const trains = node.unit.trains;
  const trainsOnline = Math.min(trains, snap.unitTrains[node.unitIndex] ?? trains);
  const rate = rateOf(snap, node.procIndex);
  const inletTph = node.inletTph * rate;
  const capacityTph = (node.unit.capPerTrainTph ?? 0) * trainsOnline;
  return {
    trainsOnline, trains, inletTph, capacityTph, rate,
    load: capacityTph > 0 ? inletTph / capacityTph : 0,
    ofDesign: trainsOnline > 0 ? rate : 0,
    alarm: trainsOnline < trains || isDown(snap.procStatus[node.procIndex]),
  };
}

export interface TankLive {
  /** level over capacity, 0..1 */
  fill: number;
  /** t/h going in and coming out right now through this site's units */
  inTph: number;
  outTph: number;
  /** hours until empty at the current draw (feed side); null when nothing draws */
  coverH: number | null;
  /** hours until full at the current make (product side); null when nothing fills */
  roomH: number | null;
}

export function tankLive(world: WorldSpec, snap: Snapshot, node: FlowTankNode): TankLive {
  const cap = world.tanks[node.tank]?.capacityT ?? 0;
  const fill = snap.tanks[4 * node.tank] ?? 0;
  const inTph = sum(node.inBy.map((f) => f.tph * rateOf(snap, f.proc)));
  const outTph = sum(node.outBy.map((f) => f.tph * rateOf(snap, f.proc)));
  return {
    fill, inTph, outTph,
    coverH: outTph > 1e-9 ? (fill * cap) / outTph : null,
    roomH: inTph > 1e-9 ? ((1 - fill) * cap) / inTph : null,
  };
}

/** A material or stream key as a label: "Heavy naphtha", "LPG", "Polyethylene", "brine". */
export function streamLabel(key: string): string {
  const given = STREAM_NAMES.get(key);
  if (given !== undefined) return given.charAt(0).toUpperCase() + given.slice(1);
  if (key !== key.toUpperCase()) {
    // an internal stream: lower case in the engine, tidied here
    const tidy = INTERNAL_NAMES[key] ?? key.replace(/_/g, ' ');
    return tidy.charAt(0).toUpperCase() + tidy.slice(1);
  }
  return materialTitle(key);
}

/** Plain names the world JSON gives its streams (`name`), by stream key; filled as flowsheets are built. */
const STREAM_NAMES = new Map<string, string>();

/** Internal stream keys that are abbreviations, spelled out for when the engine gives no name. */
const INTERNAL_NAMES: Record<string, string> = {
  edc: 'EDC',
  hcl: 'hydrogen chloride',
  eb: 'ethylbenzene',
  wet_cl2: 'wet chlorine',
  ygrade: 'Y-grade',
  resid: 'residue',
  pygas: 'pyrolysis gasoline',
};

/** Tonnes per hour for a label: one decimal under 100, none above. */
export function fmtTph(tph: number): string {
  if (!Number.isFinite(tph)) return '—';
  return tph >= 100 ? Math.round(tph).toLocaleString('en-US') : (Math.round(tph * 10) / 10).toFixed(1);
}

/** Hours as "5 h" or "3.2 d". */
export function fmtHours(hours: number | null): string {
  if (hours === null || !Number.isFinite(hours)) return '—';
  if (hours < 48) return `${Math.round(hours)} h`;
  const days = hours / 24;
  return `${days >= 100 ? Math.round(days) : (Math.round(days * 10) / 10).toFixed(1)} d`;
}
