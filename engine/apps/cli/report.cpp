// crx-report — diagnostic runner: steps one world for N days, samples the
// state after every tick, and prints why service holds or fails — sinks,
// processes with the tank that binds them, tanks, orders, fleet and bays —
// followed by a PASS/FAIL verdict (exit code 0 / 1; 2 = bad usage or config).
//
//   crx-report [--config '<json>'] [--days 60] [--checkpoints 7,30,60]
//              [--min-service 0.95] [--min-sink-service 0] [--json out.json]
//              [--quiet] [--command '[<day>:]<json>']...
//
// --config goes verbatim to Sim::createFromConfig. The engine's service
// level is tonnage-weighted over all sinks, so one big sink can hide a dry
// small one: --min-sink-service X also fails the run when any single sink
// gets less than X of its demand in any window (default 0 = only warn). --command sends one §7.2
// command (an outage, a route break) at the start of the given day (0 if
// omitted). The tool only reads engine state; it changes no engine source.

#include "sim/sim.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <limits>
#include <map>
#include <numeric>
#include <string>
#include <utility>
#include <vector>

using json = nlohmann::json;
using namespace crx;
using namespace crx::sim;

namespace {

constexpr double kDt = kTickHours;
constexpr uint64_t kTicksPerDay = 96;
constexpr double kRateEps = 1e-6;  // control.cpp: below this a rate is zero
constexpr int kVehStatusCount = 7;

const char* const kProcStatusName[4] = {"run", "hold", "shut", "restart"};
const char* const kVehStatusName[kVehStatusCount] = {
    "idle", "to_pickup", "queue_load", "loading", "to_dropoff", "queue_unload", "unloading"};
const char* const kModeName[kModeCount] = {"road", "river", "sea"};

struct Options {
  std::string config = R"({"seed":42})";
  double days = 60;
  std::vector<double> checkpoints{7, 30, 60};
  double min_service = 0.95;
  double min_sink_service = 0;  // > 0: every sink must reach this share in every window
  std::string json_path;
  bool quiet = false;
  std::vector<std::pair<double, std::string>> commands;  // (day, json)
};

// What a process touches, built the way control.cpp's makeViews does.
struct ProcInfo {
  std::string label;  // SITE/PROCESS_TYPE
  bool source = false, sink = false;
  std::vector<uint32_t> feeds, products;  // tank ids over the active modes
  int sink_tank = -1;                     // sinks: the tank they draw from
};

struct CauseAcc {
  double h = 0;       // hours the governor was below 1 with this tank lowest
  double h_last = 0;  // ... inside the last window
  double h_bad = 0;   // ... while Shutdown or HoldMin, after day 1
  double g_sum = 0;   // governor summed over those ticks (mean = g_sum·dt/h)
};

struct ProcAcc {
  std::vector<double> win_rate;  // per window: sum of rate/design
  std::vector<double> win_demand, win_served;  // sinks: tonnes per window
  double status_h[4] = {0, 0, 0, 0};
  uint32_t shutdown_episodes = 0;
  ProcStatus prev = ProcStatus::Running;
  std::map<std::pair<char, int>, CauseAcc> cause;  // ('F'|'P'|'C', tank id)
  double dry_h = 0, short_h = 0;                   // sinks
};

struct TankAcc {
  double fill0 = 0, min = 1e300, max = -1e300, low_h = 0, high_h = 0;
  std::vector<double> cp_fill;
  double unmatched_h = 0, capped_h = 0;  // hourly procurement passes left short
};

struct PipeAcc {
  std::vector<double> win_flow;  // per window: sum of flow (t/h) over ticks
  double max_flow = 0, at_cap_h = 0;
};

struct OrdRec {
  uint64_t assigned_tick = 0, delivered_tick = 0;
  bool assigned = false;
};

struct OrdAgg {
  uint32_t created = 0, delivered = 0, in_transit_end = 0, unassigned_end = 0, cancelled = 0;
  double t_created = 0, t_delivered = 0;
  double lead_sum = 0, lead_max = 0;  // creation → delivery, hours
  double wait_sum = 0, wait_max = 0;  // creation → vehicle assigned, hours
  uint32_t wait_n = 0;
  double oldest_unassigned_h = 0;
};

struct LaneAgg {
  uint32_t lots = 0, delivered = 0;
  double tonnes = 0, lead_sum = 0, km = 0;
};

struct ClassAcc {
  uint32_t count = 0, no_node = 0;
  double status_ticks[kVehStatusCount] = {0, 0, 0, 0, 0, 0, 0};
  double stalled_ticks = 0;
  double km_loaded = 0, km_empty = 0;
  double tonnes = 0, tonne_km = 0;
  uint32_t deliveries = 0;
};

struct BayAcc {
  double busy_sum = 0, queue_sum = 0;
  uint32_t queue_max = 0, busy_max = 0;
};

struct Checkpoint {
  double day = 0;
  uint64_t tick = 0;
  std::vector<double> kpi;
  double demand_t = 0, unmet_t = 0, consumed_t = 0;  // engine accumulators
  double win_service_engine = 1, win_service_sinks = 1;
  double shutdown_h_measured = 0;
  double worst_sink = 1;  // lowest delivered share of any sink in the window
  std::string worst_sink_label;
  uint64_t hash = 0;
};

bool parseOptions(int argc, char** argv, Options& o, std::string& err) {
  for (int i = 1; i < argc; ++i) {
    const std::string a = argv[i];
    auto need = [&](const char* name) -> const char* {
      if (i + 1 >= argc) {
        err = std::string(name) + " needs a value";
        return nullptr;
      }
      return argv[++i];
    };
    if (a == "--quiet") {
      o.quiet = true;
    } else if (a == "--config") {
      const char* v = need("--config");
      if (!v) return false;
      o.config = v;
    } else if (a == "--days") {
      const char* v = need("--days");
      if (!v) return false;
      o.days = std::atof(v);
    } else if (a == "--min-service") {
      const char* v = need("--min-service");
      if (!v) return false;
      o.min_service = std::atof(v);
    } else if (a == "--min-sink-service") {
      const char* v = need("--min-sink-service");
      if (!v) return false;
      o.min_sink_service = std::atof(v);
    } else if (a == "--json") {
      const char* v = need("--json");
      if (!v) return false;
      o.json_path = v;
    } else if (a == "--checkpoints") {
      const char* v = need("--checkpoints");
      if (!v) return false;
      o.checkpoints.clear();
      std::string s = v;
      size_t pos = 0;
      while (pos <= s.size()) {
        const size_t comma = s.find(',', pos);
        const std::string part = s.substr(pos, comma == std::string::npos ? comma : comma - pos);
        if (!part.empty()) o.checkpoints.push_back(std::atof(part.c_str()));
        if (comma == std::string::npos) break;
        pos = comma + 1;
      }
    } else if (a == "--command") {
      const char* v = need("--command");
      if (!v) return false;
      std::string s = v;
      double day = 0;
      const size_t colon = s.find(':');
      const size_t brace = s.find('{');
      if (colon != std::string::npos && (brace == std::string::npos || colon < brace)) {
        day = std::atof(s.substr(0, colon).c_str());
        s = s.substr(colon + 1);
      }
      o.commands.emplace_back(day, s);
    } else {
      err = "unknown argument: " + a;
      return false;
    }
  }
  if (o.days <= 0) {
    err = "--days must be positive";
    return false;
  }
  return true;
}

// control.cpp computeRMax: capacity this tick with trains down.
double rMax(const World& w, const Process& proc, const State& st) {
  const ProcessType& type = w.catalog.process_types[proc.type];
  double r_max = std::numeric_limits<double>::infinity();
  for (uint32_t u = proc.units.begin; u < rangeEnd(proc.units); ++u) {
    const Unit& unit = w.units[u];
    const UnitSlot& slot = type.units[unit.slot];
    const int online = static_cast<int>(slot.trains) - st.unit[u].trains_down;
    if (online <= 0) return 0.0;
    r_max = std::min(r_max, unit.cap_per_train_t_h * online /
                                unitThroughputPerBasis(slot, proc.mode_share));
  }
  return std::min(proc.design_rate_t_h, std::isinf(r_max) ? proc.design_rate_t_h : r_max);
}

// control.cpp scheduleFactor.
double scheduleFactor(const World& w, const Process& proc, uint64_t tick) {
  const std::vector<double>& sched = w.schedules[proc.schedule];
  if (sched.empty()) return 1.0;
  const size_t hour = static_cast<size_t>(std::fmod(static_cast<double>(tick) * kDt, 24.0));
  return sched[hour % sched.size()];
}

std::string pct(double x) {
  char b[32];
  if (!std::isfinite(x)) return "    -";
  std::snprintf(b, sizeof b, "%5.1f", 100.0 * x);
  return b;
}

std::string fmt(const char* f, double v) {
  char b[64];
  std::snprintf(b, sizeof b, f, v);
  return b;
}

std::string dayLabel(double d) {
  char b[32];
  if (std::fabs(d - std::round(d)) < 1e-9)
    std::snprintf(b, sizeof b, "d%.0f", d);
  else
    std::snprintf(b, sizeof b, "d%.2f", d);
  return b;
}

struct UnionFind {
  std::vector<uint32_t> p;
  explicit UnionFind(size_t n) : p(n) { std::iota(p.begin(), p.end(), 0u); }
  uint32_t find(uint32_t x) {
    while (p[x] != x) x = p[x] = p[p[x]];
    return x;
  }
  void join(uint32_t a, uint32_t b) { p[find(a)] = find(b); }
};

}  // namespace

