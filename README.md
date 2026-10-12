# PetroGrid

A live simulation of a chemical supply chain. When something fails, PetroGrid shows what fails next, when,
and what it costs.

The network is a typical Gulf-Coast-style chain: 22 sites (oil and gas fields, a salt mine, a gas plant, a
refinery, two steam crackers, chlor-alkali, four polymer plants, and their customers and ports) joined by
pipelines, roads, river lanes and sea lanes, with 82 trucks, barges and ships. Every plant is modelled down to
its process units with mass and energy balances. Nothing is scripted: each tank decides when to order and each
plant how fast to run from a few simple signals, so the network reacts to an upset on its own.

| | |
|---|---|
| Project site | <https://petrogrid.xyz> |
| Live demo | <https://demo.petrogrid.xyz> |
| Map builder | <https://demo.petrogrid.xyz/editor/> |
| Shared session (host) | <https://multiplayer.petrogrid.xyz/host/> |

## What it does

- **Break something and watch it spread.** Trip a cracker compressor, take down the refinery's crude unit,
  halve the gas field, close a river lane, a sea lane or a road, or send a hurricane or a water restriction
  across the whole network. The plant or route turns red and the consequences follow.
- **See inside any plant.** Click a site for its process flow diagram with every stream's live flow, each
  unit's trains and load, and its tanks. The Economics tab draws the model's rules as curves and marks where
  that site sits on each one.
- **Follow a vehicle.** Click a truck, barge or ship to see what it carries, from where to where, and its
  route.
- **Put a number on it.** The Economy window runs the next 30 days twice, once as things are and once as if
  nothing had broken, and prices the difference. It lists what stops next and when, and for any tank that has
  lost its supplier, who else can deliver and at what price.
- **Switch the market on.** With Market on, prices come from how full tanks are and everything reacts to
  them: buyers stock up when a chemical is cheap and wait when it is dear, customers buy less as prices rise,
  and plants pass feed costs down the chain.
- **Go back in time.** Runs are exactly repeatable, so the whole simulation can jump back to any earlier
  moment.
- **Redraw the map.** The map builder moves sites and redraws roads, lanes, pipelines and water, then runs
  the result.
- **Run it together.** A host opens a session and shows a QR code. Everyone joins on a phone, takes a plant,
  and cuts its rate, takes units down or stops trading with a neighbour. At the end, a damage summary compares
  the session with the same run in which nothing was changed: what broke, which prices moved, and who caused
  what.

## The economic engine

Prices are not typed in anywhere. They come out of the physical state of the network, and in the market world
the network then reacts to them. `docs/MODEL.md` has every rule and constant; this is the short version.

**How a price forms.** Every chemical has a base price. Each side of a trade moves away from it by one number
of its own:

```
asking price = base × (1 + 0.5 × (1 − 2 × how full the seller's tank is))     full tank: −50%, empty: +50%
bid          = base × (1 + 0.5 × the buyer's urgency)                          calm: base, nearly out: +50%
price paid   = halfway between the two
```

**Who a buyer buys from.** Once an hour, each tank that is running short compares every seller and vehicle that
can physically make the delivery, and takes the lowest delivered cost:

```
delivered cost per tonne = asking price + freight rate × distance + urgency × $0.50 × trip hours
```

**The market rules** (the Market switch; world `erwin-market-v1`):

| Rule | What it does |
|---|---|
| Price-aware buying | A buyer orders early and fills to 90% when the best offer is 10% under base, and waits and fills to 50% when it is 10% over. Below one delivery time of stock it buys at any price. |
| Demand reacts to price | A customer wants normal demand × (price paid ÷ base)^−0.2, kept between 60% and 120% of normal. |
| Margin and cost pass-through | A plant whose margin falls to nothing turns down to its minimum rate. A rise in feed cost is added to its asking prices, so it moves down the chain a stage at a time. |

**What a disruption costs.** The same moment is run forward 30 days twice, once as it is and once as if nothing
had broken:

```
cost = extra lost sales + stock run down + extra energy + extra freight
```

Stock is counted because customers live off existing stock at first; without it a week-long outage would look
like an energy saving.

**Damage in a shared session.** The server keeps a second run in which nobody changed anything, and one run per
player that leaves out that player's moves. Damage is the customer sales lost in the session beyond that run:
product not delivered, plus demand priced out.

**Known limits.** The market is closed (no imports or exports), every trade is a spot trade, and nothing is
calibrated against real prices. A bid is never below base, so prices settle somewhat above base even when
nothing is wrong: read the changes, not the level.

## How it is built

| Part | Where | What it is |
|---|---|---|
| Engine | `engine/` | A C++20 simulation in 15-minute steps: tank signals, plant control, production, ordering, dispatch, transport, pipelines and the market rules. The same inputs give the same run, bit for bit. |
| Catalog | `engine/data/catalog/` | Materials, 13 plant processes with 36 units, customers and sources, vehicle types. |
| Worlds | `engine/data/worlds/` | `erwin-world-v1` is the standard world; `erwin-market-v1` is the same map with the market rules on. Both are built from the hand-drawn map in `design/worlds/` by `tools/worlds/build_erwin_world.py`. |
| Server | `apps/server/` | The engine behind an HTTP API: private sessions for the demo and shared rooms for group sessions. It also serves the web app. |
| Web app | `web/` | TypeScript, React and three.js: the 3D map, the windows and charts, the host screen (`/host/`) and the phone screen (`/play/`). |
| Map builder | `web/public/editor/` | A static page with no build step. |
| Project site | `site/` | The page at petrogrid.xyz. |
| Deployment | `deploy/` | The Docker image and the Fly.io setup. |

## Run it locally

Needs a C++20 compiler, CMake 3.28 or newer with Ninja, and Node 20 or newer.

```sh
cmake --preset native-release
cmake --build --preset native-release
ctest --preset native-release          # engine, server and the 60-day checks

cd web && npm ci && npm run build && cd ..

./build/native-release/crx-server --port 8080 --web-dir web/dist
```

Open <http://localhost:8080> and press **Start simulation**. The host screen is at `/host/` and the map builder
at `/editor/`.

Two tools help when changing a world:

```sh
python3 tools/worlds/build_erwin_world.py            # size plants, tanks and fleet; writes the standard world
python3 tools/worlds/build_erwin_world.py --market   # the same, with the market rules on
./build/native-release/crx-report --config '{"seed":42,"world":"erwin-world-v1"}' --days 60
```

`crx-report` runs a world for a number of days and prints customers, plants, tanks, orders, lanes and fleet use.
Its verdict is what the tests check: service at or above 95% at days 7, 30 and 60, every customer above 90%, and
no plant starved of feed.

## What the model is, and is not

The physical side is the strong part: tonnes are tracked through recipes, tanks, pipelines and vehicles, so what
stops, in what order and after how long follows from capacities and stock. The dollar figures price that at
each chemical's base price.

It is not a model of a real company's network. The plants are typical ones sized so the network balances, and
the prices and response sizes are realistic in scale, not fitted to data. The market is closed (no imports or
exports) and every trade is a spot trade. Loading real plant data and prices is the next step; the engine is
the same.

## More

- `docs/MODEL.md`: the complete model, every rule and constant in the order the engine applies them.
- `deploy/README.md`: the Docker image, Fly.io and the domains.
- `design/`: the design system and the hand-drawn map.
- `docs/OUTLINE.md`: the original technical outline. The engine's rules follow it; the interface and the
  default world have moved on from what it describes.
