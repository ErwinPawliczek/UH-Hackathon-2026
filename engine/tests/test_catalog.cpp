// Catalog tests (§12 test 1): load the full catalog from disk, run the
// validator, and re-check the §3.2 invariants independently — every unit
// balances in every mode to 1e-9, internal streams net to zero, net recipes
// are external-only and equal to the unit aggregation, and every traded
// material has a producer and a consumer.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include "crx/catalog.h"

#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

using namespace crx;

#ifndef CRX_CATALOG_DIR
#define CRX_CATALOG_DIR "engine/data/catalog"
#endif

namespace {

Catalog loadOrDie() {
  Catalog c;
  std::string err;
  REQUIRE_MESSAGE(loadCatalogFromDir(CRX_CATALOG_DIR, c, err),
                  "catalog load/validate failed:\n" << err);
  return c;
}

double externalNet(const ProcessType& p, size_t mode, const std::string& key) {
  double net = 0.0;
  for (const UnitSlot& u : p.units) {
    const UnitRecipe& r = u.by_mode[mode];
    for (const Stream& s : r.in)
      if (s.key == key) net -= s.t_per_t;
    for (const Stream& s : r.out)
      if (s.key == key) net += s.t_per_t;
  }
  return net;
}

}  // namespace

TEST_CASE("catalog: loads from disk and passes validation") {
  loadOrDie();
}

TEST_CASE("catalog: units balance in every mode to 1e-9") {
  const Catalog c = loadOrDie();
  for (const ProcessType& p : c.process_types) {
    for (size_t m = 0; m < p.modes.size(); ++m) {
      for (const UnitSlot& u : p.units) {
        const UnitRecipe& r = u.by_mode[m];
        double in = 0.0, out = 0.0;
        for (const Stream& s : r.in) in += s.t_per_t;
        for (const Stream& s : r.out) out += s.t_per_t;
        if (p.boundary == Boundary::None) {
          CHECK_MESSAGE(std::abs(in - out) <= kBalanceTol,
                        p.key << " " << p.modes[m] << " " << u.key
                              << ": in=" << in << " out=" << out);
        } else if (p.boundary == Boundary::Source) {
          const bool oneSidedOut = r.in.empty() && !r.out.empty();
          CHECK_MESSAGE(oneSidedOut,
                        p.key << " " << p.modes[m] << " " << u.key
                              << ": source recipe must be one-sided out");
        } else {
          const bool oneSidedIn = !r.in.empty() && r.out.empty();
          CHECK_MESSAGE(oneSidedIn,
                        p.key << " " << p.modes[m] << " " << u.key
                              << ": sink recipe must be one-sided in");
        }
      }
    }
  }
}

TEST_CASE("catalog: internal streams net to zero within their process") {
  const Catalog c = loadOrDie();
  for (const ProcessType& p : c.process_types) {
    for (size_t m = 0; m < p.modes.size(); ++m) {
      for (const std::string& name : p.internal) {
        const double net = externalNet(p, m, name);
        CHECK_MESSAGE(std::abs(net) <= kBalanceTol,
                      p.key << " " << p.modes[m] << ": internal '" << name
                            << "' nets to " << net);
      }
    }
  }
}

TEST_CASE("catalog: net recipes are derived and external-only") {
  const Catalog c = loadOrDie();
  for (const ProcessType& p : c.process_types) {
    REQUIRE(p.net.size() == p.modes.size());
    for (size_t m = 0; m < p.modes.size(); ++m) {
      for (const Stream& s : p.net[m]) {
        // External only: internal streams must have fully netted out.
        CHECK_MESSAGE(c.findMaterial(s.key) >= 0,
                      p.key << " " << p.modes[m] << ": net contains non-material '"
                            << s.key << "'");
        CHECK_MESSAGE(s.t_per_t != 0.0, p.key << ": zero net entry kept");
        CHECK_MESSAGE(std::abs(s.t_per_t - externalNet(p, m, s.key)) <= kBalanceTol,
                      p.key << " " << p.modes[m] << ": net '" << s.key
                            << "' does not match unit aggregation");
      }
    }
  }
}

