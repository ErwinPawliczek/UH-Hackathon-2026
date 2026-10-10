# Chain Reaction — technical outline

Working title (rename freely). Code prefix `crx`. Outline v0.2, 2026-10-10. v0.2 changes: terrain worldgen replaced by a template-based layout
generator whose polyline arc lengths drive travel times; determinism rules relaxed to same-platform
reproducibility; milestones reordered demo-first for the 48-hour build.

A time-stepped simulation of a petrochemical supply chain in a fictional country. Plants are built from
real unit-level mass and energy balances, materials move in pipelines, ships, barges and trucks, and every
plant adapts its own rate and purchasing to what is in its tanks. The user breaks something and watches the
consequences travel through the network.

**The one question the model answers:** when a unit goes down, which plants run short or back up, how soon,
and what do rationing and re-sourcing buy them?

| In scope | Out of scope (stated as such in the demo) |
|---|---|
| Yields, capacities, turndown, ramp and restart limits | Thermodynamics, kinetics, equipment design |
| Tank inventories, transit delays, loading queues | Product grades and quality, blending specs |
| Supplier choice, re-routing, feed switching | Contracts, credit, real price formation |
| Energy duty and cost per unit | Utilities networks (steam, cooling water) |
| Scripted and random outages | Safety, emissions, regulation, labour |

---

## 1. Fixed technical decisions

| Area | Decision | Reason |
|---|---|---|
| Engine | C++20, one static library `crx_engine`. No I/O, no threads, no globals. | Same code runs natively and in the browser; easy to test. |
| Targets | Native (g++ 14+) for CLI, tests and the benchmark solver; clang welcome. WebAssembly (emsdk, latest) for the browser. | One engine, two compilers. |
| Hosting | Static site. The engine runs inside the page. No server. | Demo is a link; nothing to keep alive during judging. |
| Boundary | C ABI of 14 functions (§7). JSON for rare structured data (world, commands, event log). One binary snapshot for per-frame data, read as typed-array views with no copy. | Small, stable contract between C++ and TypeScript. |
| Threading | Engine called synchronously on the main thread, time-sliced to ≤ 4 ms per frame. No Web Worker, no SharedArrayBuffer. | GitHub Pages cannot send the headers SharedArrayBuffer needs; the engine is fast enough without it. |
| Build | CMake ≥ 3.28, Ninja, `CMakePresets.json` with `native-debug`, `native-release`, `wasm-release`. | One command per target. |
| C++ deps | FetchContent, pinned: nlohmann/json 3.12.0, doctest 2.5.3, HiGHS 1.15.1 (native only, §10). | Header-only except HiGHS; nothing to install. |
| Front end | TypeScript, Vite, React, three.js, zustand, uPlot, Tailwind 4, vitest. npm; exact versions pinned in the lockfile at install. | Current stable releases; no map tiles or API keys needed. |
| Deploy | GitHub Actions: native build and tests → wasm build → web build → GitHub Pages. | Every push to `main` updates the demo link. |
| Quantities | `double`. Tonnes, hours, km, GJ, MWh, USD. Rates in t/h. | |
| Time | Fixed tick of 0.25 h (96 per day). Time is an integer tick count. | |

If a server is ever required, a native WebSocket host wraps the same C ABI; the engine does not change.

### Determinism rules (v0.2: same-platform reproducibility, not cross-platform bit-identity)

Cross-compiler bit-identity is not a hackathon requirement. The state hash gates regressions on one
platform (native CI), which is what replay, fork and the baseline twin actually need.

1. Own random generator (PCG32) and own distributions. Never `std::*_distribution` or `std::shuffle`.
2. Iterate by index in ID order. No iteration over unordered containers. Every sort uses a total order that ends in an ID tie-break.
3. Wall-clock time never enters the engine.
4. Compile with `-ffp-contract=off`. Never `-ffast-math` or `-march=native`.
5. Prefer the smoothstep (§5.2) and other closed forms; `exp`/`log`/`pow` are allowed where clarity wins, since cross-platform bit-identity is no longer required.
6. All mutable state lives in one copyable struct (§4.4), so a run can be forked, hashed, saved and replayed.

---

## 2. The model on one page

```
Network level   sites, route graph, pipelines, vehicles, orders        "who ships what to whom"
Plant level     a site's tanks and processes                           "how fast does it run"
Unit level      units inside a process, each a black-box balance       "what does each unit do"
```

Each level only talks to the one next to it.

| Term | Meaning |
|---|---|
| **Material** | A traded or internal stream, with a phase and the transport modes it may use. |
| **Site** | A location: a plant, a source, a demand centre or a port terminal. Owns tanks, processes and loading bays. |
| **Tank** | Inventory of one material at one site, with a capacity. All material that exists is in a tank or a vehicle. |
| **Process** | A chain of units that shares one operating rate. Has one or more modes (recipes). This is where the plant "decides" (§5.3). |
| **Unit** | One piece of equipment in a process (furnace bank, column, reactor, compressor). A black box with a mass and energy balance, a capacity, and N parallel **trains**. |
| **Train** | One of several identical parallel items in a unit (8 furnaces, 6 cell circuits). Losing trains is how partial outages happen. |
| **Pipeline** | A fixed link between two tanks with a flow capacity. No vehicle, no order. |
| **Route graph** | Nodes and edges for road, river and sea. Edges have a length and a speed and can be closed. |
| **Order** | "Move X tonnes of M from tank A to tank B." The instruction a vehicle carries out. |
| **Vehicle** | A truck, barge or ship that executes one order at a time through a fixed state machine. |

Sources and sinks are ordinary sites whose single process has no input (oil field) or no output (city fuel
demand), so one mechanism covers everything.

### Material flow

```
OIL_FIELD ──CRUDE──► REFINERY ──GASOLINE, DIESEL, JET, LPG──► fuel depots
                        ├──NAPHTHA────► STEAM_CRACKER (flex)
                        ├──PROPYLENE──► POLYPROPYLENE ──PP──► packaging, consumer goods
                        ├──BENZENE────► STYRENICS
                        └──SOLVENT────► paints and coatings

GAS_FIELD ──RAW_GAS──► GAS_PLANT ──METHANE──► gas grid
                        ├──ETHANE──► STEAM_CRACKER ──ETHYLENE──► POLYETHYLENE ──PE──► packaging
                        └──LPG─────► depots, cracker       ├────► VINYLS ──PVC──► construction
                                                           ├────► STYRENICS ──PS──► consumer goods
                                                           ├──PROPYLENE──► POLYPROPYLENE
                                                           └──BENZENE────► STYRENICS ──STYRENE──► paints

SALT_MINE ──SALT──► CHLOR_ALKALI ──CHLORINE──► VINYLS
                        └──CAUSTIC──► process industries

PORT_TERMINAL ◄──► OVERSEAS   imports any shortfall at a premium, exports any surplus at a discount
```

