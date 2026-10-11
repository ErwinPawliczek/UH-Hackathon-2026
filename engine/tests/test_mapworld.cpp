// Chain Reaction — named map worlds (sim/worldfile.h) over the hand-drawn
// default world, engine/data/worlds/erwin-world-v1.json.
//
//   M1 the file loads with the drawn layout: sites, presets, pipelines,
//      one connected road network, river and sea access where the bays say
//   M2 two days step clean: finite, in bounds, mass conserved every tick
//   M3 determinism: same seed, same state hash
//   M4 a bad name or a malformed file is an error, never a crash
//   M5 market settings and per-tank lead times come through from the file
//   M6 no "world" key still means the six-site world, unchanged
//   M7 every unit can pass 110 % of its process's design rate (capacity
//      and R_max use the same per-unit throughput), in both worlds
//   M8 dispatch queue order: urgency first by default; with a boost, first
//      come first served with urgency worth a bounded head start
//
// The 60-day service gate is deliberately not here: it belongs with the
// tuned rates, not with the loader.
#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN

#include <doctest/doctest.h>

#include "sim/dispatch.h"
#include "sim/inspect.h"
#include "sim/routes.h"
#include "sim/sim.h"
#include "sim/window.h"
#include "sim/words.h"
#include "sim/worldfile.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <filesystem>
#include <fstream>
#include <array>
#include <map>
#include <memory>
#include <set>
#include <sstream>
#include <string>

using namespace crx;
using namespace crx::sim;
using json = nlohmann::json;

namespace {

constexpr double kTol = 1e-9;
const char* const kWorld = "erwin-world-v1";
const char* const kModes[kModeCount] = {"road", "river", "sea"};

std::string readWorldFile() {
  std::ifstream in(std::string(CRX_WORLDS_DIR) + "/" + kWorld + ".json", std::ios::binary);
  REQUIRE_MESSAGE(static_cast<bool>(in), "cannot open the world file");
  std::ostringstream buf;
  buf << in.rdbuf();
  return buf.str();
}

std::unique_ptr<Sim> makeMapSim(uint64_t seed = 42) {
  std::string error;
  const std::string cfg =
      json{{"seed", seed}, {"world", kWorld}}.dump();
  auto sim = Sim::createFromConfig(cfg.c_str(), error);
  REQUIRE_MESSAGE(sim != nullptr, "createFromConfig failed: " << error);
  return sim;
}

// Stock on hand: tanks plus whatever the vehicles are carrying.
double stockSum(const State& st) {
  double s = 0;
  for (const TankState& t : st.tank) s += t.level_t;
  for (const VehicleState& v : st.vehicle) s += v.cargo_t;
  return s;
}

double conservationScale(const State& st) {
  return std::max({1.0, stockSum(st), st.cum_supplied_t, st.cum_consumed_t, st.cum_loss_t});
}

bool loadsFromText(const std::string& text, std::string& error) {
  World w;
  return buildWorldFromJson("test-world", text, 42, w, error);
}

}  // namespace

// ---------------------------------------------------------------------------
TEST_CASE("M1: the drawn world loads — sites, presets, pipelines, networks") {
  World w;
  std::string error;
  REQUIRE_MESSAGE(buildNamedWorld(kWorld, 42, w, error), error);
  const json file = json::parse(readWorldFile(), nullptr, true, true);

  CHECK(w.name == kWorld);
  CHECK(w.w_km == doctest::Approx(600));
  CHECK(w.h_km == doctest::Approx(400));
  REQUIRE(w.sites.size() == 22);

  // Every plant preset is on the map (the steam cracker in both variants).
  std::set<std::string> presets;
  for (const Site& s : w.sites) {
    REQUIRE_MESSAGE(s.preset >= 0, s.key << " has no preset");
    presets.insert(w.catalog.site_presets[static_cast<size_t>(s.preset)].key);
  }
  for (const char* p : {"GAS_PLANT", "REFINERY", "STEAM_CRACKER_GAS", "STEAM_CRACKER_FLEX",
                        "CHLOR_ALKALI", "POLYETHYLENE", "POLYPROPYLENE", "VINYLS", "STYRENICS"})
    CHECK_MESSAGE(presets.count(p) == 1, "preset " << p << " is missing");

  // Nine pipelines, each along its drawn path.
  REQUIRE(w.pipelines.size() == 9);
  for (const Pipeline& pl : w.pipelines) {
    CHECK(pl.polyline.count >= 2);
    CHECK(rangeEnd(pl.polyline) * 2 <= w.polyline_xy.size());
  }

  // Water mask: the drawn cells, on the file's grid.
  CHECK(w.water_cell_km == doctest::Approx(10));
  CHECK(w.water.size() == static_cast<size_t>(w.water_cols) * w.water_rows);
  CHECK(static_cast<size_t>(std::count(w.water.begin(), w.water.end(), 1)) ==
        file.at("water").size());

  // The graph is small and well formed.
  CHECK(w.nodes.size() < 400);
  std::set<std::tuple<int, uint32_t, uint32_t>> pairs;
  for (const RouteEdge& e : w.edges) {
    REQUIRE(e.a < w.nodes.size());
    REQUIRE(e.b < w.nodes.size());
    CHECK(e.a != e.b);
    CHECK(e.speed_kmh > 0);
    CHECK(e.polyline.count >= 2);
    const double straight = std::hypot(w.nodes[e.a].x_km - w.nodes[e.b].x_km,
                                       w.nodes[e.a].y_km - w.nodes[e.b].y_km);
    CHECK(e.length_km >= straight - 1e-6);
    CHECK_MESSAGE(pairs.insert({modeIndex(e.mode), std::min(e.a, e.b), std::max(e.a, e.b)}).second,
                  "two edges join nodes " << e.a << " and " << e.b);
  }

  // Access: a node per mode exactly where the file gives the site bays.
  for (size_t s = 0; s < w.sites.size(); ++s) {
    const Site& site = w.sites[s];
    const json& bays = file.at("sites").at(s).at("bays");
    for (int m = 0; m < kModeCount; ++m) {
      const bool wanted = bays.value(kModes[m], 0) > 0;
      const uint32_t node = site.node[static_cast<size_t>(m)];
      CHECK_MESSAGE((node != kNoNode) == wanted, site.key << " " << kModes[m] << " access");
      CHECK(site.bays[static_cast<size_t>(m)] == bays.value(kModes[m], 0));
      if (node != kNoNode) {
        REQUIRE(node < w.nodes.size());
        CHECK(w.nodes[node].site == static_cast<int>(s));
      }
    }
    // Every site is on at least one network (water-only terminals have no road).
    CHECK_MESSAGE((site.node[0] != kNoNode || site.node[1] != kNoNode || site.node[2] != kNoNode),
                  site.key << " is on no network");
  }

  // One network per mode: the sites sharing a mode all reach each other in
  // it, and each mode serves more than one site.
  State st;
  st.edge_open.assign(w.edges.size(), 1);
  PathCache paths;
  refreshPaths(w, st, paths);
  const Mode modes[kModeCount] = {Mode::Road, Mode::River, Mode::Sea};
  for (int m = 0; m < kModeCount; ++m) {
    int on_mode = 0;
    for (const Site& a : w.sites) {
      if (a.node[static_cast<size_t>(m)] == kNoNode) continue;
      ++on_mode;
      for (const Site& b : w.sites) {
        if (b.node[static_cast<size_t>(m)] == kNoNode) continue;
        const double h = travelHours(w, paths, modes[m], a.node[static_cast<size_t>(m)],
                                     b.node[static_cast<size_t>(m)]);
        CHECK_MESSAGE(std::isfinite(h), "no " << kModes[m] << " route from " << a.key << " to " << b.key);
      }
    }
    CHECK_MESSAGE(on_mode >= 2, kModes[m] << " serves " << on_mode << " site(s)");
  }

  // The fleet starts on real nodes at its home sites.
  auto sim = makeMapSim();
  const World& sw = sim->world();
  REQUIRE(sim->state().vehicle.size() == sw.fleet.size());
  CHECK(sw.fleet.size() > 0);
  for (size_t v = 0; v < sw.fleet.size(); ++v) {
    const uint32_t at = sim->state().vehicle[v].at_node;
    REQUIRE(at < sw.nodes.size());
    CHECK(sw.nodes[at].site == static_cast<int>(sw.fleet[v].home.v));
  }
}

// ---------------------------------------------------------------------------
TEST_CASE("M2: two days step clean — finite, in bounds, mass conserved") {
  auto sim = makeMapSim();
  const World& w = sim->world();

  const double initial_stock = stockSum(sim->state());
  double prev_stock = initial_stock, prev_supplied = 0, prev_consumed = 0, prev_loss = 0;
  for (uint32_t tick = 0; tick < 2 * 96; ++tick) {
    sim->step(1);
    const State& st = sim->state();
    const double stock = stockSum(st);
    const double residual = (stock - prev_stock) - ((st.cum_supplied_t - prev_supplied) -
                                                    (st.cum_consumed_t - prev_consumed) -
                                                    (st.cum_loss_t - prev_loss));
    CHECK_MESSAGE(std::fabs(residual) <= kTol * conservationScale(st),
                  "tick " << tick << ": conservation residual " << residual << " t");
    prev_stock = stock;
    prev_supplied = st.cum_supplied_t;
    prev_consumed = st.cum_consumed_t;
    prev_loss = st.cum_loss_t;
  }

  const State& st = sim->state();
  for (size_t t = 0; t < w.tanks.size(); ++t) {
    const double level = st.tank[t].level_t;
    REQUIRE_MESSAGE(std::isfinite(level), w.tanks[t].key << " level is not finite");
    CHECK_MESSAGE(level >= -kTol, w.tanks[t].key << " level " << level << " below zero");
    CHECK_MESSAGE(level <= w.tanks[t].capacity_t + kTol, w.tanks[t].key << " over capacity");
    CHECK(st.tank[t].reserved_out_t >= -kTol);
    CHECK(st.tank[t].inbound_t >= -kTol);
  }
  for (size_t p = 0; p < w.processes.size(); ++p) {
    const double rate = st.proc[p].rate_t_h;
    REQUIRE(std::isfinite(rate));
    CHECK(rate >= -kTol);
    CHECK(rate <= w.processes[p].design_rate_t_h + kTol);
  }
  for (const VehicleState& v : st.vehicle) {
    CHECK(std::isfinite(v.x_km));
    CHECK(std::isfinite(v.y_km));
    CHECK(v.cargo_t >= -kTol);
  }
  std::vector<double> kpis;
  sim->computeKpis(kpis);
  for (const double k : kpis) CHECK(std::isfinite(k));
  const double net =
      initial_stock + st.cum_supplied_t - st.cum_consumed_t - st.cum_loss_t - stockSum(st);
  CHECK(std::fabs(net) <= kTol * conservationScale(st));
}

// ---------------------------------------------------------------------------
TEST_CASE("M3: determinism — the same seed gives the same state hash") {
  auto a = makeMapSim(7);
  auto b = makeMapSim(7);
  a->step(2 * 96);
  b->step(96);
  b->step(96);
  CHECK(a->stateHash() == b->stateHash());
  // A fork stepped alongside its parent stays identical too.
  Sim fork(*a);
  a->step(48);
  fork.step(48);
  CHECK(a->stateHash() == fork.stateHash());
}

// ---------------------------------------------------------------------------
TEST_CASE("M4: bad names and malformed files are errors, not crashes") {
  World w;
  std::string error;
  for (const char* name : {"", "../catalog/materials", "Erwin-World", "a/b", "no-such-world",
                           "erwin world", "x.json"}) {
    error.clear();
    CHECK_FALSE(buildNamedWorld(name, 42, w, error));
    CHECK_MESSAGE(!error.empty(), "no message for name '" << name << "'");
    CHECK(w.sites.empty());
  }

  for (const char* text : {"", "not json", "[1,2,3]", "{}", "{\"sites\":[]}", "{\"sites\":7}",
                           "{\"sites\":[{\"key\":\"A\"}]}", "{\"sites\":[{\"key\":\"bad key\"}]}",
                           "{\"format\":2,\"sites\":[]}"}) {
    error.clear();
    CHECK_FALSE(loadsFromText(text, error));
    CHECK_MESSAGE(!error.empty(), "no message for " << text);
  }
  const std::string good = readWorldFile();
  CHECK_FALSE(loadsFromText(good.substr(0, good.size() / 2), error));  // truncated

  // The real file with one thing broken at a time.
  auto broken = [&](const char* what, void (*edit)(json&)) {
    json doc = json::parse(good, nullptr, true, true);
    edit(doc);
    std::string err;
    CHECK_MESSAGE(!loadsFromText(doc.dump(), err), what << " was accepted");
    CHECK_MESSAGE(!err.empty(), what << " gave no message");
  };
  REQUIRE(loadsFromText(good, error));
  broken("unknown process", [](json& d) { d["sites"][0]["processes"][0]["type"] = "NOPE"; });
  broken("unknown material", [](json& d) { d["sites"][0]["tanks"][0]["material"] = "NOPE"; });
  broken("unknown preset", [](json& d) { d["sites"][0]["preset"] = "NOPE"; });
  broken("bad role", [](json& d) { d["sites"][0]["tanks"][0]["role"] = "sideways"; });
  broken("negative rate", [](json& d) { d["sites"][0]["processes"][0]["design_t_h"] = -1; });
  broken("duplicate site", [](json& d) { d["sites"].push_back(d["sites"][0]); });
  broken("pipeline to nowhere", [](json& d) { d["pipelines"][0]["to"] = "NOWHERE"; });
  broken("bad point", [](json& d) { d["network"][0]["points"][0] = "x"; });
  broken("unknown mode", [](json& d) { d["network"][0]["mode"] = "hyperloop"; });
  broken("unknown vehicle", [](json& d) { d["fleet"][0]["class"] = "ZEPPELIN"; });
  broken("unknown home", [](json& d) { d["fleet"][0]["home"] = "NOWHERE"; });
  broken("unknown market key", [](json& d) { d["market"] = {{"betta", 0.5}}; });
  // Bays with no strip in reach, and a vehicle based where its mode has no access.
  broken("river bays off the river", [](json& d) {
    for (json& s : d["sites"])
      if (s["key"] == "OIL_FIELD") s["bays"]["river"] = 1;
  });
  broken("barge based off the river", [](json& d) {
    d["fleet"].push_back({{"class", "BARGE_TANK"}, {"home", "OIL_FIELD"}, {"count", 1}});
  });

  // Through the session config as well.
  CHECK(Sim::createFromConfig("{\"world\":\"no-such-world\"}", error) == nullptr);
  CHECK(!error.empty());
  CHECK(Sim::createFromConfig("{\"world\":5}", error) == nullptr);
  CHECK(Sim::createFromConfig("{\"world\":\"../x\"}", error) == nullptr);
}

