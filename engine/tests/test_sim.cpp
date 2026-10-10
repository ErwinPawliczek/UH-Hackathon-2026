// Chain Reaction — §12 simulation tests (T1–T5) and the M1 acceptance
// cascade, over the hand-written six-site world (§13).
//
//   T1 world/catalog validation — unit balance per mode, internal streams
//   T2 mass conservation per tick (1e-9 relative, boundary accumulators)
//   T3 bounds — tank levels, rates, reservations
//   T4 determinism — same seed + commands → same state hash, run twice
//   T5 fork equivalence — fork + same commands == parent
//   T6 acceptance — cracker outage starves downstream, backs up upstream
#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN

#include <doctest/doctest.h>

#include "sim/sim.h"
#include "sim/sixsite.h"
#include "sim/validate.h"

#include <algorithm>
#include <cmath>
#include <memory>
#include <string>

using namespace crx;
using namespace crx::sim;

namespace {

constexpr double kTol = 1e-9;

std::unique_ptr<Sim> makeSim(uint64_t seed = 42) {
  std::string error;
  auto sim = Sim::create(seed, error);
  REQUIRE_MESSAGE(sim != nullptr, "Sim::create failed: " << error);
  return sim;
}

double stockSum(const State& st) {
  double s = 0;
  for (const TankState& t : st.tank) s += t.level_t;
  return s;
}

int findProc(const World& w, const char* site, const char* type) {
  for (size_t i = 0; i < w.processes.size(); ++i) {
    const Process& p = w.processes[i];
    if (w.sites[p.site.v].key == site && w.catalog.process_types[p.type].key == type)
      return static_cast<int>(i);
  }
  return -1;
}

// Tolerance scale for T2: relative to the larger of total stock and total
// boundary throughput, so 1e-9 is meaningful at any run length.
double conservationScale(const State& st) {
  return std::max({1.0, stockSum(st), st.cum_supplied_t, st.cum_consumed_t, st.cum_loss_t});
}

}  // namespace

// ---------------------------------------------------------------------------
TEST_CASE("T1: six-site world builds, validates and balances") {
  World world;
  std::string error;
  REQUIRE_MESSAGE(buildSixSiteWorld(42, world, error), error);

  SUBCASE("topology: the six documented sites and the gas-chain spine") {
    for (const char* key : {"GAS_FIELD", "GAS_PLANT", "STEAM_CRACKER", "POLYETHYLENE",
                            "PORT_TERMINAL", "GAS_GRID"})
      CHECK_MESSAGE(world.findSite(key) >= 0, "missing site " << key);
    CHECK_GE(world.pipelines.size(), 5);
    CHECK_GE(world.findTank("GAS_PLANT/ETHANE"), 0);
    CHECK_GE(world.findTank("STEAM_CRACKER/ETHYLENE"), 0);
    CHECK_GE(findProc(world, "STEAM_CRACKER", "OLEFINS_FLEX"), 0);
    CHECK_GE(findProc(world, "POLYETHYLENE", "PE_POLYMERISATION"), 0);
    CHECK_GE(findProc(world, "POLYETHYLENE", "PACKAGING_PE"), 0);
  }

  SUBCASE("every unit balances in every mode to 1e-9; internal streams net to zero") {
    // The catalog validator enforces this at load; re-assert it here over the
    // process types the world actually instantiates (§12 test 1).
    std::vector<uint16_t> used;
    for (const Process& p : world.processes)
      if (std::find(used.begin(), used.end(), p.type) == used.end()) used.push_back(p.type);

    for (uint16_t type_idx : used) {
      const ProcessType& type = world.catalog.process_types[type_idx];
      for (size_t m = 0; m < type.modes.size(); ++m) {
        double internal = 0;
        for (const UnitSlot& slot : type.units) {
          if (m >= slot.by_mode.size()) continue;
          for (const Stream& s : slot.by_mode[m].in)
            if (s.slot >= kInternalStreamBase) internal -= s.t_per_t;  // magnitudes: in consumes
          for (const Stream& s : slot.by_mode[m].out)
            if (s.slot >= kInternalStreamBase) internal += s.t_per_t;  // out produces
        }
        CHECK_MESSAGE(std::fabs(internal) < kTol, type.key << " mode " << type.modes[m]
                                                           << ": internal streams do not net to zero");
        double total = internal;
        if (m < type.net.size())
          for (const Stream& s : type.net[m]) total += s.t_per_t;
        // Boundary processes are one-sided by design (§3.3).
        if (type.boundary != Boundary::None)
          CHECK_MESSAGE(std::fabs(total) >= kTol,
                        type.key << " boundary mode " << type.modes[m] << " is empty");
        else
          CHECK_MESSAGE(std::fabs(total) < kTol,
                        type.key << " mode " << type.modes[m] << ": unit balance off by " << total);
      }
    }
  }
}

