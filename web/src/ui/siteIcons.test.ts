// The site-preset icon set: every preset the map world sends has its own
// icon, drawn on the shared grid, and unknown keys get the neutral mark.

import { describe, expect, it } from 'vitest';
import {
  FALLBACK_ICON, ICON_GRID, SITE_ICONS, SITE_ICON_ORDER, badgeGeometry, iconKey, presetLabel,
  siteBadgeSvg, siteIcon, siteIconSvg,
} from './siteIcons';
import { siteKinds } from './SitesKey';
import { stubWorld, type WorldSpec } from '../engine/world';

const MAP_PRESETS = [
  'OIL_FIELD', 'GAS_FIELD', 'SALT_MINE', 'GAS_PLANT', 'REFINERY', 'STEAM_CRACKER_GAS',
  'STEAM_CRACKER_FLEX', 'CHLOR_ALKALI', 'POLYETHYLENE', 'POLYPROPYLENE', 'VINYLS', 'STYRENICS',
  'FUEL_DEPOT', 'GAS_GRID', 'PACKAGING', 'CONSTRUCTION', 'CONSUMER_GOODS', 'PAINTS_COATINGS',
  'PROCESS_INDUSTRIES', 'PORT_TERMINAL',
];

describe('site icons', () => {
  it('has an icon and a readable name for all 20 presets, listed in key order', () => {
    expect(Object.keys(SITE_ICONS).sort()).toEqual([...MAP_PRESETS].sort());
    expect([...SITE_ICON_ORDER].sort()).toEqual([...MAP_PRESETS].sort());
    for (const key of MAP_PRESETS) {
      expect(siteIcon(key)).not.toBe(FALLBACK_ICON);
      expect(presetLabel(key)).toMatch(/^[A-Z][a-z]/);
    }
  });

  it('draws every icon differently', () => {
    const drawings = MAP_PRESETS.map((key) => siteIcon(key).strokes.map((s) => s.d).join('|'));
    expect(new Set(drawings).size).toBe(MAP_PRESETS.length);
  });

  it('keeps every icon inside the grid and uses at most one accent colour', () => {
    for (const key of MAP_PRESETS) {
      for (const stroke of siteIcon(key).strokes) {
        expect(stroke.d).not.toMatch(/NaN|undefined/);
        // every absolute coordinate pair in the path lies on the 24 x 24 grid
        for (const m of stroke.d.matchAll(/[ML]\s*(-?[\d.]+)[ ,](-?[\d.]+)/g)) {
          expect(Number(m[1])).toBeGreaterThanOrEqual(0);
          expect(Number(m[1])).toBeLessThanOrEqual(ICON_GRID);
          expect(Number(m[2])).toBeGreaterThanOrEqual(0);
          expect(Number(m[2])).toBeLessThanOrEqual(ICON_GRID);
        }
      }
      const svg = siteIconSvg(key);
      const colours = new Set([...svg.matchAll(/(?:stroke|fill)="(var\([^"]+\))"/g)].map((m) => m[1]));
      expect(colours.size).toBeLessThanOrEqual(2); // ink, plus the one accent
    }
  });

  it("files other worlds' keys under the right icon and falls back for unknown ones", () => {
    expect(iconKey('STEAM_CRACKER')).toBe('STEAM_CRACKER_FLEX'); // the six-site world's cracker
    expect(siteIcon('STEAM_CRACKER')).toBe(SITE_ICONS.STEAM_CRACKER_FLEX);
    expect(siteIcon('SOMETHING_NEW')).toBe(FALLBACK_ICON);
    expect(presetLabel('SOMETHING_NEW')).toBe('Something new');
  });

  it('renders standalone SVG for the map labels: the icon, and the icon in a hexagon badge', () => {
    const icon = siteIconSvg('REFINERY', 18);
    expect(icon).toMatch(/^<svg [^>]*width="18" height="18" viewBox="0 0 24 24"/);
    const badge = siteBadgeSvg('REFINERY', 16);
    const g = badgeGeometry(16);
    expect(badge).toContain(`width="${g.width}" height="${g.height}"`);
    expect(badge).toContain('<polygon');
    expect(badge).toContain('var(--badge-fill, #ffffff)'); // a host restyles it for "plant down"
    expect(g.points.split(' ')).toHaveLength(6);
    expect(g.width).toBeGreaterThan(g.height); // flat top and bottom, points left and right
  });
});

describe('siteKinds', () => {
  it('lists each kind of site once, in key order, with its sites', () => {
    const base = stubWorld(1);
    const site = (name: string, preset: string) => ({ ...base.sites[0], name, preset });
    const world: WorldSpec = {
      ...base,
      sites: [
        site('Port', 'PORT_TERMINAL'), site('Field A', 'OIL_FIELD'), site('Mystery', 'SOMETHING_NEW'),
        site('Field B', 'OIL_FIELD'), site('Cracker', 'STEAM_CRACKER'),
      ],
    };
    expect(siteKinds(world).map((k) => [k.preset, k.label, k.sites])).toEqual([
      ['OIL_FIELD', 'Oil field', [1, 3]],
      ['STEAM_CRACKER_FLEX', 'Steam cracker (flex)', [4]],
      ['PORT_TERMINAL', 'Port terminal', [0]],
      ['SOMETHING_NEW', 'Something new', [2]],
    ]);
    expect(siteKinds(null)).toEqual([]);
  });
});
