// One simple line icon per site preset, so a plant's type reads at a glance
// in the map labels, the site panel and the Sites key.
//
// All icons share one grid and one hand: 24 × 24, a single stroke weight,
// round caps and joins, drawn in ink with at most one blue accent (the v3
// palette). They are plain path data, so the map's DOM labels (an SVG
// string, see siteIconSvg / siteBadgeSvg) and React (SiteIcon.tsx) draw the
// very same shapes. This module imports nothing, so anything may use it.
//
// Colours come from CSS custom properties with the palette as fallback, so a
// host can restyle an icon without touching it — a "plant down" badge sets
// --icon-ink and --icon-accent to white on an alarm-red fill.

export interface IconStroke {
  /** SVG path data on the 24 × 24 grid */
  d: string;
  /** drawn in the accent blue instead of ink */
  accent?: boolean;
  /** a solid shape (dots, weights) rather than a line */
  fill?: boolean;
}

export interface SiteIconDef {
  /** the preset's name as people read it */
  label: string;
  strokes: IconStroke[];
}

/** Grid size and the one stroke weight every icon is drawn with. */
export const ICON_GRID = 24;
export const ICON_STROKE = 2;

const INK = 'var(--icon-ink, #0a0a0a)';
const ACCENT = 'var(--icon-accent, #1764d6)';

const n = (v: number) => String(Math.round(v * 100) / 100);

/** A full circle as path data. */
function circle(cx: number, cy: number, r: number): string {
  return `M${n(cx - r)} ${n(cy)}a${n(r)} ${n(r)} 0 1 0 ${n(2 * r)} 0a${n(r)} ${n(r)} 0 1 0 ${n(-2 * r)} 0`;
}

/** A flame: a teardrop with its tip at (cx, tip) over a round bulb centred at (cx, cy). */
function flame(cx: number, tip: number, cy: number, r: number): string {
  const h = cy - tip;
  return (
    `M${n(cx)} ${n(tip)}` +
    `C${n(cx + 0.83 * r)} ${n(tip + 0.52 * h)} ${n(cx + r)} ${n(tip + 0.78 * h)} ${n(cx + r)} ${n(cy)}` +
    `A${n(r)} ${n(r)} 0 0 1 ${n(cx - r)} ${n(cy)}` +
    `C${n(cx - r)} ${n(tip + 0.78 * h)} ${n(cx - 0.83 * r)} ${n(tip + 0.52 * h)} ${n(cx)} ${n(tip)}Z`
  );
}

/** A cog wheel outline centred on the grid: square teeth between two radii. */
function cog(teeth: number, outer: number, root: number): string {
  const pts: string[] = [];
  const step = (2 * Math.PI) / teeth;
  for (let i = 0; i < teeth; i++) {
    const a = i * step - Math.PI / 2;
    for (const [da, r] of [[-0.3, root], [-0.17, outer], [0.17, outer], [0.3, root]] as const) {
      pts.push(`${n(12 + r * Math.cos(a + da * step * 1.6))} ${n(12 + r * Math.sin(a + da * step * 1.6))}`);
    }
  }
  return `M${pts.join('L')}Z`;
}

// The furnace the two crackers share: firebox on the ground, stack, flame.
const FURNACE: IconStroke[] = [
  { d: 'M3 21h18' },
  { d: 'M4.5 21V11.5h11V21' },
  { d: 'M11 11.5V4.5h3v7' },
  { d: flame(10, 13.4, 17.4, 2.2), accent: true },
];