PVC and polystyrene each need two inputs from different plants. That is deliberate: a chlorine outage stops
PVC while ethylene is plentiful.

---

## 3. Catalog (static data, JSON files in `engine/data/catalog/`)

All numbers in this section are typical textbook values chosen so every balance closes. They are data, not
code, and are **to be reviewed by Erwin**. Prices and energy duties are placeholders of the right order of
magnitude.

### 3.1 Materials

Modes: P pipeline, S ship, B barge, T truck.

| Key | What | Phase | Modes | Base price $/t |
|---|---|---|---|---|
| `CRUDE` | Crude oil | liquid | P S | 520 |
| `RAW_GAS` | Wellhead gas | gas | P | 120 |
| `SALT` | Rock salt | solid | S B T | 50 |
| `METHANE` | Sales gas | gas | P | 180 |
| `ETHANE` | | liquefied gas | P S | 220 |
| `LPG` | Propane, butane, cracker C4s | liquefied gas | P S B T | 450 |
| `NAPHTHA` | Light naphtha, condensate | liquid | P S B T | 600 |
| `GASOLINE` | | liquid | P S B T | 750 |
| `JET` | | liquid | P S B T | 740 |
| `DIESEL` | | liquid | P S B T | 720 |
| `FUEL_OIL` | | liquid | S B T | 430 |
| `SOLVENT` | Toluene, xylenes | liquid | S B T | 850 |
| `BENZENE` | | liquid | S B T | 900 |
| `ETHYLENE` | | gas | P S | 900 |
| `PROPYLENE` | | liquefied gas | P S T | 850 |
| `CHLORINE` | | liquefied gas | P T | 300 |
| `CAUSTIC` | NaOH, dry basis | liquid | S B T | 400 |
| `STYRENE` | | liquid | S B T | 1,100 |
| `PE` | Polyethylene pellets | solid | S B T | 1,200 |
| `PP` | Polypropylene pellets | solid | S B T | 1,150 |
| `PVC` | PVC resin | solid | S B T | 950 |
| `PS` | Polystyrene pellets | solid | S B T | 1,400 |

- **Site-internal** (tank between two processes on one site, not traded in v1): `HEAVY_NAPHTHA`, `GASOIL`, `VGO` (refinery), `VCM` (vinyls).
- **Pseudo-materials** that close the balances: `FUEL_GAS` (burned on site, credited against heat duty at 48 GJ/t), `WATER` and `AIR_O2` (free inputs), `LOSS` (water, CO₂, coke, purge).
- Lower-case names in the tables below (`cracked`, `edc`) are streams internal to one process. They have no tank.

### 3.2 Plant presets

Every row is a unit. "In → out" is tonnes per tonne of the process basis. Heat is GJ and power is MWh per
tonne of basis. Each unit's trains together are sized at 110% of process nameplate, so a unit with 8 trains
loses little with one train down and a single-train unit trips the whole process.

Two rules the loader enforces: every unit balances in every mode, and every internal stream is produced and
consumed in equal amounts within its process. The net recipe of a process is derived from its units, never
written twice.

#### P1 `GAS_PLANT` — reference 20,000 t/d raw gas

Process `NGL_RECOVERY` · basis 1 t `RAW_GAS` · turndown 0.40 · ramp 20%/h · restart 12 h

| Unit | Trains | In → out | Heat | Power |
|---|---|---|---|---|
| `GP-AMINE` Amine treating and dehydration | 2 | RAW_GAS 1.000 → treated 0.960, LOSS 0.040 | 0.20 | 0.005 |
| `GP-CRYO` Cryogenic expander, demethaniser | 2 | treated 0.960 → METHANE 0.787, ygrade 0.173 | – | 0.030 |
| `GP-FRAC` NGL fractionation | 1 | ygrade 0.173 → ETHANE 0.078, LPG 0.074, NAPHTHA 0.021 | 0.30 | – |

#### P2 `REFINERY` — reference 27,000 t/d crude (about 200,000 bbl/d)

Four processes joined by on-site tanks, so one can be down while the others run until a tank fills or empties.

| Process (basis) | Turndown | Ramp | Restart | Unit | Trains | In → out | Heat | Power |
|---|---|---|---|---|---|---|---|---|
| `CRUDE_DISTILLATION` (1 t CRUDE) | 0.60 | 5%/h | 48 h | `RF-CDU` Atmospheric column | 1 | CRUDE 1.000 → LPG 0.020, NAPHTHA 0.070, HEAVY_NAPHTHA 0.130, JET 0.100, GASOIL 0.250, resid 0.430 | 0.70 | 0.005 |
| | | | | `RF-VDU` Vacuum column | 1 | resid 0.430 → VGO 0.250, FUEL_OIL 0.180 | 0.25 | – |
| `REFORMING` (1 t HEAVY_NAPHTHA) | 0.50 | 5%/h | 36 h | `RF-NHT` Naphtha hydrotreater | 1 | HEAVY_NAPHTHA 1.000 → treated 0.995, LOSS 0.005 | 0.30 | – |
| | | | | `RF-CCR` Catalytic reformer | 1 | treated 0.995 → reformate 0.850, LPG 0.080, FUEL_GAS 0.065 | 2.00 | 0.02 |
| | | | | `RF-BTX` Aromatics extraction | 1 | reformate 0.850 → GASOLINE 0.690, SOLVENT 0.100, BENZENE 0.060 | 1.00 | – |
| `FCC` (1 t VGO) | 0.60 | 5%/h | 72 h | `RF-FCC` Riser and regenerator | 1 | VGO 1.000 → vapour 0.950, LOSS 0.050 | – | 0.03 |
| | | | | `RF-FRAC` Main fractionator, gas plant | 1 | vapour 0.950 → GASOLINE 0.480, DIESEL 0.180, LPG 0.110, FUEL_OIL 0.070, FUEL_GAS 0.060, PROPYLENE 0.050 | 0.20 | – |
| `DIESEL_HDT` (1 t GASOIL) | 0.50 | 10%/h | 24 h | `RF-DHT` Diesel hydrotreater | 2 | GASOIL 1.000 → DIESEL 0.980, LOSS 0.020 | 0.30 | 0.01 |

Site slate per tonne of crude with everything running: gasoline 0.210, diesel 0.290, jet 0.100, fuel oil
0.198, naphtha 0.070, LPG 0.058, solvent 0.013, propylene 0.0125, benzene 0.0078, fuel gas and loss 0.042.

#### P3 `STEAM_CRACKER` — reference 5,500 t/d feed (about 1.5 Mt/y ethylene on ethane)

Process `OLEFINS` · basis 1 t fresh feed · turndown 0.65 · ramp 5%/h · restart 72 h · modes `ETHANE`, `LPG`, `NAPHTHA`.
Two variants: `gas` (ethane only) and `flex` (all three modes). The furnaces are the swing unit: each
furnace train is assigned a mode, and one train can change mode every 6 h.

