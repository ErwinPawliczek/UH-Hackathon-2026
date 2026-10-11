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
  const text = 62 + notes * 12 + 26; // key and name, trains and load, notes, the fail control
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
    const makes = new Map<string, { id: string; tph: number }[]>();
    const takes = new Map<string, { id: string; tph: number }[]>();
    for (const unit of process.units) {
      if (unit.index === undefined || unit.in === undefined || unit.out === undefined) continue;
      const id = `u${unit.index}`;
      units.push({
        kind: 'unit', id, unit, process, procIndex: process.index, unitIndex: unit.index,
        inletTph: sum(unit.in.map((s) => s.tph)), notes: unitNotes(unit),
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

  // ---- order within columns: a few barycentre sweeps keep streams short ----
  const columns: FlowNode[][] = Array.from({ length: nLayers }, () => []);
  for (const nd of nodes) columns[nd.layer].push(nd);
  const rank = new Map<string, number>();
  const rerank = () => columns.forEach((col) => col.forEach((nd, i) => rank.set(nd.id, i / Math.max(1, col.length - 1) || 0)));
  rerank();
  const centre = (id: string, around: Map<string, string[]>): number | null => {
    const others = around.get(id) ?? [];
    return others.length === 0 ? null : sum(others.map((o) => rank.get(o) ?? 0)) / others.length;
  };
  for (let sweep = 0; sweep < 6; sweep++) {
    const around = sweep % 2 === 0 ? preds : succs;
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
  const colHeight = (col: FlowNode[]) => sum(col.map((nd) => nd.h)) + ROW_GAP * Math.max(0, col.length - 1);
  const tallest = Math.max(...columns.map(colHeight));
  // each gap is as wide as the longest label written in it: a stream's label
  // sits beside its unit, to the right of the unit it leaves or to the left
  // of the unit it enters
  const gaps = new Array<number>(Math.max(0, nLayers - 1)).fill(COL_GAP_MIN);
  for (const l of links) {
    const a = byId.get(l.from) as FlowNode;
    const b = byId.get(l.to) as FlowNode;
    const gap = a.kind === 'unit' ? a.layer : b.layer - 1;
    if (gap < 0 || gap >= gaps.length) continue; // a recycle's label hangs off the last column
    const chars = `${streamLabel(l.key)} ${fmtTph(l.tph)}`.length + (recycle.has(links.indexOf(l)) ? 2 : 0);
    gaps[gap] = Math.min(COL_GAP_MAX, Math.max(gaps[gap], chars * LABEL_CHAR_PX + LABEL_PAD_PX));
  }
  let x = PAD;
  columns.forEach((col, c) => {
    const w = Math.max(...col.map((nd) => nd.w));
    let y = PAD + (tallest - colHeight(col)) / 2;
    for (const nd of col) {
      nd.x = x + (w - nd.w) / 2;
      nd.y = y;
      y += nd.h + ROW_GAP;
    }
    x += w + (gaps[c] ?? 0);
  });
  const width = x + PAD;
  const height = tallest + 2 * PAD + (recycle.size > 0 ? 26 : 0);

  // ---- stream geometry: ports spread down a unit's sides, one port per tank side ----
  const midY = (nd: FlowNode) => nd.y + nd.h / 2;
  const portY = (nd: FlowNode, side: 'in' | 'out', other: string): number => {
    if (nd.kind === 'tank') return midY(nd);
    const mine = links
      .filter((l) => (side === 'in' ? l.to === nd.id : l.from === nd.id))
      .map((l) => ({ other: side === 'in' ? l.from : l.to, l }))
      .sort((a, b) => midY(byId.get(a.other) as FlowNode) - midY(byId.get(b.other) as FlowNode) || a.l.key.localeCompare(b.l.key));
    const i = mine.findIndex((m) => m.other === other);
    return nd.y + (nd.h * (i + 1)) / (mine.length + 1);
  };
  const edges: FlowEdge[] = links.map((l, i) => {
    const a = byId.get(l.from) as FlowNode;
    const b = byId.get(l.to) as FlowNode;
    return {
      id: `e${i}`, from: l.from, to: l.to, key: l.key, tph: l.tph, procIndex: l.proc,
      x1: a.x + a.w, y1: portY(a, 'out', l.to), x2: b.x, y2: portY(b, 'in', l.from),
      labelAt: a.kind === 'unit' ? 'from' : 'to',
      recycle: recycle.has(i),
      run: labelWidth(l.key, l.tph) + 10,
    };
  });

  return { nodes, edges, width, height };
}

/** Pixel width of a stream's label ("Heavy naphtha 41.8") in the diagram's 10 px mono. */
export function labelWidth(key: string, tph: number): number {
  return `${streamLabel(key)} ${fmtTph(tph)}`.length * LABEL_CHAR_PX;
}

/**
 * A smooth connector between two ports, as SVG path data: left to right for
 * an ordinary stream, level for `run` px beside its label (at the end the
 * label sits at) and curving the rest of the way; a recycle leaves to the
 * right, swings under the blocks (to `under`, a y below them) and comes back
 * into its target from the left.
 */
export function edgePath(
  e: Pick<FlowEdge, 'x1' | 'y1' | 'x2' | 'y2'> & { recycle?: boolean; run?: number; labelAt?: 'from' | 'to' },
  under = 0,
): string {
  if (e.recycle === true) {
    const y = Math.max(under, e.y1, e.y2) + 18;
    return `M${e.x1} ${e.y1}C${e.x1 + 46} ${e.y1} ${e.x1 + 46} ${y} ${e.x1 - 10} ${y}L${e.x2 + 10} ${y}C${e.x2 - 46} ${y} ${e.x2 - 46} ${e.y2} ${e.x2} ${e.y2}`;
  }
  // keep at least 24 px for the bend itself, however long the label
  const run = Math.max(0, Math.min(e.run ?? 0, e.x2 - e.x1 - 24));
  const a = e.labelAt === 'from' ? e.x1 + run : e.x1;
  const b = e.labelAt === 'to' ? e.x2 - run : e.x2;
  const dx = Math.max(12, (b - a) / 2);
  const lead = a > e.x1 ? `L${a} ${e.y1}` : '';
  const tail = b < e.x2 ? `L${e.x2} ${e.y2}` : '';
  return `M${e.x1} ${e.y1}${lead}C${a + dx} ${e.y1} ${b - dx} ${e.y2} ${b} ${e.y2}${tail}`;
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
  if (key !== key.toUpperCase()) return key.replace(/_/g, ' '); // internal streams are already lower case
  return materialTitle(key);
}

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