export const SITE_ICONS: Record<string, SiteIconDef> = {
  // pumpjack: A-frame, walking beam with a horsehead, the rod in blue
  OIL_FIELD: {
    label: 'Oil field',
    strokes: [
      { d: 'M3 20.5h18' },
      { d: 'M9.5 20.5l3-10.5 3 10.5' },
      { d: 'M5 11.3l14.5-3' },
      { d: 'M5 8.6c-1.7 1.6-1.7 3.7 0 5.3' },
      { d: circle(18.9, 10.4, 1.7), fill: true },
      { d: 'M4.2 14v6.5', accent: true },
    ],
  },
  // wellhead valve tree with a flame above it
  GAS_FIELD: {
    label: 'Gas field',
    strokes: [
      { d: 'M9 21h6' },
      { d: 'M12 21v-8.3' },
      { d: 'M8 15.6h8' },
      { d: 'M8 13.9v3.4' },
      { d: 'M16 13.9v3.4' },
      { d: flame(12, 2.8, 7.8, 2.7), accent: true },
    ],
  },
  // a faceted crystal with a glint
  SALT_MINE: {
    label: 'Salt mine',
    strokes: [
      { d: 'M7.5 8h9l4.5 4.6-9 8.9-9-8.9z' },
      { d: 'M3 12.6h18' },
      { d: 'M12 8l-3 4.6 3 8.9 3-8.9z' },
      { d: 'M19.5 2.5v4M17.5 4.5h4', accent: true },
    ],
  },
  // two tall separation columns of different height, joined by a line
  GAS_PLANT: {
    label: 'Gas plant',
    strokes: [
      { d: 'M3 21h18' },
      { d: 'M6 21V8.5a2 2 0 0 1 4 0V21' },
      { d: 'M14 21V5.5a2 2 0 0 1 4 0V21' },
      { d: 'M10 13h4', accent: true },
    ],
  },
  // distillation column with three side draws, and a flare
  REFINERY: {
    label: 'Refinery',
    strokes: [
      { d: 'M3 21h18' },
      { d: 'M6.5 21V6.5a2.5 2.5 0 0 1 5 0V21' },
      { d: 'M11.5 9h3.5' },
      { d: 'M11.5 13h3.5' },
      { d: 'M11.5 17h3.5' },
      { d: 'M19 21V9.8' },
      { d: flame(19, 2.8, 6.3, 1.8), accent: true },
    ],
  },
  // cracking furnace: firebox, stack, flame
  STEAM_CRACKER_GAS: { label: 'Steam cracker (ethane)', strokes: FURNACE },
  // the same furnace with a double feed arrow arriving — the flexible one
  STEAM_CRACKER_FLEX: {
    label: 'Steam cracker (flex)',
    strokes: [
      ...FURNACE,
      { d: 'M19.6 13.2l-2.1 2.6 2.1 2.6' },
      { d: 'M22.4 13.2l-2.1 2.6 2.1 2.6' },
    ],
  },
  // electrolysis cell: a bath, two electrodes, a bolt between them
  CHLOR_ALKALI: {
    label: 'Chlor-alkali',
    strokes: [
      { d: 'M4.5 8.5v11h15v-11' },
      { d: 'M8 4.5V15M6.5 4.5h3' },
      { d: 'M16 4.5V15M14.5 4.5h3' },
      { d: 'M13 8.6l-2.4 4h2.9l-2.4 4.2', accent: true },
    ],
  },
  // a plain carbon chain
  POLYETHYLENE: {
    label: 'Polyethylene',
    strokes: [
      { d: 'M3.5 16l4.25-8 4.25 8 4.25-8 4.25 8' },
      { d: circle(3.5, 16, 2.2), fill: true },
      { d: circle(7.75, 8, 2.2), fill: true },
      { d: circle(12, 16, 2.2), fill: true, accent: true },
      { d: circle(16.25, 8, 2.2), fill: true },
      { d: circle(20.5, 16, 2.2), fill: true },
    ],
  },
  // the chain with a side group on every other carbon
  POLYPROPYLENE: {
    label: 'Polypropylene',
    strokes: [
      { d: 'M3 17l4.5-5.5 4.5 5.5 4.5-5.5 4.5 5.5' },
      { d: 'M7.5 11.5V6M16.5 11.5V6', accent: true },
      { d: circle(7.5, 4.8, 1.6), fill: true, accent: true },
      { d: circle(16.5, 4.8, 1.6), fill: true, accent: true },
    ],
  },
  // a length of pipe with a coupling
  VINYLS: {
    label: 'Vinyls',
    strokes: [
      { d: 'M6 7.5a2 4.5 0 1 0 0 9a2 4.5 0 1 0 0-9' },
      { d: 'M6 7.5h12M6 16.5h12' },
      { d: 'M18 7.5a2 4.5 0 0 1 0 9' },
      { d: 'M12 7.5a2 4.5 0 0 1 0 9', accent: true },
    ],
  },
  // a benzene ring
  STYRENICS: {
    label: 'Styrenics',
    strokes: [
      { d: 'M12 3.5l7.4 4.25v8.5L12 20.5l-7.4-4.25v-8.5z' },
      { d: circle(12, 12, 3.7), accent: true },
    ],
  },
  // a fuel pump
  FUEL_DEPOT: {
    label: 'Fuel depot',
    strokes: [
      { d: 'M4 21h11.5' },
      { d: 'M5.5 21V5.5A1.5 1.5 0 0 1 7 4h5.5A1.5 1.5 0 0 1 14 5.5V21' },
      { d: 'M14 11.5h1.4a1.5 1.5 0 0 1 1.5 1.5v4a1.6 1.6 0 0 0 3.2 0V9.5L17.9 7' },
      { d: 'M7.9 7.2h3.7v3.3H7.9z', accent: true },
    ],
  },
  // a gas burner: the blue flame over the ring
  GAS_GRID: {
    label: 'Gas grid',
    strokes: [
      { d: flame(12, 2.6, 11.3, 4.6), accent: true },
      { d: 'M6 19h12' },
      { d: 'M8.5 21.6h7' },
    ],
  },
  // an open carton with its tape
  PACKAGING: {
    label: 'Packaging',
    strokes: [
      { d: 'M4 9.5h16V20.5H4z' },
      { d: 'M4 9.5l2.5-5h11l2.5 5' },
      { d: 'M12 4.5v8.5', accent: true },
    ],
  },
  // a tower crane with its hook
  CONSTRUCTION: {
    label: 'Construction',
    strokes: [
      { d: 'M8 21V4' },
      { d: 'M5 21h6' },
      { d: 'M3.5 8.2h17' },
      { d: 'M8 4l8.5 4.2M8 4L4.5 8.2' },
      { d: 'M17 8.2v4.6' },
      { d: 'M17 12.8v1.4a1.7 1.7 0 1 1-1.7 1.7', accent: true },
    ],
  },
  // a shopping bag
  CONSUMER_GOODS: {
    label: 'Consumer goods',
    strokes: [
      { d: 'M5 8.5h14l1 12.5H4z' },
      { d: 'M9 11.5V7a3 3 0 0 1 6 0v4.5', accent: true },
    ],
  },
  // a paint roller
  PAINTS_COATINGS: {
    label: 'Paints and coatings',
    strokes: [
      { d: 'M4 4.5h12.5a1 1 0 0 1 1 1V8a1 1 0 0 1-1 1H4z' },
      { d: 'M17.5 6.8h2.7v5.2h-8.4v2.5' },
      { d: 'M11.8 14.5V21', accent: true },
    ],
  },
  // a cog wheel
  PROCESS_INDUSTRIES: {
    label: 'Process industries',
    strokes: [{ d: cog(8, 9.3, 7) }, { d: circle(12, 12, 2.7), accent: true }],
  },
  // an anchor
  PORT_TERMINAL: {
    label: 'Port terminal',
    strokes: [
      { d: circle(12, 5, 2), accent: true },
      { d: 'M12 7v13.5' },
      { d: 'M8 10.6h8' },
      { d: 'M5 13.5a7 7 0 0 0 14 0' },
      { d: 'M3.4 15.4L5 13.5l1.9 1.6M17.1 15.1l1.9-1.6 1.6 1.9' },
    ],
  },
};

