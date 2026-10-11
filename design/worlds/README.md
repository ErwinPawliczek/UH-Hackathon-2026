# Hand-drawn worlds

`erwin-world-v1.json` is a world layout drawn by Erwin in the map editor. It says where things are and
how they connect. It has no rates, tank sizes or vehicle counts; those are set when it is loaded.

## Format

All coordinates are kilometres on a 600 × 400 map, origin top-left, y down.

| Field | Meaning |
|---|---|
| `wKm`, `hKm`, `cellKm` | Map size and the water grid cell size (10 km). |
| `water` | List of `[col, row]` grid cells that are water. Everything else is land. |
| `sites` | `{id, name, preset, x, y}`. `preset` is a key from `engine/data/catalog/presets.json`. |
| `network` | Shared infrastructure, each `{mode, points}` with `mode` one of `road`, `river`, `sea`. Each entry is one straight strip or short polyline. Strips of the same mode that share an end point (within 4 km) are joined; together they form that mode's route graph. |
| `connections` | Pipelines, each `{from, to, mode: "pipeline", material, points}`. `from` and `to` are site ids; `material` is a catalog material key; `points` is the bent polyline, first point at the source site and last at the target. |

## Rules the editor applied

- A site is on a network if any point of that network is within 12 km of the site. That is how a site
  gets a road connection, a barge berth (`river`) or a ship berth (`sea`).
- Roads may cross water (bridges). River and sea lanes stay on water cells.
- Sea lanes that run to the map edge are where imports and exports enter and leave.

## This world

22 sites: one each of gas plant, refinery, chlor-alkali, polyethylene, polypropylene, vinyls and
styrenics, two steam crackers (one ethane, one flex), two oil fields, a gas field, a salt mine, two port
terminals and seven demand sites. Nine pipelines: crude ×2, raw gas, methane, ethane ×2, ethylene ×3.
Everything else moves over the road, river and sea networks.

## From layout to running world

The layout says where things are. `tools/worlds/build_erwin_world.py` adds what a drawing cannot carry
(plant sizes, customer demand, tank sizes, which sites have river and sea berths, the fleet) and writes
`engine/data/worlds/erwin-world-v1.json`, which the engine loads when a session is created with
`{"world": "erwin-world-v1"}`. After re-exporting the map from the editor, copy it over
`design/worlds/erwin-world-v1.json` and run the script again from the repository root:

```
python3 tools/worlds/build_erwin_world.py
ctest --preset native-release -R mapworld
```

The second command runs the 60-day gate: service at or above 95% at days 7, 30 and 60, every customer above
90% in every window, and no plant starved of feed. `crx-report --config '{"seed":42,"world":"erwin-world-v1"}'`
prints the full picture (customers, plants, tanks, orders, fleet) when something needs tuning.