// ---------------------------------------------------------------------------
TEST_CASE("M5: market settings and tank lead times come from the file") {
  json doc = json::parse(readWorldFile(), nullptr, true, true);
  doc["market"] = {{"min_lot_cap_frac", 0.8}, {"min_lot_target_frac", 0.4}, {"beta", 0.25},
                   {"value_of_time_usd_t_h", 1.5}, {"switch_cost_frac", 0.0},
                   {"max_lots_per_tank", 8}, {"dispatch_urgency_boost_h", 48}};
  doc["sites"][0]["tanks"][0]["lead_time_h"] = 36.0;
  doc["sites"][0]["tanks"][0]["pickup_gap_h"] = 9.0;
  doc["sites"][0]["tanks"][0]["init_frac"] = 0.25;
  // The last tank of the last site states neither: it must get the defaults.
  json& plain = doc["sites"].back()["tanks"].back();
  plain.erase("lead_time_h");
  plain.erase("pickup_gap_h");
  World w;
  std::string error;
  REQUIRE_MESSAGE(buildWorldFromJson("test-world", doc.dump(), 42, w, error), error);
  CHECK(w.market.min_lot_cap_frac == doctest::Approx(0.8));
  CHECK(w.market.min_lot_target_frac == doctest::Approx(0.4));
  CHECK(w.market.beta == doctest::Approx(0.25));
  CHECK(w.market.value_of_time_usd_t_h == doctest::Approx(1.5));
  CHECK(w.market.switch_cost_frac == doctest::Approx(0.0));
  CHECK(w.market.max_lots_per_tank == doctest::Approx(8));
  CHECK(w.market.dispatch_urgency_boost_h == doctest::Approx(48));
  CHECK(w.tanks[0].init_lead_time_h == doctest::Approx(36.0));
  CHECK(w.tanks[0].init_pickup_gap_h == doctest::Approx(9.0));
  CHECK(w.tanks[0].init_frac == doctest::Approx(0.25));
  // Untouched tanks keep the defaults.
  CHECK(w.tanks.back().init_lead_time_h == doctest::Approx(24.0));
  CHECK(w.tanks.back().init_pickup_gap_h == doctest::Approx(4.0));
}

// ---------------------------------------------------------------------------
TEST_CASE("M6: no world key is still the six-site world") {
  std::string error;
  auto plain = Sim::create(42, error);
  REQUIRE(plain != nullptr);
  auto cfg = Sim::createFromConfig("{\"seed\":42}", error);
  REQUIRE(cfg != nullptr);
  auto named = Sim::createFromConfig("{\"seed\":42,\"world\":\"sixsite\"}", error);
  REQUIRE(named != nullptr);
  CHECK(cfg->world().name == "sixsite");
  CHECK(cfg->world().sites.size() == 6);
  plain->step(96);
  cfg->step(96);
  named->step(96);
  CHECK(plain->stateHash() == cfg->stateHash());
  CHECK(plain->stateHash() == named->stateHash());
}

// ---------------------------------------------------------------------------
TEST_CASE("M7: every unit passes 110 % of its process's design rate") {
  std::string error;
  auto six = Sim::create(42, error);
  REQUIRE(six != nullptr);
  auto map = makeMapSim();
  for (const Sim* sim : {six.get(), map.get()}) {
    const World& w = sim->world();
    for (size_t p = 0; p < w.processes.size(); ++p) {
      const Process& proc = w.processes[p];
      const ProcessType& type = w.catalog.process_types[proc.type];
      for (uint32_t u = proc.units.begin; u < rangeEnd(proc.units); ++u) {
        const UnitSlot& slot = type.units[w.units[u].slot];
        // What control.cpp's R_max makes of this unit with all trains online.
        const double r_max =
            w.units[u].cap_per_train_t_h * slot.trains /
            unitThroughputPerBasis(slot, proc.mode_share);
        CHECK_MESSAGE(r_max == doctest::Approx(1.10 * proc.design_rate_t_h),
                      w.name << " " << w.sites[proc.site.v].key << "/" << type.key << " unit "
                             << slot.key << ": R_max " << r_max << " vs design "
                             << proc.design_rate_t_h);
      }
    }
  }

  // What the client shows as a unit's load: its inflow at the process's
  // design rate and mode mix, against what its trains can pass. With every
  // train online that is 100/110 for every unit, never above (the flex
  // cracker's pygas unit read 801% while capacity was sized on the ethane
  // mode alone and the cracker ran mostly on naphtha).
  for (const Sim* sim : {six.get(), map.get()}) {
    const World& w = sim->world();
    for (size_t p = 0; p < w.processes.size(); ++p) {
      const Process& proc = w.processes[p];
      const ProcessType& type = w.catalog.process_types[proc.type];
      if (type.boundary != Boundary::None) continue;
      size_t active_modes = 0, only_mode = 0;
      for (size_t m = 0; m < proc.mode_share.size(); ++m)
        if (proc.mode_share[m] > 0.0) {
          ++active_modes;
          only_mode = m;
        }
      for (uint32_t u = proc.units.begin; u < rangeEnd(proc.units); ++u) {
        const UnitSlot& slot = type.units[w.units[u].slot];
        double inflow = 0;  // t/h into the unit at design
        for (size_t m = 0; m < slot.by_mode.size() && m < proc.mode_share.size(); ++m)
          for (const Stream& s : slot.by_mode[m].in)
            inflow += s.t_per_t * proc.mode_share[m] * proc.design_rate_t_h;
        const double capacity = w.units[u].cap_per_train_t_h * slot.trains;
        if (inflow > 0)
          CHECK_MESSAGE(inflow / capacity == doctest::Approx(1.0 / 1.10),
                        w.name << " " << w.sites[proc.site.v].key << "/" << type.key << " unit "
                               << slot.key << ": load " << inflow / capacity);
        CHECK(inflow <= capacity * (1.0 / 1.10) * (1.0 + 1e-9));
        // A plant that runs one mode is sized exactly as before: 110% of
        // design times that mode's in-sum, to the last bit.
        if (active_modes == 1) {
          double in = 0;
          for (const Stream& s : slot.by_mode[only_mode].in) in += s.t_per_t;
          if (!(in > 0.0)) in = 1.0;
          CHECK(w.units[u].cap_per_train_t_h == 1.10 * proc.design_rate_t_h * in / slot.trains);
        }
      }
    }
  }
  // The unit that showed it: the flex cracker's pygas train, on the map's 1:1:6 mix.
  {
    const World& w = map->world();
    bool found = false;
    for (uint32_t u = 0; u < w.units.size(); ++u) {
      const Process& proc = w.processes[w.units[u].process.v];
      const ProcessType& type = w.catalog.process_types[proc.type];
      if (type.key != "OLEFINS_FLEX" || type.units[w.units[u].slot].key != "SC-BTX") continue;
      found = true;
      const double mix = (1 * 0.02 + 1 * 0.07 + 6 * 0.22) / 8.0;  // pygas per tonne of feed
      CHECK(unitThroughputPerBasis(type.units[w.units[u].slot], proc.mode_share) ==
            doctest::Approx(mix));
      CHECK(w.units[u].cap_per_train_t_h == doctest::Approx(1.10 * proc.design_rate_t_h * mix));
    }
    CHECK(found);
  }

  // And in the run: with no outage, no plant on the map is held below its
  // design rate by its own units (electrolysis and VCM were, at 51 % and
  // 69 %, when capacity ignored the unit's throughput per basis tonne).
  map->step(96);
  const World& w = map->world();
  for (size_t p = 0; p < w.processes.size(); ++p) {
    const std::string& key = w.catalog.process_types[w.processes[p].type].key;
    if (key != "ELECTROLYSIS" && key != "VCM") continue;
    CHECK_MESSAGE(map->state().proc[p].rate_t_h > 0.9 * w.processes[p].design_rate_t_h,
                  key << " runs at " << map->state().proc[p].rate_t_h << " of "
                      << w.processes[p].design_rate_t_h << " t/h after one day");
  }
}

// ---------------------------------------------------------------------------
TEST_CASE("M8: dispatch queue order — urgency first, or first come with a head start") {
  // Two open fuel-oil lots on the six-site world's truck lane, one idle
  // truck: which lot gets it? Returns the order index that was assigned.
  auto assigned = [](uint64_t created_a, double urgency_a, uint64_t created_b, double urgency_b,
                     double boost_h) {
    std::string error;
    auto sim = Sim::create(42, error);
    REQUIRE(sim != nullptr);
    const World& w = sim->world();
    State& st = sim->state();
    const int from = w.findTank("STEAM_CRACKER/FUEL_OIL");
    const int to = w.findTank("PORT_TERMINAL/FUEL_OIL");
    const int cls = w.catalog.findVehicle("TRUCK_TANK");
    REQUIRE(from >= 0);
    REQUIRE(to >= 0);
    REQUIRE(cls >= 0);
    REQUIRE(st.vehicle.size() == 2);
    st.vehicle[1].status = VehStatus::ToDropoff;  // only vehicle 0 is free
    st.tick = 2000;
    const uint64_t created[2] = {created_a, created_b};
    const double urgency[2] = {urgency_a, urgency_b};
    for (int i = 0; i < 2; ++i) {
      Order o;
      o.from = static_cast<uint32_t>(from);
      o.to = static_cast<uint32_t>(to);
      o.material = w.tanks[static_cast<size_t>(from)].material;
      o.qty_t = 25;
      o.price = 1;
      o.urgency = urgency[i];
      o.cls = static_cast<uint16_t>(cls);
      o.created_tick = created[i];
      st.order.push_back(o);
    }
    PathCache paths;
    stepDispatch(w, st, paths, sim->recorder(), boost_h);
    int got = -1, count = 0;
    for (size_t i = 0; i < st.order.size(); ++i)
      if (st.order[i].status == OrdStatus::Assigned) {
        got = static_cast<int>(i);
        ++count;
      }
    CHECK(count == 1);
    return got;
  };

  // Default: the urgent lot wins however long the other has waited.
  CHECK(assigned(0, 0.1, 1600, 0.9, -1.0) == 1);
  // 48 h boost: a lot 400 h older is served first...
  CHECK(assigned(0, 0.1, 1600, 0.9, 48.0) == 0);
  // ...but urgency still jumps a queue it is less than its head start behind
  // (0.8 x 48 h = 38.4 h; here the urgent lot is 25 h younger).
  CHECK(assigned(0, 0.1, 100, 0.9, 48.0) == 1);
  // Equal urgency: plain first come first served.
  CHECK(assigned(40, 0.5, 8, 0.5, 48.0) == 1);
  // Boost 0: age alone decides.
  CHECK(assigned(0, 0.1, 4, 1.0, 0.0) == 0);
}