| Unit | Trains | In → out | Heat (E / L / N) | Power |
|---|---|---|---|---|
| `SC-FURN` Pyrolysis furnaces | 8 | feed 1.000 → cracked 1.000 | 13.0 / 11.0 / 9.5 | – |
| `SC-QUENCH` Quench, primary fractionator | 1 | cracked 1.000 → quenched, FUEL_OIL | – | – |
| `SC-CGC` Cracked-gas compressor | 1 | quenched → compressed (same mass) | – | 0.12 |
| `SC-COLD` Chilling train and splitters | 1 | compressed → ETHYLENE, PROPYLENE, LPG, pygas, FUEL_GAS | – | 0.10 |
| `SC-BTX` Pygas hydrotreating, benzene extraction | 1 | pygas → BENZENE, GASOLINE | 0.05 | – |

Yields per tonne of feed, by mode:

| Product | `ETHANE` | `LPG` | `NAPHTHA` |
|---|---|---|---|
| ETHYLENE | 0.780 | 0.420 | 0.310 |
| PROPYLENE | 0.030 | 0.170 | 0.160 |
| LPG (C4s) | 0.030 | 0.050 | 0.090 |
| BENZENE | 0.007 | 0.025 | 0.075 |
| GASOLINE (pygas raffinate) | 0.013 | 0.045 | 0.145 |
| FUEL_GAS (hydrogen, methane) | 0.130 | 0.270 | 0.170 |
| FUEL_OIL | 0.010 | 0.020 | 0.050 |
| **Total** | 1.000 | 1.000 | 1.000 |

Switching to naphtha cuts ethylene per tonne of feed by more than half and raises benzene tenfold, so a gas
shortage reshapes the whole downstream slate.

#### P4 `CHLOR_ALKALI` — reference 1,370 t/d chlorine (500 kt/y)

Process `ELECTROLYSIS` · basis 1 t `CHLORINE` · turndown 0.30 · ramp 30%/h · restart 6 h

| Unit | Trains | In → out | Heat | Power |
|---|---|---|---|---|
| `CA-BRINE` Brine saturation and purification | 1 | SALT 1.648, WATER 0.508 → brine 2.156 | – | 0.02 |
| `CA-CELL` Membrane cell room | 6 | brine 2.156 → wet_cl2 1.000, catholyte 1.128, FUEL_GAS 0.028 | – | 2.40 |
| `CA-CL2` Chlorine drying, compression, liquefaction | 1 | wet_cl2 1.000 → CHLORINE 1.000 | – | 0.10 |
| `CA-EVAP` Caustic evaporation | 1 | catholyte 1.128 → CAUSTIC 1.128 | 0.80 | – |

Chlorine storage is limited to one day (hazard), and chlorine and caustic are made in a fixed ratio. If
caustic cannot be moved, chlorine stops.

#### P5 `POLYETHYLENE` — reference 1,370 t/d (500 kt/y) and P6 `POLYPROPYLENE` — reference 820 t/d (300 kt/y)

Process `PE_POLYMERISATION` · basis 1 t `PE` · turndown 0.50 · ramp 10%/h · restart 12 h. Polypropylene is
identical in structure with PROPYLENE 1.020 → PP 1.000, LOSS 0.020.

| Unit | Trains | In → out | Heat | Power |
|---|---|---|---|---|
| `PO-PURIF` Feed purification | 1 | ETHYLENE 1.015 → pure 1.015 | – | 0.01 |
| `PO-RX` Gas-phase reactor | 2 | pure 1.015 → powder 1.000, LOSS 0.015 | – | 0.15 |
| `PO-EXTR` Extruder and pelletiser | 2 | powder 1.000 → PE 1.000 | – | 0.25 |

#### P7 `VINYLS` — reference 1,640 t/d PVC (600 kt/y)

| Process (basis) | Turndown | Ramp | Restart | Unit | Trains | In → out | Heat | Power |
|---|---|---|---|---|---|---|---|---|
| `VCM` (1 t VCM) | 0.60 | 5%/h | 48 h | `VN-DC` Direct chlorination | 1 | ETHYLENE 0.232, CHLORINE 0.585 → edc 0.800, LOSS 0.017 | – | 0.01 |
| | | | | `VN-OXY` Oxychlorination | 1 | ETHYLENE 0.233, hcl 0.583, AIR_O2 0.135 → edc 0.790, LOSS 0.161 | – | 0.02 |
| | | | | `VN-CRACK` EDC cracking furnaces | 4 | edc 1.590 → crude 1.590 | 3.00 | – |
| | | | | `VN-PURIF` VCM purification, HCl column | 1 | crude 1.590 → VCM 1.000, hcl 0.583, LOSS 0.007 | 1.00 | – |
| `PVC` (1 t PVC) | 0.30 | 25%/h | 8 h | `VN-POLY` Suspension reactors | 8 | VCM 1.020 → slurry 1.020 | – | 0.10 |
| | | | | `VN-DRY` Stripping, centrifuge, dryer | 2 | slurry 1.020 → PVC 1.000, LOSS 0.020 | 1.50 | 0.10 |

Net for `VCM`: ETHYLENE 0.465 + CHLORINE 0.585 + AIR_O2 0.135 → VCM 1.000 + LOSS 0.185. The HCl made in
purification is consumed in oxychlorination, which the internal-stream rule checks.

#### P8 `STYRENICS` — reference 550 t/d styrene (200 kt/y)

| Process (basis) | Turndown | Ramp | Restart | Unit | Trains | In → out | Heat | Power |
|---|---|---|---|---|---|---|---|---|
| `STYRENE` (1 t STYRENE) | 0.60 | 5%/h | 36 h | `ST-ALK` Alkylation to ethylbenzene | 1 | BENZENE 0.780, ETHYLENE 0.285 → eb 1.050, LOSS 0.015 | 0.50 | – |
| | | | | `ST-DEHY` Dehydrogenation reactors | 2 | eb 1.050 → crude 1.030, FUEL_GAS 0.020 | 6.00 | – |
| | | | | `ST-DIST` Vacuum distillation | 1 | crude 1.030 → STYRENE 1.000, SOLVENT 0.020, LOSS 0.010 | 1.50 | 0.02 |
| `PS` (1 t PS) | 0.50 | 10%/h | 12 h | `ST-PS` Mass polymerisation, pelletising | 2 | STYRENE 1.010 → PS 1.000, LOSS 0.010 | 0.50 | 0.15 |

Styrene is sold both to the on-site `PS` process and to paints as monomer.

### 3.3 Other site presets