// ---------------------------------------------------------------------------
TEST_CASE("T2: mass conservation holds every tick to 1e-9 relative") {
  auto sim = makeSim();
  const World& w = sim->world();

  const double initial_stock = stockSum(sim->state());
  double prev_stock = initial_stock;
  double prev_supplied = 0, prev_consumed = 0, prev_loss = 0;

  // Three days tick-by-tick with shocks in flight — conservation must hold
  // through rationing, throttling and boundary flows alike.
  REQUIRE(sim->command(R"({"type":"demand_shock","site":"PORT_TERMINAL","multiplier":0.6,"duration_h":48})")
              .find("\"ok\":true") != std::string::npos);

  for (uint32_t tick = 0; tick < 3 * 96; ++tick) {
    sim->step(1);
    const State& st = sim->state();
    const double scale = conservationScale(st);
    const double d_stock = stockSum(st) - prev_stock;
    const double d_supplied = st.cum_supplied_t - prev_supplied;
    const double d_consumed = st.cum_consumed_t - prev_consumed;
    const double d_loss = st.cum_loss_t - prev_loss;
    const double residual = d_stock - (d_supplied - d_consumed - d_loss);
    CHECK_MESSAGE(std::fabs(residual) <= kTol * scale,
                  "tick " << tick << ": conservation residual " << residual << " t");
    prev_stock = stockSum(st);
    prev_supplied = st.cum_supplied_t;
    prev_consumed = st.cum_consumed_t;
    prev_loss = st.cum_loss_t;
    if (tick == 96)
      sim->command(R"({"type":"supply_shock","site":"GAS_FIELD","multiplier":0.8,"duration_h":24})");
  }

  // No mass invented or destroyed over the run as a whole either.
  const State& st = sim->state();
  const double net =
      initial_stock + st.cum_supplied_t - st.cum_consumed_t - st.cum_loss_t - stockSum(st);
  CHECK(std::fabs(net) <= kTol * conservationScale(st));
  CHECK_GT(w.tanks.size(), 0);
}

// ---------------------------------------------------------------------------
TEST_CASE("T3: levels stay in bounds, rates within [0, design], reservations non-negative") {
  auto sim = makeSim();
  const World& w = sim->world();

  REQUIRE(sim->command(
              R"({"type":"unit_outage","site":"STEAM_CRACKER","unit":"SC-FURN","trains":4,"duration_h":120})")
              .find("\"ok\":true") != std::string::npos);
  REQUIRE(sim->command(R"({"type":"demand_shock","site":"GAS_GRID","multiplier":1.4,"duration_h":96})")
              .find("\"ok\":true") != std::string::npos);
  sim->step(10 * 96);  // ten days through outage and recovery

  const State& st = sim->state();
  for (size_t t = 0; t < w.tanks.size(); ++t) {
    const double level = st.tank[t].level_t;
    const double cap = w.tanks[t].capacity_t;
    CHECK_MESSAGE(level >= -kTol, w.tanks[t].key << " level " << level << " below zero");
    CHECK_MESSAGE(level <= cap + kTol,
                  w.tanks[t].key << " level " << level << " over capacity " << cap);
    CHECK(st.tank[t].reserved_out_t >= -kTol);
  }
  for (size_t p = 0; p < w.processes.size(); ++p) {
    const double rate = st.proc[p].rate_t_h;
    const double design = w.processes[p].design_rate_t_h;
    CHECK_MESSAGE(rate >= -kTol, "process " << p << " rate " << rate << " below zero");
    CHECK_MESSAGE(rate <= design + kTol,
                  "process " << p << " rate " << rate << " over design " << design);
    // Steady state after ten days: a Running process sits in its band.
    // Shutdown/Restarting transients legitimately sweep through the band on
    // their ramp to zero, so the band applies only to Running processes.
    if (rate > kTol && st.proc[p].status == ProcStatus::Running) {
      const ProcessType& type = w.catalog.process_types[w.processes[p].type];
      CHECK_MESSAGE(rate >= type.turndown * design - 1e-6,
                    "process " << p << " (" << type.key << ") rate " << rate
                               << " below turndown band " << type.turndown * design);
    }
  }
}

// ---------------------------------------------------------------------------
TEST_CASE("T4: determinism — same seed and commands give the same state hash") {
  const std::string outage =
      R"({"type":"unit_outage","site":"STEAM_CRACKER","unit":"SC-FURN","trains":4,"duration_h":168})";
  const std::string shock =
      R"({"type":"demand_shock","site":"PORT_TERMINAL","multiplier":0.5,"duration_h":72})";

  auto a = makeSim(7);
  auto b = makeSim(7);

  a->step(288);
  b->step(288);
  CHECK_EQ(a->stateHash(), b->stateHash());

  REQUIRE(a->command(outage).find("\"ok\":true") != std::string::npos);
  REQUIRE(b->command(outage).find("\"ok\":true") != std::string::npos);
  a->step(192);
  b->step(192);
  REQUIRE(a->command(shock).find("\"ok\":true") != std::string::npos);
  REQUIRE(b->command(shock).find("\"ok\":true") != std::string::npos);
  a->step(960);
  b->step(960);  // same commands, same ticks, run twice in-process

  CHECK_EQ(a->stateHash(), b->stateHash());
  CHECK_EQ(a->state().tick, b->state().tick);

  std::vector<double> ka, kb;
  a->computeKpis(ka);
  b->computeKpis(kb);
  REQUIRE_EQ(ka.size(), kb.size());
  for (size_t i = 0; i < ka.size(); ++i) CHECK_EQ(ka[i], kb[i]);

  CHECK_EQ(a->recorder().log.size(), b->recorder().log.size());
  CHECK_EQ(crx::sim::eventsJson(a->recorder(), 0), crx::sim::eventsJson(b->recorder(), 0));
}

