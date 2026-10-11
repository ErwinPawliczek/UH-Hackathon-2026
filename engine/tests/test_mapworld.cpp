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
#include "sim/worldfile.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
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
            w.units[u].cap_per_train_t_h * slot.trains / unitThroughputPerBasis(slot);
        CHECK_MESSAGE(r_max == doctest::Approx(1.10 * proc.design_rate_t_h),
                      w.name << " " << w.sites[proc.site.v].key << "/" << type.key << " unit "
                             << slot.key << ": R_max " << r_max << " vs design "
                             << proc.design_rate_t_h);
      }
    }
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
