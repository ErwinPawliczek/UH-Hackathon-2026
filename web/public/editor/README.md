# Map builder

A static page served by the app at `/editor/`. It is not part of the React bundle and has no build step or
libraries: `index.html` is the whole editor. It started as Erwin's own map editor and keeps how its tools feel.

Scope is fixed: the 22 sites and 9 pipelines of the default world. Sites can be moved and renamed, pipelines
re-bent, and roads, river lanes, sea lanes and water drawn freely.

## Files

| File | What it is | Keep in sync with |
|---|---|---|
| `index.html` | The editor. | The style tokens in `design/v3/simulation-style.md` and the layout format in `design/worlds/README.md`. |
| `default-layout.json` | The layout loaded on first open and by "Default world". A copy of `design/worlds/erwin-world-v1.json`. | **Copy that file here again whenever it changes:** `cp design/worlds/erwin-world-v1.json web/public/editor/default-layout.json`. |
| `site-icons.js` | The site icons, generated from `web/src/ui/siteIcons.ts`. | Run `node scripts/build-editor-icons.mjs` in `web/` after changing an icon. |

## How it talks to the app

- The working layout is kept in localStorage under `petrogrid-layout-v2`, written on every edit.
- **Check** posts `{"layout": …}` to `/api/worlds/check` and shows the reply. If the server has no such
  endpoint the page falls back to its own checklist rules and says so; the 30-day trial then is not run.
  `?mock=pass` and `?mock=fail` force that fallback with a made-up trial result, for working on the panel.
- **Run this world** saves the layout, sets `petrogrid-run-custom` to `1` and goes to `/`.
- **Default world** removes both keys and reloads `default-layout.json`.