| Preset | Process | Notes |
|---|---|---|
| `OIL_FIELD` | → CRUDE | Rate from a supply schedule; shuts in when its export tank is full. |
| `GAS_FIELD` | → RAW_GAS | Pipeline to a gas plant. |
| `SALT_MINE` | → SALT | |
| `FUEL_DEPOT` | GASOLINE, DIESEL, JET, LPG → | One per city. Demand scales with population. |
| `GAS_GRID` | METHANE → | Pipeline only. |
| `PACKAGING` | PE, PP → | |
| `CONSTRUCTION` | PVC → | |
| `CONSUMER_GOODS` | PS, PP → | |
| `PAINTS_COATINGS` | SOLVENT, STYRENE → | |
| `PROCESS_INDUSTRIES` | CAUSTIC → | Alumina, pulp and paper, water treatment. |
| `PORT_TERMINAL` | none | Tanks only. Buys and sells the same material. Linked by sea to `OVERSEAS`, an off-map node 18 days away that sells anything at 1.25× base price and buys anything at 0.85×. Also takes FUEL_OIL for bunkering. |

Sinks consume at their demand rate whenever stock is on hand. What they could not consume is recorded as
unmet demand, which is the headline measure of damage.

### 3.4 Vehicle classes

| Class | Carries | Capacity t | Speed km/h | Load rate t/h | Freight $/t·km |
|---|---|---|---|---|---|
| `TRUCK_TANK` | liquids | 25 | 70 | 50 | 0.10 |
| `TRUCK_PRESS` | liquefied gases | 20 | 70 | 40 | 0.14 |
| `TRUCK_BULK` | solids | 25 | 70 | 50 | 0.10 |
| `BARGE_TANK` | liquids | 2,000 | 12 | 400 | 0.025 |
| `BARGE_DRY` | solids | 1,500 | 12 | 300 | 0.025 |
| `SHIP_TANK` | liquids | 40,000 | 26 | 2,500 | 0.004 |
| `SHIP_GAS` | liquefied gases | 12,000 | 30 | 800 | 0.008 |
| `SHIP_DRY` | solids | 20,000 | 24 | 1,000 | 0.005 |

Scale decides the mode: a cracker makes thousands of tonnes a day, so gases move by pipeline, bulk liquids
by ship and barge, and trucks carry pellets and small lots.

### 3.5 Unit glyphs (3D kit of parts)

Each unit names one glyph; a plant's 3D model is assembled from its unit list, so new presets need no
modelling. Glyphs are low-poly primitives: `column`, `furnace` (box and stack), `reactor`, `compressor_house`,
`exchanger_bank`, `cell_room`, `extruder_hall`, `sphere` (pressurised tank), `tank` (with a visible level),
`silo`, `cooling_tower`, `flare`, `jetty`, `truck_rack`, `pipe_rack`.

### 3.6 Extension presets (same schema, not in v1)

Ethylene oxide and glycol; aromatics to PET; ammonia and urea from methane; methanol; synthetic rubber from
C4s; a gas-fired power station (METHANE → power), which would close the energy loop.

### 3.7 Catalog file format (one process shown)

```json
{ "key": "PE_POLYMERISATION", "name": "Polyethylene polymerisation",
  "basis": "PE", "modes": ["DEFAULT"], "internal": ["pure", "powder"],
  "turndown": 0.50, "ramp_per_h": 0.10, "restart_h": 12,
  "units": [
    { "key": "PO-PURIF", "name": "Feed purification", "glyph": "column", "trains": 1,
      "recipes": [{ "in": {"ETHYLENE": 1.015}, "out": {"pure": 1.015}, "heat_gj": 0, "power_mwh": 0.01 }] },
    { "key": "PO-RX", "name": "Gas-phase reactor", "glyph": "reactor", "trains": 2,
      "recipes": [{ "in": {"pure": 1.015}, "out": {"powder": 1.000, "LOSS": 0.015}, "heat_gj": 0, "power_mwh": 0.15 }] },
    { "key": "PO-EXTR", "name": "Extruder and pelletiser", "glyph": "extruder_hall", "trains": 2,
      "recipes": [{ "in": {"powder": 1.000}, "out": {"PE": 1.000}, "heat_gj": 0, "power_mwh": 0.25 }] } ] }
```

---

## 4. Data structures (C++)

### 4.1 Conventions

- Three layers: **Catalog** (what kinds of things exist), **World** (this country; immutable during a run), **State** (everything that changes).
- Flat arrays indexed by typed 32-bit IDs. No pointers between simulation objects.
- `World` is shared and const. `State` is plain data: copying it forks the run.

```cpp
namespace crx {
template <class Tag> struct Id { uint32_t v = UINT32_MAX; };
using MaterialId = Id<struct MaterialTag>;   using SiteId    = Id<struct SiteTag>;
using TankId     = Id<struct TankTag>;       using ProcessId = Id<struct ProcessTag>;
using UnitId     = Id<struct UnitTag>;       using NodeId    = Id<struct NodeTag>;
using EdgeId     = Id<struct EdgeTag>;       using PipelineId= Id<struct PipelineTag>;
using VehicleId  = Id<struct VehicleTag>;    using OrderId   = Id<struct OrderTag>;
template <class I> struct Range { uint32_t begin = 0, count = 0; };
```

### 4.2 Catalog

```cpp
enum class Phase   : uint8_t { Liquid, LiquefiedGas, Gas, Solid };
enum class Mode    : uint8_t { Road, River, Sea, Pipeline };
enum class MatKind : uint8_t { Traded, SiteInternal, Pseudo };

struct Material { std::string key, name; Phase phase; MatKind kind;
                  uint8_t modes;                 // bitmask of Mode
                  double base_price, lhv_gj_t; };

struct Stream     { uint16_t slot; double t_per_t; };   // slot = material or process-local stream
struct UnitRecipe { std::vector<Stream> in, out; double heat_gj, power_mwh; };  // per tonne of basis
struct UnitSlot   { std::string key, name; uint8_t glyph, trains; double overdesign = 1.10;
                    std::vector<UnitRecipe> by_mode; double mtbf_h, mttr_h; };

struct ProcessType {
  std::string key, name;
  MaterialId basis;
  std::vector<std::string> modes;        // {"DEFAULT"} or {"ETHANE","LPG","NAPHTHA"}
  std::vector<std::string> internal;     // process-local stream names
  std::vector<UnitSlot> units;           // in flow order
  int    swing_unit = -1;                // unit whose trains choose the mode
  double turndown, ramp_per_h, restart_h, switch_h;
  bool   rations = true;                 // false for sinks
  std::vector<std::vector<Stream>> net;  // derived at load: external in (−) and out (+) per mode
};

enum class TankRole : uint8_t { Feed, Product, Internal, Both };
struct TankRule    { MaterialId m; TankRole role; double cover_days; double target_frac; };
struct SitePreset  { std::string key, name; std::vector<uint16_t> processes; std::vector<TankRule> tanks;
                     uint8_t bays[3];   // road, river, sea
                     double ref_nameplate_t_d; };
struct VehicleClass{ std::string key; Mode mode; Phase carries; double capacity_t, speed_kmh, load_t_h, freight; };
struct Catalog     { std::vector<Material> materials; std::vector<ProcessType> process_types;
                     std::vector<SitePreset> presets; std::vector<VehicleClass> vehicle_classes; };
```

