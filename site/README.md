# Presentation site

The page served at petrogrid.xyz. One static HTML file, no build step.

| Folder | What it is |
|---|---|
| `v1/` | First version, kept as exported. |
| `v2/` | Second version: adds the model, customers and agents sections. |
| `v3/` | Third version: the problem in five numbers, then the solution. |
| `v4/` | Current version, as exported on 2026-10-11 with its preview-width toolbar hidden. This is what gets deployed. |
| `deploy/` | nginx config for the container. |

## Deploy

Runs on Fly.io as the app `petrogrid-site` (one small machine in Dallas that sleeps when nobody is visiting).
The simulation app is a separate Fly app; see `/deploy`.

```
cd site
fly deploy
```

To publish a new version, add a folder (`v5/`), point the `COPY` line in `Dockerfile` at it, and deploy.

## Editing

Colours, type and spacing come from `/design/v2/design-system.md`. The demo link is the `DEMO_URL`
constant near the top of the script in `index.html`. Every figure on the page is tied to a numbered
entry in the Sources section; keep them together.