TEST_CASE("M9: a window of a run accounts for exactly that stretch") {
  auto sim = makeMapSim();
  REQUIRE(sim);
  sim->step(960);  // day 10
  REQUIRE(sim->command(R"({"type":"unit_outage","site":"CRACKER_ETHANE","unit":"SC-CGC",)"
                       R"("trains":1,"duration_h":240})")
              .find("\"ok\":true") != std::string::npos);

  const uint64_t parent_hash = sim->stateHash();
  std::vector<double> k0, k1;
  sim->computeKpis(k0);

  Sim future(*sim);  // the window runs on a copy: the run itself is untouched
  const WindowReport r = runWindow(future, 30 * 96);
  future.computeKpis(k1);
  CHECK(sim->stateHash() == parent_hash);
  CHECK(sim->state().tick == 960);
  CHECK(r.from_tick == 960);
  CHECK(r.to_tick == 960 + 30 * 96);

  // Totals are the window's own, and they add up from the per-customer rows.
  double demand = 0, served = 0;
  for (const WindowCustomer& c : r.customers) {
    demand += c.demand_t;
    served += c.served_t;
    CHECK(c.served_t <= c.demand_t + 1e-6);
  }
  CHECK(r.customers.size() == 15);
  CHECK(demand == doctest::Approx(r.demand_t).epsilon(1e-9));
  CHECK(demand - served == doctest::Approx(r.unmet_t).epsilon(1e-6));
  CHECK(r.unmet_t == doctest::Approx(k1[1] - k0[1]).epsilon(1e-9));
  CHECK(r.unmet_usd == doctest::Approx(k1[2] - k0[2]).epsilon(1e-9));
  CHECK(r.freight_usd == doctest::Approx(k1[6] - k0[6]).epsilon(1e-9));
  CHECK(r.energy_usd == doctest::Approx(k1[7] - k0[7]).epsilon(1e-9));
  CHECK(r.inventory_usd_start > 0);
  CHECK(r.inventory_usd_end > 0);

  // The shutdown-hours KPI now counts: it equals the plants' hours down.
  double down = 0;
  bool cracker_down = false, pe_down = false;
  for (const WindowPlant& pl : r.plants) {
    down += pl.down_h;
    const Process& proc = sim->world().processes[pl.process];
    const std::string site = sim->world().sites[proc.site.v].key;
    if (site == "CRACKER_ETHANE" && pl.down_h >= 240) {
      cracker_down = true;
      CHECK(pl.first_down_tick == 961);  // the tick after the command
    }
    if (site == "POLYETHYLENE" && pl.down_h > 0) pe_down = pl.first_down_tick > 961;
  }
  CHECK(cracker_down);
  CHECK(pe_down);
  CHECK(down > 240);
  CHECK(r.shutdown_h == doctest::Approx(down).epsilon(1e-9));
  CHECK(k1[4] - k0[4] == doctest::Approx(down).epsilon(1e-9));
  CHECK(k0[4] == 0.0);  // nothing was down in the first ten undisturbed days

  // The JSON names sites and processes and marks "never" as null.
  const json doc = json::parse(windowJson(sim->world(), r));
  CHECK(doc.at("customers").size() == 15);
  CHECK(doc.at("plants").size() == r.plants.size());
  CHECK(doc.at("totals").at("shutdown_h").get<double>() == doctest::Approx(down));
  bool saw_null = false;
  for (const json& pl : doc.at("plants")) saw_null = saw_null || pl.at("first_down_tick").is_null();
  CHECK(saw_null);
}

TEST_CASE("M10: every vehicle on the map world can say where it is going") {
  auto sim = makeMapSim();
  REQUIRE(sim);
  const World& w = sim->world();
  const std::set<std::string> statuses = {"idle", "to_pickup", "queue_load", "loading",
                                          "to_dropoff", "queue_unload", "unloading"};
  size_t travelling = 0, loaded = 0;
  for (int hour = 0; hour < 96; ++hour) {
    sim->step(4);
    const State& st = sim->state();
    for (uint32_t v = 0; v < st.vehicle.size(); ++v) {
      const std::string text = vehicleJson(w, st, v);
      REQUIRE(!text.empty());
      const json doc = json::parse(text);
      const std::string status = doc.at("status").get<std::string>();
      REQUIRE(statuses.count(status) == 1);
      CHECK(doc.at("index") == v);
      if (status == "idle") {
        CHECK(doc.at("order").is_null());
        CHECK(doc.at("path").empty());
        continue;
      }
      REQUIRE(doc.at("order").is_object());
      const json& order = doc.at("order");
      CHECK(order.at("from").at("site") != order.at("to").at("site"));
      const bool to_pickup = status == "to_pickup" || status == "queue_load" || status == "loading";
      CHECK(doc.at("legDestination").at("site") ==
            (to_pickup ? order.at("from") : order.at("to")).at("site"));
      if (!doc.at("cargo").is_null()) {
        ++loaded;
        CHECK(doc.at("cargo").at("material") == order.at("material"));
        CHECK(doc.at("cargo").at("tonnes").get<double>() <=
              doc.at("capacityT").get<double>() + 1e-9);
      }
      if (status != "to_pickup" && status != "to_dropoff") {
        CHECK(doc.at("path").empty());
        continue;
      }
      const json& path = doc.at("path");
      REQUIRE(!path.empty());
      ++travelling;
      // Starts at the vehicle, ends on the destination site's node in its
      // mode, and is as long as the distance it says is left.
      CHECK(path.front() == doc.at("position"));
      const VehicleClass& vc = w.catalog.vehicle_classes[w.fleet[v].cls];
      const uint32_t dest_site = doc.at("legDestination").at("site").get<uint32_t>();
      const RouteNode& node = w.nodes[w.sites[dest_site].node[modeIndex(vc.mode)]];
      CHECK(path.back().at(0).get<double>() == doctest::Approx(node.x_km));
      CHECK(path.back().at(1).get<double>() == doctest::Approx(node.y_km));
      double length = 0;
      for (size_t i = 1; i < path.size(); ++i)
        length += std::hypot(path[i].at(0).get<double>() - path[i - 1].at(0).get<double>(),
                             path[i].at(1).get<double>() - path[i - 1].at(1).get<double>());
      CHECK(length == doctest::Approx(doc.at("remainingKm").get<double>()).epsilon(1e-6));
      CHECK(doc.at("remainingKm").get<double>() <= doc.at("tripKm").get<double>() + 1e-6);
    }
  }
  CHECK(travelling > 100);
  CHECK(loaded > 50);
  CHECK(vehicleJson(w, sim->state(), static_cast<uint32_t>(w.fleet.size())).empty());
}

TEST_CASE("M11: the economy view adds up to the order book and the running totals") {
  auto sim = makeMapSim();
  REQUIRE(sim);
  const World& w = sim->world();

  // Nothing has happened yet: no buckets, no rows.
  const json empty = json::parse(economyJson(w, sim->state(), sim->recorder(), 24));
  CHECK(empty.at("buckets") == 0);
  CHECK(empty.at("materials").empty());
  CHECK(empty.at("totals").at("spendUsd").empty());

  sim->step(60 * 96);
  const State& st = sim->state();
  const json doc = json::parse(economyJson(w, st, sim->recorder(), 24));
  const size_t n = doc.at("buckets").get<size_t>();
  CHECK(n == 60);
  CHECK(doc.at("tick") == 60 * 96);
  CHECK(doc.at("bucketH") == 24);
  const auto sum = [](const json& arr) {
    double s = 0;
    for (const json& v : arr) s += v.get<double>();
    return s;
  };
  const double tol = 0.01 * static_cast<double>(n);  // each bucket is rounded to the cent

  // Per material: tonnes ordered, dollars spent and tonnes delivered match
  // the order book, bucket arrays are all N long.
  std::map<std::string, std::array<double, 4>> book;  // ordered, spend, delivered, freight
  double freight_book = 0;
  for (const Order& o : st.order) {
    if (o.status == OrdStatus::Cancelled) continue;
    auto& b = book[w.catalog.materials[o.material].key];
    b[0] += o.qty_t;
    b[1] += o.qty_t * o.price;
    if (o.status == OrdStatus::Delivered) {
      b[2] += o.qty_t;
      b[3] += o.freight_usd;
      freight_book += o.freight_usd;
      CHECK(o.delivered_tick >= o.created_tick);
      CHECK(o.km > 0.0);
    }
  }
  CHECK(doc.at("materials").size() == book.size());
  CHECK(book.size() >= 15);
  for (const json& m : doc.at("materials")) {
    const auto& b = book.at(m.at("key").get<std::string>());
    for (const char* key : {"orderedT", "lots", "spendUsd", "freightUsd", "deliveredT", "priceIndex"})
      CHECK(m.at(key).size() == n);
    CHECK(std::abs(sum(m.at("orderedT")) - b[0]) <= tol);
    CHECK(std::abs(sum(m.at("spendUsd")) - b[1]) <= tol);
    CHECK(std::abs(sum(m.at("deliveredT")) - b[2]) <= tol);
    CHECK(std::abs(sum(m.at("freightUsd")) - b[3]) <= tol);
    for (const json& idx : m.at("priceIndex")) {
      CHECK(idx.get<double>() >= 0.25);
      CHECK(idx.get<double>() <= 4.0);
    }
    CHECK(m.at("basePriceUsdT").get<double>() > 0.0);
  }

  // By class and in total: freight equals the engine's running total, and
  // every other total is the accumulator it came from.
  double class_freight = 0, class_tonnes = 0, delivered_tonnes = 0;
  for (const json& c : doc.at("byClass")) {
    class_freight += sum(c.at("freightUsd"));
    class_tonnes += sum(c.at("tonnes"));
    CHECK(sum(c.at("tonneKm")) > 0.0);
  }
  for (const auto& entry : book) delivered_tonnes += entry.second[2];
  CHECK(doc.at("byClass").size() == 7);  // every class in the fleet has delivered
  CHECK(std::abs(class_freight - freight_book) <= 7 * tol);
  CHECK(std::abs(class_tonnes - delivered_tonnes) <= 7 * tol);
  const json& totals = doc.at("totals");
  CHECK(std::abs(sum(totals.at("freightUsd")) - st.cum_freight_usd) <= tol);
  CHECK(std::abs(sum(totals.at("energyUsd")) - st.cum_energy_usd) <= tol);
  CHECK(std::abs(sum(totals.at("demandT")) - st.cum_demand_t) <= tol);
  CHECK(std::abs(sum(totals.at("unmetT")) - st.cum_unmet_t) <= tol);
  CHECK(std::abs(sum(totals.at("shutdownH")) - st.cum_shutdown_h) <= tol);
  double spend_book = 0;
  for (const auto& entry : book) spend_book += entry.second[1];
  CHECK(std::abs(sum(totals.at("spendUsd")) - spend_book) <= tol);
  for (const json& s : totals.at("service")) CHECK(s.get<double>() == doctest::Approx(1.0));

  // Plants: sources and plants (no customers), each with a rate band inside
  // [0, 1.1] per bucket.
  CHECK(doc.at("plants").size() == 18);
  for (const json& pl : doc.at("plants")) {
    CHECK(pl.at("designRateTph").get<double>() > 0.0);
    // Minimum stable rate from the catalog: none for a source, 30 to 65% for a plant.
    if (pl.at("boundary") == "source") {
      CHECK(pl.at("turndown") == 0.0);
    } else {
      CHECK(pl.at("turndown").get<double>() >= 0.3);
      CHECK(pl.at("turndown").get<double>() <= 0.65);
    }
    for (size_t b = 0; b < n; ++b) {
      const double lo = pl.at("rateMin")[b].get<double>(), mid = pl.at("rateMean")[b].get<double>(),
                   hi = pl.at("rateMax")[b].get<double>();
      CHECK(lo >= 0.0);
      CHECK(hi <= 1.1);
      CHECK(lo <= mid + 1e-4);
      CHECK(mid <= hi + 1e-4);
    }
  }

  // A fork carries its parent's history; a few more ticks open a partial
  // bucket; other bucket sizes re-cut the same history.
  Sim fork(*sim);
  CHECK(economyJson(w, fork.state(), fork.recorder(), 24) ==
        economyJson(w, st, sim->recorder(), 24));
  fork.step(10);
  const json more = json::parse(economyJson(w, fork.state(), fork.recorder(), 24));
  CHECK(more.at("buckets") == 61);
  CHECK(more.at("plants")[5].at("rateMean").size() == 61);
  const json hourly = json::parse(economyJson(w, st, sim->recorder(), 1));
  CHECK(hourly.at("buckets") == 60 * 24);
  CHECK(std::abs(sum(hourly.at("totals").at("freightUsd")) - st.cum_freight_usd) <= 0.01 * 1440);
  const json weekly = json::parse(economyJson(w, st, sim->recorder(), 168));
  CHECK(weekly.at("buckets") == 9);  // 60 days = 8 full weeks and a part
  CHECK(std::abs(sum(weekly.at("totals").at("demandT")) - st.cum_demand_t) <= 0.1);
}