### 4.3 World

```cpp
struct Terrain  { uint16_t n; float cell_km, sea_level; std::vector<float> height; };
struct Node     { float x_km, y_km; };
struct Edge     { NodeId a, b; Mode mode; float length_km, speed_kmh; Range<uint32_t> polyline; };

struct Site     { std::string name; uint16_t preset; float x_km, y_km; uint16_t region;
                  NodeId node[3];                 // road, river, sea; invalid if no access
                  uint8_t bays[3];
                  Range<TankId> tanks; Range<ProcessId> processes; };
struct Tank     { SiteId site; MaterialId m; TankRole role;
                  double capacity_t, target_frac;
                  double design_in_t_h, design_out_t_h;   // sums over the processes that use it
                  bool piped_in, piped_out; };
struct Process  { SiteId site; uint16_t type; double design_rate_t_h; Range<UnitId> units;
                  std::vector<TankId> tank_of;    // one per external stream in the net recipe
                  uint16_t schedule; };           // demand or supply curve for sinks and sources
struct Unit     { ProcessId process; uint8_t slot; double cap_per_train_t_h; };
struct Pipeline { TankId from, to; double cap_t_h; float length_km; Range<uint32_t> polyline; };
struct VehicleSpec { uint16_t cls; NodeId home; };
struct Contract { TankId buyer, seller; };        // preferred supplier

struct World { uint64_t seed; Catalog catalog; Terrain terrain;
               std::vector<Node> nodes; std::vector<Edge> edges; std::vector<float> polyline_xy;
               std::vector<Site> sites; std::vector<Tank> tanks; std::vector<Process> processes;
               std::vector<Unit> units; std::vector<Pipeline> pipelines;
               std::vector<VehicleSpec> fleet; std::vector<Contract> contracts;
               std::vector<std::vector<float>> schedules; };
```

### 4.4 State

```cpp
enum class ProcStatus : uint8_t { Running, HoldMin, Shutdown, Restarting };
enum class VehStatus  : uint8_t { Idle, ToPickup, QueueLoad, Loading, ToDropoff, QueueUnload, Unloading };
enum class OrdStatus  : uint8_t { Open, Assigned, Loaded, Delivered, Cancelled };

struct TankState    { double level_t, inbound_t, reserved_out_t;
                      double lead_time_h, pickup_gap_h, caution;   // learned (§5.8); caution ≥ 1
                      uint64_t next_eta_tick, last_pickup_tick; };
struct ProcState    { double rate_t_h; ProcStatus status; uint32_t timer;
                      uint8_t trains_by_mode[4]; uint32_t switch_timer; };
struct UnitState    { uint8_t trains_down; uint64_t back_at_tick; };
struct VehicleState { VehStatus status; OrderId order; MaterialId cargo; double cargo_t;
                      NodeId at; uint32_t path, leg; float leg_km, x_km, y_km, dir_x, dir_y; };
struct Order        { TankId from, to; MaterialId m; double qty_t, price; float urgency;
                      uint16_t cls; VehicleId vehicle; uint64_t created_tick, eta_tick; OrdStatus status; };
struct Ledger       { double revenue, feed_cost, freight, energy_cost, produced_t, consumed_t, unmet_t; };

struct State { uint64_t tick; Rng rng;
               std::vector<TankState> tank;   std::vector<ProcState> proc;  std::vector<UnitState> unit;
               std::vector<VehicleState> vehicle; std::vector<Order> order;
               std::vector<double> pipe_flow_t_h; std::vector<uint8_t> edge_open;
               std::vector<double> price;     std::vector<Ledger> ledger;
               std::vector<Event> pending;    Kpis kpi; };

struct Sim   { std::shared_ptr<const World> world; State state;
               Recorder rec; PathCache paths; };    // rec and paths are derived, not part of the hash
}  // namespace crx
```

---

## 5. Simulation

### 5.1 One tick, fixed order

| # | System | Does |
|---|---|---|
| 1 | `events` | Applies scheduled events, draws random failures, completes repairs. |
| 2 | `signals` | Turns every tank's state into 0–1 signals (§5.2). |
| 3 | `control` | Sets each process's rate and mode mix (§5.3). |
| 4 | `production` | Applies recipes: tanks down, tanks up, energy and money booked (§5.4). |
| 5 | `pipelines` | Continuous transfers (§5.5). |
| 6 | `procurement` | Hourly. Tanks raise requirements; the market turns them into orders (§5.6). |
| 7 | `dispatch` | Assigns idle vehicles to orders (§5.7). |
| 8 | `transport` | Moves vehicles, runs bay queues, loads and unloads (§5.7). |
| 9 | `accounting` | Price indices, ledgers, KPIs (§5.10). |
| 10 | `record` | Hourly history and event log; increments the tick. |

### 5.2 The S-curve and the tank signals

One function is used everywhere. It is a smoothstep, chosen over the logistic curve because it needs no transcendental functions (determinism rule 5) and its two parameters have plain meanings: at or below `lo` the signal is 0,
at or above `hi` it is 1.

```
S(x; lo, hi) = t²·(3 − 2t),   t = clamp((x − lo) / (hi − lo), 0, 1)
```

For each tank, with `D_out` the design draw of all processes that consume from it and `D_in` the design
make of all processes that fill it (both t/h):

| Signal | Formula | Defaults | Used for |
|---|---|---|---|
| Feed `f` | `S( (level / D_out) / gap )` where `gap` = hours to the next confirmed arrival, or `lead_time` if nothing is inbound | lo 0.25, hi 1.25 | Rationing: slow the process when stock on hand will not last until the next delivery. |
| Urgency `u` | `1 − S( ((level + inbound) / D_out) / (lead_time · caution) )` | lo 1.0, hi 2.5 | Ordering priority and bid price. |
| Room `h` | `S( ((capacity − level) / D_in) / pickup_gap )` | lo 0.10, hi 1.00 | Slow the process when its product tank is about to fill. |

For internal and pipeline-fed tanks, `gap` and `pickup_gap` are a fixed 4 h.

### 5.3 Process control

```
R_max    = min over units ( cap_per_train · trains_online / throughput_per_tonne_of_basis )
R_target = R_max · min( f of every feed tank, h of every product tank )
rate    += clamp( R_target − rate, −ramp · R_design · dt, +ramp · R_design · dt )
```

- **Units set the ceiling.** Losing a furnace train lowers `R_max`; losing a single-train unit sets it to zero.
- **The worst tank governs.** One empty feed or one full product is enough to slow the process.
- **Turndown.** If `R_target` is below `turndown · R_design`, the process goes to `HoldMin` and runs at minimum while the tanks can sustain it. When they cannot, it goes to `Shutdown`.
- **Restart.** From `Shutdown`, when every signal is back above 0.6 and every unit has a train, the process enters `Restarting` for `restart_h`, then resumes at minimum rate. The gap between the 0.6 restart threshold and the shutdown point prevents flicker.
- **Feed switching** (swing unit only). The desired share of trains per mode is proportional to that mode's feed signal. One train is reassigned per `switch_h`, and only when the desired and actual counts differ by a whole train.
- **Sinks** ignore the signals and consume `min(demand, stock)`. **Sources** run at `supply · h`.

