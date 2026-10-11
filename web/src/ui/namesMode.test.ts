import { describe, expect, it } from 'vitest';
import { NAMES_LABEL, nextNamesMode, useNamesMode } from './namesMode';

describe('names on the map', () => {
  it("cycles names and icons, icons only, hidden, and round again", () => {
    expect(nextNamesMode('full')).toBe('icons');
    expect(nextNamesMode('icons')).toBe('hidden');
    expect(nextNamesMode('hidden')).toBe('full');
    expect(NAMES_LABEL.full).toBe('Names: on');
  });

  it("is on by default and steps when cycled", () => {
    expect(useNamesMode.getState().mode).toBe('full');
    useNamesMode.getState().cycle();
    expect(useNamesMode.getState().mode).toBe('icons');
    useNamesMode.getState().cycle();
    useNamesMode.getState().cycle();
    expect(useNamesMode.getState().mode).toBe('full');
  });
});
