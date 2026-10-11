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