TEST_CASE("M12: sourcing lists every way to supply a tank and names what the next pass books") {
  auto sim = makeMapSim();
  REQUIRE(sim);
  const World& w = sim->world();

  // The picker list: tanks that buy by vehicle and have a supplier.
  const json list = json::parse(buyTanksJson(*sim));
  CHECK(list.at("tanks").size() == 20);
  for (const json& t : list.at("tanks")) {
    CHECK(t.at("options").get<int>() >= 1);
    CHECK(t.at("cover_h").get<double>() > 0.0);
    CHECK(t.at("usual").is_null());  // nothing has been delivered yet
  }

  // Run for ten days. Just before each hourly pass ask every buying tank
  // what the pass will book for it, then let the pass happen and compare
  // with the order book.
  size_t compared_tanks = 0, compared_lots = 0, tanks_with_bookings = 0;
  for (int hour = 0; hour < 240; ++hour) {
    sim->step(3);
    REQUIRE(sim->state().tick % 4 == 3);
    struct Expect {
      uint32_t tank;
      json doc;
    };
    std::vector<Expect> expected;
    if (hour % 6 == 0) {  // every sixth hour is plenty, and keeps the test quick
      for (const json& t : list.at("tanks")) {
        const std::string site = t.at("site"), material = t.at("material");
        const int tank = w.findTank(site + "/" + material);
        REQUIRE(tank >= 0);
        expected.push_back({static_cast<uint32_t>(tank), json::parse(sourcingJson(*sim, site, material))});
      }
    }
    const uint64_t hash_before = sim->stateHash();
    if (!expected.empty()) CHECK(sim->stateHash() == hash_before);  // asking changes nothing
    const size_t orders_before = sim->state().order.size();
    sim->step(1);
    for (const Expect& e : expected) {
      ++compared_tanks;
      const json& pass = e.doc.at("next_pass");
      CHECK(pass.at("tick") == sim->state().tick);
      // The lots the pass really booked for this tank, in booking order.
      std::vector<const Order*> booked;
      for (size_t i = orders_before; i < sim->state().order.size(); ++i)
        if (sim->state().order[i].to == e.tank) booked.push_back(&sim->state().order[i]);
      REQUIRE(pass.at("lots").size() == booked.size());
      std::set<std::pair<std::string, std::string>> chosen_pairs, booked_pairs;
      for (size_t i = 0; i < booked.size(); ++i) {
        const Order& o = *booked[i];
        const std::string seller = w.sites[w.tanks[o.from].site.v].key;
        const std::string cls = w.catalog.vehicle_classes[o.cls].key;
        CHECK(pass.at("lots")[i].at("seller") == seller);
        CHECK(pass.at("lots")[i].at("cls") == cls);
        CHECK(pass.at("lots")[i].at("tonnes").get<double>() == doctest::Approx(o.qty_t).epsilon(1e-3));
        booked_pairs.insert({seller, cls});
        ++compared_lots;
      }
      for (const json& o : e.doc.at("options"))
        if (o.at("chosen").get<bool>())
          chosen_pairs.insert({o.at("seller").get<std::string>(), o.at("cls").get<std::string>()});
      CHECK(chosen_pairs == booked_pairs);  // "chosen" is exactly what gets booked
      if (!booked.empty()) ++tanks_with_bookings;
    }
  }
  CHECK(compared_tanks == 40 * 20);
  CHECK(tanks_with_bookings > 30);
  CHECK(compared_lots > 40);

  // One tank in detail, after ten days of deliveries.
  const json doc = json::parse(sourcingJson(*sim, "STYRENICS", "BENZENE"));
  const json& tank = doc.at("tank");
  CHECK(tank.at("buys") == true);
  CHECK(tank.at("cover_h").get<double>() ==
        doctest::Approx(tank.at("level_t").get<double>() / tank.at("draw_t_h").get<double>())
            .epsilon(1e-3));
  CHECK(doc.at("usual").at("delivered_t").get<double>() > 0.0);
  const json& options = doc.at("options");
  REQUIRE(options.size() == 3);  // refinery and both crackers, by tank truck
  double last = 0;
  int usual_rows = 0;
  for (const json& o : options) {
    CHECK(o.at("cls") == "TRUCK_TANK");
    CHECK(o.at("landed_usd_t").get<double>() >= last);  // cheapest first
    last = o.at("landed_usd_t").get<double>();
    // Landed cost is its parts, and freight is the class rate times distance.
    CHECK(o.at("landed_usd_t").get<double>() ==
          doctest::Approx(o.at("ask_usd_t").get<double>() + o.at("freight_usd_t").get<double>() +
                          o.at("time_usd_t").get<double>() + o.at("switch_usd_t").get<double>())
              .epsilon(1e-4));
    CHECK(o.at("freight_usd_t").get<double>() ==
          doctest::Approx(0.10 * o.at("km").get<double>()).epsilon(1e-3));
    CHECK(o.at("travel_h").get<double>() ==
          doctest::Approx(o.at("km").get<double>() / 70.0).epsilon(1e-2));
    CHECK(o.at("lot_t").get<double>() <= 25.0);
    CHECK(o.at("free_t").get<double>() <= o.at("stock_t").get<double>() + 1e-6);
    CHECK(o.at("vehicles") == 13);
    CHECK(o.at("feasible_now").get<bool>() == o.at("blocked").is_null());
    CHECK(o.at("arrives_before_dry").get<bool>() ==
          (o.at("travel_h").get<double>() + o.at("handling_h").get<double>() <
           tank.at("cover_h").get<double>()));
    usual_rows += o.at("usual").get<bool>() ? 1 : 0;
  }
  CHECK(usual_rows == 1);

  // A supplier that is down shows as down, and a pipeline-fed tank says so.
  REQUIRE(sim->command(R"({"type":"site_shutdown","site":"CRACKER_FLEX","duration_h":240})")
              .find("\"ok\":true") != std::string::npos);
  sim->step(8);
  bool flex_down = false;
  const json after_trip = json::parse(sourcingJson(*sim, "STYRENICS", "BENZENE"));
  for (const json& o : after_trip.at("options"))
    if (o.at("seller") == "CRACKER_FLEX") flex_down = o.at("seller_state") == "shut_down";
  CHECK(flex_down);
  const json piped = json::parse(sourcingJson(*sim, "VINYLS", "ETHYLENE"));
  CHECK(piped.at("tank").at("buys") == false);
  CHECK(piped.at("tank").at("piped_in") == true);
  CHECK(piped.at("options").empty());
  CHECK(piped.at("next_pass").is_null());

  // Bad queries say why.
  CHECK(json::parse(sourcingJson(*sim, "NOPE", "PE")).contains("error"));
  CHECK(json::parse(sourcingJson(*sim, "VINYLS", "NOPE")).contains("error"));
  CHECK(json::parse(sourcingJson(*sim, "VINYLS", "PE")).contains("error"));
  CHECK(json::parse(sourcingJson(*sim, "11", "CHLORINE")).at("tank").at("site") == "VINYLS");
}

namespace {

// The first route edge on the way between two sites in a mode.
uint32_t firstEdgeBetween(const Sim& sim, const char* from, const char* to, crx::Mode mode) {
  const World& w = sim.world();
  PathCache paths = sim.paths();
  refreshPaths(w, sim.state(), paths);
  const int m = modeIndex(mode);
  const uint32_t a = w.sites[static_cast<size_t>(w.findSite(from))].node[m];
  const uint32_t b = w.sites[static_cast<size_t>(w.findSite(to))].node[m];
  const std::vector<uint32_t> path = buildPath(w, paths, mode, a, b);
  REQUIRE(path.size() >= 2);
  return edgeBetween(w, mode, path[0], path[1]);
}

bool routeOpen(const Sim& sim, const char* from, const char* to, crx::Mode mode) {
  const World& w = sim.world();
  PathCache paths;
  refreshPaths(w, sim.state(), paths);
  const int m = modeIndex(mode);
  return std::isfinite(travelKm(w, paths, mode,
                                w.sites[static_cast<size_t>(w.findSite(from))].node[m],
                                w.sites[static_cast<size_t>(w.findSite(to))].node[m]));
}

// Books stay sane while routes are cut: nothing negative, no vehicle
// carrying more than its order, mass conserved over the stretch.
void checkBooks(const Sim& sim) {
  const World& w = sim.world();
  const State& st = sim.state();
  for (size_t t = 0; t < st.tank.size(); ++t) {
    CHECK_MESSAGE(st.tank[t].level_t >= -1e-6, w.tanks[t].key << " level " << st.tank[t].level_t);
    CHECK_MESSAGE(st.tank[t].reserved_out_t >= -1e-6,
                  w.tanks[t].key << " reserved " << st.tank[t].reserved_out_t);
    CHECK_MESSAGE(st.tank[t].inbound_t >= -1e-6, w.tanks[t].key << " inbound " << st.tank[t].inbound_t);
  }
  for (size_t v = 0; v < st.vehicle.size(); ++v) {
    const VehicleState& vs = st.vehicle[v];
    if (vs.status == VehStatus::Idle || vs.order >= st.order.size()) continue;
    CHECK_MESSAGE(vs.cargo_t <= st.order[vs.order].qty_t + 1e-6,
                  "vehicle " << v << " carries " << vs.cargo_t << " t of a "
                             << st.order[vs.order].qty_t << " t lot");
  }
}

}  // namespace

TEST_CASE("M13: a route edge can be closed by index, traffic copes, and it reopens") {
  auto sim = makeMapSim();
  REQUIRE(sim);
  const World& w = sim->world();
  const auto ok = [&](const json& cmd) {
    return json::parse(sim->command(cmd.dump())).at("ok").get<bool>();
  };

  // Validation: the index must be a route of this world; the site form still works.
  CHECK(!ok({{"type", "route_break"}, {"edge", w.edges.size()}, {"duration_h", 24}}));
  CHECK(!ok({{"type", "route_break"}, {"edge", -1}, {"duration_h", 24}}));
  CHECK(!ok({{"type", "route_break"}, {"edge", "43"}, {"duration_h", 24}}));
  CHECK(!ok({{"type", "route_break"}, {"duration_h", 24}}));

  sim->step(960);  // day 10
  const uint32_t river = firstEdgeBetween(*sim, "SALT_MINE", "CHLOR_ALKALI", crx::Mode::River);
  REQUIRE(river < w.edges.size());
  REQUIRE(w.edges[river].mode == crx::Mode::River);
  REQUIRE(routeOpen(*sim, "SALT_MINE", "CHLOR_ALKALI", crx::Mode::River));
  const double stock0 = stockSum(sim->state());
  const double supplied0 = sim->state().cum_supplied_t, consumed0 = sim->state().cum_consumed_t,
               loss0 = sim->state().cum_loss_t;

  // Close the salt barges' river lane for five days.
  const uint64_t version = sim->state().graph_version;
  REQUIRE(ok({{"type", "route_break"}, {"edge", river}, {"duration_h", 120}}));
  sim->step(1);
  CHECK(sim->state().edge_open[river] == 0);
  CHECK(sim->state().graph_version > version);
  CHECK(!routeOpen(*sim, "SALT_MINE", "CHLOR_ALKALI", crx::Mode::River));  // the river is a tree
  for (int hour = 0; hour < 119; ++hour) {
    sim->step(4);
    CHECK(sim->state().edge_open[river] == 0);
    if (hour % 12 == 0) checkBooks(*sim);
  }
  sim->step(8);
  CHECK(sim->state().edge_open[river] == 1);
  CHECK(routeOpen(*sim, "SALT_MINE", "CHLOR_ALKALI", crx::Mode::River));
  bool logged_close = false, logged_open = false;
  for (const LogEntry& e : sim->recorder().log) {
    if (e.type == "route_break" && e.unit == std::to_string(river)) logged_close = true;
    if (e.type == "route_reopened" && e.unit == std::to_string(river)) logged_open = true;
  }
  CHECK(logged_close);
  CHECK(logged_open);

  // While the river was shut, salt went by road.
  const int bulk_truck = w.catalog.findVehicle("TRUCK_BULK");
  const int salt = w.catalog.findMaterial("SALT");
  REQUIRE(bulk_truck >= 0);
  size_t salt_by_truck = 0;
  for (const Order& o : sim->state().order)
    if (o.material == salt && o.cls == bulk_truck && o.created_tick > 960) ++salt_by_truck;
  CHECK(salt_by_truck > 10);

  // On to day 60: nothing is left waiting, the customers were served, and
  // mass is conserved across the whole episode.
  while (sim->state().tick < 60 * 96) sim->step(96);
  checkBooks(*sim);
  for (const Order& o : sim->state().order)
    if (o.status == OrdStatus::Open)
      CHECK(sim->state().tick - o.created_tick < 10 * 96);
  std::vector<double> kpis;
  sim->computeKpis(kpis);
  CHECK(kpis[0] > 0.99);
  const State& st = sim->state();
  const double residual = (stockSum(st) - stock0) - ((st.cum_supplied_t - supplied0) -
                                                     (st.cum_consumed_t - consumed0) -
                                                     (st.cum_loss_t - loss0));
  CHECK(std::fabs(residual) <= 1e-6 * conservationScale(st));
}

TEST_CASE("M14: a closed sea lane holds loaded ships at the berth without loading them twice") {
  auto sim = makeMapSim();
  REQUIRE(sim);
  const World& w = sim->world();
  sim->step(960);
  // The lane every ship between the refinery and the fuel depot uses.
  PathCache paths = sim->paths();
  refreshPaths(w, sim->state(), paths);
  const int sea = modeIndex(crx::Mode::Sea);
  const std::vector<uint32_t> path =
      buildPath(w, paths, crx::Mode::Sea, w.sites[static_cast<size_t>(w.findSite("REFINERY"))].node[sea],
                w.sites[static_cast<size_t>(w.findSite("FUEL_DEPOT"))].node[sea]);
  REQUIRE(path.size() >= 3);
  const uint32_t lane = edgeBetween(w, crx::Mode::Sea, path[path.size() - 3], path[path.size() - 2]);
  REQUIRE(lane < w.edges.size());

  // Two overlapping closures of the same lane: the longer one holds it shut.
  REQUIRE(json::parse(sim->command(json{{"type", "route_break"}, {"edge", lane}, {"duration_h", 96}}
                                       .dump()))
              .at("ok") == true);
  REQUIRE(json::parse(sim->command(json{{"type", "route_break"}, {"edge", lane}, {"duration_h", 240}}
                                       .dump()))
              .at("ok") == true);
  size_t held_at_berth = 0;
  for (int hour = 0; hour < 239; ++hour) {
    sim->step(4);
    CHECK(sim->state().edge_open[lane] == 0);  // still shut after the first one ends
    checkBooks(*sim);  // the regression: a held ship used to load its lot again and again
    for (size_t v = 0; v < sim->state().vehicle.size(); ++v) {
      const VehicleState& vs = sim->state().vehicle[v];
      if (vs.status == VehStatus::Loading && vs.order < sim->state().order.size() &&
          vs.cargo_t >= sim->state().order[vs.order].qty_t - 1e-6)
        ++held_at_berth;
    }
  }
  CHECK(held_at_berth > 0);  // some ship did sit loaded, waiting for the lane
  sim->step(8);
  CHECK(sim->state().edge_open[lane] == 1);

  // It recovers: by day 45 every plant is running again and customers are served.
  while (sim->state().tick < 45 * 96) sim->step(96);
  checkBooks(*sim);
  std::vector<double> at45, at60;
  sim->computeKpis(at45);
  while (sim->state().tick < 60 * 96) sim->step(96);
  sim->computeKpis(at60);
  CHECK(at60[1] - at45[1] == doctest::Approx(0.0).epsilon(1e-9));  // no unmet demand days 45 to 60
  for (size_t p = 0; p < w.processes.size(); ++p)
    CHECK(sim->state().proc[p].status == ProcStatus::Running);
}