TEST_CASE("catalog: per-preset and per-mode sweep") {
  const Catalog c = loadOrDie();
  for (const SitePreset& sp : c.site_presets) {
    for (uint16_t idx : sp.processes) {
      REQUIRE(idx < c.process_types.size());
      const ProcessType& p = c.process_types[idx];
      for (size_t m = 0; m < p.modes.size(); ++m) {
        for (const Stream& s : p.net[m]) {
          CHECK_MESSAGE(c.findMaterial(s.key) >= 0,
                        sp.key << " -> " << p.key << " " << p.modes[m]
                               << ": net stream '" << s.key << "' is not a material");
          CHECK_MESSAGE(std::abs(s.t_per_t - externalNet(p, m, s.key)) <= kBalanceTol,
                        sp.key << " -> " << p.key << " " << p.modes[m]
                               << ": net stream '" << s.key << "' mismatch");
        }
      }
    }
  }
  // Cross-references resolve both ways.
  for (const ProcessType& p : c.process_types)
    REQUIRE_MESSAGE(c.findMaterial(p.basis_key) >= 0,
                    p.key << ": basis does not resolve");
}

TEST_CASE("catalog: every traded material has a producer and a consumer") {
  const Catalog c = loadOrDie();
  for (size_t i = 0; i < c.materials.size(); ++i) {
    const Material& m = c.materials[i];
    if (m.kind != MatKind::Traded) continue;
    bool produced = false, consumed = false;
    for (const ProcessType& p : c.process_types) {
      for (size_t mm = 0; mm < p.modes.size(); ++mm) {
        for (const Stream& s : p.net[mm]) {
          if (s.slot != i) continue;
          produced |= s.t_per_t > 0.0;
          consumed |= s.t_per_t < 0.0;
        }
      }
    }
    CHECK_MESSAGE(produced, m.key << ": no producer process");
    CHECK_MESSAGE(consumed, m.key << ": no consumer process");
  }
}

