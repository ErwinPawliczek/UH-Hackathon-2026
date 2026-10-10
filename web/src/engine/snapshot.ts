// Binary snapshot codec (S7.3) - the contract between the C++ engine and the
// web shell. decode() reads what the engine writes; nothing here knows about
// React or three.js. When the wasm module lands (M4) only the producer
// changes; this decoder is the durable half of the contract.

export const N_ARRAYS = 12;

/** Scalar type of each array, in snapshot order. */
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
  if (count !== N_ARRAYS) throw new Error('expected ' + N_ARRAYS + ' arrays, got ' + count);

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
  };
}
