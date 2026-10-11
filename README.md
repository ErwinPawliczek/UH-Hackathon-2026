# PetroGrid

A live simulation of a petrochemical supply chain: 22 sites (oil and gas fields, a refinery, two steam
crackers, chlor-alkali, four polymer plants, and their customers) joined by pipelines, roads, river lanes and
sea lanes, with trucks, barges and ships moving product between them. Break a unit, close a route or lose a
supplier, and watch what stops next, what it costs, and who else can supply in time.

Every plant is modelled down to its process units with real mass and energy balances. Each tank decides
when to order and each plant how fast to run from three simple signals, so the network reacts to an upset
on its own rather than following a script.

Live demo: <https://demo.petrogrid.xyz> · Project site: <https://petrogrid.xyz>

## Run it locally

Needs a C++20 compiler, CMake 3.23 or newer with Ninja, and Node 20 or newer.

```sh
cmake --preset native-release
cmake --build --preset native-release
ctest --preset native-release          # engine, server and the 60-day gate for the default world

cd web && npm ci && npm run build && cd ..

./build/native-release/crx-server --port 8080 --web-dir web/dist
```

Open <http://localhost:8080> and press **Start simulation**.

## What to try

- **Speed.** One editable number: 1 is one simulated hour per second. Try 0.3 to follow single trucks, 16
  to skip ahead.
- **Scenario.** Trip a cracker compressor, take down the refinery's crude unit, halve the gas field, or close
  a river lane, a sea lane or a road. The plant or route turns red and the consequences spread from there.
- **Click a plant.** Its window shows a process flow diagram with every stream's live flow, each unit's
  trains and load, and tank levels, then charts for the plant as a whole or for the units inside it. Each
  unit has a Fail unit button.
- **Click a truck, barge or ship.** See what it carries, from where to where, how far it has left, and its
  route on the map.
- **Economy.** Four views of the whole network: money and tonnes ordered per chemical over time, every
  plant's running rate day by day, what the current disruption will cost over the next 30 days with a
  countdown of what stops next, and, for any tank that buys material, who else can supply it, at what
  delivered price, and whether it arrives before the tank runs dry. You can place an order with an
  alternative supplier and watch the vehicle go.
- **Back in time.** Jump the whole simulation back to any earlier moment; runs are exactly repeatable.
- **Log.** What you changed, and optionally what followed.

## How it is built

| Part | Where | What it is |
|---|---|---|
| Engine | `engine/` | Deterministic C++20 simulation in 15-minute steps: tank signals, plant control, production, ordering, dispatch and transport, pipelines, learning. Same inputs give byte-identical runs. |
| Catalog | `engine/data/catalog/` | Materials, 13 plant processes with 36 units, customers and sources, vehicle types. |
| Default world | `engine/data/worlds/erwin-world-v1.json` | The hand-drawn map with plant sizes, tanks, berths and an 82-vehicle fleet. Built from `design/worlds/erwin-world-v1.json` by `tools/worlds/build_erwin_world.py`. |
| Server | `apps/server/` | One engine per browser session behind a small HTTP API: step, command, world, events, history, vehicle, economy, forecast, sourcing, rewind. |
| Web app | `web/` | React and three.js. The map, the windows and the charts. |
| Project site | `site/` | The presentation site at petrogrid.xyz. |

Two tools help when changing the world:

```sh
python3 tools/worlds/build_erwin_world.py      # re-size plants, tanks and fleet; writes the world file
./build/native-release/crx-report --config '{"seed":42,"world":"erwin-world-v1"}' --days 60
```

`crx-report` runs the world for a number of days and prints customers, plants (with the tank that limits
each), tanks, orders, lanes and fleet use. Its exit code is the verdict that `ctest -R mapworld_60d` checks:
service at or above 95% at days 7, 30 and 60, every customer above 90%, and no plant starved of feed.

## Deployment

`deploy/README.md` covers the Docker image and Fly.io. The demo runs as one always-on machine.

## Background

`docs/OUTLINE.md` is the original technical outline. The engine's rules follow it closely; the user interface
and the default world have moved on from what it describes.