TEST_CASE("M15: place_order books a buyer's own lot exactly as the hourly pass would") {
  auto sim = makeMapSim();
  REQUIRE(sim);
  const World& w = sim->world();
  const auto send = [&](const json& cmd) { return json::parse(sim->command(cmd.dump())); };
  const json good = {{"type", "place_order"}, {"site", "STYRENICS"}, {"material", "BENZENE"},
                     {"seller", "REFINERY"},  {"cls", "TRUCK_TANK"}, {"tonnes", 25}};

  // It works on a fresh run too (paths are built on demand).
  CHECK(send(good).at("ok") == true);

  sim->step(960);
  const int buyer = w.findTank("STYRENICS/BENZENE"), seller = w.findTank("REFINERY/BENZENE");
  REQUIRE(buyer >= 0);
  REQUIRE(seller >= 0);
  const size_t orders_before = sim->state().order.size();
  const double reserved = sim->state().tank[static_cast<size_t>(seller)].reserved_out_t;
  const double inbound = sim->state().tank[static_cast<size_t>(buyer)].inbound_t;

  const json reply = send(good);
  REQUIRE(reply.at("ok") == true);
  const uint32_t id = reply.at("order").at("id").get<uint32_t>();
  REQUIRE(id == orders_before);
  REQUIRE(sim->state().order.size() == orders_before + 1);
  const Order booked = sim->state().order[id];
  CHECK(booked.status == OrdStatus::Open);
  CHECK(booked.from == static_cast<uint32_t>(seller));
  CHECK(booked.to == static_cast<uint32_t>(buyer));
  CHECK(booked.qty_t == 25.0);
  CHECK(booked.created_tick == 960);
  CHECK(booked.km == doctest::Approx(reply.at("order").at("km").get<double>()));
  CHECK(booked.freight_usd == doctest::Approx(25.0 * 0.10 * booked.km));
  CHECK(reply.at("order").at("priceUsdT").get<double>() == doctest::Approx(booked.price));
  CHECK(reply.at("order").at("etaTick").get<uint64_t>() > 960);
  CHECK(sim->state().tank[static_cast<size_t>(seller)].reserved_out_t ==
        doctest::Approx(reserved + 25.0));
  CHECK(sim->state().tank[static_cast<size_t>(buyer)].inbound_t == doctest::Approx(inbound + 25.0));

  // A truck takes it within the hour and delivers it; the books stay sane.
  sim->step(4);
  CHECK(sim->state().order[id].status != OrdStatus::Open);
  CHECK(sim->state().order[id].vehicle < sim->state().vehicle.size());
  for (int hour = 0; hour < 72 && sim->state().order[id].status != OrdStatus::Delivered; ++hour)
    sim->step(4);
  CHECK(sim->state().order[id].status == OrdStatus::Delivered);
  checkBooks(*sim);

  // Refusals, each with a reason and the word the sourcing view uses.
  const auto refusal = [&](json cmd) -> std::string {
    const json r = send(cmd);
    if (r.at("ok") != false || r.at("error").get<std::string>().rfind("place_order: ", 0) != 0)
      return "(not refused)";
    return r.at("blocked").get<std::string>();
  };
  const auto with = [&](const char* key, const json& value) {
    json cmd = good;
    cmd[key] = value;
    return cmd;
  };
  const size_t before_refusals = sim->state().order.size();
  CHECK(refusal(with("site", "NOPE")) == "bad_request");
  CHECK(refusal(with("seller", "NOPE")) == "bad_request");
  CHECK(refusal(with("material", "NOPE")) == "bad_request");
  CHECK(refusal(with("cls", "NOPE")) == "bad_request");
  CHECK(refusal(with("tonnes", 0)) == "bad_request");
  CHECK(refusal(with("tonnes", -5)) == "bad_request");
  CHECK(refusal(with("seller", "STYRENICS")) == "bad_request");  // buyer and seller the same
  CHECK(refusal(with("seller", "PACKAGING")) == "bad_request");  // packaging sells no benzene
  CHECK(refusal(with("cls", "TRUCK_BULK")) == "not_possible");   // a bulk truck cannot carry a liquid
  CHECK(refusal(with("cls", "SHIP_TANK")) == "not_possible");    // styrenics has no berth
  CHECK(refusal(with("cls", "SHIP_DRY")) == "not_possible");
  json no_tonnes = good;
  no_tonnes.erase("tonnes");
  CHECK(refusal(no_tonnes) == "bad_request");
  CHECK(sim->state().order.size() == before_refusals);  // a refusal books nothing

  // Clamping: one vehicle load at most, and no more than the seller can
  // spare. The styrenics solvent tank holds about a truckload.
  const json big = send(with("tonnes", 400));
  REQUIRE(big.at("ok") == true);
  CHECK(big.at("order").at("tonnes") == 25.0);  // one tank truck
  CHECK(big.at("order").at("requestedTonnes") == 400.0);
  const json solvent = {{"type", "place_order"}, {"site", "PAINTS"}, {"material", "SOLVENT"},
                        {"seller", "STYRENICS"}, {"cls", "TRUCK_TANK"}, {"tonnes", 25}};
  const int small_tank = w.findTank("STYRENICS/SOLVENT");
  REQUIRE(small_tank >= 0);
  int placed = 0;
  double last_lot = 25.0;
  for (int i = 0; i < 10; ++i) {
    const TankState& ts = sim->state().tank[static_cast<size_t>(small_tank)];
    const double free_before = ts.level_t - ts.reserved_out_t;
    const json r = send(solvent);
    if (r.at("ok") == false) {
      CHECK(r.at("blocked") == "seller_short");
      CHECK(free_before < 0.5);
      break;
    }
    ++placed;
    last_lot = r.at("order").at("tonnes").get<double>();
    CHECK(last_lot == doctest::Approx(std::min(25.0, free_before)));
  }
  CHECK(placed >= 1);
  CHECK(placed < 10);       // the tank ran out and the last order was refused
  CHECK(last_lot < 25.0);   // and the one before it was cut down to what was left
  checkBooks(*sim);

  // The older key for the seller still works.
  json old_key = good;
  old_key.erase("seller");
  old_key["from"] = "CRACKER_FLEX";
  CHECK(send(old_key).at("ok") == true);

  // The same commands at the same ticks give the same run.
  auto again = makeMapSim();
  REQUIRE(json::parse(again->command(good.dump())).at("ok") == true);
  again->step(960);
  REQUIRE(json::parse(again->command(good.dump())).at("ok") == true);
  auto third = makeMapSim();
  REQUIRE(json::parse(third->command(good.dump())).at("ok") == true);
  third->step(960);
  REQUIRE(json::parse(third->command(good.dump())).at("ok") == true);
  again->step(200);
  third->step(200);
  CHECK(again->stateHash() == third->stateHash());
}

namespace {

// A sim on a world file the test wrote itself, loaded through the worlds
// directory like any named world.
std::unique_ptr<Sim> simFromFile(const std::string& name, const json& file) {
  const std::string dir = std::string(CRX_WORLDS_DIR) + "/../../../build/native-release/test-worlds";
  std::error_code ec;
  std::filesystem::create_directories(dir, ec);
  std::ofstream(dir + "/" + name + ".json") << file.dump();
  setenv("CRX_WORLDS_DIR", dir.c_str(), 1);
  std::string error;
  auto sim = Sim::createFromConfig(json{{"seed", 42}, {"world", name}}.dump().c_str(), error);
  unsetenv("CRX_WORLDS_DIR");
  REQUIRE_MESSAGE(sim != nullptr, error);
  return sim;
}

// A sim on a copy of the map world file with one tank's fields changed (a
// null value removes the field), loaded through the worlds directory like
// any named world.
std::unique_ptr<Sim> makeVariantSim(const std::string& name, const std::string& site,
                                    const std::string& material, const json& tank_fields) {
  json file = json::parse(readWorldFile());
  file["name"] = name;
  bool found = false;
  for (json& s : file["sites"])
    if (s.at("key") == site)
      for (json& t : s["tanks"])
        if (t.at("material") == material) {
          for (const auto& item : tank_fields.items()) {
            if (item.value().is_null())
              t.erase(item.key());
            else
              t[item.key()] = item.value();
          }
          found = true;
        }
  REQUIRE(found);
  return simFromFile(name, file);
}

}  // namespace

