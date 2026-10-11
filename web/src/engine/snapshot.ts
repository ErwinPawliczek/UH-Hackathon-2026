// Binary snapshot codec (S7.3) - the contract between the C++ engine and the
// web shell. decode() reads what the engine writes; nothing here knows about
// React or three.js. When the wasm module lands (M4) only the producer
// changes; this decoder is the durable half of the contract.
//
// v1 = 12 arrays (0-11). v2 appends three per-vehicle movement arrays
// (12 vehRoute, 13 vehProgress, 14 vehEta) - the client's movement contract:
// which client route the vehicle is driving, progress 0..1 along it, and the
// absolute tick the current activity ends. The table is self-describing and
// append-only, so decode() accepts any payload that carries at least the v1
// baseline and exposes the v2 fields only when their arrays are present.

export const N_ARRAYS = 12; // v1 baseline; v2 payloads carry 15
export const NO_ROUTE = 0xffffffff; // array 12 sentinel: vehicle not on a route
export const NO_ETA = 0xffffffff; // array 14 sentinel: activity end not derivable

const ARRAY_TYPES = ['f32', 'f32', 'u8', 'u8', 'u8', 'f32', 'f32', 'u8', 'u32', 'f32', 'u8', 'f32'] as const;
type ScalarType = (typeof ARRAY_TYPES)[number];

const MAGIC = 0x53585243; // 'CRXS' little-endian
const HEADER_BYTES = 20; // magic(4) version(4) tick(8) count(4)

export interface Snapshot {
  version: number;
  tick: bigint;
  /** Entity counts implied by the array lengths. */
  nTanks: number;
  nProc: number;
  nUnits: number;
  nSites: number;
  nVeh: number;
  nPipes: number;
  nEdges: number;
  nMats: number;
  /** tanks: fill, f, u, h per tank */
  tanks: Float32Array;
  procRate: Float32Array;
  procStatus: Uint8Array;
  unitTrains: Uint8Array;
  siteStatus: Uint8Array;
  siteUrgency: Float32Array;
  /** vehicles: x, y, dirX, dirY, fill per vehicle */
  vehPos: Float32Array;
  vehStatus: Uint8Array;
  vehOrder: Uint32Array;
  pipeFlow: Float32Array;
  edgeOpen: Uint8Array;
  prices: Float32Array;
  /** v2 only (absent on v1 payloads): movement contract, per vehicle. */
  vehRoute?: Uint32Array;
  vehProgress?: Float32Array;
  vehEta?: Uint32Array;
}

function viewFor(buf: ArrayBuffer, type: ScalarType, offset: number, scalars: number) {
  switch (type) {
    case 'f32':
      return new Float32Array(buf, offset, scalars);
    case 'u8':
      return new Uint8Array(buf, offset, scalars);
    case 'u32':
      return new Uint32Array(buf, offset, scalars);
  }
}

/** Decodes the engine's snapshot into typed-array views with no copy. */
export function decode(buf: ArrayBuffer): Snapshot {
  const v = new DataView(buf);
  if (buf.byteLength < HEADER_BYTES + 8 * N_ARRAYS) throw new Error('snapshot too small');
  if (v.getUint32(0, true) !== MAGIC) throw new Error('bad snapshot magic');
  const version = v.getUint32(4, true);
  const tick = v.getBigUint64(8, true);
  const count = v.getUint32(16, true);
  // Tolerant by design: any version >= 1, any count >= the v1 baseline. The
  // snapshot table is self-describing and append-only, so a newer producer
  // may carry more arrays than this decoder knows; everything we do know
  // about still decodes.
  if (count < N_ARRAYS) throw new Error('expected at least ' + N_ARRAYS + ' arrays, got ' + count);

  const scalars: number[] = [];
  const offsets: number[] = [];
  for (let i = 0; i < count; i++) {
    scalars.push(v.getUint32(HEADER_BYTES + 8 * i, true));
    offsets.push(v.getUint32(HEADER_BYTES + 8 * i + 4, true));
  }

  const views = ARRAY_TYPES.map((t, i) => viewFor(buf, t, offsets[i], scalars[i])) as [
    Float32Array, Float32Array, Uint8Array, Uint8Array, Uint8Array, Float32Array,
    Float32Array, Uint8Array, Uint32Array, Float32Array, Uint8Array, Float32Array,
  ];

  const [tanks, procRate, procStatus, unitTrains, siteStatus, siteUrgency,
    vehPos, vehStatus, vehOrder, pipeFlow, edgeOpen, prices] = views;

  // Presence-gated v2 fields: they exist iff their arrays do. No fabrication
  // and no version guesswork. The casts pin the concrete view kind —
  // ARRAY_TYPES fixes 12/13/14 as u32/f32/u32 by codec contract.
  const vehRoute = count >= 15 ? viewFor(buf, 'u32', offsets[12], scalars[12]) as Uint32Array : undefined;
  const vehProgress = count >= 15 ? viewFor(buf, 'f32', offsets[13], scalars[13]) as Float32Array : undefined;
  const vehEta = count >= 15 ? viewFor(buf, 'u32', offsets[14], scalars[14]) as Uint32Array : undefined;

  return {
    version,
    tick,
    nTanks: tanks.length / 4,
    nProc: procRate.length,
    nUnits: unitTrains.length,
    nSites: siteStatus.length,
    nVeh: vehOrder.length,
    nPipes: pipeFlow.length,
    nEdges: edgeOpen.length,
    nMats: prices.length,
    tanks, procRate, procStatus, unitTrains, siteStatus, siteUrgency,
    vehPos, vehStatus, vehOrder, pipeFlow, edgeOpen, prices,
    vehRoute, vehProgress, vehEta,
  };
}
