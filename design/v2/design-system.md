# PetroGrid Design System

Oct 10, 2026 · @Erwin

## Overview

PetroGrid is black, blue and white: black ink on a white page, with PetroGrid Blue `#1764d6` as the only brand color. Every product surface (the website, the demo, slides) uses the tokens in this document and no others.

## Color

Blue is the one brand color. Red appears only to mark a state (closed route, tripped unit, error), never as decoration.

| Token | Hex | Use |
| --- | --- | --- |
| `blue` | `#1764d6` | PetroGrid Blue: primary buttons, links, active states, logo tail, key data. 5.3:1 on white. |
| `blue-strong` | `#0f54ba` | Hover and pressed state of anything blue. |
| `blue-light` | `#79aef2` | Secondary data series and map flows. Never text. |
| `blue-soft` | `#e8f0fc` | Tint behind selected or active items. |
| `ink` | `#0a0a0a` | All primary text, headings, logo ring, icons. |
| `muted` | `#5f656c` | Secondary text, captions, axis labels. 6.0:1 on white. |
| `dim` | `#9aa0a6` | Non-text marks only: inactive dots, ticks, placeholders. |
| `white` | `#ffffff` | Page background; text on blue or ink. |
| `panel` | `#f7f8f9` | Raised surfaces: cards, consoles, panels. |
| `panel-2` | `#f0f2f4` | Controls inside a panel: buttons, chips, inputs. |
| `line` | `#e4e7ea` | Hairline borders and dividers. |
| `line-2` | `#cdd2d7` | Control outlines, ghost buttons. |
| `alarm` | `#d1372f` | State only: closed, tripped, error. |

## Typography

Three families, all free on Google Fonts. Archivo is always set expanded (`font-stretch: 125%`).

| Role | Family | Weights | Use |
| --- | --- | --- | --- |
| Display | Archivo, width 125 | 700, 800 | Headlines, wordmark |
| Text | Instrument Sans | 400, 500, 600 | Body, titles, UI |
| Mono | IBM Plex Mono | 400, 500 | Labels, numbers, units, logs |

| Style | Family | Size / line height | Weight | Notes |
| --- | --- | --- | --- | --- |
| hero | Display | 96px / 0.95 | 800 | letter-spacing −0.02em |
| h2 | Display | 54px / 1.0 | 700 | letter-spacing −0.015em |
| wordmark | Display | 17px / 1.0 | 700 | "Grid" in blue |
| lede | Text | 19px / 1.55 | 400 |  |
| title | Text | 20px / 1.3 | 600 |  |
| body | Text | 16px / 1.55 | 400 | max \~65 characters per line |
| label | Mono | 12px / 1.4 | 500 | uppercase, letter-spacing 0.14em |
| data | Mono | 13px / 1.5 | 400 | tabular numerals |

Load link:

```html
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@112,500;125,700;125,800&family=Instrument+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap">
```

## Corner radii

Two radii, no others.

| Token | Value | Applies to |
| --- | --- | --- |
| `radius-sm` | 4px | Controls: buttons, chips, tags, inputs, tooltips, scenario buttons |
| `radius-md` | 8px | Containers: cards, panels, consoles, map frame, terminal, demo box |
| `radius-full` | 999px | Status dots and pills only |

## Spacing

| Token | Value | Use |
| --- | --- | --- |
| `space-1` | 4px | Icon-to-text gaps |
| `space-2` | 8px | Gaps between chips and buttons |
| `space-3` | 16px | Control padding; minimum page gutter |
| `space-4` | 24px | Card padding |
| `space-5` | 48px | Desktop gutter; gap between blocks |
| `space-6` | 96px | Between page sections |

## Logo

The mark is a hexagonal node ring with one blue tail: the network, plus the route out of it.

![PetroGrid mark](logo.svg)

- **Ring:** flat-sided hexagon, radius 14 in a 48-unit grid, stroke 2.6, `ink`.
- **Nodes:** five open nodes (white fill, `ink` stroke 2.2, r 2.8) and one filled `ink` node where the tail leaves.
- **Tail:** `blue`, stroke 2.6, leaving its vertex radially at 30° above horizontal, so it makes 120° with both adjacent edges. Ends in a filled `blue` node, r 3.6.
- **Wordmark:** "Petro**Grid**" in Archivo expanded 700, "Grid" in `blue`, set to the right of the mark at about half the mark's height.
- **Use:** on white. Keep clear space of one node-width around the mark. Do not rotate, recolor or change the tail angle.
- **Minimum size:** 16px (favicon).

## Drop-in CSS

Paste this into the demo and any new page so everything matches the site.

```css
:root{
  --blue:#1764d6; --blue-strong:#0f54ba; --blue-light:#79aef2; --blue-soft:#e8f0fc;
  --ink:#0a0a0a; --muted:#5f656c; --dim:#9aa0a6; --white:#ffffff;
  --panel:#f7f8f9; --panel-2:#f0f2f4; --line:#e4e7ea; --line-2:#cdd2d7; --alarm:#d1372f;
  --f-display:"Archivo","Arial Narrow",Arial,sans-serif;
  --f-body:"Instrument Sans",system-ui,-apple-system,"Segoe UI",sans-serif;
  --f-mono:"IBM Plex Mono",ui-monospace,SFMono-Regular,Menlo,monospace;
  --r-sm:4px; --r-md:8px; --r-full:999px;
  --s-1:4px; --s-2:8px; --s-3:16px; --s-4:24px; --s-5:48px; --s-6:96px;
}
body{background:var(--white);color:var(--ink);font-family:var(--f-body)}
h1,h2{font-family:var(--f-display);font-stretch:125%}
```
