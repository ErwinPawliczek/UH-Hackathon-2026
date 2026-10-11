import { describe, expect, it } from 'vitest';
import { decode } from './snapshot';
import { encodeStub } from './stub';

describe('snapshot decode', () => {
  it('round-trips the stub encoder including the v2 movement arrays', () => {
    const s = decode(encodeStub(7, 96));
    expect(s.version).toBe(2);
    expect(s.tick).toBe(96n);
    expect(s.nTanks).toBe(8);
    expect(s.tanks.length).toBe(4 * 8);
    expect(s.nVeh).toBe(6);
    expect(s.vehPos.length).toBe(5 * 6);
    expect(s.nMats).toBe(22);
    expect(s.prices.length).toBe(22);
    // v2 movement contract: route ids in range, progress in [0,1], ETA ahead
    for (let v = 0; v < s.nVeh; v++) {
      expect(s.vehRoute![v]).toBeLessThan(7); // stub world has 7 routes
      expect(s.vehProgress![v]).toBeGreaterThanOrEqual(0);
      expect(s.vehProgress![v]).toBeLessThanOrEqual(1);
      expect(s.vehEta![v]).toBeGreaterThanOrEqual(96);
    }
  });

  it('decodes a v1 payload (12 arrays) without the movement fields', () => {
    // Encode a v1-shaped payload: truncate a v2 buffer's array table to 12
    // entries and rewrite the header. The v2 arrays' bytes become trailing
    // slack the decoder must ignore.
    const v2 = encodeStub(7, 96);
    const copy = v2.slice(0); // fresh buffer: the views must not alias
    const count = new DataView(copy);
    count.setUint32(16, 12, true);
    count.setUint32(4, 1, true); // pretend v1
    const s = decode(copy);
    expect(s.version).toBe(1);
    expect(s.nVeh).toBe(6);
    expect(s.vehRoute).toBeUndefined();
    expect(s.vehProgress).toBeUndefined();
    expect(s.vehEta).toBeUndefined();
    // baseline arrays still decode
    expect(s.vehPos.length).toBe(5 * 6);
  });

  it('accepts a payload with more arrays than this decoder knows (v3 tolerance)', () => {
    const v2 = encodeStub(7, 96);
    const grown = new ArrayBuffer(v2.byteLength + 8);
    new Uint8Array(grown).set(new Uint8Array(v2), 0);
    const v = new DataView(grown);
    v.setUint32(16, 16, true); // a hypothetical v3 producer appends array 15
    v.setUint32(20 + 8 * 15, 4, true); // scalars
    v.setUint32(20 + 8 * 15 + 4, v2.byteLength, true); // offset into the slack
    const s = decode(grown);
    expect(s.vehRoute).toBeDefined();
    expect(s.vehProgress).toBeDefined();
    expect(s.vehEta).toBeDefined();
  });

  it('keeps vehicle positions inside the map', () => {
    const s = decode(encodeStub(3, 500));
    for (let v = 0; v < s.nVeh; v++) {
      expect(s.vehPos[5 * v]).toBeGreaterThanOrEqual(0);
      expect(s.vehPos[5 * v]).toBeLessThanOrEqual(600);
      expect(s.vehPos[5 * v + 1]).toBeGreaterThanOrEqual(0);
      expect(s.vehPos[5 * v + 1]).toBeLessThanOrEqual(400);
    }
  });

  it('rejects a bad magic', () => {
    const buf = encodeStub(1, 0);
    new DataView(buf).setUint32(0, 0xdeadbeef, true);
    expect(() => decode(buf)).toThrow(/magic/);
  });

  it('rejects a payload with fewer arrays than the v1 baseline', () => {
    const buf = encodeStub(1, 0);
    new DataView(buf).setUint32(16, 11, true);
    expect(() => decode(buf)).toThrow(/arrays/);
  });

  it('changes with the tick', () => {
    const a = decode(encodeStub(1, 10));
    const b = decode(encodeStub(1, 110));
    expect(a.tanks[0]).not.toBe(b.tanks[0]);
  });
});