### 5.4 Production

For each process, each tick: consume `in · rate · dt` from the bound tanks and add `out · rate · dt` to
them, summed over the mode mix. If any tank cannot supply or accept its share, the whole process is scaled
down for that tick so nothing goes negative or overflows. Energy is `Σ units (heat, power) · rate · dt`;
`FUEL_GAS` made on site is credited against the heat duty, and the remainder is bought at a fixed energy
price.

### 5.5 Pipelines

```
wanted = clamp( D_out(to) + (target(to) − level(to)) / 4 h, 0, cap )
flow   = min( wanted, level(from) / dt, (capacity(to) − level(to)) / dt )
```

Flow is instantaneous in v1 (pipeline transit is hours against days of inventory).

### 5.6 Procurement and market

**Each buy-side tank runs a reorder policy.** When `u > 0`, it asks for enough to bring stock on hand plus
inbound up to its target fill, cut into lots of one vehicle load.

**The market matches lots to sellers**, most urgent first:

```
candidates = (seller tank, vehicle class) with  level − reserved ≥ lot  and a route in that class's mode
cost       = ask + freight · km + u · V · eta_hours + (seller is the contract partner ? 0 : switch_cost)
ask        = base · (1 + β · (1 − 2 · seller_fill)),   bid = base · (1 + β · u),   price = (ask + bid) / 2
```

Defaults: `V` = $0.5 per tonne-hour, `switch_cost` = 5% of base price, `β` = 0.5. The cheapest candidate
wins and becomes an `Order`; the seller's stock is reserved and the buyer's `inbound` rises. A lot with no
candidate stays open and pushes the material's price index up.

Higher urgency weights arrival time more, so an anxious plant pays for a truck where a calm one waits for
a barge. Ports export by holding low-urgency buy tanks that only match sellers above 70% full.

### 5.7 Dispatch and transport

- **Dispatch.** Open orders in order of urgency take the idle vehicle of the right class that can reach the pickup soonest. If none is idle, the order waits.
- **Vehicle state machine.** `Idle → ToPickup → QueueLoad → Loading → ToDropoff → QueueUnload → Unloading → Idle`.
- **Travel.** Shortest path by time on the vehicle's mode, cached per (mode, from, to) and recomputed when an edge opens or closes. A vehicle whose route is cut re-plans from its current node, or waits if no route exists.
- **Bays.** Each site has a fixed number of bays per mode, served first come, first served. Loading and unloading move material between tank and vehicle at the class's load rate, tick by tick.
- **Delivery.** Completing an unload closes the order and feeds the buyer's lead-time estimate (§5.8).

### 5.8 Adaptation

| Parameter | Update | Limits |
|---|---|---|
| `lead_time` | Running average of observed order-to-delivery time, weight 0.2 on the newest. | 0.5× to 4× its initial value |
| `pickup_gap` | Running average of time between pickups from a product tank. | same |
| `caution` | Multiplied by 1.25 each time the tank runs dry and stops a process. Decays linearly back toward 1 with a 30-day time constant. | 1 to 2 |

`caution` stretches the urgency curve, so a plant that has been burned orders earlier and more. Across the
network this produces the bullwhip effect. The limits stop the network hoarding itself into oscillation. A
global switch turns adaptation off for comparison.

### 5.9 Events

| Event | Parameters |
|---|---|
| `unit_outage` | site, unit, trains down, duration |
| `site_shutdown` | site, duration |
| `region_storm` | centre, radius, duration: shuts sites, closes bays and sea edges inside the circle |
| `edge_closure` | edge or mode within a region, duration (low river, road closure) |
| `power_curtailment` | region, fraction, duration: caps every unit by its power draw |
| `demand_shock`, `supply_shock` | site, multiplier, duration |

Random failures are optional: each tick each unit loses a train with probability `trains_online · dt / mtbf`,
for a repair time drawn uniformly from 0.5–1.5 × `mttr`.

### 5.10 Measures

Service level (end demand met ÷ end demand), unmet demand in tonnes and dollars, production index (made ÷
design) per plant and overall, shutdown hours, stock-outs, hours from the event to each site's first drop
below 90% rate, number of sites affected, recovery time, freight and energy cost, and a price index per
material.

Every scenario also runs a **baseline twin**: the state is forked at the moment of the event and stepped
without it, so each measure is reported as a loss against the same world with no outage.

---

## 6. Layout generator (v0.2: template-based, metric-first)

Deterministic from a seed and a small parameter set (map 600 × 400 km, 8 cities, demand scale, target
utilisation 0.88, tank cover multipliers). Runs in the browser and natively; no solver. The simulation
consumes only positions, polylines and arc lengths — terrain is a render-time concern, derived from the
same seed for looks, never an input to the sim.

The reference topology of §2 is the template. The generator randomises within it, never outside it:

1. **Frame.** Sea occupies one map edge; `OVERSEAS` sits a fixed 18 ship-days out (~11,000 km at 26 km/h).
2. **Features.** One oil basin, one gas basin, one salt deposit placed by seed; a river enters the
   highlands and reaches the sea as a wiggled polyline; 8 cities on the remaining land with minimum
   spacing; populations follow a rank-size rule.
3. **Siting.** By rule, not search: refineries and crackers at ports; gas plants at the gas basin; polymer
   and derivative plants within 25 km of a cracker; chlor-alkali next to vinyls; sinks in cities; barge
   sites as nodes along the river polyline.
4. **Routes.** Every route is a polyline and every distance is arc length — never the Euclidean gap
   between sites. Roads: spanning tree plus nearest neighbours, straight segments with a deterministic
   wiggle worth roughly the 1.2–1.4 detour factor of real road networks. River: the polyline itself; two
   sites 40 km apart as the crow flies may be 150 km apart by barge — that asymmetry is what makes mode
   choice matter. Sea: coastal arcs between ports. Pipelines: straight, short, field → plant and cluster
   links as in v0.1.
5. **Sizing.** Walk materials from end products back to raw materials: required production = the sum of
   what consumers need, converted through the net recipes, co-products credited, residuals sent to the
   ports as import or export. Plant count = required ÷ reference nameplate, rounded up; capacity =
   required ÷ count ÷ utilisation.
6. **Tanks, fleet, contracts.** Tanks from cover days; vehicles per class from tonnes moved × round-trip
   time ÷ capacity, plus 20%; each buyer's contract is its cheapest feasible supplier.
