// Chart colours. Series colours identify a series (categorical); they are
// assigned in this fixed order and never cycled — a series beyond the last
// slot is drawn in the neutral "other" grey and should be folded into an
// "Other" line by the caller.
//
// The order is the brand blue followed by six hues chosen to stay apart for
// colour-blind readers when adjacent. Validated on the panel surface
// (#f7f8f9): lightness band, chroma floor, adjacent-pair CVD separation
// (worst 9.1) and normal-vision separation (worst 19.6) all pass. Three
// slots (aqua, yellow, magenta) sit under 3:1 contrast on the surface, so a
// chart using them always carries a legend and a hover readout — which
// LineChart does for any chart with two or more series. Alarm red is left
// out on purpose: red means "something is wrong" everywhere else in the app.

export const CHART_COLORS: readonly string[] = [
  '#1764d6', // blue (the brand blue)
  '#eb6834', // orange
  '#1baf7a', // aqua
  '#eda100', // yellow
  '#e87ba4', // magenta
  '#008300', // green
  '#6250d6', // violet
];

/** Colour for anything past the last slot: fold those series into one "Other". */
export const CHART_OTHER = '#9aa0a6';

/** Colour of the series in position `i` (fixed order, never cycled). */
export function seriesColor(i: number): string {
  return CHART_COLORS[i] ?? CHART_OTHER;
}

/** Chart chrome, from the v3 tokens. */
export const CHART_INK = {
  text: '#0a0a0a',
  muted: '#5f656c',
  grid: '#e4e7ea',
  axis: '#cdd2d7',
  surface: '#f7f8f9',
} as const;

// ---- one hue, light to dark: for series that belong together ----
//
// When the lines of a chart are all the same kind of thing — every chemical
// coming out of one plant — they share one hue and differ in shade, so the
// chart reads as one family and the darker a line, the more it matters.
// Shades alone cannot carry many series, so such a chart always has its
// legend and hover readout too.

/** OKLCH lightness of the lightest and darkest step, the hue, and the most chroma a step may take. */
const RAMP_LIGHT = 0.73;
const RAMP_DARK = 0.21;
const RAMP_HUE = 258;
const RAMP_CHROMA = 0.17;

function oklchToLinearRgb(L: number, C: number, hueDeg: number): [number, number, number] {
  const a = C * Math.cos((hueDeg * Math.PI) / 180);
  const b = C * Math.sin((hueDeg * Math.PI) / 180);
  const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

function rampStep(L: number): string {
  // as much chroma as the screen can show at this lightness, up to the cap
  let rgb = oklchToLinearRgb(L, RAMP_CHROMA, RAMP_HUE);
  for (let C = RAMP_CHROMA; C > 0.005 && !rgb.every((v) => v >= -1e-4 && v <= 1 + 1e-4); C -= 0.005) {
    rgb = oklchToLinearRgb(L, C - 0.005, RAMP_HUE);
  }
  const channel = (v: number) => {
    const c = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, c)) * 255).toString(16).padStart(2, '0');
  };
  return `#${rgb.map(channel).join('')}`;
}

/**
 * `n` shades of blue from light (index 0) to very dark navy (index n - 1),
 * evenly spaced in perceptual lightness (OKLab). Up to nine steps keep at
 * least 0.06 of lightness between neighbours, and the lightest still stands
 * out at better than 2:1 on the panel surface. One step alone is a mid blue.
 */
export function blueRamp(n: number): string[] {
  const count = Math.max(0, Math.floor(n));
  if (count === 0) return [];
  if (count === 1) return [rampStep((RAMP_LIGHT + RAMP_DARK) / 2)];
  return Array.from({ length: count }, (_, i) => rampStep(RAMP_LIGHT + ((RAMP_DARK - RAMP_LIGHT) * i) / (count - 1)));
}