/** Preset keys other worlds use for a plant that has an icon here. */
const ALIASES: Record<string, string> = {
  STEAM_CRACKER: 'STEAM_CRACKER_FLEX', // the six-site world's one cracker
  PAINTS: 'PAINTS_COATINGS',
  PORT_TERMINAL_B: 'PORT_TERMINAL',
  OIL_FIELD_B: 'OIL_FIELD',
};

/** A neutral mark for a preset this set does not know: the brand hexagon with a dot. */
export const FALLBACK_ICON: SiteIconDef = {
  label: 'Site',
  strokes: [{ d: 'M12 4l7 4v8l-7 4-7-4V8z' }, { d: circle(12, 12, 1.6), fill: true, accent: true }],
};

/** The presets in the order a key should list them: upstream to downstream. */
export const SITE_ICON_ORDER: readonly string[] = [
  'OIL_FIELD', 'GAS_FIELD', 'SALT_MINE', 'GAS_PLANT', 'REFINERY', 'STEAM_CRACKER_GAS',
  'STEAM_CRACKER_FLEX', 'CHLOR_ALKALI', 'POLYETHYLENE', 'POLYPROPYLENE', 'VINYLS', 'STYRENICS',
  'FUEL_DEPOT', 'GAS_GRID', 'PACKAGING', 'CONSTRUCTION', 'CONSUMER_GOODS', 'PAINTS_COATINGS',
  'PROCESS_INDUSTRIES', 'PORT_TERMINAL',
];