TEST_CASE("M16: smooth_km rounds interior corners and leaves the ends where they are") {
  const auto lengthOf = [](const std::vector<double>& xy) {
    double len = 0;
    for (size_t i = 2; i + 1 < xy.size(); i += 2)
      len += std::hypot(xy[i] - xy[i - 2], xy[i + 1] - xy[i - 1]);
    return len;
  };

  // A right angle: 100 km east, then 100 km south (y grows downward).
  const std::vector<double> corner = {0, 0, 100, 0, 100, 100};
  const std::vector<double> r = roundPolylineCorners(corner, 8.0);
  REQUIRE(r.size() == 2 * 9);  // start, a 7-point curve, end
  CHECK(r[0] == 0.0);
  CHECK(r[1] == 0.0);
  CHECK(r[16] == 100.0);
  CHECK(r[17] == 100.0);
  // The curve leaves the first leg 8 km before the corner and joins the
  // second 8 km after it; its middle is the Bezier midpoint.
  CHECK(r[2] == doctest::Approx(92.0));
  CHECK(r[3] == doctest::Approx(0.0));
  CHECK(r[14] == doctest::Approx(100.0));
  CHECK(r[15] == doctest::Approx(8.0));
  CHECK(r[8] == doctest::Approx(98.0));
  CHECK(r[9] == doctest::Approx(2.0));
  for (size_t i = 2; i < 16; i += 2) {  // inside the corner, never past it
    CHECK(r[i] >= 92.0 - 1e-9);
    CHECK(r[i] <= 100.0 + 1e-9);
    CHECK(r[i + 1] >= -1e-9);
    CHECK(r[i + 1] <= 8.0 + 1e-9);
  }
  // Shorter than the drawn path, longer than the straight line between the ends.
  CHECK(lengthOf(r) < lengthOf(corner));
  CHECK(lengthOf(r) > std::hypot(100.0, 100.0));
  CHECK(lengthOf(r) == doctest::Approx(200.0 - 16.0 + 12.98).epsilon(0.01));

  // Off, too few points, a near-straight bend and repeated points.
  CHECK(roundPolylineCorners(corner, 0.0) == corner);
  const std::vector<double> two = {0, 0, 50, 50};
  CHECK(roundPolylineCorners(two, 8.0) == two);
  const std::vector<double> gentle = {0, 0, 100, 0, 200, 5};  // under 3 degrees
  CHECK(roundPolylineCorners(gentle, 8.0) == gentle);
  const std::vector<double> repeated = {0, 0, 100, 0, 100, 0, 100, 0, 100, 100};
  const std::vector<double> rr = roundPolylineCorners(repeated, 8.0);
  CHECK(rr == r);  // the duplicates vanish and the corner is rounded once
  const std::vector<double> stacked = {5, 5, 5, 5, 5, 5};
  CHECK(roundPolylineCorners(stacked, 8.0) == stacked);
  for (const double v : rr) CHECK(std::isfinite(v));
  // Short legs limit the curve: it takes at most 45% of either one.
  const std::vector<double> tight = roundPolylineCorners({0, 0, 10, 0, 10, 4}, 8.0);
  CHECK(tight[2] == doctest::Approx(10.0 - 1.8));  // 0.45 x the 4 km leg
  CHECK(tight[tight.size() - 3] == doctest::Approx(1.8));
  // Two corners in a row never overlap.
  const std::vector<double> zig = roundPolylineCorners({0, 0, 10, 0, 10, 10, 20, 10}, 8.0);
  for (size_t i = 2; i + 1 < zig.size(); i += 2) {
    const double step = std::hypot(zig[i] - zig[i - 2], zig[i + 1] - zig[i - 1]);
    CHECK(step > 0.0);
  }
  CHECK(zig.front() == 0.0);
  CHECK(zig.back() == 10.0);

  // On the map world: without the key (or with 0) every path is as drawn;
  // with it the nodes stay put, each edge keeps its ends, gets no longer
  // and stays at least as long as the straight line between them.
  json file = json::parse(readWorldFile());
  file.erase("smooth_km");
  World plain, zero, smooth;
  std::string error;
  REQUIRE(buildWorldFromJson("erwin-world-v1", file.dump(), 42, plain, error));
  file["smooth_km"] = 0;
  REQUIRE(buildWorldFromJson("erwin-world-v1", file.dump(), 42, zero, error));
  CHECK(zero.polyline_xy == plain.polyline_xy);
  file["smooth_km"] = 8;
  REQUIRE(buildWorldFromJson("erwin-world-v1", file.dump(), 42, smooth, error));
  REQUIRE(smooth.nodes.size() == plain.nodes.size());
  REQUIRE(smooth.edges.size() == plain.edges.size());
  // Site nodes never move. A junction may: onto the curve that replaces its
  // corner, which for an 8 km radius is at most 0.5 x 8 x sin(40 deg) away.
  const double max_move = 0.5 * 8.0 * std::sin(40.0 * 3.14159265358979323846 / 180.0) + 1e-9;
  size_t moved_nodes = 0;
  for (size_t n = 0; n < plain.nodes.size(); ++n) {
    const double move = std::hypot(smooth.nodes[n].x_km - plain.nodes[n].x_km,
                                   smooth.nodes[n].y_km - plain.nodes[n].y_km);
    CHECK(smooth.nodes[n].site == plain.nodes[n].site);
    if (plain.nodes[n].site >= 0) {
      CHECK(move == 0.0);
    } else {
      CHECK(move <= max_move);
      if (move > 0.0) ++moved_nodes;
    }
  }
  CHECK(moved_nodes >= 10);  // 21 on the map as drawn today
  for (size_t s = 0; s < plain.sites.size(); ++s)
    for (int m = 0; m < kModeCount; ++m)
      CHECK(smooth.sites[s].node[static_cast<size_t>(m)] == plain.sites[s].node[static_cast<size_t>(m)]);
  size_t rounded_edges = 0;
  double plain_km = 0, smooth_km = 0;
  for (size_t e = 0; e < plain.edges.size(); ++e) {
    const RouteEdge& a = plain.edges[e];
    const RouteEdge& b = smooth.edges[e];
    CHECK(b.a == a.a);
    CHECK(b.b == a.b);
    const size_t b0 = 2 * b.polyline.begin, b1 = 2 * (b.polyline.begin + b.polyline.count - 1);
    // Every edge still starts and ends exactly on its two nodes, wherever
    // they are now.
    CHECK(smooth.polyline_xy[b0] == smooth.nodes[b.a].x_km);
    CHECK(smooth.polyline_xy[b0 + 1] == smooth.nodes[b.a].y_km);
    CHECK(smooth.polyline_xy[b1] == smooth.nodes[b.b].x_km);
    CHECK(smooth.polyline_xy[b1 + 1] == smooth.nodes[b.b].y_km);
    // Rounding shortens a path; an edge re-ended on a moved junction can
    // gain at most the two moves.
    CHECK(b.length_km <= a.length_km + 2.0 * max_move);
    const double chord = std::hypot(smooth.polyline_xy[b1] - smooth.polyline_xy[b0],
                                    smooth.polyline_xy[b1 + 1] - smooth.polyline_xy[b0 + 1]);
    CHECK(b.length_km >= chord - 1e-9);
    // The edge is exactly as long as the path it carries.
    std::vector<double> xy(smooth.polyline_xy.begin() + static_cast<long>(b0),
                           smooth.polyline_xy.begin() + static_cast<long>(b1) + 2);
    CHECK(b.length_km == doctest::Approx(std::max(lengthOf(xy), 0.01)).epsilon(1e-9));
    if (b.polyline.count > a.polyline.count) ++rounded_edges;
    plain_km += a.length_km;
    smooth_km += b.length_km;
  }
  CHECK(rounded_edges > 20);
  CHECK(smooth_km < plain_km);
  CHECK(smooth_km > 0.98 * plain_km);  // corners only: the network barely shrinks
  // Pipelines keep their ends too.
  for (size_t i = 0; i < plain.pipelines.size(); ++i) {
    const Range<uint32_t> a = plain.pipelines[i].polyline, b = smooth.pipelines[i].polyline;
    REQUIRE(a.count >= 2);
    CHECK(b.count >= a.count);
    CHECK(smooth.polyline_xy[2 * b.begin] == plain.polyline_xy[2 * a.begin]);
    CHECK(smooth.polyline_xy[2 * (b.begin + b.count - 1) + 1] ==
          plain.polyline_xy[2 * (a.begin + a.count - 1) + 1]);
  }
  // The turn through a junction, on its own: a road arriving from the west
  // meets one leaving east-north-east (a 31 degree turn) at (50, 0).
  std::vector<double> moved, toward_a, toward_b;
  REQUIRE(roundJunctionCorner(50, 0, 0, 0, 100, 30, 8.0, moved, toward_a, toward_b));
  const double ub_x = 50.0 / std::hypot(50.0, 30.0), ub_y = 30.0 / std::hypot(50.0, 30.0);
  REQUIRE(toward_a.size() == 6);
  REQUIRE(toward_b.size() == 6);
  // The curve meets each road 8 km out, on the road's own line...
  CHECK(toward_a[4] == doctest::Approx(42.0));
  CHECK(toward_a[5] == doctest::Approx(0.0));
  CHECK(toward_b[4] == doctest::Approx(50.0 + 8.0 * ub_x));
  CHECK(toward_b[5] == doctest::Approx(8.0 * ub_y));
  // ...and the junction moves to its midpoint, inside the corner.
  CHECK(moved[0] == doctest::Approx(0.25 * 42.0 + 0.5 * 50.0 + 0.25 * (50.0 + 8.0 * ub_x)));
  CHECK(moved[1] == doctest::Approx(0.25 * 8.0 * ub_y));
  const double turn = std::acos(ub_x);  // from heading east to heading along ub
  CHECK(std::hypot(moved[0] - 50.0, moved[1]) == doctest::Approx(0.5 * 8.0 * std::sin(turn / 2)));
  CHECK(moved[1] > 0.0);
  CHECK(moved[1] < 8.0 * ub_y);
  // Each half runs from the junction outward without doubling back.
  CHECK(toward_a[0] < moved[0]);
  CHECK(toward_a[2] < toward_a[0]);
  CHECK(toward_a[4] < toward_a[2]);
  CHECK(toward_b[0] > moved[0]);
  CHECK(toward_b[2] > toward_b[0]);
  CHECK(toward_b[4] > toward_b[2]);
  // Left alone: nearly straight on, a real T junction, no radius, no length.
  CHECK(!roundJunctionCorner(50, 0, 0, 0, 100, 5, 8.0, moved, toward_a, toward_b));
  CHECK(moved.empty());
  CHECK(!roundJunctionCorner(50, 0, 0, 0, 50, 60, 8.0, moved, toward_a, toward_b));
  CHECK(!roundJunctionCorner(50, 0, 0, 0, 100, 30, 0.0, moved, toward_a, toward_b));
  CHECK(!roundJunctionCorner(50, 0, 50, 0, 100, 30, 8.0, moved, toward_a, toward_b));
  // Short approaches limit it, as for interior corners.
  REQUIRE(roundJunctionCorner(50, 0, 46, 0, 100, 30, 8.0, moved, toward_a, toward_b));
  CHECK(toward_a[4] == doctest::Approx(50.0 - 0.45 * 4.0));

  // Vehicles drive the moved geometry: every travelling vehicle sits on the
  // drawn path of the edge it is on, and its reported path ends on the
  // destination's node.
  file["smooth_km"] = 8;
  file["name"] = "smooth-on";
  auto driving = simFromFile("smooth-on", file);
  const World& sw = driving->world();
  size_t on_edges = 0;
  for (int hour = 0; hour < 72; ++hour) {
    driving->step(4);
    const State& st = driving->state();
    for (size_t v = 0; v < st.vehicle.size(); ++v) {
      const VehicleState& vs = st.vehicle[v];
      if (vs.edge >= sw.edges.size()) continue;
      if (vs.status != VehStatus::ToPickup && vs.status != VehStatus::ToDropoff) continue;
      const Range<uint32_t> pl = sw.edges[vs.edge].polyline;
      double nearest = 1e300;
      for (uint32_t i = pl.begin; i + 1 < pl.begin + pl.count; ++i) {
        const double ax = sw.polyline_xy[2 * i], ay = sw.polyline_xy[2 * i + 1];
        const double bx = sw.polyline_xy[2 * i + 2], by = sw.polyline_xy[2 * i + 3];
        const double len2 = (bx - ax) * (bx - ax) + (by - ay) * (by - ay);
        double t = len2 > 0 ? ((vs.x_km - ax) * (bx - ax) + (vs.y_km - ay) * (by - ay)) / len2 : 0;
        t = std::max(0.0, std::min(1.0, t));
        nearest = std::min(nearest, std::hypot(vs.x_km - (ax + t * (bx - ax)), vs.y_km - (ay + t * (by - ay))));
      }
      CHECK(nearest < 1e-6);
      ++on_edges;
      if (hour % 12 == 0) {
        const json doc = json::parse(vehicleJson(sw, st, static_cast<uint32_t>(v)));
        const VehicleClass& vc = sw.catalog.vehicle_classes[sw.fleet[v].cls];
        const RouteNode& dest =
            sw.nodes[sw.sites[doc.at("legDestination").at("site").get<size_t>()].node[modeIndex(vc.mode)]];
        CHECK(doc.at("path").back().at(0).get<double>() == doctest::Approx(dest.x_km));
        CHECK(doc.at("path").back().at(1).get<double>() == doctest::Approx(dest.y_km));
      }
    }
  }
  CHECK(on_edges > 1000);

  // A bad radius is a load error.
  file["name"] = "erwin-world-v1";
  file["smooth_km"] = -1;
  World bad_world;
  CHECK(!buildWorldFromJson("erwin-world-v1", file.dump(), 42, bad_world, error));
  file["smooth_km"] = "wide";
  CHECK(!buildWorldFromJson("erwin-world-v1", file.dump(), 42, bad_world, error));
}

TEST_CASE("M17: a product tank that rejects when full does not hold its plant back") {
  // Both runs set the ethane tank and the flag themselves, so the test does
  // not depend on what the shipped world file chooses: the same small tank,
  // held back in one run and free to reject in the other.
  const json small_held = {{"cover_days", 5}, {"init_frac", 0.5}, {"reject_when_full", false}};
  const json small_rejecting = {{"cover_days", 5}, {"init_frac", 0.5}, {"reject_when_full", true}};
  auto held = makeVariantSim("reject-off", "GAS_PLANT", "ETHANE", small_held);
  auto free = makeVariantSim("reject-on", "GAS_PLANT", "ETHANE", small_rejecting);
  const World& w = free->world();
  const int ethane = w.findTank("GAS_PLANT/ETHANE");
  REQUIRE(ethane >= 0);
  CHECK(w.tanks[static_cast<size_t>(ethane)].reject_when_full);
  CHECK(!held->world().tanks[static_cast<size_t>(ethane)].reject_when_full);
  size_t gas_plant = w.processes.size(), grid = w.processes.size();
  for (size_t p = 0; p < w.processes.size(); ++p) {
    const std::string key = w.catalog.process_types[w.processes[p].type].key;
    if (key == "NGL_RECOVERY") gas_plant = p;
    if (key == "GAS_GRID_METHANE") grid = p;
  }
  REQUIRE(gas_plant < w.processes.size());
  REQUIRE(grid < w.processes.size());

  // Undisturbed, nothing is ever rejected and the two runs are the same run.
  held->step(960);
  free->step(960);
  CHECK(free->state().tank[static_cast<size_t>(ethane)].rejected_t == 0.0);
  for (size_t t = 0; t < w.tanks.size(); ++t)
    CHECK(free->state().tank[t].level_t == held->state().tank[t].level_t);

  // Ethane cracker down for ten days: the ethane has nowhere to go.
  const std::string trip =
      R"({"type":"unit_outage","site":"CRACKER_ETHANE","unit":"SC-CGC","trains":1,"duration_h":240})";
  REQUIRE(held->command(trip).find("\"ok\":true") != std::string::npos);
  REQUIRE(free->command(trip).find("\"ok\":true") != std::string::npos);
  const double stock0 = stockSum(free->state());
  const double supplied0 = free->state().cum_supplied_t, consumed0 = free->state().cum_consumed_t,
               loss0 = free->state().cum_loss_t;
  double min_rate = 1e300;
  bool ever_down = false;
  for (int tick = 0; tick < 20 * 96; ++tick) {
    held->step(1);
    free->step(1);
    const ProcState& ps = free->state().proc[gas_plant];
    min_rate = std::min(min_rate, ps.rate_t_h);
    ever_down = ever_down || ps.status != ProcStatus::Running;
    CHECK(free->state().tank[static_cast<size_t>(ethane)].level_t <=
          w.tanks[static_cast<size_t>(ethane)].capacity_t + 1e-6);
  }
  // With the flag the gas plant never left design rate and the city's gas
  // kept flowing; the surplus ethane was thrown away.
  CHECK(!ever_down);
  CHECK(min_rate == doctest::Approx(w.processes[gas_plant].design_rate_t_h));
  const ProcTotals& grid_free = free->state().proc_totals[grid];
  CHECK(grid_free.served_t == doctest::Approx(grid_free.demand_t).epsilon(1e-9));
  const double rejected = free->state().tank[static_cast<size_t>(ethane)].rejected_t;
  CHECK(rejected > 1000.0);
  CHECK(free->state().tank[static_cast<size_t>(ethane)].level_t ==
        doctest::Approx(w.tanks[static_cast<size_t>(ethane)].capacity_t).epsilon(1e-6));
  // Without it the gas plant was held back and the grid went short.
  const ProcTotals& grid_held = held->state().proc_totals[grid];
  CHECK(grid_held.served_t < 0.95 * grid_held.demand_t);
  CHECK(held->state().proc_totals[gas_plant].down_h > 24.0);
  CHECK(held->state().tank[static_cast<size_t>(ethane)].rejected_t == 0.0);

  // Mass is conserved: what was rejected left through the loss account.
  const State& st = free->state();
  const double residual = (stockSum(st) - stock0) - ((st.cum_supplied_t - supplied0) -
                                                     (st.cum_consumed_t - consumed0) -
                                                     (st.cum_loss_t - loss0));
  CHECK(std::fabs(residual) <= 1e-6 * conservationScale(st));
  CHECK(st.cum_loss_t - loss0 > rejected * 0.999);  // the loss account grew by at least that much

  // The window account and the economy view report it, at catalog price.
  Sim probe(*free);
  const WindowReport quiet = runWindow(probe, 96);
  CHECK(quiet.rejected_t >= 0.0);
  const json econ = json::parse(economyJson(w, st, free->recorder(), 24));
  REQUIRE(econ.at("rejected").size() == 1);
  CHECK(econ.at("rejected")[0].at("site") == "GAS_PLANT");
  CHECK(econ.at("rejected")[0].at("material") == "ETHANE");
  CHECK(econ.at("rejected")[0].at("rejectedT").get<double>() == doctest::Approx(rejected).epsilon(1e-4));
  CHECK(econ.at("rejected")[0].at("rejectedUsd").get<double>() ==
        doctest::Approx(rejected * 220.0).epsilon(1e-4));
  double by_bucket = 0;
  for (const json& v : econ.at("totals").at("rejectedT")) by_bucket += v.get<double>();
  CHECK(by_bucket == doctest::Approx(rejected).epsilon(1e-3));
  // A world without the flag has no rejecting tanks and all-zero rejected totals.
  const json econ_held = json::parse(economyJson(held->world(), held->state(), held->recorder(), 24));
  CHECK(econ_held.at("rejected").empty());
  for (const json& v : econ_held.at("totals").at("rejectedT")) CHECK(v.get<double>() == 0.0);

  // Only a product tank may carry the flag.
  json file = json::parse(readWorldFile());
  for (json& s : file["sites"])
    if (s.at("key") == "GAS_PLANT")
      for (json& t : s["tanks"])
        if (t.at("material") == "RAW_GAS") t["reject_when_full"] = true;
  World bad_world;
  std::string error;
  CHECK(!buildWorldFromJson("erwin-world-v1", file.dump(), 42, bad_world, error));
  CHECK(error.find("reject_when_full") != std::string::npos);
}