// ---------------------------------------------------------------------------
TEST_CASE("T5: fork equivalence — a fork stepped with the same commands matches its parent") {
  auto parent = makeSim(11);
  parent->step(672);  // one week of warm-up

  auto child = std::make_unique<Sim>(*parent);  // deep copy at the same tick
  CHECK_EQ(parent->stateHash(), child->stateHash());

  const std::string outage =
      R"({"type":"unit_outage","site":"POLYETHYLENE","unit":"PO-RX","trains":1,"duration_h":96})";
  const std::string shock =
      R"({"type":"demand_shock","site":"GAS_GRID","multiplier":1.3,"duration_h":48})";
  REQUIRE(parent->command(outage).find("\"ok\":true") != std::string::npos);
  REQUIRE(child->command(outage).find("\"ok\":true") != std::string::npos);

  // Parent: two large chunks. Child: several small ones, same command at the
  // same tick. Chunk boundaries must be invisible in the state.
  parent->step(240);
  child->step(96);
  child->step(144);
  CHECK_EQ(parent->stateHash(), child->stateHash());

  REQUIRE(parent->command(shock).find("\"ok\":true") != std::string::npos);
  REQUIRE(child->command(shock).find("\"ok\":true") != std::string::npos);

  parent->step(240);
  child->step(144);
  child->step(96);
  CHECK_EQ(parent->stateHash(), child->stateHash());
  CHECK_EQ(parent->state().tick, child->state().tick);
}

// ---------------------------------------------------------------------------
TEST_CASE("T6 acceptance: a cracker outage starves downstream and backs up upstream") {
  auto sim = makeSim();
  const World& w = sim->world();

  const int cracker = findProc(w, "STEAM_CRACKER", "OLEFINS_FLEX");
  const int gas_plant = findProc(w, "GAS_PLANT", "NGL_RECOVERY");
  const int ethane_tank = w.findTank("GAS_PLANT/ETHANE");
  REQUIRE_GE(cracker, 0);
  REQUIRE_GE(gas_plant, 0);
  REQUIRE_GE(ethane_tank, 0);

  sim->step(3 * 96);  // three days of warm-up
  const double ethane_before = sim->state().tank[ethane_tank].level_t;
  const double cracker_rate_before = sim->state().proc[cracker].rate_t_h;
  CHECK_GT(cracker_rate_before, 0.5 * w.processes[cracker].design_rate_t_h);

  // All eight pyrolysis furnaces trip for a week — a full cracker outage.
  // The cascade needs the whole unit: downstream cover (4 d ethylene at the
  // PE plant + 3 d PE at the packaging sink) is spent roughly seven days in.
  REQUIRE(sim->command(
              R"({"type":"unit_outage","site":"STEAM_CRACKER","unit":"SC-FURN","trains":8,"duration_h":168})")
              .find("\"ok\":true") != std::string::npos);
  sim->step(8 * 96);  // eight days: past the downstream cover, still inside the outage

  const State& st = sim->state();
  const double ethane_after = st.tank[ethane_tank].level_t;
  const double ethane_cap = w.tanks[ethane_tank].capacity_t;

  // Downstream starves: the PE plant draws against a draining ethylene tank
  // and the packaging sink goes unserved once the PE tank empties.
  std::vector<double> kpis;
  sim->computeKpis(kpis);
  CHECK_GT(kpis[1], 1.0);  // cumulative unmet tonnage grows beyond warm-up noise

  // Upstream backs up: with the cracker drawing no ethane, the gas plant's
  // ethane tank climbs well above its pre-outage level, and the worst-tank
  // governor throttles the gas plant below design.
  CHECK_GT(ethane_after, ethane_before + 0.2 * ethane_cap);
  CHECK_LT(st.proc[gas_plant].rate_t_h, 0.95 * w.processes[gas_plant].design_rate_t_h);

  // After the repair the chain heals: the cracker and the gas plant ramp
  // back up (the restart timers and governor gaps clear once downstream
  // stock drains back below target).
  sim->step(20 * 96);
  CHECK_GT(sim->state().proc[cracker].rate_t_h, 0.5 * w.processes[cracker].design_rate_t_h);
  CHECK_GT(sim->state().proc[gas_plant].rate_t_h, 0.3 * w.processes[gas_plant].design_rate_t_h);
}