/** The canonical preset key an icon is filed under ("STEAM_CRACKER" → the flex cracker). */
export function iconKey(preset: string): string {
  return preset in SITE_ICONS ? preset : ALIASES[preset] ?? preset;
}

/** The icon for a preset key; the neutral fallback for one this set does not know. */
export function siteIcon(preset: string): SiteIconDef {
  return SITE_ICONS[iconKey(preset)] ?? FALLBACK_ICON;
}

/** The preset's name as people read it; the key itself, tidied, when unknown. */
export function presetLabel(preset: string): string {
  const def = SITE_ICONS[iconKey(preset)];
  if (def !== undefined) return def.label;
  const words = preset.toLowerCase().replace(/_/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** The icon's strokes as SVG markup (no <svg> wrapper), in grid units. */
export function iconMarkup(def: SiteIconDef): string {
  return def.strokes
    .map((s) => {
      const colour = s.accent === true ? ACCENT : INK;
      return s.fill === true
        ? `<path d="${s.d}" fill="${colour}" stroke="none"/>`
        : `<path d="${s.d}" fill="none" stroke="${colour}"/>`;
    })
    .join('');
}

const SVG_ATTRS =
  `fill="none" stroke-width="${ICON_STROKE}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"`;

/** A preset's icon as a standalone SVG string, `size` pixels square. */
export function siteIconSvg(preset: string, size = 18): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" ` +
    `viewBox="0 0 ${ICON_GRID} ${ICON_GRID}" ${SVG_ATTRS}>${iconMarkup(siteIcon(preset))}</svg>`
  );
}

/** Geometry of a hexagon badge around an icon `icon` pixels square. */
export function badgeGeometry(icon: number): { width: number; height: number; points: string; inset: [number, number] } {
  // A regular hexagon, flat top and bottom, as tall as the icon's diagonal needs.
  const height = Math.round(icon * 1.42);
  const width = Math.round((height * 2) / Math.sqrt(3));
  const q = width / 4;
  const e = 0.75; // half the outline, so it is not clipped
  const points = [
    [q, e], [width - q, e], [width - e, height / 2], [width - q, height - e], [q, height - e], [e, height / 2],
  ].map(([x, y]) => `${n(x)},${n(y)}`).join(' ');
  return { width, height, points, inset: [(width - icon) / 2, (height - icon) / 2] };
}

/**
 * A preset's icon inside a small hexagon badge, as a standalone SVG string.
 * The badge's fill and outline follow --badge-fill and --badge-line (white
 * and ink by default), so a host shows a plant's state by setting them.
 */
export function siteBadgeSvg(preset: string, icon = 16): string {
  const g = badgeGeometry(icon);
  const scale = icon / ICON_GRID;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${g.width}" height="${g.height}" ` +
    `viewBox="0 0 ${g.width} ${g.height}" ${SVG_ATTRS}>` +
    `<polygon points="${g.points}" fill="var(--badge-fill, #ffffff)" stroke="var(--badge-line, #0a0a0a)" stroke-width="1.5"/>` +
    `<g transform="translate(${n(g.inset[0])} ${n(g.inset[1])}) scale(${n(scale)})">${iconMarkup(siteIcon(preset))}</g>` +
    `</svg>`
  );
}
