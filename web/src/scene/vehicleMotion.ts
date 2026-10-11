// Vehicle motion: turns the engine's snapshots (one every 250 ms) into
// continuous movement.
//
// Each snapshot says where every vehicle is: on which route and how far along
// it, or standing at a site. Between two snapshots a vehicle is drawn driving
// the network path that joins the two places — through the junctions when it
// changed route, in either direction along a route — at constant speed, so
// it never cuts a corner, never jumps at a junction and never freezes for a
// step. When a snapshot arrives early or late the vehicle carries on from
// wherever it is drawn at that moment, so the movement stays continuous.
// Heading follows the path a little ahead of the vehicle and turns at a
// limited rate instead of snapping.

import type { RouteMode, WorldSpec } from '../engine/world';
import type { VehiclePose } from './instances';

export type Pt = [number, number];

/** A place on the drawn network. */
export type NetLoc =
  | { kind: 'route'; route: number; /** km along the route's polyline */ s: number }
  | { kind: 'node'; node: number };

interface RouteGeom {
  pts: Pt[];
  /** cumulative arc length at each point */
  cum: number[];
  length: number;
  mode: RouteMode;
  /** node ids of the first and last point */
  a: number;
  b: number;
}

const dist2 = (p: Pt, q: Pt) => Math.hypot(q[0] - p[0], q[1] - p[1]);