7. **Feasibility gate.** Warm-up 20 days, then require the steady-state test (§12) on the seed; reject and
   reseed on failure. Also assert every site reaches every other in each available mode, and spot-check
   travel times (truck covers at most ~300 km of driving per day, barge pace, port leg ≈ 18 days). The
   gate is what makes every future random map trustworthy, not just the reference one.

**Reference world:** about 30 sites (2 oil fields, 3 gas fields, 1 salt mine, 3 gas plants, 2 refineries,
2 crackers of which one flex, 2 chlor-alkali, 3 polyethylene, 1 polypropylene, 2 vinyls, 1 styrenics,
2 port terminals, the rest demand centres), about 150 tanks, 60 processes, 200 vehicles and 12 pipelines.

A world can also be loaded from `world.json` in the same schema, which is the route to real plant data later.

---

## 7. Engine API and data contracts

### 7.1 C ABI (`engine/include/crx/api.h`)

```c
typedef struct crx_sim crx_sim;

crx_sim*       crx_create(const char* config_json);      /* {"seed":..,"gen":{..}} or {"world":{..}} */
crx_sim*       crx_fork(const crx_sim*);                  /* copies State, shares World */
void           crx_destroy(crx_sim*);
void           crx_step(crx_sim*, uint32_t ticks);
const char*    crx_command(crx_sim*, const char* json);   /* reply valid until the next call */
const char*    crx_world_json(const crx_sim*);            /* static description, read once */
const float*   crx_terrain(const crx_sim*, uint32_t* n);
const uint8_t* crx_snapshot(crx_sim*, uint32_t* bytes);   /* §7.3 */
const char*    crx_events(crx_sim*, uint64_t since_seq);  /* JSON array of log entries */
const float*   crx_series(crx_sim*, uint32_t kind, uint32_t id, uint32_t* n);  /* hourly history */
const double*  crx_kpis(crx_sim*, uint32_t* n);
uint64_t       crx_tick(const crx_sim*);
uint64_t       crx_state_hash(const crx_sim*);
const char*    crx_version(void);
```

### 7.2 Commands and log entries (JSON)

```json
{"cmd":"event","type":"unit_outage","site":12,"unit":"SC-CGC","trains":1,"duration_h":240}
{"cmd":"event","type":"region_storm","x_km":410,"y_km":95,"radius_km":60,"duration_h":120}
{"cmd":"set","key":"adaptive","value":false}
{"cmd":"override","type":"rate_cap","process":31,"frac":0.7,"duration_h":72}
{"cmd":"override","type":"force_supplier","buyer_tank":88,"seller_tank":41,"duration_h":240}
```

Overrides are the hooks an automated manager would use (§10). Log entries carry a sequence number, a tick
and a type: `order_created`, `order_delivered`, `stockout`, `tank_full`, `process_shutdown`,
`process_restart`, `unit_failed`, `unit_repaired`, `mode_switch`, `reroute`.

### 7.3 Snapshot (binary, little-endian, version 1)

Header: magic `CRXS`, version, tick, then a count and byte offset for each array. Arrays are 4-byte aligned.

| Array | Type × length | Content |
|---|---|---|
| tanks | f32 × 4 × nTanks | fill fraction, `f`, `u`, `h` |
| processes | f32 × nProc, u8 × nProc | rate ÷ design, status |
| units | u8 × nUnits | trains online |
| sites | u8 × nSites, f32 × nSites | status, worst urgency |
| vehicles | f32 × 5 × nVeh, u8 × 2 × nVeh, u32 × nVeh | x, y, dir x, dir y, fill; status, material; order |
| pipelines | f32 × nPipe | flow ÷ capacity |
| edges | u8 × nEdges | open |
| prices | f32 × nMaterials | price index |

The static world JSON maps every index to its name, geometry and catalog entry. A golden test decodes a
snapshot file written by the CLI in TypeScript.

---

## 8. Front end

```
web/src/engine/   wasm loader, typed wrapper over the C ABI, snapshot decoder
web/src/scene/    terrain, routes, sites, vehicles, picking, camera (three.js)
web/src/ui/       panels, charts, timeline (React)
web/src/state/    zustand stores: clock, selection, scenario, measures
```

**Frame loop.** Each frame advances the engine by `speed × elapsed` ticks within a 4 ms budget, reads the
snapshot, and renders. Speeds: 1 hour, 6 hours, 1 day and 1 week of simulated time per second. Vehicles are
interpolated between the last two snapshots.

**Scene.**

- Terrain mesh from the height grid, coloured by elevation, with a water plane.
- Roads, rivers and sea lanes as lines draped on the terrain. Pipelines as lines with a dash pattern that moves at a speed proportional to flow.
- Sites as instanced unit glyphs coloured by status (running, reduced, holding at minimum, shut down, restarting), with tanks that show their level. Far away, a site collapses to one icon with a status ring.
- Vehicles as one instanced mesh per class, coloured by cargo.
- Map-style camera (pan, zoom, tilt). Click to select a site, a unit or a vehicle.

**Panels.**

| Panel | Shows |
|---|---|
| Top bar | Clock, play and pause, speed, seed, scenario picker. |
| Break something | Pick a site and unit, set trains and duration; or drop a storm circle on the map. |
| Site inspector | Block diagram of each process generated from the catalog, with per-unit flows, energy and train status; tanks with level and days of cover; the S-curves with a live dot per tank; charts of rate, levels and urgency; open orders. |
| Vehicle inspector | Cargo, order, route, arrival time. |
| Timeline | Event markers, service level and production index against the baseline twin, price sparklines. |
| Shortage map | Materials × time heat map of unmet demand. |

---

## 9. Demo scenarios (JSON in `engine/data/scenarios/`)

| Scenario | Event | What it shows |
|---|---|---|
| Compressor trip | Cracked-gas compressor at the main cracker down 10 days | Ethylene runs short: polyethylene, PVC and styrene ration then stop in order of their cover. Upstream, ethane backs up and gas plants slow. Ports import. |
| Chlorine squeeze | Power curtailed to 40% at chlor-alkali for 14 days | PVC stops with ethylene plentiful; ethylene backs up; caustic customers run short. |
| Hurricane landfall | Coastal storm: sites shut 5 days, port and sea lanes closed 7 | Many failures at once; recovery limited by restart times and the vessel queue. |
| Low river | Barge edges closed 20 days | Freight shifts to trucks until the fleet saturates. |
| Gas shortfall | Gas field output halved for 30 days | The flex cracker moves furnaces to naphtha; ethylene falls, benzene and propylene rise. |

---

## 10. Benchmark and automated manager (stretch)

**Benchmark.** A linear program over daily steps with the same world and event: variables are process
rates, shipments (with transit lag), inventories and unmet demand; constraints are balances and capacities;
the objective is the least unmet demand at the lowest freight cost. Solved with HiGHS by `crx-cli oracle`
and shipped as JSON for the preset scenarios. It ignores turndown and has perfect foresight, so it is an
upper bound, and is labelled as one: "plants acting alone lost X; perfect coordination could not have lost
less than Y."

