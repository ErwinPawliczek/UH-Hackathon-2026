// M0 stub producer: encodes fake animated data in the exact S7.3 snapshot
// layout so the render path (encode -> decode -> draw) runs before the wasm
// module lands. Replaced by the real engine at M4; layout stays identical.

import type { Snapshot } from './snapshot';

export const MAP_W = 600;
export const MAP_H = 400;

const N_SITES = 4;
const N_TANKS = 8;
const N_PROC = 4;
const N_UNITS = 6;
const N_VEH = 6;
const N_PIPES = 3;
const N_EDGES = 8;
const N_MATS = 22;

const COUNTS = [4 * N_TANKS, N_PROC, N_PROC, N_UNITS, N_SITES, N_SITES, 5 * N_VEH, 2 * N_VEH, N_VEH, N_PIPES, N_EDGES, N_MATS];
const TYPES = ['f32', 'f32', 'u8', 'u8', 'u8', 'f32', 'f32', 'u8', 'u32', 'f32', 'u8', 'f32'] as const;
const TYPE_SIZE: Record<string, number> = { f32: 4, u8: 1, u32: 4 };
const HEADER_BYTES = 20;

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
const wobble = (tick: number, phase: number) => {
  const t = (tick / (96 * 2) + phase) % 1;
  return t < 0.5 ? 2 * t : 2 - 2 * t;
};

export function encodeStub(seed: number, tick: number): ArrayBuffer {
  const rand = mulberry32(seed);
  const tankPhase = Array.from({ length: N_TANKS }, () => rand());
  const vehPhase = Array.from({ length: N_VEH }, () => rand());
  const pipePhase = Array.from({ length: N_PIPES }, () => rand());

  let offset = HEADER_BYTES + 8 * COUNTS.length;
  const offsets = COUNTS.map((n, i) => {
    const o = offset;
    offset += n * TYPE_SIZE[TYPES[i]];
    offset = (offset + 3) & ~3;
    return o;
  });
  const bytes = new ArrayBuffer(offset);
  const v = new DataView(bytes);
  v.setUint32(0, 0x53585243, true); // 'CRXS'
  v.setUint32(4, 1, true);
  v.setBigUint64(8, BigInt(Math.floor(tick)), true);
  v.setUint32(16, COUNTS.length, true);
  COUNTS.forEach((n, i) => {
    v.setUint32(HEADER_BYTES + 8 * i, n, true);
    v.setUint32(HEADER_BYTES + 8 * i + 4, offsets[i], true);
  });

  const f32 = (i: number) => new Float32Array(bytes, offsets[i], COUNTS[i]);
  const u8 = (i: number) => new Uint8Array(bytes, offsets[i], COUNTS[i]);
  const u32 = (i: number) => new Uint32Array(bytes, offsets[i], COUNTS[i]);

  const tanks = f32(0);
  tankPhase.forEach((ph, i) => {
    const fill = 0.55 + 0.4 * scurve(wobble(tick, ph), 0.15, 0.85);
    tanks.set([fill, scurve(fill, 0.25, 1.25), 1 - scurve(fill, 0.2, 1.0), scurve(1 - fill, 0.1, 1.0)], 4 * i);
  });
  const rate = f32(1);
  for (let i = 0; i < N_PROC; i++) rate[i] = 0.7 + 0.3 * scurve(wobble(tick, 0.1 * i), 0, 1);
  u8(2).fill(0);
  const trains = u8(3);
  for (let i = 0; i < N_UNITS; i++) trains[i] = i % 2 === 0 ? 2 : 1;
  u8(4).fill(0);
  const urg = f32(5);
  for (let i = 0; i < N_SITES; i++) urg[i] = 0.5 * scurve(wobble(tick, 0.2 * i), 0, 1);
  const veh = f32(6);
  for (let i = 0; i < N_VEH; i++) {
    const ang = 2 * Math.PI * (wobble(tick, vehPhase[i]) + 0.125 * i);
    veh.set([
      300 + 220 * Math.cos(ang),
      200 + 150 * Math.sin(ang),
      -Math.sin(ang),
      Math.cos(ang),
      0.4 + 0.6 * scurve(wobble(tick, vehPhase[i] + 0.3), 0, 1),
    ], 5 * i);
    u8(7)[2 * i] = 3;
    u8(7)[2 * i + 1] = (i * 5) % N_MATS;
    u32(8)[i] = i;
  }
  pipePhase.forEach((ph, i) => {
    f32(9)[i] = 0.3 + 0.5 * scurve(wobble(tick, ph), 0, 1);
  });
  u8(10).fill(1);
  for (let m = 0; m < N_MATS; m++) f32(11)[m] = 1 + 0.05 * scurve(wobble(tick, 0.02 * m), 0, 1);

  return bytes;
}

export type { Snapshot };
