// Chain Reaction — the six-site M1 world (§13): a gas chain that makes the
// cascade visible. Chosen composition and why:
//
//   GAS_FIELD (GAS_PRODUCTION 635 t/h)
//     → GAS_PLANT (NGL_RECOVERY 635 t/h RAW_GAS basis)
//         makes METHANE 0.787, ETHANE 0.078, LPG 0.074, NAPHTHA 0.021 /t
//     → STEAM_CRACKER (OLEFINS_FLEX 99 t/h ETHANE basis, train mix 4/3/1
//       over ETHANE/LPG/NAPHTHA — the locked M1 mix)
//         makes ETHYLENE ≈ 0.587/t basis mixed, plus propylene, benzene,
//         gasoline, fuel oil and FUEL_GAS
//     → POLYETHYLENE (PE_POLYMERISATION 55 t/h) with the PACKAGING_PE sink
//       on-site (demand at the plant gate)
//     → GAS_GRID (GAS_GRID_METHANE sink 495 t/h)
//     → PORT_TERMINAL (FUEL_DEPOT_LPG 12, FUEL_DEPOT_GASOLINE 0.04,
//       PORT_BUNKER_FUEL_OIL 0.018 — exports for the co-products the
//       catalog has sinks for)
//
// PROPYLENE and BENZENE have no catalog sink in M1 (the catalog belongs to
// another workstream): they accumulate in 120-day tanks — the M1 test
// horizons (≤ 30 days) never reach the fill limit, and M2/M3 add the
// consumers. NAPHTHA is over-produced by ~1 t/h by design; its cracker tank
// has 60 days of cover for the same reason.
//
// Sizing intent: at design rates the world sits in a near-steady state
// (production index ≈ 1) with every tank drifting only slowly, so a cracker
// outage shows clean signatures — downstream (polyethylene) starves after
// roughly the ethylene tank's days of cover, and upstream (gas plant, gas
// field) backs up as product tanks fill.
#include "sim/sixsite.h"

#include "sim/validate.h"

