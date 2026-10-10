// Stub producer: encodes animated fake data in the exact §7.3 snapshot layout
// so the render path (encode -> decode -> draw) runs before the real engine
// lands (M4). Every value is a pure function of (seed, tick); the layout is
// byte-identical to what the engine will write. World structure (sites, units,
// tanks, routes, fleet) comes from stubWorld so the encoder and the world
// JSON can never drift apart.

import type { Snapshot } from './snapshot';
import { MATERIALS, routeLength, routePointAt, stubWorld, type WorldSpec } from './world';

const MAGIC = 0x53585243; // 'CRXS' little-endian
const VERSION = 1;
const HEADER_BYTES = 20;
const TYPES = ['f32', 'f32', 'u8', 'u8', 'u8', 'f32', 'f32', 'u8', 'u32', 'f32', 'u8', 'f32'] as const;
const TYPE_SIZE: Record<string, number> = { f32: 4, u8: 1, u32: 4 };

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const clamp01 = (x: number) => Math.min(1, Math.max(0, x));
const scurve = (x: number, lo: number, hi: number) => {
  const t = clamp01((x - lo) / (hi - lo));
  return t * t * (3 - 2 * t);
};
const frac = (x: number) => x - Math.floor(x);
const wobble = (tick: number, phase: number) => {
  const t = (tick / (96 * 2) + phase) % 1;
  return t < 0.5 ? 2 * t : 2 - 2 * t;
};

/** Vehicle status names, index = §4.4 VehStatus enum. */
export const VEH_STATUS = ['Idle', 'To pickup', 'Queue load', 'Loading', 'To dropoff', 'Queue unload', 'Unloading'] as const;

export interface StubVehicleState {
  x: number;
  y: number;
  dirX: number;
  dirY: number;
  fill: number;
  /** §4.4 VehStatus enum value */
  status: number;
  outbound: boolean;
  /** 0..1 progress through the current leg */
  legProgress: number;
  /** tick at which the current leg ends */
  etaTick: number;
  orderId: number;
  from: string;
  to: string;
}

/**
 * Deterministic vehicle pose: ping-pong along its route polyline. One leg per
 * loopTicks; the vehicle loads at the start of the outbound leg and unloads at
 * the end. The same maths drives the encoder, the scene interpolation and the
 * vehicle inspector, so ETA and position always agree.
 */
export function stubVehicleState(world: WorldSpec, tick: number, v: number): StubVehicleState {
  const spec = world.vehicles[v];
  const route = world.routes[spec.route];
  const total = routeLength(route.points);
  const leg = Math.floor(spec.phase + tick / spec.loopTicks);
  const outbound = leg % 2 === 0;
  const p = frac(spec.phase + tick / spec.loopTicks);
  const s = outbound ? p : 1 - p;
  const pose = routePointAt(route.points, s * total);
  const dirSign = outbound ? 1 : -1;
  const fill = outbound ? 0.15 + 0.8 * Math.min(1, p / 0.12) : 0.15;
  // §4.4 VehStatus: 1 ToPickup, 2 QueueLoad, 3 Loading, 4 ToDropoff, 5 QueueUnload, 6 Unloading
  const status = outbound ? (p < 0.1 ? 3 : p > 0.95 ? 5 : 4) : p < 0.1 ? 2 : 1;
  return {
    x: pose.x,
    y: pose.y,
    dirX: pose.dirX * dirSign,
    dirY: pose.dirY * dirSign,
    fill,
    status,
    outbound,
    legProgress: p,
    etaTick: tick + Math.round((1 - p) * spec.loopTicks),
    orderId: v * 1000 + leg,
    from: route.ends[outbound ? 0 : 1],
    to: route.ends[outbound ? 1 : 0],
  };
}

