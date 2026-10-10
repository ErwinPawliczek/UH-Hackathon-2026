// Chain Reaction — recorder implementation: hourly series, the event log,
// and the deterministic state fingerprint.
#include "sim/recorder.h"

#include "crx/hash.h"

#include <cstdio>
#include <cstring>

namespace crx {
namespace sim {

namespace {

constexpr size_t kMaxSeriesPoints = 24 * 60;  // §4.4: rolling 60-day window

template <typename T>
void pushRing(std::vector<float>& ring, T value) {
  ring.push_back(static_cast<float>(value));
  if (ring.size() > kMaxSeriesPoints) ring.erase(ring.begin());
}

}  // namespace

void recordHourly(const World& world, const State& state, Recorder& rec) {
  for (size_t t = 0; t < world.tanks.size(); ++t)
    pushRing(rec.tank_fill[t], world.tanks[t].capacity_t > 0.0
                                   ? state.tank[t].level_t / world.tanks[t].capacity_t
                                   : 0.0);
  for (size_t p = 0; p < world.processes.size(); ++p)
    pushRing(rec.proc_rate[p],
             world.processes[p].design_rate_t_h > 0.0
                 ? state.proc[p].rate_t_h / world.processes[p].design_rate_t_h
                 : 0.0);
}

void logEvent(Recorder& rec, uint64_t tick, const std::string& type, const std::string& site,
              const std::string& unit, const std::string& text) {
  rec.log.push_back({rec.next_seq++, tick, type, site, unit, text});
}

std::string eventsJson(const Recorder& rec, uint64_t since_seq) {
  std::string out = "[";
  char buf[32];
  bool first = true;
  for (const LogEntry& e : rec.log) {
    if (e.seq <= since_seq) continue;
    if (!first) out += ",";
    first = false;
    std::snprintf(buf, sizeof buf, "%llu", static_cast<unsigned long long>(e.seq));
    out += std::string("{\"seq\":") + buf + ",\"tick\":";
    std::snprintf(buf, sizeof buf, "%llu", static_cast<unsigned long long>(e.tick));
    out += buf;
    out += ",\"type\":\"" + e.type + "\",\"site\":\"" + e.site + "\",\"unit\":\"" + e.unit +
           "\",\"text\":\"" + e.text + "\"}";
  }
  out += "]";
  return out;
}

uint64_t hashState(const World& world, const State& state) {
  Hasher h;
  h.mixU64(world.seed);
  h.mixU64(state.tick);
  h.mixU64(state.rng.state);
  h.mixU64(state.rng.inc);
  for (const TankState& t : state.tank) {
    h.mixF64(t.level_t);
    h.mixF64(t.inbound_t);
    h.mixF64(t.reserved_out_t);
    h.mixF64(t.lead_time_h);
    h.mixF64(t.caution);
    h.mixU64(t.next_eta_tick);
    h.mixU64(t.last_pickup_tick);
  }
  for (const ProcState& p : state.proc) {
    h.mixF64(p.rate_t_h);
    h.mix(&p.status, sizeof p.status);
    h.mixU32(p.timer);
    h.mix(p.trains_by_mode.data(), p.trains_by_mode.size());
    h.mixU32(p.switch_timer);
  }
  for (const UnitState& u : state.unit) {
    h.mix(&u.trains_down, sizeof u.trains_down);
    h.mixU64(u.back_at_tick);
  }
  for (const EventDef& e : state.pending) {
    h.mix(&e.type, sizeof e.type);
    h.mixU32(e.site);
    h.mixU32(static_cast<uint32_t>(e.unit));
    h.mixU32(e.trains);
    h.mixF64(e.multiplier);
    h.mixU64(e.start_tick);
    h.mixU64(e.end_tick);
    h.mix(&e.applied, sizeof e.applied);
  }
  for (const EventDef& e : state.active) {
    // Applied events are deterministic from their pending form; mix the
    // identity fields so expiry order is pinned.
    h.mixU32(e.site);
    h.mixU64(e.start_tick);
    h.mixU64(e.end_tick);
    h.mixF64(e.multiplier);
  }
  for (const double f : state.pipe_flow_t_h) h.mixF64(f);
  for (const Ledger& l : state.ledger) {
    h.mixF64(l.produced_t);
    h.mixF64(l.consumed_t);
    h.mixF64(l.unmet_t);
    h.mixF64(l.revenue);
    h.mixF64(l.feed_cost);
    h.mixF64(l.freight);
    h.mixF64(l.energy_cost);
  }
  h.mix(state.sink_starved.data(), state.sink_starved.size());
  h.mixF64(state.cum_supplied_t);
  h.mixF64(state.cum_consumed_t);
  h.mixF64(state.cum_loss_t);
  h.mixF64(state.cum_demand_t);
  h.mixF64(state.cum_unmet_t);
  h.mixF64(state.cum_unmet_usd);
  h.mixF64(state.cum_shutdown_h);
  h.mixF64(state.stockouts);
  h.mixF64(state.cum_freight_usd);
  h.mixF64(state.cum_energy_usd);
  h.mixF64(state.last_production_index);
  h.mix(&state.random_failures, sizeof state.random_failures);
  for (const double r : state.rate_override) h.mixF64(r);
  return finish(h);
}

}  // namespace sim
}  // namespace crx