function polylineLength(pts: Pt[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist2(pts[i - 1], pts[i]);
  return len;
}

/** Append `more` to `pts`, skipping a first point that repeats the last one. */
function extend(pts: Pt[], more: Pt[]): void {
  for (const p of more) {
    const last = pts[pts.length - 1];
    if (last !== undefined && Math.abs(last[0] - p[0]) < 1e-6 && Math.abs(last[1] - p[1]) < 1e-6) continue;
    pts.push(p);
  }
}

/**
 * The routes of a world as a graph: route ends that share a point are one
 * node, and shortest paths between all nodes are worked out once. Routes of
 * different modes never share a node, so a truck's path stays on roads and a
 * barge's on the river.
 */
export class RouteNet {
  readonly routes: RouteGeom[] = [];
  private readonly nodeXY: Pt[] = [];
  private readonly nodeMode: RouteMode[] = [];
  private readonly n: number;
  private readonly dist: Float64Array;
  /** first route to take from node u towards node v, -1 when unreachable */
  private readonly hop: Int32Array;
  private readonly siteNodes = new Map<string, number>();

  constructor(world: Pick<WorldSpec, 'routes'>) {
    const ids = new Map<string, number>();
    const nodeOf = (mode: RouteMode, p: Pt): number => {
      const key = `${mode}:${Math.round(p[0] * 100)}:${Math.round(p[1] * 100)}`;
      let id = ids.get(key);
      if (id === undefined) {
        id = this.nodeXY.length;
        ids.set(key, id);
        this.nodeXY.push([p[0], p[1]]);
        this.nodeMode.push(mode);
      }
      return id;
    };
    world.routes.forEach((route) => {
      const pts: Pt[] = route.points.length >= 2 ? route.points : [[0, 0], [0, 0]];
      const cum = [0];
      for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + dist2(pts[i - 1], pts[i]));
      const a = nodeOf(route.mode, pts[0]);
      const b = nodeOf(route.mode, pts[pts.length - 1]);
      this.routes.push({ pts, cum, length: cum[cum.length - 1], mode: route.mode, a, b });
      route.sites.forEach((site, end) => {
        if (site === null) return;
        const key = `${site}:${route.mode}`;
        if (!this.siteNodes.has(key)) this.siteNodes.set(key, end === 0 ? a : b);
      });
    });

    const n = (this.n = this.nodeXY.length);
    this.dist = new Float64Array(n * n).fill(Infinity);
    this.hop = new Int32Array(n * n).fill(-1);
    for (let i = 0; i < n; i++) this.dist[i * n + i] = 0;
    this.routes.forEach((g, r) => {
      if (g.a === g.b || g.length <= 0) return;
      if (g.length < this.dist[g.a * n + g.b]) {
        this.dist[g.a * n + g.b] = this.dist[g.b * n + g.a] = g.length;
        this.hop[g.a * n + g.b] = this.hop[g.b * n + g.a] = r;
      }
    });
    for (let k = 0; k < n; k++) {
      for (let i = 0; i < n; i++) {
        const ik = this.dist[i * n + k];
        if (ik === Infinity) continue;
        for (let j = 0; j < n; j++) {
          const via = ik + this.dist[k * n + j];
          if (via < this.dist[i * n + j] - 1e-9) {
            this.dist[i * n + j] = via;
            this.hop[i * n + j] = this.hop[i * n + k];
          }
        }
      }
    }
  }

  /** The node a site's road, river or sea lanes end at, or -1 when it has none. */
  siteNode(site: number, mode: RouteMode): number {
    return this.siteNodes.get(`${site}:${mode}`) ?? -1;
  }

  /** Nearest node of a mode within `tolKm` of a point, or -1. */
  nodeNear(mode: RouteMode, x: number, y: number, tolKm: number): number {
    let best = -1;
    let bestD = tolKm;
    for (let i = 0; i < this.n; i++) {
      if (this.nodeMode[i] !== mode) continue;
      const d = Math.hypot(this.nodeXY[i][0] - x, this.nodeXY[i][1] - y);
      if (d <= bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  }

  /** Point and direction of increasing arc length at `s` km along a route. */
  pointAt(route: number, s: number): { x: number; y: number; dirX: number; dirY: number } {
    const g = this.routes[route];
    const c = Math.min(g.length, Math.max(0, s));
    let i = 1;
    while (i < g.cum.length - 1 && g.cum[i] < c) i++;
    const seg = g.cum[i] - g.cum[i - 1];
    const t = seg > 0 ? (c - g.cum[i - 1]) / seg : 0;
    const [ax, ay] = g.pts[i - 1];
    const [bx, by] = g.pts[i];
    return {
      x: ax + (bx - ax) * t,
      y: ay + (by - ay) * t,
      dirX: seg > 0 ? (bx - ax) / seg : 0,
      dirY: seg > 0 ? (by - ay) / seg : 1,
    };
  }

  /** The polyline along a route from arc length `s0` to `s1`, in that order (either direction). */
  span(route: number, s0: number, s1: number): Pt[] {
    const g = this.routes[route];
    const from = Math.min(g.length, Math.max(0, s0));
    const to = Math.min(g.length, Math.max(0, s1));
    const lo = Math.min(from, to);
    const hi = Math.max(from, to);
    const a = this.pointAt(route, lo);
    const b = this.pointAt(route, hi);
    const out: Pt[] = [[a.x, a.y]];
    for (let i = 1; i < g.pts.length - 1; i++) {
      if (g.cum[i] > lo + 1e-9 && g.cum[i] < hi - 1e-9) out.push(g.pts[i]);
    }
    extend(out, [[b.x, b.y]]);
    return from <= to ? out : out.reverse();
  }

  /** The shortest drive from one place on the network to another, or null when they are not joined. */
  path(from: NetLoc, to: NetLoc): Pt[] | null {
    if (from.kind === 'route' && to.kind === 'route' && from.route === to.route) {
      return this.span(from.route, from.s, to.s);
    }
    const n = this.n;
    type Lead = { node: number; cost: number; pts: Pt[] };
    const leads = (loc: NetLoc, outbound: boolean): Lead[] => {
      if (loc.kind === 'node') return [{ node: loc.node, cost: 0, pts: [this.nodeXY[loc.node]] }];
      const g = this.routes[loc.route];
      const ends: Lead[] = [
        { node: g.a, cost: loc.s, pts: outbound ? this.span(loc.route, loc.s, 0) : this.span(loc.route, 0, loc.s) },
        {
          node: g.b,
          cost: g.length - loc.s,
          pts: outbound ? this.span(loc.route, loc.s, g.length) : this.span(loc.route, g.length, loc.s),
        },
      ];
      return ends;
    };
    let best: { a: Lead; b: Lead; total: number } | null = null;
    for (const a of leads(from, true)) {
      for (const b of leads(to, false)) {
        const mid = this.dist[a.node * n + b.node];
        if (mid === Infinity) continue;
        const total = a.cost + mid + b.cost;
        if (best === null || total < best.total) best = { a, b, total };
      }
    }
    if (best === null) return null;
    const out: Pt[] = [];
    extend(out, best.a.pts);
    let u = best.a.node;
    let guard = 0;
    while (u !== best.b.node && guard++ <= n) {
      const r = this.hop[u * n + best.b.node];
      if (r < 0) return null;
      const g = this.routes[r];
      if (g.a === u) {
        extend(out, g.pts);
        u = g.b;
      } else {
        extend(out, [...g.pts].reverse());
        u = g.a;
      }
    }
    extend(out, best.b.pts);
    return out;
  }
}

/** Where a vehicle should be drawn once it has caught up with a snapshot. */
export interface DrawTarget {
  x: number;
  y: number;
  /** its place on the network, when it has one */
  net: NetLoc | null;
  /** heading to use when it is placed at once (first frame, rewind) */
  dir: [number, number];
  /** heading to settle on at rest (parked, moored); null keeps the direction of arrival */
  restDir: [number, number] | null;
  /**
   * A parked truck stands beside its site, not on the road: it leaves and
   * joins the road this many km out from the site's node. 0 when the target
   * is on the network itself.
   */
  standoffKm: number;
}

interface Track {
  pts: Pt[];
  cum: number[];
  length: number;
}

function makeTrack(pts: Pt[]): Track {
  const clean: Pt[] = [];
  extend(clean, pts);
  const cum = [0];
  for (let i = 1; i < clean.length; i++) cum.push(cum[i - 1] + dist2(clean[i - 1], clean[i]));
  return { pts: clean, cum, length: cum[cum.length - 1] };
}

function trackPoint(t: Track, arc: number): Pt {
  if (t.pts.length === 1 || arc <= 0) return t.pts[0];
  if (arc >= t.length) return t.pts[t.pts.length - 1];
  let i = 1;
  while (i < t.cum.length - 1 && t.cum[i] < arc) i++;
  const seg = t.cum[i] - t.cum[i - 1];
  const k = seg > 0 ? (arc - t.cum[i - 1]) / seg : 0;
  return [
    t.pts[i - 1][0] + (t.pts[i][0] - t.pts[i - 1][0]) * k,
    t.pts[i - 1][1] + (t.pts[i][1] - t.pts[i - 1][1]) * k,
  ];
}

/** The part of a track still ahead of arc length `arc`, starting at that point. */
function trackTail(t: Track, arc: number): Pt[] {
  const out: Pt[] = [trackPoint(t, arc)];
  for (let i = 1; i < t.pts.length; i++) if (t.cum[i] > arc + 1e-9) out.push(t.pts[i]);
  return out;
}

/** Drop the first `km` of a polyline; a shorter polyline leaves its last point. */
function dropStart(pts: Pt[], km: number): Pt[] {
  const t = makeTrack(pts);
  if (t.length <= km) return [t.pts[t.pts.length - 1]];
  return trackTail(t, km);
}

const dropEnd = (pts: Pt[], km: number): Pt[] => dropStart([...pts].reverse(), km).reverse();

/**
 * A vehicle is never drawn faster than this many times its own speed. Leaving
 * a berth by another lane, mooring, or catching up after a late snapshot
 * then takes a little longer instead of showing as a lunge.
 */
const MAX_SPEEDUP = 2;
/** A straight hop longer than this is not a drive: the vehicle is placed at once. */
const FREE_HOP_KM = 45;
/** Sim hours per engine tick. */
const TICK_H = 0.25;

export interface MotionVehicle {
  mode: RouteMode;
  speedKmh: number;
}

/** Seconds for a heading to close most of a turn, per mode: trucks turn briskly, hulls swing. */
const TURN_TAU_S: Record<RouteMode, number> = { road: 0.07, river: 0.22, sea: 0.28 };
/** How far ahead (km) a vehicle looks for its heading, per mode. */
const LOOK_KM: Record<RouteMode, number> = { road: 2, river: 4, sea: 6 };

export class VehicleMotion {
  private tracks: Track[] = [];
  private targets: DrawTarget[] = [];
  private headings: number[] = [];
  /** ms each vehicle takes over its current track (the shared duration, or longer when capped) */
  private durations: number[] = [];
  /** wall-clock ms the current tracks started at */
  private t0 = 0;
  /** ms a track takes to drive */
  private duration = 275;
  /** smoothed ms between snapshots, and how much they vary */
  private interval = 250;
  private jitter = 0;
  /** the step loop's own cadence, as last told */
  private stepMs = 250;
  private lastSampleMs = 0;

  constructor(
    private readonly net: RouteNet,
    private readonly vehicles: MotionVehicle[],
    /** optional filter for vessels: true where a point lies on water */
    private readonly isWater: ((x: number, y: number) => boolean) | null = null,
  ) {}

  private fraction(nowMs: number, v: number): number {
    return Math.min(1, Math.max(0, (nowMs - this.t0) / (this.durations[v] ?? this.duration)));
  }

  /**
   * Head for a new set of targets. `ticks` is how many engine ticks the new
   * snapshot is ahead of the last one. `instant` places every vehicle at its
   * target with no drive (first snapshot, new run, back in time). `stepMs`
   * is the cadence the step loop aims for (it differs between speeds).
   */
  retarget(targets: DrawTarget[], nowMs: number, ticks: number, instant: boolean, stepMs = 250): void {
    const fresh = instant || this.targets.length !== targets.length;
    if (stepMs !== this.stepMs && stepMs > 0) {
      this.stepMs = stepMs;
      this.interval = stepMs;
      this.jitter = 0;
    }
    if (!fresh) {
      const gap = nowMs - this.t0;
      // pauses and the first step after one are not the cadence
      if (gap > 0.25 * this.stepMs && gap < 2.8 * this.stepMs) {
        this.jitter += 0.25 * (Math.abs(gap - this.interval) - this.jitter);
        this.interval += 0.25 * (gap - this.interval);
      }
    }
    // A drive lasts a little longer than snapshots are apart — by more when
    // they arrive unevenly — so a late snapshot finds the vehicle still
    // moving instead of waiting at the end of its path.
    this.duration = Math.min(
      2.8 * this.stepMs,
      Math.max(0.8 * this.stepMs, this.interval + 2 * this.jitter + 0.06 * this.stepMs),
    );
    const tracks: Track[] = [];
    const durations: number[] = [];
    for (let v = 0; v < targets.length; v++) {
      const next = targets[v];
      const prev = this.targets[v];
      const old = this.tracks[v];
      const leg = fresh || prev === undefined || old === undefined ? null : this.leg(v, prev, next, ticks);
      if (leg === null) {
        tracks.push(makeTrack([[next.x, next.y]]));
        durations.push(this.duration);
        const d = next.restDir ?? next.dir;
        if (fresh || this.headings[v] === undefined) this.headings[v] = Math.atan2(d[0], d[1]);
        continue;
      }
      const pts = trackTail(old, this.fraction(nowMs, v) * old.length);
      extend(pts, leg);
      const track = makeTrack(pts);
      tracks.push(track);
      // km the vehicle covers per real ms at its own speed, at this sim speed
      const cruise = ((this.vehicles[v]?.speedKmh ?? 70) * TICK_H * Math.max(1, ticks)) / this.stepMs;
      durations.push(Math.min(6 * this.duration, Math.max(this.duration, track.length / (MAX_SPEEDUP * cruise))));
    }
    this.tracks = tracks;
    this.durations = durations;
    this.targets = targets;
    this.headings.length = targets.length;
    this.t0 = nowMs;
  }

  /** The drive from one target to the next, or null when it cannot have been driven. */
  private leg(v: number, prev: DrawTarget, next: DrawTarget, ticks: number): Pt[] | null {
    const here: Pt = [prev.x, prev.y];
    const there: Pt = [next.x, next.y];
    if (dist2(here, there) < 1e-6) return [there];
    const veh = this.vehicles[v];
    let pts: Pt[] | null = null;
    if (prev.net !== null && next.net !== null) {
      const path = this.net.path(prev.net, next.net);
      if (path !== null) {
        pts = path;
        if (prev.standoffKm > 0) pts = [here, ...dropStart(pts, prev.standoffKm)];
        if (next.standoffKm > 0) pts = [...dropEnd(pts, next.standoffKm), there];
        if (veh !== undefined && veh.mode !== 'road' && this.isWater !== null && pts.length > 2) {
          // lanes run up the bank to their site: a vessel passing one keeps to the water
          const wet = this.isWater;
          pts = pts.filter((p, i) => i === 0 || i === pts!.length - 1 || wet(p[0], p[1]));
        }
        pts = [here, ...pts, there];
      }
    }
    if (pts === null) {
      if (dist2(here, there) > FREE_HOP_KM) return null;
      pts = [here, there];
    }
    // further than it can have driven in the time: not a drive (a re-plan, a reset)
    const reach = (veh?.speedKmh ?? 70) * TICK_H * Math.max(1, ticks) * 1.3 + 60;
    if (polylineLength(pts) > reach) return null;
    return pts;
  }

  /** Poses at wall-clock time `nowMs`, written into `out`. */
  sample(nowMs: number, out: VehiclePose[]): void {
    const dt = Math.min(0.1, Math.max(0, (nowMs - this.lastSampleMs) / 1000));
    this.lastSampleMs = nowMs;
    out.length = this.tracks.length;
    for (let v = 0; v < this.tracks.length; v++) {
      const track = this.tracks[v];
      const arc = this.fraction(nowMs, v) * track.length;
      const p = trackPoint(track, arc);
      const mode = this.vehicles[v]?.mode ?? 'road';
      let want: number | null = null;
      if (track.length - arc > 1e-6) {
        const q = trackPoint(track, Math.min(track.length, arc + LOOK_KM[mode]));
        if (dist2(p, q) > 1e-6) want = Math.atan2(q[0] - p[0], q[1] - p[1]);
      } else {
        const rest = this.targets[v]?.restDir;
        if (rest !== null && rest !== undefined) want = Math.atan2(rest[0], rest[1]);
      }
      let heading = this.headings[v] ?? 0;
      if (want !== null) {
        let diff = want - heading;
        diff -= Math.round(diff / (2 * Math.PI)) * 2 * Math.PI; // shortest way round
        heading += diff * (1 - Math.exp(-dt / TURN_TAU_S[mode]));
      }
      this.headings[v] = heading;
      out[v] = { x: p[0], y: p[1], dirX: Math.sin(heading), dirY: Math.cos(heading) };
    }
  }
}
