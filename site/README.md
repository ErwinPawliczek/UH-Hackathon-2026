# Presentation site

The page served at petrogrid.xyz.

| Folder | What it is |
|---|---|
| `v1/` | First version, kept as exported. |
| `v2/` | Second version: adds the model, customers and agents sections. |
| `v3/` | Third version: the problem in five numbers, then the solution. Single HTML file. |
| `v4/` | Current version: the hexagon-grid design, exported from Lovable (TanStack Start, React, Tailwind). This is what gets deployed. |
| `deploy/` | nginx config used by v1 to v3. Not used by v4, which runs as a Node server. |

## Deploy

Runs on Fly.io as the app `petrogrid-site` (two small machines in Dallas, always on).
The simulation app is a separate Fly app; see `/deploy`.

```
cd site
fly deploy
```

To update v4 from a new Lovable export, replace the contents of `v4/` (keep `package-lock.json`) and deploy.

## Editing

The page content is in `v4/src/components/hex-content.tsx`. Two things differ from the Lovable export and
need keeping when it is replaced: the 75% figure refers to ethylene capacity (the export said polyethylene),
and the favicon is `public/favicon.svg`, drawn from the current logo.
