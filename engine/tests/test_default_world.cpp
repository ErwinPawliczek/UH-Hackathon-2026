// The default-world acceptance suite (PR #25). The default world is the
// hand-drawn layout (engine/data/catalog/worlds/erwin-world-v1.json), loaded
// exactly as drawn by the worldgen hand-drawn loader. These tests re-validate
// it with the real-Sim warm-up gate and a 60-day no-event run, so catalog or
// layout drift turns them red.
//
// KNOWN AS-DRAWN LIMITATION (do not remove until fixed in the design file):
// propylene is pipeline-only in the catalog and no pipeline reaches the
// polypropylene plant, so the PP chain (PP_POLYMERISATION and the
// PACKAGING_PP / CONSUMER_GOODS_PP sinks it feeds) is unsuppliable as drawn.
// The suite excludes exactly those process types and documents the gap; when
// a drawn pipeline lands, drop the exclusion set back to {}.
#include "crx/api.h"
#include "sim/genworld.h"
#include "sim/sim.h"
#include "world/worldgen/HandDrawn.h"
#include "world/worldgen/WorldGen.h"

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include <fstream>
#include <memory>
#include <set>
#include <sstream>
#include <string>
#include <vector>

#ifndef CRX_CATALOG_DIR
#define CRX_CATALOG_DIR "."
#endif

using namespace crx;

namespace {

constexpr uint32_t kTicksPerHour = 4;  // kTickHours = 0.25

// The one documented as-drawn gap (see file comment).
const std::set<std::string>& unsuppliableTypes() {
  static const std::set<std::string> kTypes{"PP_POLYMERISATION", "PACKAGING_PP",
                                            "CONSUMER_GOODS_PP"};
  return kTypes;
}

bool loadHandDrawnWorld(worldgen::GeneratedWorld& out, std::string& error) {
  crx::Catalog catalog;
  if (!loadCatalogFromDir(CRX_CATALOG_DIR, catalog, error)) return false;
  std::vector<worldgen::HandDrawnGap> gaps;
  return worldgen::loadHandDrawnWorld(std::string(CRX_CATALOG_DIR) + "/worlds/erwin-world-v1.json",
                                      worldgen::makeCatalogView(catalog), out, gaps, error);
}

// End-demand sinks (Boundary::Sink not hosted on the port) and plant
// processes (Boundary::None) with their feed tanks — the warm-up gate's
// classes, computed on a built sim world. Processes whose type is on the
// documented unsuppliable list are excluded from the checks.
struct ProcClasses {
  std::vector<char> endDemand, plant, excluded;
  std::vector<std::vector<uint32_t>> feedTanks;
};

ProcClasses classify(const sim::World& w) {
  ProcClasses c;
  const size_t n = w.processes.size();
  c.endDemand.assign(n, 0);
  c.plant.assign(n, 0);
  c.excluded.assign(n, 0);
  c.feedTanks.assign(n, {});
  const auto sitePresetKey = [&](uint32_t site) -> std::string {
    const int preset = w.sites[site].preset;
    return preset >= 0 ? w.catalog.site_presets[static_cast<size_t>(preset)].key : std::string{};
  };
  for (size_t p = 0; p < n; ++p) {
    const ProcessType& type = w.catalog.process_types[w.processes[p].type];
    if (unsuppliableTypes().count(type.key) != 0) {
      c.excluded[p] = 1;  // documented as-drawn gap — see the file comment
      continue;
    }
    if (type.boundary == Boundary::Sink && sitePresetKey(w.processes[p].site.v) != "PORT_TERMINAL") {
      c.endDemand[p] = 1;
    } else if (type.boundary == Boundary::None) {
      c.plant[p] = 1;
    }
    for (size_t m = 0; m < type.net.size(); ++m)
      for (const auto& s : type.net[m])
        if (s.t_per_t < 0 && s.slot < w.processes[p].tank_of.size()) {
          const uint32_t tank = w.processes[p].tank_of[s.slot].v;
          if (tank < w.tanks.size()) c.feedTanks[p].push_back(tank);
        }
  }
  return c;
}

}  // namespace

