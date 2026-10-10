# Chain Reaction

An interactive demo of a petrochemical supply chain in a fictional country. Trigger
disruptions — compressor trips, chlorine squeezes, hurricanes, low rivers, gas
shortfalls — and watch shortages, rerouting, and recovery propagate through plants,
inventories, pipelines, and truck fleets. Every run can be compared against an
outage-free baseline twin.

The engine is a deterministic, time-stepped C++20 simulation exposed over a small
HTTP API; the front end is a React + three.js client rendering the binary snapshots
the engine emits. The design contract lives in [`docs/OUTLINE.md`](docs/OUTLINE.md).

## Build and run locally

Prerequisites: a C++20 toolchain, CMake (≥ 3.23) with Ninja, and Node 20.

```sh
# 1. Native engine + server + tests (6 suites)
cmake --preset native-release
cmake --build --preset native-release
ctest --preset native-release

# 2. Web client + unit tests
cd web
npm ci
npm run build
cd ..

# 3. Serve API + client from one origin
./build/native-release/crx-server --port 8080 --web-dir web/dist
```

Open **http://localhost:8080**. The app boots on the in-page stub engine; switch the
**Engine** selector to **Hosted (HTTP)** to drive the real C++ simulation.

## What to try

- **Scenarios** — pick one from the dropdown (Compressor trip, Chlorine squeeze,
  Hurricane landfall, Low river, Gas shortfall) and watch the event log as the
  disruption propagates: unit failures, process shutdowns, stockouts, rerouting.
- **Speed** — 4×/16×/64× playback; the timeline scrubs through the 60-day horizon.
- **Inspectors** — click a site or a vehicle for tanks, recipes, cargo, and route.
- **Deterministic runs** — the CLI drives the same engine headlessly:

  ```sh
  ./build/native-release/crx-cli run --seed 42 --ticks 960 --report 96 \
      --event '{"kind":"unit_outage", ...}'   # repeatable, applied before tick 0
  ./build/native-release/crx-cli worldgen --seed 7 --out world.json
  ```

  Same seed + same events ⇒ byte-identical runs.

## Deployment

`deploy/README.md` covers the Docker image, Fly.io, and the `demo.petrogrid.xyz`
domain wiring. The demo needs no cloud to run — everything above is local.
