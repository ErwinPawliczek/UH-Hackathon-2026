// Chain Reaction — §5.3 operating control.
//
// Per process per tick: R_max from unit capacity minus trains down, the
// governor g = min(f of feeds, h of products), the ramp toward R_max·g
// (§5.1 rule 8), and the status machine over turndown / HoldMin /
// Shutdown / Restarting with restart_h and the 0.6 anti-flicker gap.
// Boundary sources and sinks take their one-sided paths (§5.4) and ignore
// the machine, except that units down stop them too.
#include "sim/control.h"

#include "sim/adaptation.h"
#include "sim/events.h"
#include "sim/recorder.h"
#include "sim/words.h"

#include <algorithm>
#include <cmath>
#include <limits>

namespace crx {
namespace sim {

namespace {

constexpr double kRateEps = 1e-6;   // t/h: below this a rate is zero
constexpr double kRestartGap = 0.6; // §5.3 anti-flicker threshold

// Feed tanks (consumer draws) and product tanks (producer fills) over all
// active modes, from the bound net streams.
struct ProcView {
  std::vector<TankId> feeds, products;
};

std::vector<ProcView> makeViews(const World& world) {
  std::vector<ProcView> views(world.processes.size());
  for (size_t p = 0; p < world.processes.size(); ++p) {
    const Process& proc = world.processes[p];
    const ProcessType& type = world.catalog.process_types[proc.type];
    ProcView& view = views[p];
    for (size_t m = 0; m < type.net.size() && m < proc.mode_share.size(); ++m) {
      if (proc.mode_share[m] <= 0.0) continue;
      for (const Stream& s : type.net[m]) {
        if (s.slot >= kInternalStreamBase) continue;
        const TankId tank = proc.tank_of[s.slot];
        if (!tank.valid()) continue;
        if (s.t_per_t < 0.0) view.feeds.push_back(tank);
        // A tank that rejects when full has room as far as the plant is
        // concerned: its headroom signal is left out of the governor.
        if (s.t_per_t > 0.0 && !world.tanks[tank.v].reject_when_full)
          view.products.push_back(tank);
      }
    }
  }
  return views;
}

// R_max (§5.3): minimum over units of what the online trains can pass, in
// t/h of process basis. A unit's capacity is in its own throughput tonnes;
// unitThroughputPerBasis() (world.h) converts it back to basis, the same
// factor the world builder sized the capacity with.
double computeRMax(const World& world, const Process& proc, const State& state) {
  const ProcessType& type = world.catalog.process_types[proc.type];
  double r_max = std::numeric_limits<double>::infinity();
  for (uint32_t u = proc.units.begin; u < rangeEnd(proc.units); ++u) {
    const Unit& unit = world.units[u];
    const UnitSlot& slot = type.units[unit.slot];
    const int online = static_cast<int>(slot.trains) - state.unit[u].trains_down;
    if (online <= 0) return 0.0;
    r_max = std::min(r_max, unit.cap_per_train_t_h * online /
                                unitThroughputPerBasis(slot, proc.mode_share));
  }
  // §3.2 sizes trains at 110% of nameplate so the process still reaches
  // nameplate with one train down; the process rate itself never exceeds it.
  return std::min(proc.design_rate_t_h, std::isinf(r_max) ? proc.design_rate_t_h : r_max);
}

// Governor (§5.3): min over feeds of f and products of h; 1 when none.
double computeGovernor(const ProcView& view, const std::vector<TankSignals>& signals) {
  double g = 1.0;
  for (const TankId t : view.feeds) g = std::min(g, signals[t.v].f);
  for (const TankId t : view.products) g = std::min(g, signals[t.v].h);
  return g;
}

double rampToward(double rate, double target, double design, double ramp_per_h, double dt_h) {
  const double step = ramp_per_h * design * dt_h;
  return std::max(0.0, rate + std::clamp(target - rate, -step, step));
}

double scheduleFactor(const World& world, const Process& proc, uint64_t tick) {
  const std::vector<double>& sched = world.schedules[proc.schedule];
  const size_t hour = static_cast<size_t>(std::fmod(static_cast<double>(tick) * kTickHours, 24.0));
  return sched[hour % sched.size()];
}

}  // namespace

void stepControl(const World& world, State& state, const std::vector<TankSignals>& signals,
                 Recorder& rec, std::vector<ControlDecision>& out) {
  const double dt_h = kTickHours;
  const std::vector<ProcView> views = makeViews(world);
  out.resize(world.processes.size());

  for (size_t p = 0; p < world.processes.size(); ++p) {
    const Process& proc = world.processes[p];
    const ProcessType& type = world.catalog.process_types[proc.type];
    const Site& site = world.sites[proc.site.v];
    ProcState& ps = state.proc[p];
    ControlDecision& d = out[p];
    const ProcStatus prev = ps.status;

    if (type.boundary == Boundary::Source) {
      // Source path: supply curve × shock, throttled by product-room signal.
      const double shock = shockFactor(state, proc.site.v, EventDef::Type::SupplyShock);
      double target = proc.design_rate_t_h * scheduleFactor(world, proc, state.tick) * shock;
      const double source_max = computeRMax(world, proc, state);
      if (source_max <= kRateEps) target = 0.0;  // units down
      for (const TankId t : views[p].products) target *= signals[t.v].h;
      ps.status = ProcStatus::Running;
      ps.rate_t_h = rampToward(ps.rate_t_h, target, proc.design_rate_t_h, type.ramp_per_h, dt_h);
      if (ps.rate_t_h > source_max) ps.rate_t_h = source_max;  // lost trains cap it at once
      d = {ps.rate_t_h, ps.status, target, 1.0, target};
      continue;
    }

    if (type.boundary == Boundary::Sink) {
      // Sink path: demand curve × shock, clipped by stock on hand.
      const double shock = shockFactor(state, proc.site.v, EventDef::Type::DemandShock);
      double demand = proc.design_rate_t_h * scheduleFactor(world, proc, state.tick) * shock;
      if (computeRMax(world, proc, state) <= kRateEps) demand = 0.0;  // units down
      double stock = std::numeric_limits<double>::infinity();
      for (const TankId t : views[p].feeds)
        stock = std::min(stock, state.tank[t.v].level_t);
      const double prev_rate = ps.rate_t_h;  // last tick's rate, for the dry edge
      ps.status = ProcStatus::Running;
      ps.rate_t_h = std::isinf(stock) ? demand : std::min(demand, stock / dt_h);
      // §5.8: a sink whose feed ran dry learns caution too — the empty tank
      // stopped its (boundary) process. Falling edge only, so one bump per
      // dry episode, matching the normal machine's Shutdown path.
      if (prev_rate > kRateEps && ps.rate_t_h <= kRateEps)
        for (const TankId t : views[p].feeds)
          if (signals[t.v].f <= kRateEps) onDryFeed(world, state, t.v);
      d = {ps.rate_t_h, ps.status, demand, 1.0, demand};
      continue;
    }

    // ---- normal process: the §5.3 machine -------------------------------
    // Rate override (§7.2): an absolute cap on unit capacity, in t/h of
    // basis — the machine below sees no difference from trains being down,
    // so a zero cap shuts down naturally instead of bypassing turndown.
    const double r_max_raw = computeRMax(world, proc, state);
    const double cap = state.rate_override[p];
    const double r_max =
        cap >= 0.0 ? std::min(r_max_raw, cap) : r_max_raw;
    const double g = computeGovernor(views[p], signals);
    const double desired = r_max * g;
    const double min_rate = type.turndown * proc.design_rate_t_h;

    if (r_max <= kRateEps || r_max < min_rate - kRateEps) {
      // No capacity, or capacity below the turndown floor: cannot sustain
      // minimum. Shutdown; restart when every signal clears the 0.6 gap.
      ps.status = ProcStatus::Shutdown;
      ps.rate_t_h = rampToward(ps.rate_t_h, 0.0, proc.design_rate_t_h, type.ramp_per_h, dt_h);
      if (g > kRestartGap && r_max > kRateEps) {
        ps.status = ProcStatus::Restarting;
        ps.timer = static_cast<uint32_t>(std::lround(type.restart_h / dt_h));
      }
    } else {
      switch (ps.status) {
        case ProcStatus::Running:
        case ProcStatus::HoldMin: {
          if (desired < min_rate - kRateEps && g > kRateEps) {
            // Below turndown, but the tanks can sustain minimum (§5.4
            // rationing guards the draw while it runs).
            ps.status = ProcStatus::HoldMin;
            ps.rate_t_h = rampToward(ps.rate_t_h, min_rate, proc.design_rate_t_h,
                                     type.ramp_per_h, dt_h);
          } else if (g <= kRateEps) {
            // A tank sits at its hard floor: minimum no longer sustainable.
            ps.status = ProcStatus::Shutdown;
            ps.rate_t_h = rampToward(ps.rate_t_h, 0.0, proc.design_rate_t_h,
                                     type.ramp_per_h, dt_h);
            // §5.8: every feed tank at the floor learns caution from this.
            for (const TankId t : views[p].feeds)
              if (signals[t.v].f <= kRateEps) onDryFeed(world, state, t.v);
          } else {
            ps.status = ProcStatus::Running;
            ps.rate_t_h = rampToward(ps.rate_t_h, desired, proc.design_rate_t_h,
                                     type.ramp_per_h, dt_h);
          }
          break;
        }
        case ProcStatus::Shutdown: {
          ps.rate_t_h = rampToward(ps.rate_t_h, 0.0, proc.design_rate_t_h, type.ramp_per_h, dt_h);
          if (g > kRestartGap) {
            ps.status = ProcStatus::Restarting;
            ps.timer = static_cast<uint32_t>(std::lround(type.restart_h / dt_h));
          }
          break;
        }
        case ProcStatus::Restarting: {
          ps.rate_t_h = 0.0;
          if (ps.timer > 0) --ps.timer;
          if (ps.timer == 0) {
            ps.status = ProcStatus::Running;
            ps.rate_t_h = min_rate;  // resumes at minimum rate (§5.3)
          }
          break;
        }
      }
    }

    // Log the two §7.2 transitions, once each.
    if (prev != ps.status) {
      if (ps.status == ProcStatus::Shutdown) {
        // Say why: a failed unit, too few trains left, a feed that ran out
        // or a product with nowhere to go.
        std::string why;
        if (r_max <= kRateEps) {
          why = "a unit is down";
          for (uint32_t u = proc.units.begin; u < rangeEnd(proc.units); ++u) {
            const UnitSlot& slot = type.units[world.units[u].slot];
            if (static_cast<int>(slot.trains) - state.unit[u].trains_down <= 0) {
              why = "its " + slot.name + " is down";
              break;
            }
          }
        } else if (r_max < min_rate - kRateEps) {
          why = "with trains down it cannot hold its minimum rate";
        } else {
          for (const TankId t : views[p].feeds)
            if (why.empty() && signals[t.v].f <= kRateEps)
              why = "it ran out of " + materialWord(world.catalog, world.tanks[t.v].material);
          for (const TankId t : views[p].products)
            if (why.empty() && signals[t.v].h <= kRateEps)
              why = "its " + materialWord(world.catalog, world.tanks[t.v].material) + " tank is full";
          if (why.empty()) why = "its tanks cannot keep it running";
        }
        logEvent(rec, state.tick, "process_shutdown", site.key, type.key,
                 site.name + ": " + processWithin(site.name, type.name) + " stopped, " + why);
      }
      if (prev == ProcStatus::Restarting && ps.status == ProcStatus::Running)
        logEvent(rec, state.tick, "process_restart", site.key, type.key,
                 site.name + ": " + processWithin(site.name, type.name) +
                     " is running again, at minimum rate");
    }

    // A plant cannot pass more than its online trains allow. The ramp limits
    // how fast the rate follows the governor; a lost train is a physical cap
    // and takes effect at once.
    if (ps.rate_t_h > r_max) ps.rate_t_h = r_max;

    d = {ps.rate_t_h, ps.status, r_max, g, desired};
  }
}

}  // namespace sim
}  // namespace crx