export function encodeStub(seed: number, tick: number): ArrayBuffer {
  const world = stubWorld(seed);
  const nSites = world.sites.length;
  const nTanks = world.tanks.length;
  const procs = world.sites.flatMap((s) => s.processes);
  const units = procs.flatMap((p) => p.units);
  const nProc = procs.length;
  const nUnits = units.length;
  const nVeh = world.vehicles.length;
  const nPipes = world.pipelines.length;
  const nEdges = world.routes.length;
  const nMats = MATERIALS.length;

  const COUNTS = [
    4 * nTanks, nProc, nProc, nUnits, nSites, nSites,
    5 * nVeh, 2 * nVeh, nVeh, nPipes, nEdges, nMats,
  ];

  const rand = mulberry32(seed);
  const tankPhase = Array.from({ length: nTanks }, () => rand());
  const pipePhase = Array.from({ length: nPipes }, () => rand());
  const outageStart = Math.floor(96 * 5 + 384 * rand()) * 1; // refinery HDT outage window
  const outageEnd = outageStart + 192;

  let offset = HEADER_BYTES + 8 * COUNTS.length;
  const offsets = COUNTS.map((n, i) => {
    const o = offset;
    offset += n * TYPE_SIZE[TYPES[i]];
    offset = (offset + 3) & ~3;
    return o;
  });
  const bytes = new ArrayBuffer(offset);
  const v = new DataView(bytes);
  v.setUint32(0, MAGIC, true);
  v.setUint32(4, VERSION, true);
  v.setBigUint64(8, BigInt(Math.floor(tick)), true);
  v.setUint32(16, COUNTS.length, true);
  COUNTS.forEach((n, i) => {
    v.setUint32(HEADER_BYTES + 8 * i, n, true);
    v.setUint32(HEADER_BYTES + 8 * i + 4, offsets[i], true);
  });

  const f32 = (i: number) => new Float32Array(bytes, offsets[i], COUNTS[i]);
  const u8 = (i: number) => new Uint8Array(bytes, offsets[i], COUNTS[i]);
  const u32 = (i: number) => new Uint32Array(bytes, offsets[i], COUNTS[i]);

  // tanks: fill, f, u, h — smooth daily wobble per tank
  const tanks = f32(0);
  tankPhase.forEach((ph, i) => {
    const fill = 0.55 + 0.4 * scurve(wobble(tick, ph), 0.15, 0.85);
    tanks.set([fill, scurve(fill, 0.25, 1.25), 1 - scurve(fill, 0.2, 1.0), scurve(1 - fill, 0.1, 1.0)], 4 * i);
  });

  // processes: the HDT unit runs a scripted outage -> shutdown, restart; the
  // cracker dips into HoldMin when its rate wobble runs low.
  const rate = f32(1);
  const procStatus = u8(2);
  for (let i = 0; i < nProc; i++) {
    let r = 0.7 + 0.3 * scurve(wobble(tick, 0.1 * i), 0, 1);
    let status = 0; // Running
    if (procs[i].key === 'DIESEL_HDT') {
      if (tick >= outageStart && tick < outageEnd) {
        status = 2; // Shutdown
        r = 0;
      } else if (tick >= outageEnd && tick < outageEnd + 96) {
        status = 3; // Restarting
        r = 0.5 * ((tick - outageEnd) / 96);
      }
    } else if (procs[i].key === 'OLEFINS' && r < 0.75) {
      status = 1; // HoldMin
    }
    rate[i] = r;
    procStatus[i] = status;
  }

  // units: full trains, except the HDT trains are down for the outage
  const trains = u8(3);
  for (let i = 0; i < nUnits; i++) trains[i] = units[i].trains;
  const dhtProcIdx = procs.findIndex((p) => p.key === 'DIESEL_HDT');
  if (dhtProcIdx >= 0) {
    const dhtUnitIdx = procs.slice(0, dhtProcIdx).reduce((n, p) => n + p.units.length, 0)
      + procs[dhtProcIdx].units.findIndex((u) => u.key === 'RF-DHT');
    if (tick >= outageStart && tick < outageEnd && dhtUnitIdx >= 0) trains[dhtUnitIdx] = 0;
  }

  u8(4).fill(0); // site status: all running
  const urg = f32(5);
  for (let i = 0; i < nSites; i++) urg[i] = 0.5 * scurve(wobble(tick, 0.2 * i), 0, 1);

  // vehicles follow their route polylines
  const veh = f32(6);
  for (let i = 0; i < nVeh; i++) {
    const st = stubVehicleState(world, tick, i);
    veh.set([st.x, st.y, st.dirX, st.dirY, st.fill], 5 * i);
    u8(7)[2 * i] = st.status;
    u8(7)[2 * i + 1] = MATERIALS.indexOf(world.vehicles[i].cargo);
    u32(8)[i] = st.orderId;
  }

  pipePhase.forEach((ph, i) => {
    f32(9)[i] = 0.3 + 0.5 * scurve(wobble(tick, ph), 0, 1);
  });
  u8(10).fill(1); // all edges open
  for (let m = 0; m < nMats; m++) f32(11)[m] = 1 + 0.05 * scurve(wobble(tick, 0.02 * m), 0, 1);

  return bytes;
}

export type { Snapshot };
