# PetroGrid: visual style for the simulation app

For whoever builds `web/`. The app should look like the same product as the website: black ink on a
white page, one blue, red only when something is wrong. The current dark cyan theme is to be replaced.

## Name and logo

- The product is **PetroGrid**. Use it in the page title and top bar. Do not use "Chain Reaction" or "PetroChain".
- Logo file: `design/v3/logo.svg`. A hexagon ring with five open nodes, and a blue tail leaving the upper-right
  vertex and ending in a filled blue node. The node where the tail leaves has a blue ring.
- Wordmark: "Petro" in ink, "Grid" in blue, Archivo expanded 700, set to the right of the mark.
- Use the mark on white. Do not rotate or recolour it. Minimum size 16px.

## Colour tokens

| Token | Hex | Use |
|---|---|---|
| `blue` | `#1764d6` | The one brand colour: primary buttons, links, selection, key numbers |
| `blue-strong` | `#0f54ba` | Hover and pressed |
| `blue-light` | `#79aef2` | Secondary data and flows. Never text. |
| `blue-soft` | `#e8f0fc` | Tint behind a selected item |
| `ink` | `#0a0a0a` | Primary text, icons, outlines |
| `muted` | `#5f656c` | Secondary text, axis labels |
| `dim` | `#9aa0a6` | Non-text marks: ticks, inactive dots |
| `white` | `#ffffff` | Page and map background |
| `panel` | `#f7f8f9` | Panels, inspectors, timeline |
| `panel-2` | `#f0f2f4` | Controls inside a panel |
| `line` | `#e4e7ea` | Hairlines and dividers |
| `line-2` | `#cdd2d7` | Control outlines |
| `alarm` | `#d1372f` | State only: shut down, closed, stock-out, error |

## Colour in the map

Colour carries meaning, so use little of it.

| Thing | Colour |
|---|---|
| Land | `#f1f3f5` |
| Sea and background | `white` |
| Rivers | `#9dc3ef` |
| Site running at rate | `ink` outline, white fill |
| Site running reduced or holding at minimum | `blue-light` |
| Site selected | `blue` outline, `blue-soft` fill |
| Site shut down, route closed, tank empty | `alarm` |
| Site restarting | `alarm` outline, white fill |
| Gas and NGL flows (methane, ethane, LPG) | `blue-light` |
| Olefin flows (ethylene, propylene) | `blue` |
| Crude and liquid fuels | `ink` |
| Polymers and other solids | `dim` |
| Export and import lanes | `#b9bec4` |

Tell transport modes apart by line style, not colour: pipeline solid and thin, barge long dash, ship dotted,
road short dash.

## Type

All three families are free on Google Fonts.

| Role | Family | Weight | Use |
|---|---|---|---|
| Display | Archivo, width 125 | 700, 800 | Wordmark, large numbers, headings |
| Text | Instrument Sans | 400, 500, 600 | Body, panel titles, buttons |
| Mono | IBM Plex Mono | 400, 500 | Labels, units, clock, event log, tables of numbers |

- Labels: Mono 12px, uppercase, letter-spacing 0.14em, `muted`.
- Data: Mono 13px with tabular numerals.
- Body: Text 16px, line height 1.55.

```html
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@112,500;125,700;125,800&family=Instrument+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
```

## Shape and spacing

- Two corner radii only: 4px for controls, 8px for panels and the map frame. 999px for status dots.
- Borders are 1px hairlines in `line`. No drop shadows, no gradients, no glow.
- Spacing steps: 4, 8, 16, 24, 48, 96px.
- The hexagon is the brand shape. Use it for site markers and number badges where a shape is needed.

## Drop-in CSS

```css
:root{
  --blue:#1764d6; --blue-strong:#0f54ba; --blue-light:#79aef2; --blue-soft:#e8f0fc;
  --ink:#0a0a0a; --muted:#5f656c; --dim:#9aa0a6; --white:#ffffff;
  --panel:#f7f8f9; --panel-2:#f0f2f4; --line:#e4e7ea; --line-2:#cdd2d7; --alarm:#d1372f;
  --land:#f1f3f5; --water:#9dc3ef; --lane:#b9bec4;
  --f-display:"Archivo","Arial Narrow",Arial,sans-serif;
  --f-body:"Instrument Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  --f-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --r-sm:4px; --r-md:8px; --r-full:999px;
}
body{background:var(--white);color:var(--ink);font-family:var(--f-body)}
h1,h2{font-family:var(--f-display);font-stretch:125%}
```