**Automated manager.** A language-model agent that reads a compact state summary and issues the override
commands of §7.2 during an outage, scored on the same measures against the plant rules and the benchmark.
Runs from the CLI; a browser version would need a small proxy for the API key.

---

## 11. Repository layout and build

```
CMakeLists.txt  CMakePresets.json
engine/
  include/crx/        api.h (C ABI), public types
  src/core/           ids, rng, scurve, hash
  src/catalog/        types, JSON loader, validator
  src/world/          types, worldgen/, world_io
  src/sim/            state, events, signals, control, production, pipelines,
                      procurement, dispatch, transport, accounting, recorder
  src/oracle/         linear program (native only)
  apps/cli/           crx-cli: gen, run, dump, bench, oracle
  apps/wasm/          Emscripten exports
  data/catalog/       materials.json, processes/*.json, presets.json, vehicles.json
  data/scenarios/     *.json
  tests/
web/                  Vite project (§8); public/ receives crx.js and crx.wasm
docs/                 OUTLINE.md, model notes
.github/workflows/    ci.yml
```

```
cmake --preset native-release && cmake --build --preset native-release && ctest --preset native-release
cmake --preset wasm-release   && cmake --build --preset wasm-release
cd web && npm ci && npm run dev
```

The catalog JSON is embedded in the engine at build time, so the WebAssembly file is self-contained.

---

## 12. Tests and invariants

| # | Test | Passes when |
|---|---|---|
| 1 | Catalog validation | Every unit balances in every mode to 1e-9; every internal stream nets to zero; every traded material has a producer and a consumer. |
| 2 | Mass conservation | Tanks + vehicle cargo + cumulative consumption and loss − cumulative supply is constant to 1e-9 relative, every tick. |
| 3 | Bounds | `0 ≤ level ≤ capacity`; rate is 0 or within `[turndown, R_max]`; no negative reservations. |
| 4 | Determinism | Same seed and commands give the same state hash natively (CI gate). Wasm hash checked once per release, not per commit. |
| 5 | Fork | A fork stepped with the same commands matches its parent. |
| 6 | Steady state | For seeds 1–20 with no events: after warm-up, service level ≥ 97%, every process within ±5% of its design rate, no stock-outs, for 60 days. |
| 7 | Cascade | Cracker outage: downstream processes drop after roughly their days of cover, upstream processes slow as tanks fill, and all recover after repair. |
| 8 | Speed | 90 days of the reference world in under 1 s in WebAssembly. |
| 9 | Snapshot | TypeScript decodes a CLI-written snapshot and matches the CLI's text dump. |
| 10 | Reachability and travel times | For 20 generated seeds: every site reaches every other in each available mode; spot-checked origin–destination travel times are plausible (truck day-distance, barge pace, port leg ≈ 18 days). |

Tests 2, 3 and 6 are the gate for merging any change to the simulation systems.

---

## 13. Milestones and work packages

| Milestone | Delivers | Done when |
|---|---|---|
| **M0 Contracts** | Repo layout, CMake presets, CI, catalog schema with loader and validator, core types, `api.h`, snapshot layout, a stub engine that animates fake data through the real API, a web shell that loads it. | CI green for native and web; the page shows the stub moving. |
| **M1 Plant core** | Signals, control, production, pipelines, events, recorder, CLI. A hand-written six-site world. | Tests 1–5 pass; a cracker outage in the six-site world starves downstream and backs up upstream in the CLI output. |
| **M2 Logistics** | Route graph, path cache, procurement, market, dispatch, vehicle state machine, bays, adaptation. | Test 2 passes with vehicles; the six-site world holds steady state. |
| **M3 Layout generator** | Template-based generator (§6) with the feasibility gate; full catalog (8 plant presets, sources, sinks, port). | Tests 6 and 10 pass on 20 generated seeds. |
| **M4 Front end** | Map, sites, vehicles, inspectors, timeline, scenario controls, baseline twin. | Three scenarios play end to end from the hosted link. |
| **M5 Depth** | 3D unit glyphs, block diagrams with per-unit balances, live S-curves, shortage map, feed switching, random failures. | |
| **M6 Stretch** | Benchmark, automated manager, extension presets, real-data loader. | |

M0 → M1 → M2 is a single spine and should have one owner, because those systems share state closely.
Everything else can run in parallel once M0 has fixed the contracts:

| Work package | Needs | Parallel with |
|---|---|---|
| Catalog JSON for each of the 8 presets (one package each) | M0 schema and validator | everything |
| World generator: terrain and rivers; siting and sizing; routes | M0 types | M1, M2 |
| Scene: terrain, routes, sites, vehicles | M0 stub engine | M1–M3 |
| Panels: inspectors, timeline, scenario controls | M0 stub engine | M1–M3 |
| Unit glyph kit | M0 | everything |
| Scenarios and the cascade test | M2, M3 | M4 |
| CI, Pages deploy, snapshot golden test | M0 | everything |
| Benchmark linear program | M3 | M4, M5 |

**48-hour slice plan** (demo-first ordering):

| Hours | Work |
|---|---|
| 0–4 | M0 contracts, presets, CI, toolchain (ninja, emsdk) |
| 4–16 | M1 core engine on the tiny world; tests 1–3 green |
| 16–28 | M2 logistics; six-site steady state |
| 28–38 | M3 layout generator + feasibility gate; reference world |
| 38–46 | M4 wasm + thin web scene + one scenario; Pages deploy live |
| 46–48 | Polish, README, demo script, buffer |

The web scene reads the same `world.json` and snapshots as the CLI, so M4 work starts as soon as M0's
contracts exist and runs in parallel whenever hands allow.

---

## 14. Risks and cut lines

| Risk | Mitigation |
|---|---|
| Control rules oscillate or hoard | Test 6 gates every change; limits on learned parameters; adaptation can be switched off. |
| Generated worlds do not balance | Ports absorb every residual; warm-up asserts steady state and rejects a bad seed. |
| The cascade is dull | Utilisation and days of cover are the two knobs; M1 exists to find this out early. |
| Numbers are challenged | All yields live in one reviewed data folder; the demo states the model's limits. |
| New major versions in the web stack | Exact versions pinned in the lockfile. |
| Debugging in WebAssembly | All logic is tested natively; the wasm target adds one thin export file. |

**Cut order if time runs short:** automated manager → benchmark → shortage map → random failures →
3D unit glyphs (use extruded blocks) → adaptation → feed switching (fix the cracker on ethane) →
barges (river freight moves by truck). M0–M4 with the first three scenarios is the submission.

---

## 15. Open items

1. **Erwin to review** the yields, turndowns, restart times and energy duties in §3.
2. **Tracks.** Once known, the framing (resilience, sustainability, AI) may reorder M5 and M6. The core does not change.
3. **No server** is assumed. Say so now if a track or sponsor requires a hosted back end.
4. **Name.** "Chain Reaction" and the `crx` prefix are placeholders.