TEST_CASE("M18: with the flag absent or false the run is the same run") {
  // Whatever the shipped file sets for this tank, compare the field removed
  // against the field set to false.
  auto plain = makeVariantSim("reject-absent", "GAS_PLANT", "ETHANE", {{"reject_when_full", nullptr}});
  auto off = makeVariantSim("reject-false", "GAS_PLANT", "ETHANE", {{"reject_when_full", false}});
  plain->step(30 * 96);
  off->step(30 * 96);
  // World names differ, nothing else: every tank, process and vehicle agrees.
  REQUIRE(off->state().tank.size() == plain->state().tank.size());
  for (size_t t = 0; t < plain->state().tank.size(); ++t) {
    CHECK(off->state().tank[t].level_t == plain->state().tank[t].level_t);
    CHECK(off->state().tank[t].rejected_t == 0.0);
  }
  for (size_t p = 0; p < plain->state().proc.size(); ++p)
    CHECK(off->state().proc[p].rate_t_h == plain->state().proc[p].rate_t_h);
  CHECK(off->state().order.size() == plain->state().order.size());
  CHECK(off->stateHash() == plain->stateHash());
}

TEST_CASE("M19: unit_outage by unit index takes down exactly the unit asked for") {
  auto sim = makeMapSim();
  REQUIRE(sim);
  const World& w = sim->world();
  const auto send = [&](const json& cmd) { return json::parse(sim->command(cmd.dump())); };

  // The fuel depot's four demand blocks share one unit key.
  const auto unitOf = [&](const char* process_key) {
    for (uint32_t u = 0; u < w.units.size(); ++u)
      if (w.catalog.process_types[w.processes[w.units[u].process.v].type].key == process_key) return u;
    return static_cast<uint32_t>(w.units.size());
  };
  const uint32_t jet = unitOf("FUEL_DEPOT_JET"), gasoline = unitOf("FUEL_DEPOT_GASOLINE");
  const uint32_t diesel = unitOf("FUEL_DEPOT_DIESEL"), lpg = unitOf("FUEL_DEPOT_LPG");
  REQUIRE(jet < w.units.size());
  REQUIRE(gasoline < w.units.size());
  const auto keyOf = [&](uint32_t u) {
    return w.catalog.process_types[w.processes[w.units[u].process.v].type].units[w.units[u].slot].key;
  };
  REQUIRE(keyOf(jet) == keyOf(gasoline));  // which is why the key cannot tell them apart
  REQUIRE(jet != gasoline);

  sim->step(96);
  // By key the first match goes down, as before: not the jet block.
  REQUIRE(send({{"type", "unit_outage"}, {"site", "FUEL_DEPOT"}, {"unit", keyOf(jet)},
                {"trains", 1}, {"duration_h", 2}})
              .at("ok") == true);
  sim->step(1);
  const uint32_t first = std::min({jet, gasoline, diesel, lpg});
  CHECK(sim->state().unit[first].trains_down == 1);
  sim->step(16);  // repaired
  for (const uint32_t u : {jet, gasoline, diesel, lpg}) CHECK(sim->state().unit[u].trains_down == 0);

  // By index, with no site: exactly the jet block, for two days.
  REQUIRE(send({{"type", "unit_outage"}, {"unit_index", jet}, {"trains", 1}, {"duration_h", 48}})
              .at("ok") == true);
  sim->step(1);
  CHECK(sim->state().unit[jet].trains_down == 1);
  for (const uint32_t u : {gasoline, diesel, lpg}) CHECK(sim->state().unit[u].trains_down == 0);
  const uint32_t jet_proc = w.units[jet].process.v, gasoline_proc = w.units[gasoline].process.v;
  sim->step(8);
  CHECK(sim->state().proc[jet_proc].rate_t_h == 0.0);       // the jet customers are off
  CHECK(sim->state().proc[gasoline_proc].rate_t_h > 0.0);   // gasoline is not
  // The log names the process as well as the unit, so the four read apart.
  bool named = false;
  for (const LogEntry& e : sim->recorder().log)
    if (e.type == "unit_failed" && e.tick == sim->state().tick - 8 &&
        e.text.find("City jet fuel demand") != std::string::npos &&
        e.text.find(w.catalog.process_types[w.processes[jet_proc].type].units[w.units[jet].slot].name) !=
            std::string::npos)
      named = true;
  CHECK(named);
  sim->step(48 * 4);
  CHECK(sim->state().unit[jet].trains_down == 0);  // and it comes back
  bool repaired = false;
  for (const LogEntry& e : sim->recorder().log)
    if (e.type == "unit_repaired" && e.text.find("City jet fuel demand") != std::string::npos)
      repaired = true;
  CHECK(repaired);

  // The index wins over a key, and must belong to the site when one is named.
  REQUIRE(send({{"type", "unit_outage"}, {"site", "FUEL_DEPOT"}, {"unit", "NO-SUCH-UNIT"},
                {"unit_index", jet}, {"trains", 1}, {"duration_h", 1}})
              .at("ok") == true);
  sim->step(1);
  CHECK(sim->state().unit[jet].trains_down == 1);
  const json wrong_site = send({{"type", "unit_outage"}, {"site", "REFINERY"}, {"unit_index", jet},
                                {"trains", 1}, {"duration_h", 1}});
  CHECK(wrong_site.at("ok") == false);
  CHECK(wrong_site.at("error").get<std::string>().find("is not at REFINERY") != std::string::npos);
  // Bad indexes and a missing unit are refused with a reason.
  CHECK(send({{"type", "unit_outage"}, {"unit_index", w.units.size()}, {"trains", 1}}).at("ok") == false);
  CHECK(send({{"type", "unit_outage"}, {"unit_index", -1}, {"trains", 1}}).at("ok") == false);
  CHECK(send({{"type", "unit_outage"}, {"unit_index", "7"}, {"trains", 1}}).at("ok") == false);
  CHECK(send({{"type", "unit_outage"}, {"site", "FUEL_DEPOT"}, {"trains", 1}}).at("ok") == false);
  CHECK(send({{"type", "unit_outage"}, {"unit_index", jet}}).at("ok") == false);  // no trains
}

TEST_CASE("M20: a tank cut off by a closed route keeps its options, marked route_closed") {
  auto sim = makeMapSim();
  REQUIRE(sim);
  const World& w = sim->world();
  sim->step(480);
  const auto send = [&](const json& cmd) { return json::parse(sim->command(cmd.dump())); };

  const json before_list = json::parse(buyTanksJson(*sim));
  const size_t tanks_before = before_list.at("tanks").size();
  CHECK(tanks_before == 20);
  for (const json& t : before_list.at("tanks")) CHECK(t.at("route_closed") == 0);
  const json before = json::parse(sourcingJson(*sim, "VINYLS", "CHLORINE"));
  REQUIRE(before.at("options").size() == 1);
  CHECK(before.at("options")[0].at("feasible_now") == true);
  CHECK(before.at("options")[0].at("blocked_reason").is_null());
  const double normal_km = before.at("options")[0].at("km").get<double>();
  const double normal_h = before.at("options")[0].at("travel_h").get<double>();

  // Close the road into Vinyls for ten days: chlorine has no other way in.
  const uint32_t road = firstEdgeBetween(*sim, "VINYLS", "CHLOR_ALKALI", crx::Mode::Road);
  REQUIRE(send({{"type", "route_break"}, {"edge", road}, {"duration_h", 240}}).at("ok") == true);
  sim->step(2);
  REQUIRE(!routeOpen(*sim, "CHLOR_ALKALI", "VINYLS", crx::Mode::Road));

  // Still in the picker list, flagged; still one option, priced as the
  // route normally runs, not feasible, and saying why.
  const json list = json::parse(buyTanksJson(*sim));
  CHECK(list.at("tanks").size() == tanks_before);
  bool listed = false;
  size_t cut_tanks = 0;
  for (const json& t : list.at("tanks")) {
    if (t.at("route_closed").get<int>() > 0) ++cut_tanks;
    if (t.at("site") == "VINYLS" && t.at("material") == "CHLORINE") {
      listed = true;
      CHECK(t.at("options") == 1);
      CHECK(t.at("route_closed") == 1);
    }
  }
  CHECK(listed);
  CHECK(cut_tanks >= 1);
  const json cut = json::parse(sourcingJson(*sim, "VINYLS", "CHLORINE"));
  REQUIRE(cut.at("options").size() == 1);
  const json& row = cut.at("options")[0];
  CHECK(row.at("seller") == "CHLOR_ALKALI");
  CHECK(row.at("cls") == "TRUCK_PRESS");
  CHECK(row.at("feasible_now") == false);
  CHECK(row.at("blocked") == "route_closed");
  CHECK(row.at("blocked_reason") == "the road to this site is closed");
  CHECK(row.at("arrives_before_dry") == false);
  CHECK(row.at("chosen") == false);
  CHECK(row.at("km").get<double>() == doctest::Approx(normal_km));
  CHECK(row.at("travel_h").get<double>() == doctest::Approx(normal_h));
  CHECK(row.at("landed_usd_t").get<double>() > 0.0);
  CHECK(cut.at("next_pass").at("lots").empty());  // the hourly pass books nothing for it

  // An order placed by hand is refused with the same word and sentence.
  const json refused = send({{"type", "place_order"}, {"site", "VINYLS"}, {"material", "CHLORINE"},
                             {"seller", "CHLOR_ALKALI"}, {"cls", "TRUCK_PRESS"}, {"tonnes", 20}});
  CHECK(refused.at("ok") == false);
  CHECK(refused.at("blocked") == "route_closed");
  CHECK(refused.at("error") == "place_order: the road to this site is closed");
  // What could never work still says so, closure or not.
  const json never = send({{"type", "place_order"}, {"site", "VINYLS"}, {"material", "CHLORINE"},
                           {"seller", "CHLOR_ALKALI"}, {"cls", "SHIP_GAS"}, {"tonnes", 20}});
  CHECK(never.at("blocked") == "not_possible");

  // A tank the closure does not touch is unaffected.
  const json other = json::parse(sourcingJson(*sim, "PROCESS_INDUSTRIES", "CAUSTIC"));
  bool any_feasible = false;
  for (const json& o : other.at("options")) {
    CHECK(o.at("blocked") != "route_closed");
    any_feasible = any_feasible || o.at("feasible_now").get<bool>();
  }
  CHECK(any_feasible);

  // On water the sentence names the lane: shut the salt barges' river.
  const uint32_t river = firstEdgeBetween(*sim, "SALT_MINE", "CHLOR_ALKALI", crx::Mode::River);
  REQUIRE(send({{"type", "route_break"}, {"edge", river}, {"duration_h", 48}}).at("ok") == true);
  sim->step(2);
  const json salt = json::parse(sourcingJson(*sim, "CHLOR_ALKALI", "SALT"));
  bool barge_cut = false, truck_open = false;
  for (const json& o : salt.at("options")) {
    if (o.at("cls") == "BARGE_DRY") {
      barge_cut = o.at("blocked") == "route_closed" &&
                  o.at("blocked_reason") == "the river lane to this site is closed";
    }
    if (o.at("cls") == "TRUCK_BULK") truck_open = o.at("blocked") != "route_closed";
  }
  CHECK(barge_cut);
  CHECK(truck_open);  // the road is still there for salt

  // When the road reopens the option is bookable again and the hand order goes through.
  sim->step(241 * 4);
  REQUIRE(routeOpen(*sim, "CHLOR_ALKALI", "VINYLS", crx::Mode::Road));
  const json after = json::parse(sourcingJson(*sim, "VINYLS", "CHLORINE"));
  REQUIRE(after.at("options").size() == 1);
  CHECK(after.at("options")[0].at("blocked") != "route_closed");
  const json after_list = json::parse(buyTanksJson(*sim));
  for (const json& t : after_list.at("tanks")) CHECK(t.at("route_closed") == 0);
}