TEST_CASE("the hand-drawn default world passes the real-Sim warm-up gate") {
  worldgen::GeneratedWorld gen;
  std::string error;
  REQUIRE(loadHandDrawnWorld(gen, error));

  // The shipped validation: the same gate every preset must survive. Red here
  // means the catalog or the drawn file drifted out of balance.
  const std::vector<std::string> errors = sim::realSimWarmup(gen, worldgen::CatalogView{});
  std::string joined;
  for (const std::string& e : errors) joined += e + "; ";
  REQUIRE_MESSAGE(errors.empty(), joined);
}

TEST_CASE("the default world holds 60 days: end-demand service and plant health") {
  worldgen::GeneratedWorld gen;
  std::string error;
  REQUIRE(loadHandDrawnWorld(gen, error));

  Catalog catalog;
  REQUIRE(loadCatalogFromDir(CRX_CATALOG_DIR, catalog, error));
  sim::World world;
  REQUIRE(sim::buildGeneratedWorld(catalog, gen, world, error));
  auto shared = std::make_shared<const sim::World>(std::move(world));
  auto sim = sim::Sim::fromWorld(shared, error);
  REQUIRE(sim != nullptr);

  const sim::World& w = sim->world();
  const ProcClasses cls = classify(w);
  const size_t nProc = w.processes.size();

  // Per-day starved-tick counts per end-demand sink: a trailing 7-day window
  // at each checkpoint must show >=95% service (fewer than 5% starved ticks).
  std::vector<std::vector<uint32_t>> starvedPerDay(7, std::vector<uint32_t>(nProc, 0));
  uint32_t feedLimitedTicks = 0;  // plant processes starving on empty feeds, whole run

  uint32_t done = 0;
  const uint32_t checkpoints[3] = {7, 30, 60};
  for (uint32_t ci = 0; ci < 3; ++ci) {
    const uint32_t target = checkpoints[ci] * 24 * kTicksPerHour;
    while (done < target) {
      const uint32_t daySlot = static_cast<uint32_t>((done / (24 * kTicksPerHour)) % 7);
      for (uint32_t t = 0; t < 24 * kTicksPerHour; ++t) {
        sim->step(1);
        const sim::State& st = sim->state();
        for (size_t p = 0; p < nProc; ++p) {
          if (cls.endDemand[p] != 0 && st.sink_starved[p] != 0) ++starvedPerDay[daySlot][p];
          if (cls.plant[p] != 0 && st.proc[p].status != sim::ProcStatus::Running) {
            for (const uint32_t tank : cls.feedTanks[p])
              if (st.tank[tank].level_t <= 1e-6) {
                ++feedLimitedTicks;
                break;
              }
          }
        }
        ++done;
        if (done >= target) break;
      }
    }
    uint32_t worst = 0;
    std::string worstWhere;
    for (size_t p = 0; p < nProc; ++p) {
      if (cls.endDemand[p] == 0) continue;
      uint32_t starved = 0;
      for (const auto& day : starvedPerDay) starved += day[p];
      if (starved > worst) {
        worst = starved;
        worstWhere = w.sites[w.processes[p].site.v].name + "/" +
                     w.catalog.process_types[w.processes[p].type].key;
      }
    }
    const uint32_t window = 7 * 24 * kTicksPerHour;
    CHECK_MESSAGE(worst * 20 < window, "end-demand sink ", worstWhere, " served <95% over days ",
                  checkpoints[ci] - 6, "-", checkpoints[ci], " (", worst, "/", window,
                  " starved ticks)");
    for (auto& day : starvedPerDay) day.assign(nProc, 0);
  }
  CHECK_MESSAGE(feedLimitedTicks == 0, "plant processes ran feed-limited for ", feedLimitedTicks,
                " ticks across 60 days");
}

TEST_CASE("the default world simulates deterministically") {
  crx_sim* a = crx_create("{}");
  REQUIRE_MESSAGE(a != nullptr, crx_last_error());
  crx_sim* b = crx_create("{}");
  REQUIRE(b != nullptr);
  crx_step(a, 96);
  crx_step(b, 96);
  CHECK(crx_state_hash(a) == crx_state_hash(b));
  crx_destroy(a);
  crx_destroy(b);
}
