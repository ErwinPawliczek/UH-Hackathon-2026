import { describe, expect, it } from 'vitest';
import { decode } from './snapshot';
import { encodeStub } from './stub';

describe('snapshot decode', () => {
  it('round-trips the stub encoder', () => {
    const s = decode(encodeStub(7, 96));
    expect(s.version).toBe(1);
    expect(s.tick).toBe(96n);
    expect(s.nTanks).toBe(8);
    expect(s.tanks.length).toBe(4 * 8);
    expect(s.nVeh).toBe(6);
    expect(s.vehPos.length).toBe(5 * 6);
    expect(s.nMats).toBe(22);
    expect(s.prices.length).toBe(22);
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

  it('rejects a wrong array count', () => {
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