int main(int argc, char** argv) {
  Options opt;
  std::string err;
  if (!parseOptions(argc, argv, opt, err)) {
    std::fprintf(stderr,
                 "crx-report: %s\n"
                 "usage: crx-report [--config '<json>'] [--days 60] [--checkpoints 7,30,60]\n"
                 "                  [--min-service 0.95] [--min-sink-service 0] [--json out.json]\n"
                 "                  [--quiet] [--command '[<day>:]<json>']...\n",
                 err.c_str());
    return 2;
  }

  std::unique_ptr<Sim> sim = Sim::createFromConfig(opt.config.c_str(), err);
  if (!sim) {
    std::fprintf(stderr, "crx-report: engine rejected the config: %s\n", err.c_str());
    return 2;
  }
  const World& w = sim->world();
  const Catalog& cat = w.catalog;
  const MarketParams market;  // defaults, as Sim uses them

  // Checkpoints: the requested days inside the run, plus the final day.
  const uint64_t total_ticks = static_cast<uint64_t>(std::llround(opt.days * kTicksPerDay));
  std::vector<Checkpoint> cps;
  {
    std::vector<double> days = opt.checkpoints;
    days.push_back(opt.days);
    std::sort(days.begin(), days.end());
    for (double d : days) {
      const uint64_t t = static_cast<uint64_t>(std::llround(d * kTicksPerDay));
      if (t == 0 || t > total_ticks) continue;
      if (!cps.empty() && cps.back().tick == t) continue;
      Checkpoint c;
      c.day = d;
      c.tick = t;
      cps.push_back(c);
    }
  }
  const size_t nwin = cps.size();

  // ---- Static views.
  const size_t np = w.processes.size(), nt = w.tanks.size(), nv = w.fleet.size();
  std::vector<ProcInfo> pinfo(np);
  std::vector<ProcAcc> pacc(np);
  for (size_t p = 0; p < np; ++p) {
    const Process& proc = w.processes[p];
    const ProcessType& type = cat.process_types[proc.type];
    ProcInfo& pi = pinfo[p];
    pi.label = w.sites[proc.site.v].key + "/" + type.key;
    pi.source = type.boundary == Boundary::Source;
    pi.sink = type.boundary == Boundary::Sink;
    for (size_t m = 0; m < type.net.size() && m < proc.mode_share.size(); ++m) {
      if (proc.mode_share[m] <= 0.0) continue;
      for (const Stream& s : type.net[m]) {
        if (s.slot >= kInternalStreamBase) continue;
        const TankId tank = proc.tank_of[s.slot];
        if (!tank.valid()) continue;
        auto& list = s.t_per_t < 0.0 ? pi.feeds : pi.products;
        if (s.t_per_t == 0.0) continue;
        // control.cpp leaves a tank that rejects when full out of the governor.
        if (s.t_per_t > 0.0 && w.tanks[tank.v].reject_when_full) continue;
        if (std::find(list.begin(), list.end(), tank.v) == list.end()) list.push_back(tank.v);
      }
    }
    if (pi.sink && !pi.feeds.empty()) pi.sink_tank = static_cast<int>(pi.feeds.front());
    pacc[p].win_rate.assign(nwin, 0.0);
    pacc[p].win_demand.assign(nwin, 0.0);
    pacc[p].win_served.assign(nwin, 0.0);
  }

  std::vector<TankAcc> tacc(nt);
  for (size_t t = 0; t < nt; ++t) {
    const double cap = w.tanks[t].capacity_t;
    tacc[t].fill0 = cap > 0 ? sim->state().tank[t].level_t / cap : 0.0;
    tacc[t].min = tacc[t].max = tacc[t].fill0;
  }

  std::vector<PipeAcc> ppacc(w.pipelines.size());
  for (PipeAcc& a : ppacc) a.win_flow.assign(nwin, 0.0);

  const size_t ncls = cat.vehicle_classes.size();
  std::vector<ClassAcc> cacc(ncls);
  // Distance comes from edge progress, not from the pose: VehicleState x/y
  // is mirrored on edges driven b→a (edgePose ignores `reverse` for position).
  std::vector<uint32_t> prev_edge(nv, UINT32_MAX);
  std::vector<double> prev_pos(nv, 0.0);
  for (size_t v = 0; v < nv; ++v) {
    ClassAcc& c = cacc[w.fleet[v].cls];
    c.count += 1;
    if (sim->state().vehicle[v].at_node == kNoNode) c.no_node += 1;
  }

  std::vector<std::array<BayAcc, kModeCount>> bacc(w.sites.size());
  std::vector<std::array<uint32_t, kModeCount>> bay_busy(w.sites.size()), bay_queue(w.sites.size());

  std::vector<OrdRec> orec;
  std::vector<uint32_t> live;  // order ids not yet delivered or cancelled
  std::map<std::pair<uint16_t, uint16_t>, OrdAgg> oagg;                    // (material, class)
  std::map<std::tuple<uint32_t, uint32_t, uint16_t>, LaneAgg> lanes;       // (from, to, class)
  std::vector<uint32_t> new_orders_for_tank(nt, 0);
  PathCache paths;  // own copy, for delivered tonne-km

  // ---- Run.
  std::sort(opt.commands.begin(), opt.commands.end(),
            [](const auto& a, const auto& b) { return a.first < b.first; });
  size_t next_cmd = 0;
  size_t win = 0;
  double window_demand = 0, window_served = 0;  // sampled sink totals in this window
  double prev_demand = 0, prev_unmet = 0;       // engine accumulators at the last checkpoint
  double step_seconds = 0;
  double shutdown_h_measured = 0;
  const auto wall0 = std::chrono::steady_clock::now();

  for (uint64_t i = 0; i < total_ticks; ++i) {
    while (next_cmd < opt.commands.size() &&
           static_cast<uint64_t>(std::llround(opt.commands[next_cmd].first * kTicksPerDay)) <= i) {
      const std::string res = sim->command(opt.commands[next_cmd].second);
      std::printf("command @ day %.2f: %s -> %s\n", opt.commands[next_cmd].first,
                  opt.commands[next_cmd].second.c_str(), res.c_str());
      ++next_cmd;
    }

    const auto t0 = std::chrono::steady_clock::now();
    sim->step(1);
    step_seconds += std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();

    const State& st = sim->state();
    const std::vector<TankSignals>& sig = sim->signals;  // the signals control used this tick
    const uint64_t tick = st.tick;
    const bool after_day1 = tick > kTicksPerDay;
    const bool last_window = win + 1 == nwin;

    // -- Processes and sinks.
    for (size_t p = 0; p < np; ++p) {
      const Process& proc = w.processes[p];
      const ProcInfo& pi = pinfo[p];
      const ProcState& ps = st.proc[p];
      ProcAcc& a = pacc[p];
      const double design = proc.design_rate_t_h;
      a.win_rate[win] += design > 0 ? ps.rate_t_h / design : 0.0;
      a.status_h[static_cast<int>(ps.status)] += kDt;
      if (ps.status == ProcStatus::Shutdown && a.prev != ProcStatus::Shutdown)
        a.shutdown_episodes += 1;
      a.prev = ps.status;

      const double r_max = rMax(w, proc, st);

      if (pi.sink) {
        double demand = design * scheduleFactor(w, proc, tick) *
                        shockFactor(st, proc.site.v, EventDef::Type::DemandShock);
        if (r_max <= kRateEps) demand = 0.0;
        const double served = std::min(ps.rate_t_h, demand) * kDt;
        a.win_demand[win] += demand * kDt;
        a.win_served[win] += served;
        window_demand += demand * kDt;
        window_served += served;
        if (demand > kRateEps) {
          if (ps.rate_t_h <= kRateEps) a.dry_h += kDt;
          if (ps.rate_t_h < 0.999 * demand) a.short_h += kDt;
        }
        continue;
      }

      if (!pi.source && ps.status == ProcStatus::Shutdown) shutdown_h_measured += kDt;

      // The governor as control.cpp computes it, and the tank that set it.
      double g = 1.0;
      char kind = 0;
      int tank = -1;
      if (pi.source) {
        double lowest = 1.0;
        for (uint32_t t : pi.products) {
          g *= sig[t].h;
          if (sig[t].h < lowest) {
            lowest = sig[t].h;
            kind = 'P';
            tank = static_cast<int>(t);
          }
        }
      } else {
        for (uint32_t t : pi.feeds)
          if (sig[t].f < g) {
            g = sig[t].f;
            kind = 'F';
            tank = static_cast<int>(t);
          }
        for (uint32_t t : pi.products)
          if (sig[t].h < g) {
            g = sig[t].h;
            kind = 'P';
            tank = static_cast<int>(t);
          }
      }
      const bool bad = after_day1 &&
                       (ps.status == ProcStatus::Shutdown || ps.status == ProcStatus::HoldMin);
      if (kind != 0 && g < 1.0 - 1e-12) {
        CauseAcc& c = a.cause[{kind, tank}];
        c.h += kDt;
        c.g_sum += g;
        if (last_window) c.h_last += kDt;
        if (bad) c.h_bad += kDt;
      }
      if (r_max < design * (1.0 - 1e-9)) {
        CauseAcc& c = a.cause[{'C', -1}];
        c.h += kDt;
        c.g_sum += design > 0 ? r_max / design : 0.0;
        if (last_window) c.h_last += kDt;
        if (bad && kind == 0) c.h_bad += kDt;
      }
    }

    // -- Tanks.
    for (size_t t = 0; t < nt; ++t) {
      const double cap = w.tanks[t].capacity_t;
      const double fill = cap > 0 ? st.tank[t].level_t / cap : 0.0;
      TankAcc& a = tacc[t];
      a.min = std::min(a.min, fill);
      a.max = std::max(a.max, fill);
      if (fill < 0.05) a.low_h += kDt;
      if (fill > 0.97) a.high_h += kDt;
    }

    // -- Pipelines.
    for (size_t i = 0; i < w.pipelines.size() && i < st.pipe_flow_t_h.size(); ++i) {
      const double flow = st.pipe_flow_t_h[i];
      PipeAcc& a = ppacc[i];
      a.win_flow[win] += flow;
      a.max_flow = std::max(a.max_flow, flow);
      if (flow >= 0.999 * w.pipelines[i].cap_t_h) a.at_cap_h += kDt;
    }

    // -- Orders: pick up the new ones, then advance the live ones.
    std::fill(new_orders_for_tank.begin(), new_orders_for_tank.end(), 0u);
    for (uint32_t oi = static_cast<uint32_t>(orec.size()); oi < st.order.size(); ++oi) {
      const Order& o = st.order[oi];
      orec.emplace_back();
      live.push_back(oi);
      OrdAgg& g = oagg[{o.material, o.cls}];
      g.created += 1;
      g.t_created += o.qty_t;
      LaneAgg& l = lanes[{o.from, o.to, o.cls}];
      l.lots += 1;
      l.tonnes += o.qty_t;
      if (o.to < nt) new_orders_for_tank[o.to] += 1;
    }
    for (size_t k = 0; k < live.size();) {
      const uint32_t oi = live[k];
      const Order& o = st.order[oi];
      OrdRec& r = orec[oi];
      OrdAgg& g = oagg[{o.material, o.cls}];
      if (!r.assigned && o.status != OrdStatus::Open && o.status != OrdStatus::Cancelled) {
        r.assigned = true;
        r.assigned_tick = tick;
        const double wait_h = static_cast<double>(tick - o.created_tick) * kDt;
        g.wait_sum += wait_h;
        g.wait_max = std::max(g.wait_max, wait_h);
        g.wait_n += 1;
      }
      bool done = false;
      if (o.status == OrdStatus::Delivered) {
        r.delivered_tick = tick;
        const double lead_h = static_cast<double>(tick - o.created_tick) * kDt;
        g.delivered += 1;
        g.t_delivered += o.qty_t;
        g.lead_sum += lead_h;
        g.lead_max = std::max(g.lead_max, lead_h);
        LaneAgg& l = lanes[{o.from, o.to, o.cls}];
        l.delivered += 1;
        l.lead_sum += lead_h;
        const VehicleClass& vc = cat.vehicle_classes[o.cls];
        ClassAcc& c = cacc[o.cls];
        c.tonnes += o.qty_t;
        c.deliveries += 1;
        const int m = modeIndex(vc.mode);
        if (m >= 0 && m < kModeCount) {
          refreshPaths(w, st, paths);
          const uint32_t a = w.sites[w.tanks[o.from].site.v].node[m];
          const uint32_t b = w.sites[w.tanks[o.to].site.v].node[m];
          if (a != kNoNode && b != kNoNode) {
            const double km = travelKm(w, paths, vc.mode, a, b);
            if (std::isfinite(km)) {
              c.tonne_km += o.qty_t * km;
              l.km = km;
            }
          }
        }
        done = true;
      } else if (o.status == OrdStatus::Cancelled) {
        g.cancelled += 1;
        done = true;
      }
      if (done) {
        live[k] = live.back();
        live.pop_back();
      } else {
        ++k;
      }
    }

    // -- Hourly: buy-side tanks the procurement pass left short this hour.
    // After a pass a buyer's (level + inbound) sits at target unless a lot
    // found no candidate (the loop breaks) or the 64-lot cap ended the pass.
    if (tick % 4 == 0) {
      for (size_t t = 0; t < nt; ++t) {
        const Tank& tk = w.tanks[t];
        if (tk.piped_in || tk.design_out_t_h <= 0.0) continue;
        if (tk.role != TankRole::Feed && tk.role != TankRole::Both) continue;
        const double u = tk.export_buy ? market.export_urgency : sig[t].u;
        if (u <= 0.0) continue;
        const double want =
            tk.target_frac * tk.capacity_t - (st.tank[t].level_t + st.tank[t].inbound_t);
        if (want <= 1e-3) continue;
        if (new_orders_for_tank[t] >= market.max_lots_per_tank)
          tacc[t].capped_h += 1.0;
        else
          tacc[t].unmatched_h += 1.0;
      }
    }

    // -- Fleet and bays.
    for (auto& b : bay_busy) b = {0, 0, 0};
    for (auto& b : bay_queue) b = {0, 0, 0};
    for (size_t v = 0; v < nv; ++v) {
      const VehicleState& vs = st.vehicle[v];
      const VehicleClass& vc = cat.vehicle_classes[w.fleet[v].cls];
      ClassAcc& c = cacc[w.fleet[v].cls];
      const int s = static_cast<int>(vs.status);
      if (s >= 0 && s < kVehStatusCount) c.status_ticks[s] += 1;
      double moved = 0;
      if (prev_edge[v] != UINT32_MAX && vs.edge != prev_edge[v])
        moved += std::max(0.0, w.edges[prev_edge[v]].length_km - prev_pos[v]);
      if (vs.edge != UINT32_MAX && vs.edge < w.edges.size())
        moved += vs.edge == prev_edge[v] ? std::max(0.0, vs.edge_pos_km - prev_pos[v])
                                         : vs.edge_pos_km;
      prev_edge[v] = vs.edge;
      prev_pos[v] = vs.edge_pos_km;
      const bool travelling =
          vs.status == VehStatus::ToPickup || vs.status == VehStatus::ToDropoff;
      if (vs.cargo_t > 1e-9)
        c.km_loaded += moved;
      else
        c.km_empty += moved;
      if (travelling && moved < 1e-9) c.stalled_ticks += 1;

      const int m = modeIndex(vc.mode);
      if (m < 0 || m >= kModeCount || vs.at_node == kNoNode || vs.at_node >= w.nodes.size())
        continue;
      const int site = w.nodes[vs.at_node].site;
      if (site < 0) continue;
      if (vs.status == VehStatus::Loading || vs.status == VehStatus::Unloading)
        bay_busy[site][m] += 1;
      else if (vs.status == VehStatus::QueueLoad || vs.status == VehStatus::QueueUnload)
        bay_queue[site][m] += 1;
    }
    for (size_t s = 0; s < w.sites.size(); ++s)
      for (int m = 0; m < kModeCount; ++m) {
        BayAcc& b = bacc[s][m];
        b.busy_sum += bay_busy[s][m];
        b.queue_sum += bay_queue[s][m];
        b.busy_max = std::max(b.busy_max, bay_busy[s][m]);
        b.queue_max = std::max(b.queue_max, bay_queue[s][m]);
      }

    // -- Checkpoint.
    if (win < nwin && tick == cps[win].tick) {
      Checkpoint& c = cps[win];
      sim->computeKpis(c.kpi);
      c.demand_t = st.cum_demand_t;
      c.unmet_t = st.cum_unmet_t;
      c.consumed_t = st.cum_consumed_t;
      const double dd = c.demand_t - prev_demand, du = c.unmet_t - prev_unmet;
      c.win_service_engine = dd > 0 ? 1.0 - du / dd : 1.0;
      c.win_service_sinks = window_demand > 0 ? window_served / window_demand : 1.0;
      c.shutdown_h_measured = shutdown_h_measured;
      for (size_t p = 0; p < np; ++p) {
        if (!pinfo[p].sink || pacc[p].win_demand[win] <= 0) continue;
        const double share = pacc[p].win_served[win] / pacc[p].win_demand[win];
        if (share < c.worst_sink) {
          c.worst_sink = share;
          c.worst_sink_label = pinfo[p].label;
        }
      }
      c.hash = sim->stateHash();
      for (size_t t = 0; t < nt; ++t) {
        const double cap = w.tanks[t].capacity_t;
        tacc[t].cp_fill.push_back(cap > 0 ? st.tank[t].level_t / cap : 0.0);
      }
      prev_demand = c.demand_t;
      prev_unmet = c.unmet_t;
      window_demand = window_served = 0;
      if (win + 1 < nwin) ++win;
    }
  }
  const double wall_seconds =
      std::chrono::duration<double>(std::chrono::steady_clock::now() - wall0).count();

  const State& st = sim->state();
  const uint64_t end_tick = st.tick;

  // Orders still open at the end.
  for (uint32_t oi : live) {
    const Order& o = st.order[oi];
    OrdAgg& g = oagg[{o.material, o.cls}];
    if (o.status == OrdStatus::Open) {
      g.unassigned_end += 1;
      g.oldest_unassigned_h = std::max(
          g.oldest_unassigned_h, static_cast<double>(end_tick - o.created_tick) * kDt);
    } else {
      g.in_transit_end += 1;
    }
  }

  // Window lengths in ticks, for means.
  std::vector<double> win_ticks(nwin);
  for (size_t k = 0; k < nwin; ++k)
    win_ticks[k] = static_cast<double>(cps[k].tick - (k ? cps[k - 1].tick : 0));
  const double run_ticks = static_cast<double>(end_tick);
  const double run_hours = run_ticks * kDt;

  // ---- Verdict.
  bool pass = true;
  std::vector<std::string> reasons, warnings;
  for (size_t k = 0; k < nwin; ++k) {
    const Checkpoint& c = cps[k];
    const double cum = c.kpi.empty() ? 1.0 : c.kpi[0];
    if (cum < opt.min_service || c.win_service_engine < opt.min_service) {
      pass = false;
      std::string r = "day " + fmt("%.0f", c.day) + ": service " + fmt("%.4f", cum) +
                      " cumulative, " + fmt("%.4f", c.win_service_engine) + " in the window";
      // Name the sinks that pulled the window down.
      std::vector<std::pair<double, size_t>> worst;
      for (size_t p = 0; p < np; ++p) {
        if (!pinfo[p].sink || pacc[p].win_demand[k] <= 0) continue;
        const double share = pacc[p].win_served[k] / pacc[p].win_demand[k];
        if (share < opt.min_service) worst.emplace_back(share, p);
      }
      std::sort(worst.begin(), worst.end());
      for (size_t j = 0; j < worst.size() && j < 6; ++j)
        r += (j ? ", " : " — short sinks: ") + pinfo[worst[j].second].label + " " +
             pct(worst[j].first).substr(pct(worst[j].first).find_first_not_of(' ')) + "%";
      reasons.push_back(r);
    } else {
      // The tonnage-weighted level passed: still name any single sink that
      // fell short in this window (a failure with --min-sink-service).
      const double bar = opt.min_sink_service > 0 ? opt.min_sink_service : opt.min_service;
      std::string list;
      int n = 0;
      for (size_t p = 0; p < np; ++p) {
        if (!pinfo[p].sink || pacc[p].win_demand[k] <= 0) continue;
        const double share = pacc[p].win_served[k] / pacc[p].win_demand[k];
        if (share >= bar) continue;
        if (n++ < 8) list += (list.empty() ? "" : ", ") + pinfo[p].label + " " + fmt("%.1f", 100 * share) + "%";
      }
      if (n > 0) {
        const std::string r = "window ending day " + fmt("%.0f", c.day) + ": " +
                              std::to_string(n) + " sink(s) below " + fmt("%.2f", bar) + ": " + list;
        if (opt.min_sink_service > 0) {
          pass = false;
          reasons.push_back(r);
        } else {
          warnings.push_back(r);
        }
      }
    }
  }
  for (size_t p = 0; p < np; ++p) {
    if (pinfo[p].sink || pinfo[p].source) continue;
    for (const auto& [key, c] : pacc[p].cause) {
      if (c.h_bad <= 0) continue;
      const std::string tank = key.second >= 0 ? w.tanks[key.second].key : "units down";
      if (key.first == 'F') {
        pass = false;
        reasons.push_back(pinfo[p].label + " feed-starved by " + tank + ": " +
                          fmt("%.1f", c.h_bad) + " h in Shutdown/HoldMin after day 1");
      } else if (key.first == 'P') {
        warnings.push_back(pinfo[p].label + " product-blocked by " + tank + ": " +
                           fmt("%.1f", c.h_bad) + " h in Shutdown/HoldMin after day 1");
      }
    }
  }

  // ---- Route graph summary (per mode).
  struct ModeSummary {
    uint32_t edges = 0, nodes = 0, components = 0, sites = 0;
    double km = 0;
  };
  std::array<ModeSummary, kModeCount> msum{};
  for (int m = 0; m < kModeCount; ++m) {
    UnionFind uf(w.nodes.size());
    std::vector<uint8_t> used(w.nodes.size(), 0);
    for (const RouteEdge& e : w.edges) {
      if (modeIndex(e.mode) != m) continue;
      msum[m].edges += 1;
      msum[m].km += e.length_km;
      if (e.a < w.nodes.size() && e.b < w.nodes.size()) {
        used[e.a] = used[e.b] = 1;
        uf.join(e.a, e.b);
      }
    }
    for (const Site& s : w.sites)
      if (s.node[m] != kNoNode) {
        msum[m].sites += 1;
        if (s.node[m] < used.size()) used[s.node[m]] = 1;
      }
    std::vector<uint32_t> roots;
    for (uint32_t n = 0; n < w.nodes.size(); ++n)
      if (used[n]) {
        msum[m].nodes += 1;
        roots.push_back(uf.find(n));
      }
    std::sort(roots.begin(), roots.end());
    msum[m].components =
        static_cast<uint32_t>(std::unique(roots.begin(), roots.end()) - roots.begin());
  }

  // ---- Text report.
  std::printf("crx-report  world=%s  config=%s  days=%.4g  min-service=%.2f\n", w.name.c_str(),
              opt.config.c_str(), opt.days, opt.min_service);
  std::printf("world: %zu sites, %zu processes, %zu units, %zu tanks, %zu pipelines, %zu nodes, "
              "%zu edges, %zu vehicles\n",
              w.sites.size(), np, w.units.size(), nt, w.pipelines.size(), w.nodes.size(),
              w.edges.size(), nv);
  if (!opt.quiet) {
    for (int m = 0; m < kModeCount; ++m)
      std::printf("  %-5s: %u edges, %.0f km, %u nodes in %u connected piece(s), %u sites attached\n",
                  kModeName[m], msum[m].edges, msum[m].km, msum[m].nodes, msum[m].components,
                  msum[m].sites);
  }

  std::printf("\n== 1. Checkpoints (KPI columns are Sim::computeKpis, cumulative from tick 0) ==\n");
  std::printf("%-6s %9s %12s %14s %10s %11s %9s %13s %13s | %10s %10s %12s %10s\n", "day",
              "service", "unmet_t", "unmet_usd", "prod_idx", "shutdown_h", "stockouts",
              "freight_usd", "energy_usd", "win_svc", "win_svc(s)", "shut_h(meas)", "worst_sink");
  for (const Checkpoint& c : cps) {
    std::printf("%-6s %9.4f %12.1f %14.0f %10.4f %11.1f %9.0f %13.0f %13.0f | %10.4f %10.4f %12.1f %10.4f %s\n",
                dayLabel(c.day).c_str(), c.kpi[0], c.kpi[1], c.kpi[2], c.kpi[3], c.kpi[4],
                c.kpi[5], c.kpi[6], c.kpi[7], c.win_service_engine, c.win_service_sinks,
                c.shutdown_h_measured, c.worst_sink, c.worst_sink_label.c_str());
  }
  {
    // Reconciliation of the sampled sink totals against the engine's books.
    double d = 0, s = 0;
    for (size_t p = 0; p < np; ++p)
      for (size_t k = 0; k < nwin; ++k) {
        d += pacc[p].win_demand[k];
        s += pacc[p].win_served[k];
      }
    if (!opt.quiet || std::fabs(d - st.cum_demand_t) > 1e-6 * std::max(1.0, d) ||
        std::fabs(s - st.cum_consumed_t) > 1e-6 * std::max(1.0, s))
      std::printf("  sampled sinks: demand %.1f t, served %.1f t | engine: demand %.1f t, "
                  "consumed %.1f t (difference %.3f / %.3f t)\n",
                  d, s, st.cum_demand_t, st.cum_consumed_t, d - st.cum_demand_t,
                  s - st.cum_consumed_t);
  }

  json jdoc;
  if (!opt.quiet || !opt.json_path.empty()) {
    // The detailed sections build their JSON alongside the text.
    json jsinks = json::array(), jprocs = json::array(), jtanks = json::array(),
         jpipes = json::array(), jorders = json::array(), jlanes = json::array(),
         junmatched = json::array(),
         jfleet = json::array(), jbays = json::array();
    const bool text = !opt.quiet;

    // -- 2. Sinks.
    if (text) {
      std::printf("\n== 2. Sinks (delivered share of demand per window, %%) ==\n");
      std::printf("%-44s %-10s %9s", "sink", "material", "design");
      for (const Checkpoint& c : cps) std::printf(" %7s", ("->" + dayLabel(c.day)).c_str());
      std::printf(" %7s %8s %8s %10s\n", "all", "dry_h", "short_h", "unmet_t");
    }
    for (size_t p = 0; p < np; ++p) {
      if (!pinfo[p].sink) continue;
      const ProcAcc& a = pacc[p];
      const std::string mat =
          pinfo[p].sink_tank >= 0 ? cat.materials[w.tanks[pinfo[p].sink_tank].material].key : "-";
      double d = 0, s = 0;
      json jw = json::array();
      if (text)
        std::printf("%-44s %-10s %9.2f", pinfo[p].label.c_str(), mat.c_str(),
                    w.processes[p].design_rate_t_h);
      for (size_t k = 0; k < nwin; ++k) {
        d += a.win_demand[k];
        s += a.win_served[k];
        const double share = a.win_demand[k] > 0 ? a.win_served[k] / a.win_demand[k] : 1.0;
        jw.push_back(share);
        if (text) std::printf(" %7s", pct(share).c_str());
      }
      const double all = d > 0 ? s / d : 1.0;
      if (text) std::printf(" %7s %8.1f %8.1f %10.1f\n", pct(all).c_str(), a.dry_h, a.short_h, d - s);
      jsinks.push_back({{"sink", pinfo[p].label},
                        {"material", mat},
                        {"design_t_h", w.processes[p].design_rate_t_h},
                        {"delivered_share_by_window", jw},
                        {"delivered_share", all},
                        {"dry_h", a.dry_h},
                        {"short_h", a.short_h},
                        {"unmet_t", d - s}});
    }

    // -- 3. Processes.
    if (text) {
      std::printf("\n== 3. Processes (mean commanded rate / design per window, %%; status hours; "
                  "binding tank) ==\n");
      std::printf("%-44s %9s", "process", "design");
      for (const Checkpoint& c : cps) std::printf(" %7s", ("->" + dayLabel(c.day)).c_str());
      std::printf(" %7s %7s %7s %7s %4s  %s\n", "run_h", "hold_h", "shut_h", "rstrt_h", "shut#",
                  "governor < 1: cause tank hours (in last window; mean governor)");
    }
    for (size_t p = 0; p < np; ++p) {
      if (pinfo[p].sink) continue;
      const ProcAcc& a = pacc[p];
      json jw = json::array();
      if (text) std::printf("%-44s %9.2f", pinfo[p].label.c_str(), w.processes[p].design_rate_t_h);
      for (size_t k = 0; k < nwin; ++k) {
        const double share = win_ticks[k] > 0 ? a.win_rate[k] / win_ticks[k] : 0.0;
        jw.push_back(share);
        if (text) std::printf(" %7s", pct(share).c_str());
      }
      if (text)
        std::printf(" %7.1f %7.1f %7.1f %7.1f %4u ", a.status_h[0], a.status_h[1], a.status_h[2],
                    a.status_h[3], a.shutdown_episodes);
      std::vector<std::pair<double, std::pair<char, int>>> order;
      for (const auto& [key, c] : a.cause) order.push_back({-c.h, key});
      std::sort(order.begin(), order.end());
      json jc = json::array();
      for (size_t j = 0; j < order.size(); ++j) {
        const auto key = order[j].second;
        const CauseAcc& c = a.cause.at(key);
        const char* kind = key.first == 'F' ? "feed" : key.first == 'P' ? "product" : "capacity";
        const std::string tank = key.second >= 0 ? w.tanks[key.second].key : "units-down";
        const double g_mean = c.h > 0 ? c.g_sum * kDt / c.h : 1.0;
        if (text && j < 4)
          std::printf(" %s:%s %.0fh (%.0fh; %.2f)", kind, tank.c_str(), c.h, c.h_last, g_mean);
        jc.push_back({{"kind", kind},
                      {"tank", tank},
                      {"hours", c.h},
                      {"hours_last_window", c.h_last},
                      {"hours_shutdown_or_holdmin_after_day1", c.h_bad},
                      {"mean_governor", g_mean}});
      }
      if (text) std::printf("\n");
      jprocs.push_back({{"process", pinfo[p].label},
                        {"boundary", pinfo[p].source ? "source" : "none"},
                        {"design_t_h", w.processes[p].design_rate_t_h},
                        {"rate_share_by_window", jw},
                        {"running_h", a.status_h[0]},
                        {"holdmin_h", a.status_h[1]},
                        {"shutdown_h", a.status_h[2]},
                        {"restarting_h", a.status_h[3]},
                        {"shutdown_episodes", a.shutdown_episodes},
                        {"causes", jc}});
    }

    // -- 4. Tanks.
    if (text) {
      std::printf("\n== 4. Tanks (fill = level / capacity, %%) ==\n");
      std::printf("%-36s %-4s %-4s %10s %6s %8s %8s %6s", "tank", "role", "pipe", "cap_t",
                  "cover", "in_t_h", "out_t_h", "d0");
      for (const Checkpoint& c : cps) std::printf(" %6s", dayLabel(c.day).c_str());
      std::printf(" %6s %6s %7s %7s %7s %6s %5s %9s %7s %10s\n", "min", "max", "h<5%", "h>97%",
                  "lead_h", "gap_h", "caut", "inbound_t", "short_h", "rejected_t");
    }
    for (size_t t = 0; t < nt; ++t) {
      const Tank& tk = w.tanks[t];
      const TankAcc& a = tacc[t];
      const TankState& ts = st.tank[t];
      const char* role = tk.role == TankRole::Feed      ? "feed"
                         : tk.role == TankRole::Product ? "prod"
                         : tk.role == TankRole::Both    ? "both"
                                                        : "intl";
      const char* pipe = tk.piped_in ? (tk.piped_out ? "io" : "in") : (tk.piped_out ? "out" : "-");
      if (text) {
        std::printf("%-36s %-4s %-4s %10.0f %6.1f %8.2f %8.2f %6s", tk.key.c_str(), role, pipe,
                    tk.capacity_t, tk.cover_days, tk.design_in_t_h, tk.design_out_t_h,
                    pct(a.fill0).c_str());
        for (double f : a.cp_fill) std::printf(" %6s", pct(f).c_str());
        std::printf(" %6s %6s %7.1f %7.1f %7.1f %6.1f %5.2f %9.0f %7.0f", pct(a.min).c_str(),
                    pct(a.max).c_str(), a.low_h, a.high_h, ts.lead_time_h, ts.pickup_gap_h,
                    ts.caution, ts.inbound_t, a.unmatched_h + a.capped_h);
        // Product thrown away at a tank that rejects when full ("-" = it cannot).
        if (tk.reject_when_full)
          std::printf(" %10.1f\n", ts.rejected_t);
        else
          std::printf(" %10s\n", "-");
      }
      jtanks.push_back({{"tank", tk.key},
                        {"role", role},
                        {"piped_in", tk.piped_in},
                        {"piped_out", tk.piped_out},
                        {"capacity_t", tk.capacity_t},
                        {"cover_days", tk.cover_days},
                        {"design_in_t_h", tk.design_in_t_h},
                        {"design_out_t_h", tk.design_out_t_h},
                        {"fill_day0", a.fill0},
                        {"fill_at_checkpoints", a.cp_fill},
                        {"fill_min", a.min},
                        {"fill_max", a.max},
                        {"hours_below_5pct", a.low_h},
                        {"hours_above_97pct", a.high_h},
                        {"lead_time_h", ts.lead_time_h},
                        {"pickup_gap_h", ts.pickup_gap_h},
                        {"caution", ts.caution},
                        {"inbound_t", ts.inbound_t},
                        {"reserved_out_t", ts.reserved_out_t},
                        {"reject_when_full", tk.reject_when_full},
                        {"rejected_t", ts.rejected_t}});
    }

    // Pipelines: what actually flowed against the capacity.
    if (text && !w.pipelines.empty()) {
      std::printf("\n-- pipelines (mean flow per window, t/h) --\n");
      std::printf("%-34s %-34s %8s", "from", "to", "cap_t_h");
      for (const Checkpoint& c : cps) std::printf(" %8s", ("->" + dayLabel(c.day)).c_str());
      std::printf(" %8s %9s\n", "max", "at_cap_h");
    }
    for (size_t i = 0; i < w.pipelines.size(); ++i) {
      const Pipeline& pl = w.pipelines[i];
      const PipeAcc& a = ppacc[i];
      json jw = json::array();
      if (text)
        std::printf("%-34s %-34s %8.1f", w.tanks[pl.from.v].key.c_str(),
                    w.tanks[pl.to.v].key.c_str(), pl.cap_t_h);
      for (size_t k = 0; k < nwin; ++k) {
        const double mean = win_ticks[k] > 0 ? a.win_flow[k] / win_ticks[k] : 0.0;
        jw.push_back(mean);
        if (text) std::printf(" %8.2f", mean);
      }
      if (text) std::printf(" %8.1f %9.1f\n", a.max_flow, a.at_cap_h);
      jpipes.push_back({{"from", w.tanks[pl.from.v].key},
                        {"to", w.tanks[pl.to.v].key},
                        {"cap_t_h", pl.cap_t_h},
                        {"mean_flow_by_window", jw},
                        {"max_flow_t_h", a.max_flow},
                        {"hours_at_cap", a.at_cap_h}});
    }

    // -- 5. Orders.
    if (text) {
      std::printf("\n== 5. Orders by material and vehicle class (one lot = one vehicle load) ==\n");
      std::printf("%-10s %-11s %7s %7s %8s %8s %6s %11s %11s %8s %8s %8s %8s %10s\n", "material",
                  "class", "created", "deliv", "transit", "unassgn", "cancel", "t_created",
                  "t_delivered", "lead_avg", "lead_max", "wait_avg", "wait_max", "oldest_una");
      if (oagg.empty()) std::printf("(no orders)\n");
    }
    for (const auto& [key, g] : oagg) {
      const std::string mat = cat.materials[key.first].key;
      const std::string cls = cat.vehicle_classes[key.second].key;
      const double lead_avg = g.delivered ? g.lead_sum / g.delivered : 0.0;
      const double wait_avg = g.wait_n ? g.wait_sum / g.wait_n : 0.0;
      if (text)
        std::printf("%-10s %-11s %7u %7u %8u %8u %6u %11.0f %11.0f %8.1f %8.1f %8.1f %8.1f %10.1f\n",
                    mat.c_str(), cls.c_str(), g.created, g.delivered, g.in_transit_end,
                    g.unassigned_end, g.cancelled, g.t_created, g.t_delivered, lead_avg,
                    g.lead_max, wait_avg, g.wait_max, g.oldest_unassigned_h);
      jorders.push_back({{"material", mat},
                         {"class", cls},
                         {"lots_created", g.created},
                         {"lots_delivered", g.delivered},
                         {"lots_in_transit_at_end", g.in_transit_end},
                         {"lots_unassigned_at_end", g.unassigned_end},
                         {"lots_cancelled", g.cancelled},
                         {"tonnes_created", g.t_created},
                         {"tonnes_delivered", g.t_delivered},
                         {"lead_h_mean", lead_avg},
                         {"lead_h_max", g.lead_max},
                         {"wait_for_vehicle_h_mean", wait_avg},
                         {"wait_for_vehicle_h_max", g.wait_max},
                         {"oldest_unassigned_h", g.oldest_unassigned_h}});
    }

    // Lanes: who actually bought from whom.
    {
      std::vector<std::pair<double, std::tuple<uint32_t, uint32_t, uint16_t>>> order;
      for (const auto& [key, l] : lanes) order.push_back({-l.tonnes, key});
      std::sort(order.begin(), order.end());
      if (text && !order.empty()) {
        std::printf("\n-- lanes (seller tank -> buyer tank), by tonnes ordered --\n");
        std::printf("%-34s %-34s %-11s %6s %6s %10s %8s %8s %8s\n", "from", "to", "class", "lots",
                    "deliv", "tonnes", "t_per_h", "km", "lead_avg");
      }
      for (const auto& [neg, key] : order) {
        const LaneAgg& l = lanes.at(key);
        const std::string from = w.tanks[std::get<0>(key)].key, to = w.tanks[std::get<1>(key)].key;
        const std::string cls = cat.vehicle_classes[std::get<2>(key)].key;
        const double lead_avg = l.delivered ? l.lead_sum / l.delivered : 0.0;
        if (text)
          std::printf("%-34s %-34s %-11s %6u %6u %10.0f %8.2f %8.1f %8.1f\n", from.c_str(),
                      to.c_str(), cls.c_str(), l.lots, l.delivered, l.tonnes,
                      run_hours > 0 ? l.tonnes / run_hours : 0.0, l.km, lead_avg);
        jlanes.push_back({{"from", from},
                          {"to", to},
                          {"class", cls},
                          {"lots", l.lots},
                          {"lots_delivered", l.delivered},
                          {"tonnes", l.tonnes},
                          {"km", l.km},
                          {"lead_h_mean", lead_avg}});
      }
    }

    // Buy-side tanks left short by procurement, and price indices off par.
    {
      bool any = false;
      for (size_t t = 0; t < nt; ++t) {
        const TankAcc& a = tacc[t];
        if (a.unmatched_h <= 0 && a.capped_h <= 0) continue;
        if (text && !any) {
          std::printf("\n-- buy-side tanks left short after an hourly procurement pass --\n");
          std::printf("%-36s %14s %14s\n", "tank", "no_seller_h", "lot_cap_h");
        }
        any = true;
        if (text)
          std::printf("%-36s %14.0f %14.0f\n", w.tanks[t].key.c_str(), a.unmatched_h, a.capped_h);
        junmatched.push_back({{"tank", w.tanks[t].key},
                              {"no_candidate_hours", a.unmatched_h},
                              {"lot_cap_hours", a.capped_h}});
      }
      if (text && !any) std::printf("\n-- every buy-side tank was fully matched every hour --\n");
      if (text) {
        std::printf("-- price index at the end (1.00 = par; each unmatched lot multiplies it by "
                    "1.01, cap 4.00):");
        bool off = false;
        for (size_t m = 0; m < cat.materials.size() && m < st.price_index.size(); ++m)
          if (std::fabs(st.price_index[m] - 1.0) > 0.005) {
            std::printf(" %s %.2f", cat.materials[m].key.c_str(), st.price_index[m]);
            off = true;
          }
        std::printf("%s\n", off ? "" : " all at par");
      }
    }

    // -- 6. Fleet and bays.
    if (text) {
      std::printf("\n== 6. Fleet (share of vehicle time by status, %%) ==\n");
      std::printf("%-11s %5s %6s %6s %6s %6s %6s %6s %6s %7s %7s %10s %12s %9s %9s %7s\n", "class",
                  "count", "idle", "to_pu", "q_load", "load", "to_do", "q_unl", "unload",
                  "stalled", "trips", "tonnes", "tonne_km", "km_loaded", "km_empty", "no_node");
      if (nv == 0) std::printf("(no vehicles)\n");
    }
    for (size_t c = 0; c < ncls; ++c) {
      const ClassAcc& a = cacc[c];
      if (a.count == 0) continue;
      const double denom = run_ticks * a.count;
      json js = json::object();
      if (text) std::printf("%-11s %5u", cat.vehicle_classes[c].key.c_str(), a.count);
      for (int s = 0; s < kVehStatusCount; ++s) {
        const double share = denom > 0 ? a.status_ticks[s] / denom : 0.0;
        js[kVehStatusName[s]] = share;
        if (text) std::printf(" %6s", pct(share).c_str());
      }
      const double stalled = denom > 0 ? a.stalled_ticks / denom : 0.0;
      if (text)
        std::printf(" %7s %7u %10.0f %12.0f %9.0f %9.0f %7u\n", pct(stalled).c_str(), a.deliveries,
                    a.tonnes, a.tonne_km, a.km_loaded, a.km_empty, a.no_node);
      jfleet.push_back({{"class", cat.vehicle_classes[c].key},
                        {"count", a.count},
                        {"time_share", js},
                        {"stalled_share", stalled},
                        {"deliveries", a.deliveries},
                        {"tonnes", a.tonnes},
                        {"tonne_km", a.tonne_km},
                        {"km_loaded", a.km_loaded},
                        {"km_empty", a.km_empty},
                        {"vehicles_without_start_node", a.no_node}});
    }
    if (text) {
      std::printf("\n-- bays per site and mode (sites with access in that mode) --\n");
      std::printf("%-28s %-6s %5s %9s %9s %9s %9s\n", "site", "mode", "bays", "busy_avg",
                  "busy_max", "queue_avg", "queue_max");
    }
    for (size_t s = 0; s < w.sites.size(); ++s)
      for (int m = 0; m < kModeCount; ++m) {
        const Site& site = w.sites[s];
        if (site.node[m] == kNoNode && site.bays[m] == 0) continue;
        const BayAcc& b = bacc[s][m];
        const double busy_avg = run_ticks > 0 ? b.busy_sum / run_ticks : 0.0;
        const double queue_avg = run_ticks > 0 ? b.queue_sum / run_ticks : 0.0;
        const char* flag = site.node[m] == kNoNode ? "  (bays but no node)"
                           : site.bays[m] == 0     ? "  (node but no bays)"
                                                   : "";
        if (text)
          std::printf("%-28s %-6s %5u %9.2f %9u %9.2f %9u%s\n", site.key.c_str(), kModeName[m],
                      static_cast<unsigned>(site.bays[m]), busy_avg, b.busy_max, queue_avg,
                      b.queue_max, flag);
        jbays.push_back({{"site", site.key},
                         {"mode", kModeName[m]},
                         {"bays", site.bays[m]},
                         {"has_node", site.node[m] != kNoNode},
                         {"busy_mean", busy_avg},
                         {"busy_max", b.busy_max},
                         {"queue_mean", queue_avg},
                         {"queue_max", b.queue_max}});
      }

    json jcps = json::array();
    for (const Checkpoint& c : cps)
      jcps.push_back({{"day", c.day},
                      {"service_level", c.kpi[0]},
                      {"unmet_t", c.kpi[1]},
                      {"unmet_usd", c.kpi[2]},
                      {"production_index", c.kpi[3]},
                      {"shutdown_h", c.kpi[4]},
                      {"stockouts", c.kpi[5]},
                      {"freight_usd", c.kpi[6]},
                      {"energy_usd", c.kpi[7]},
                      {"window_service_engine", c.win_service_engine},
                      {"window_service_sinks", c.win_service_sinks},
                      {"shutdown_h_measured", c.shutdown_h_measured},
                      {"worst_sink_share", c.worst_sink},
                      {"worst_sink", c.worst_sink_label},
                      {"state_hash", std::to_string(c.hash)}});
    json jmodes = json::array();
    for (int m = 0; m < kModeCount; ++m)
      jmodes.push_back({{"mode", kModeName[m]},
                        {"edges", msum[m].edges},
                        {"km", msum[m].km},
                        {"nodes", msum[m].nodes},
                        {"components", msum[m].components},
                        {"sites_attached", msum[m].sites}});
    jdoc = {{"world", w.name},
            {"config", opt.config},
            {"days", opt.days},
            {"min_service", opt.min_service},
            {"counts",
             {{"sites", w.sites.size()},
              {"processes", np},
              {"units", w.units.size()},
              {"tanks", nt},
              {"pipelines", w.pipelines.size()},
              {"nodes", w.nodes.size()},
              {"edges", w.edges.size()},
              {"vehicles", nv},
              {"orders", st.order.size()}}},
            {"modes", jmodes},
            {"checkpoints", jcps},
            {"sinks", jsinks},
            {"processes", jprocs},
            {"tanks", jtanks},
            {"pipelines", jpipes},
            {"orders", jorders},
            {"lanes", jlanes},
            {"short_buyers", junmatched},
            {"fleet", jfleet},
            {"bays", jbays}};
  }

  // -- 7. Verdict and timing.
  std::printf("\n== 7. Verdict ==\n");
  for (const std::string& r : warnings) std::printf("WARN  %s\n", r.c_str());
  for (const std::string& r : reasons) std::printf("FAIL  %s\n", r.c_str());
  std::printf("%s  service >= %.2f at every checkpoint (cumulative and in its window)%s and no "
              "feed-starved Shutdown/HoldMin after day 1: %s\n",
              pass ? "PASS" : "FAIL", opt.min_service,
              opt.min_sink_service > 0 ? ", every sink above --min-sink-service," : "",
              pass ? "yes" : "no");
  const double tps = step_seconds > 0 ? run_ticks / step_seconds : 0.0;
  std::printf("time: %.3f s inside Sim::step for %llu ticks (%.0f ticks/s, %.3f s per simulated "
              "day); %.3f s wall including sampling; %zu orders; state hash %llu\n",
              step_seconds, static_cast<unsigned long long>(end_tick), tps,
              run_ticks > 0 ? step_seconds / (run_ticks / kTicksPerDay) : 0.0, wall_seconds,
              st.order.size(), static_cast<unsigned long long>(sim->stateHash()));

  if (!opt.json_path.empty()) {
    jdoc["verdict"] = {{"pass", pass}, {"failures", reasons}, {"warnings", warnings}};
    jdoc["timing"] = {{"step_seconds", step_seconds},
                      {"wall_seconds", wall_seconds},
                      {"ticks", end_tick},
                      {"ticks_per_second", tps}};
    std::ofstream f(opt.json_path);
    if (!f) {
      std::fprintf(stderr, "crx-report: cannot write %s\n", opt.json_path.c_str());
      return 2;
    }
    f << jdoc.dump(1) << "\n";
  }
  return pass ? 0 : 1;
}