TEST_CASE("M21: a plant never passes more than its online trains allow") {
  auto sim = makeMapSim();
  REQUIRE(sim);
  const World& w = sim->world();
  sim->step(480);
  uint32_t reactor = static_cast<uint32_t>(w.units.size());
  for (uint32_t u = 0; u < w.units.size(); ++u) {
    const Process& proc = w.processes[w.units[u].process.v];
    const ProcessType& type = w.catalog.process_types[proc.type];
    if (type.key == "PP_POLYMERISATION" && type.units[w.units[u].slot].key == "PO-RX") reactor = u;
  }
  REQUIRE(reactor < w.units.size());
  const uint32_t p = w.units[reactor].process.v;
  const double design = w.processes[p].design_rate_t_h;
  REQUIRE(sim->state().proc[p].rate_t_h == doctest::Approx(design));

  // One of the two reactor trains fails for two days.
  REQUIRE(sim->command(json{{"type", "unit_outage"}, {"unit_index", reactor}, {"trains", 1},
                            {"duration_h", 48}}
                           .dump())
              .find("\"ok\":true") != std::string::npos);
  const double cap = 1.10 * design / 2.0;  // one train of two, each sized for 55% of design
  for (int tick = 0; tick < 48 * 4 - 1; ++tick) {
    sim->step(1);
    REQUIRE(sim->state().unit[reactor].trains_down == 1);
    // From the very first tick: never above what one train passes.
    CHECK(sim->state().proc[p].rate_t_h <= cap * (1.0 + 1e-12));
    // So the load the client shows for the unit is never above 100%.
    const double load = sim->state().proc[p].rate_t_h / cap;
    CHECK(load <= 1.0 + 1e-12);
  }
  CHECK(sim->state().proc[p].rate_t_h == doctest::Approx(cap));  // and it settles on the cap
  sim->step(80);
  CHECK(sim->state().proc[p].rate_t_h > cap);  // repaired: ramps back up

  // The same for every plant in the world under a harsher test: half of
  // every multi-train unit goes at once.
  auto all = makeMapSim();
  all->step(200);
  for (uint32_t u = 0; u < w.units.size(); ++u) {
    const ProcessType& type = w.catalog.process_types[w.processes[w.units[u].process.v].type];
    const int trains = type.units[w.units[u].slot].trains;
    if (trains < 2) continue;
    all->command(json{{"type", "unit_outage"}, {"unit_index", u}, {"trains", trains / 2},
                      {"duration_h", 24}}
                     .dump());
  }
  for (int tick = 0; tick < 96; ++tick) {
    all->step(1);
    const State& st = all->state();
    for (uint32_t u = 0; u < w.units.size(); ++u) {
      const Process& proc = w.processes[w.units[u].process.v];
      const ProcessType& type = w.catalog.process_types[proc.type];
      if (type.boundary == Boundary::Sink) continue;
      const UnitSlot& slot = type.units[w.units[u].slot];
      const int online = slot.trains - st.unit[u].trains_down;
      const double unit_max = w.units[u].cap_per_train_t_h * online /
                              unitThroughputPerBasis(slot, proc.mode_share);
      CHECK(st.proc[w.units[u].process.v].rate_t_h <= unit_max * (1.0 + 1e-9));
    }
  }
}

TEST_CASE("M22: supply and demand shocks say when they start and end") {
  auto sim = makeMapSim();
  REQUIRE(sim);
  sim->step(96);
  const auto ok = [&](const json& cmd) {
    return json::parse(sim->command(cmd.dump())).at("ok").get<bool>();
  };
  REQUIRE(ok({{"type", "supply_shock"}, {"site", "GAS_FIELD"}, {"multiplier", 0.5}, {"duration_h", 240}}));
  REQUIRE(ok({{"type", "demand_shock"}, {"site", "FUEL_DEPOT"}, {"multiplier", 1.3}, {"duration_h", 36}}));
  sim->step(1);
  const auto has = [&](const char* type, const char* site, const std::string& text) {
    for (const LogEntry& e : sim->recorder().log)
      if (e.type == type && e.site == site && e.text == text) return true;
    return false;
  };
  CHECK(has("supply_shock", "GAS_FIELD", "Gas field: output cut to 50% for 10 days"));
  CHECK(has("demand_shock", "FUEL_DEPOT", "Fuel depot: demand raised to 130% for 36 hours"));
  CHECK(!has("shock_ended", "FUEL_DEPOT", "Fuel depot: demand back to normal"));
  sim->step(36 * 4);
  CHECK(has("shock_ended", "FUEL_DEPOT", "Fuel depot: demand back to normal"));
  CHECK(!has("shock_ended", "GAS_FIELD", "Gas field: output back to normal"));
  sim->step(204 * 4);
  CHECK(has("shock_ended", "GAS_FIELD", "Gas field: output back to normal"));
  size_t starts = 0, ends = 0;
  for (const LogEntry& e : sim->recorder().log) {
    starts += (e.type == "supply_shock" || e.type == "demand_shock") ? 1 : 0;
    ends += e.type == "shock_ended" ? 1 : 0;
  }
  CHECK(starts == 2);  // once each, not every tick
  CHECK(ends == 2);
}

TEST_CASE("M23: the event log reads as plain sentences") {
  // The word helpers on their own.
  CHECK(materialWord("PE") == "polyethylene");
  CHECK(materialWord("JET") == "jet fuel");
  CHECK(materialWord("LPG") == "LPG");
  CHECK(materialWord("SOME_NEW_THING") == "some new thing");
  CHECK(vehicleWord("TRUCK_BULK") == "a bulk truck");
  CHECK(vehicleWord("SHIP_TANK") == "a tanker");
  CHECK(tonnesText(25.0) == "25 t");
  CHECK(tonnesText(7.5) == "7.5 t");
  CHECK(tonnesText(1610.4) == "1,610 t");
  CHECK(tonnesText(40000.0) == "40,000 t");
  CHECK(trainsDownText(1) == "1 train down");
  CHECK(trainsDownText(2) == "2 trains down");
  CHECK(processWithin("Process industries", "Process industries caustic demand") == "caustic demand");
  CHECK(processWithin("Refinery", "Crude distillation") == "Crude distillation");
  CHECK(processWithin("Packaging", "Packaging") == "Packaging");
  CHECK(streamTitle("edc") == "Ethylene dichloride");
  CHECK(streamTitle("wet_cl2") == "Wet chlorine gas");
  CHECK(streamTitle("PE") == "Polyethylene");

  // A run with a little of everything: a unit failure that stops a plant,
  // a route closure, a customer running short.
  auto sim = makeMapSim();
  REQUIRE(sim);
  sim->step(480);
  const auto send = [&](const json& cmd) { return json::parse(sim->command(cmd.dump())).at("ok"); };
  REQUIRE(send({{"type", "unit_outage"}, {"site", "REFINERY"}, {"unit", "RF-CDU"}, {"trains", 1},
                {"duration_h", 480}}) == true);
  REQUIRE(send({{"type", "unit_outage"}, {"site", "POLYPROPYLENE"}, {"unit", "PO-RX"}, {"trains", 2},
                {"duration_h", 24}}) == true);
  const uint32_t river = firstEdgeBetween(*sim, "SALT_MINE", "CHLOR_ALKALI", crx::Mode::River);
  REQUIRE(send({{"type", "route_break"}, {"edge", river}, {"duration_h", 48}}) == true);
  sim->step(40 * 96);
  std::map<std::string, std::vector<std::string>> by_type;
  for (const LogEntry& e : sim->recorder().log) by_type[e.type].push_back(e.text);
  const auto any = [&](const char* type, const std::string& text) {
    const auto& v = by_type[type];
    return std::find(v.begin(), v.end(), text) != v.end();
  };
  const auto anyStarting = [&](const char* type, const std::string& head) {
    for (const std::string& t : by_type[type])
      if (t.rfind(head, 0) == 0) return true;
    return false;
  };
  CHECK(any("unit_failed", "Refinery: Crude distillation, Atmospheric column failed (1 train down)"));
  CHECK(any("unit_failed",
            "Polypropylene: polymerisation, Gas-phase reactor failed (2 trains down)"));
  CHECK(any("unit_repaired", "Polypropylene: polymerisation, Gas-phase reactor repaired"));
  // The shutdown says a unit caused it, not that tanks could not sustain it.
  CHECK(any("process_shutdown", "Refinery: Crude distillation stopped, its Atmospheric column is down"));
  CHECK(any("process_shutdown",
            "Polypropylene: polymerisation stopped, its Gas-phase reactor is down"));
  CHECK(anyStarting("process_restart", "Polypropylene: polymerisation is running again"));
  // Downstream of the crude unit the reason is the feed that ran out.
  CHECK(any("process_shutdown", "Refinery: Fluid catalytic cracking stopped, it ran out of vacuum gasoil"));
  // Closing and reopening use the same words for the stretch.
  std::string closed, reopened;
  for (const std::string& t : by_type["route_break"]) closed = t;
  for (const std::string& t : by_type["route_reopened"]) reopened = t;
  REQUIRE(closed.size() > 20);
  REQUIRE(reopened.size() > 10);
  CHECK(closed.rfind("River lane between ", 0) == 0);
  CHECK(closed.substr(closed.size() - 18) == " closed for 2 days");
  CHECK(reopened == closed.substr(0, closed.size() - 18) + " reopened");
  // Customers say what they cannot get.
  CHECK(!by_type["stockout"].empty());
  for (const std::string& t : by_type["stockout"]) {
    CHECK(t.find(" cannot get enough ") != std::string::npos);
    CHECK(t.find("demand") == std::string::npos);
  }
  // Trucks, barges and ships are sent and deliver in words.
  CHECK(anyStarting("dispatch", "A bulk truck was sent for 25 t of PVC from Vinyls"));
  CHECK(anyStarting("dispatch", "A tanker was sent for "));
  bool delivered_ok = false;
  for (const std::string& t : by_type["delivered"])
    delivered_ok = delivered_ok || (t.rfind("25 t of PVC delivered to Construction after ", 0) == 0 &&
                                    t.substr(t.size() - 2) == " h");
  CHECK(delivered_ok);
  // Nothing in the log shouts a raw key or the old stock phrases.
  for (const auto& entry : by_type)
    for (const std::string& t : entry.second) {
      CHECK(t.find("train(s)") == std::string::npos);
      CHECK(t.find("cannot sustain") == std::string::npos);
      CHECK(t.find("cannot serve demand") == std::string::npos);
      CHECK(t.find("TRUCK_") == std::string::npos);
      CHECK(t.find("\xE2\x86\x92") == std::string::npos);  // no arrows
    }
}

TEST_CASE("M24: sourcing tells the site's state from the plant's, and a short seller says both numbers") {
  auto sim = makeMapSim();
  REQUIRE(sim);
  sim->step(960);
  // Everything running: both states agree.
  const json calm = json::parse(sourcingJson(*sim, "FUEL_DEPOT", "DIESEL"));
  for (const json& o : calm.at("options")) CHECK(o.at("seller_site_state") == "running");
  CHECK(calm.at("usual").at("site_state") == "running");

  // The crude unit goes down. Diesel is still made from gasoil in stock.
  REQUIRE(sim->command(R"({"type":"unit_outage","site":"REFINERY","unit":"RF-CDU","trains":1,)"
                       R"("duration_h":240})")
              .find("\"ok\":true") != std::string::npos);
  sim->step(8);
  const json doc = json::parse(sourcingJson(*sim, "FUEL_DEPOT", "DIESEL"));
  bool saw_refinery = false;
  for (const json& o : doc.at("options"))
    if (o.at("seller") == "REFINERY") {
      saw_refinery = true;
      CHECK(o.at("seller_state") == "running");         // the diesel hydrotreater
      CHECK(o.at("seller_site_state") == "shut_down");  // the site, as the map shows it
    }
  CHECK(saw_refinery);
  CHECK(doc.at("usual").at("site") == "REFINERY");
  CHECK(doc.at("usual").at("state") == "running");
  CHECK(doc.at("usual").at("site_state") == "shut_down");
  const json list = json::parse(buyTanksJson(*sim));
  bool row_ok = false;
  for (const json& t : list.at("tanks"))
    if (t.at("site") == "FUEL_DEPOT" && t.at("material") == "DIESEL")
      row_ok = t.at("usual_state") == "running" && t.at("usual_site_state") == "shut_down";
  CHECK(row_ok);

  // A seller without a full load: the reason gives what it can spare and
  // what one load is, in the same units the row shows.
  // (Empty the small solvent tank at Styrenics with hand orders first, so
  // there is a short seller to look at.)
  for (int i = 0; i < 12; ++i)
    sim->command(R"({"type":"place_order","site":"PAINTS","material":"SOLVENT","seller":"STYRENICS",)"
                 R"("cls":"TRUCK_TANK","tonnes":20})");
  size_t short_rows = 0;
  for (const json& t : list.at("tanks")) {
    const json d = json::parse(sourcingJson(*sim, t.at("site").get<std::string>(),
                                            t.at("material").get<std::string>()));
    for (const json& o : d.at("options")) {
      if (o.at("blocked") != "seller_short") continue;
      ++short_rows;
      const std::string reason = o.at("blocked_reason").get<std::string>();
      CHECK(reason == "it can spare " + tonnesText(o.at("free_t").get<double>()) +
                          "; one load here is " + tonnesText(o.at("lot_t").get<double>()));
      CHECK(o.at("free_t").get<double>() < o.at("lot_t").get<double>());
    }
  }
  CHECK(short_rows > 0);
}