namespace crx {
namespace sim {

namespace {

WorldSpec sixSiteSpec() {
  // Material closure (per-tonne yields from the §3 catalog): NGL_RECOVERY at
  // 615 t/h of RAW_GAS makes 484 METHANE (the gas-grid sink), 48 ETHANE (the
  // cracker's ETHANE-mode draw, 4/8 × 96), 45.5 LPG (36 cracker LPG-mode +
  // 9.5 port depot) and 12.9 NAPHTHA (12 cracker NAPHTHA-mode + a slow
  // buffer drift). The flex cracker at 96 t/h makes 56.3 ETHYLENE (PE eats
  // 55.8), 4.0 GASOLINE and 1.8 FUEL_OIL (the port depots); PROPYLENE and
  // BENZENE have no catalog sinks and sit in 120-day stranded tanks, and
  // the cracker's small LPG co-product drains to the port depot.
  WorldSpec spec;
  spec.sites.push_back(
      {"GAS_FIELD", "Gas field", 80, 260,
       {{"GAS_PRODUCTION", 635.0, {1}}},
       {{"RAW_GAS", TankRole::Product, 2.0, 0.7}}});

  spec.sites.push_back(
      {"GAS_PLANT", "Gas plant", 230, 230,
       {{"NGL_RECOVERY", 615.0, {1}}},
       {{"RAW_GAS", TankRole::Feed, 2.0, 0.7},
        {"METHANE", TankRole::Product, 3.0, 0.7},
        {"ETHANE", TankRole::Product, 5.0, 0.7},
        {"LPG", TankRole::Product, 10.0, 0.7},
        // NAPHTHA drains 12 of 12.9 t/h to the cracker; the ~0.9 t/h drift
        // needs ~90 days of headroom above the 70% start (sizing: cover ×
        // dominant flow, headroom = 30% of that).
        {"NAPHTHA", TankRole::Product, 22.0, 0.7}}});

  spec.sites.push_back(
      {"STEAM_CRACKER", "Steam cracker", 380, 170,
       {{"OLEFINS_FLEX", 96.0, {4, 3, 1}}},
       {{"ETHANE", TankRole::Feed, 5.0, 0.7},
        {"LPG", TankRole::Both, 5.0, 0.7},
        {"NAPHTHA", TankRole::Feed, 60.0, 0.7},
        {"ETHYLENE", TankRole::Product, 10.0, 0.7},
        // Stranded tanks have no drain, so the design's "120 days of
        // stranded storage" is headroom above the 70% start, not the whole
        // tank: cover 400 d × 30% free ≈ 120 days of surplus absorption.
        {"PROPYLENE", TankRole::Product, 400.0, 0.7},
        {"BENZENE", TankRole::Product, 400.0, 0.7},
        {"GASOLINE", TankRole::Product, 30.0, 0.7},
        {"FUEL_OIL", TankRole::Product, 30.0, 0.7}}});

  spec.sites.push_back(
      {"POLYETHYLENE", "Polyethylene plant", 500, 120,
       {{"PE_POLYMERISATION", 55.0, {1}}, {"PACKAGING_PE", 55.0, {1}}},
       {{"ETHYLENE", TankRole::Feed, 4.0, 0.7}, {"PE", TankRole::Both, 3.0, 0.7}}});

  spec.sites.push_back(
      {"PORT_TERMINAL", "Port terminal", 600, 40,
       {{"FUEL_DEPOT_LPG", 13.8, {1}},
        {"FUEL_DEPOT_GASOLINE", 4.0, {1}},
        {"PORT_BUNKER_FUEL_OIL", 1.8, {1}}},
       {{"LPG", TankRole::Feed, 10.0, 0.7},
        {"GASOLINE", TankRole::Feed, 10.0, 0.7},
        {"FUEL_OIL", TankRole::Feed, 10.0, 0.7}}});

  spec.sites.push_back(
      {"GAS_GRID", "Gas grid", 300, 320,
       {{"GAS_GRID_METHANE", 484.0, {1}}},
       {{"METHANE", TankRole::Feed, 2.0, 0.7}}});

  spec.pipes = {
      {"RAW_GAS", "GAS_FIELD/RAW_GAS", "GAS_PLANT/RAW_GAS", 700.0},
      {"METHANE", "GAS_PLANT/METHANE", "GAS_GRID/METHANE", 560.0},
      {"ETHANE", "GAS_PLANT/ETHANE", "STEAM_CRACKER/ETHANE", 60.0},
      {"LPG", "GAS_PLANT/LPG", "STEAM_CRACKER/LPG", 45.0},
      {"LPG", "GAS_PLANT/LPG", "PORT_TERMINAL/LPG", 20.0},
      {"NAPHTHA", "GAS_PLANT/NAPHTHA", "STEAM_CRACKER/NAPHTHA", 16.0},
      {"ETHYLENE", "STEAM_CRACKER/ETHYLENE", "POLYETHYLENE/ETHYLENE", 65.0},
      {"GASOLINE", "STEAM_CRACKER/GASOLINE", "PORT_TERMINAL/GASOLINE", 8.0},
      // FUEL_OIL deliberately moves by TRUCK_TANK (§13 M2): the port's
      // bunker tank is replenished through procurement, dispatch and road
      // transport so the logistics layer has a real lane to run.
  };

  // Roads (§4.3): a ring plus the direct cracker-port span. The direct
  // route and the cracker-polyethylene-port alternative give dispatch a
  // reroute to find when the direct road breaks (§5.7).
  spec.roads = {
      {"GAS_FIELD", "GAS_PLANT", 70.0},
      {"GAS_PLANT", "STEAM_CRACKER", 70.0},
      {"STEAM_CRACKER", "POLYETHYLENE", 70.0},
      {"POLYETHYLENE", "PORT_TERMINAL", 70.0},
      {"STEAM_CRACKER", "PORT_TERMINAL", 70.0},
      {"GAS_PLANT", "GAS_GRID", 70.0},
  };

  // Two tank trucks based at the cracker serve the fuel-oil lane; one truck
  // keeps up with the 1.8 t/h draw at design, the second covers queueing
  // and a broken-road detour.
  spec.fleet = {{"TRUCK_TANK", "STEAM_CRACKER"}, {"TRUCK_TANK", "STEAM_CRACKER"}};
  spec.contracts = {{"PORT_TERMINAL/FUEL_OIL", "STEAM_CRACKER/FUEL_OIL"}};

  spec.stranded_materials = {"PROPYLENE", "BENZENE"};
  return spec;
}

}  // namespace

bool buildSixSiteWorld(uint64_t seed, World& out, std::string& error) {
  Catalog catalog;
  if (!loadCatalogFromDir(CRX_DATA_DIR, catalog, error)) return false;

  const WorldSpec spec = sixSiteSpec();
  if (!buildWorld(catalog, seed, spec, out, error)) return false;
  return validateWorld(out, spec, error);
}

}  // namespace sim
}  // namespace crx