TEST_CASE("catalog: outline section 3 spot values") {
  const Catalog c = loadOrDie();

  // §3.1: 22 traded materials; FUEL_GAS LHV 48 GJ/t.
  int traded = 0, internal = 0, pseudo = 0;
  for (const Material& m : c.materials) {
    switch (m.kind) {
      case MatKind::Traded: ++traded; break;
      case MatKind::SiteInternal: ++internal; break;
      case MatKind::Pseudo: ++pseudo; break;
    }
  }
  CHECK(traded == 22);
  CHECK(internal == 4);
  CHECK(pseudo == 4);
  const int fg = c.findMaterial("FUEL_GAS");
  REQUIRE(fg >= 0);
  CHECK(c.materials[size_t(fg)].lhv_gj_t == doctest::Approx(48.0));

  // §3.2 reference nameplates (t/d of basis) on the eight plant presets.
  const std::vector<std::pair<const char*, double>> nameplates = {
      {"GAS_PLANT", 20000}, {"REFINERY", 27000}, {"STEAM_CRACKER_GAS", 5500},
      {"STEAM_CRACKER_FLEX", 5500}, {"CHLOR_ALKALI", 1370}, {"POLYETHYLENE", 1370},
      {"POLYPROPYLENE", 820}, {"VINYLS", 1640}, {"STYRENICS", 550}};
  for (const auto& [key, t_d] : nameplates) {
    const int idx = c.findPreset(key);
    const std::string missing = std::string(key) + " missing from presets";
    const std::string mismatch = std::string(key) + ": reference nameplate mismatch";
    REQUIRE_MESSAGE(idx >= 0, missing);
    CHECK_MESSAGE(c.site_presets[size_t(idx)].ref_nameplate_t_d == doctest::Approx(t_d),
                  mismatch);
  }

  // Both cracker variants: the ethane cracker runs one mode, flex three.
  const int gas = c.findProcess("OLEFINS_GAS");
  const int flex = c.findProcess("OLEFINS_FLEX");
  REQUIRE(gas >= 0);
  REQUIRE(flex >= 0);
  CHECK(c.process_types[size_t(gas)].modes.size() == 1);
  const ProcessType& fp = c.process_types[size_t(flex)];
  REQUIRE(fp.modes.size() == 3);
  CHECK(fp.modes[0] == "ETHANE");
  CHECK(fp.modes[1] == "LPG");
  CHECK(fp.modes[2] == "NAPHTHA");

  // §3.2 per-mode furnace heat (13/11/9.5 GJ/t on the flex cracker) and
  // power lands per recipe.
  REQUIRE(flex >= 0);
  const ProcessType& fp2 = c.process_types[size_t(flex)];
  const UnitSlot& furn = *std::find_if(
      fp2.units.begin(), fp2.units.end(),
      [](const UnitSlot& x) { return x.key == "SC-FURN"; });
  CHECK(furn.by_mode[0].heat_gj == doctest::Approx(13.0));
  CHECK(furn.by_mode[1].heat_gj == doctest::Approx(11.0));
  CHECK(furn.by_mode[2].heat_gj == doctest::Approx(9.5));
  const UnitSlot& cell = *std::find_if(
      c.process_types[size_t(c.findProcess("ELECTROLYSIS"))].units.begin(),
      c.process_types[size_t(c.findProcess("ELECTROLYSIS"))].units.end(),
      [](const UnitSlot& x) { return x.key == "CA-CELL"; });
  CHECK(cell.by_mode[0].power_mwh == doctest::Approx(2.40));

  // §3.3: site presets exist and reference valid processes.
  for (const char* key :
       {"OIL_FIELD", "GAS_FIELD", "SALT_MINE", "GAS_PLANT", "REFINERY",
        "STEAM_CRACKER_GAS", "STEAM_CRACKER_FLEX", "CHLOR_ALKALI", "POLYETHYLENE",
        "POLYPROPYLENE", "VINYLS", "STYRENICS", "FUEL_DEPOT", "GAS_GRID", "PACKAGING",
        "CONSTRUCTION", "CONSUMER_GOODS", "PAINTS_COATINGS", "PROCESS_INDUSTRIES",
        "PORT_TERMINAL"}) {
    CHECK_MESSAGE(c.findPreset(key) >= 0, "missing site preset " << key);
  }
  const int vinyls = c.findPreset("VINYLS");
  REQUIRE(vinyls >= 0);
  CHECK(c.site_presets[size_t(vinyls)].processes.size() == 2);

  // §3.4: eight vehicle classes with spot values (TRUCK_TANK 25 t, 70 km/h;
  // BARGE_TANK 2000 t; SHIP_TANK 40000 t).
  REQUIRE(c.vehicle_classes.size() == 8);
  const auto truck = std::find_if(c.vehicle_classes.begin(), c.vehicle_classes.end(),
                                  [](const VehicleClass& v) { return v.key == "TRUCK_TANK"; });
  REQUIRE(truck != c.vehicle_classes.end());
  CHECK(truck->capacity_t == doctest::Approx(25.0));
  CHECK(truck->speed_kmh == doctest::Approx(70.0));
  CHECK(truck->freight == doctest::Approx(0.10));
  const auto barge = std::find_if(c.vehicle_classes.begin(), c.vehicle_classes.end(),
                                  [](const VehicleClass& v) { return v.key == "BARGE_TANK"; });
  REQUIRE(barge != c.vehicle_classes.end());
  CHECK(barge->capacity_t == doctest::Approx(2000.0));
  const auto ship = std::find_if(c.vehicle_classes.begin(), c.vehicle_classes.end(),
                                 [](const VehicleClass& v) { return v.key == "SHIP_TANK"; });
  REQUIRE(ship != c.vehicle_classes.end());
  CHECK(ship->capacity_t == doctest::Approx(40000.0));

  // Chlorine hazard note (§3.2): 1.0 day cover wherever it is stored.
  const int chlorAlkali = c.findPreset("CHLOR_ALKALI");
  REQUIRE(chlorAlkali >= 0);
  const int cl = c.findMaterial("CHLORINE");
  REQUIRE(cl >= 0);
  for (const TankRule& t : c.site_presets[size_t(chlorAlkali)].tanks) {
    if (t.m.v == uint32_t(cl)) CHECK(t.cover_days == doctest::Approx(1.0));
  }
}
