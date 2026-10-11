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
  if (rec.muted) return;
  for (size_t t = 0; t < world.tanks.size(); ++t)
    pushRing(rec.tank_fill[t], world.tanks[t].capacity_t > 0.0
                                   ? state.tank[t].level_t / world.tanks[t].capacity_t
                                   : 0.0);
  for (size_t p = 0; p < world.processes.size(); ++p)
    pushRing(rec.proc_rate[p],
             world.processes[p].design_rate_t_h > 0.0
                 ? state.proc[p].rate_t_h / world.processes[p].design_rate_t_h
                 : 0.0);

  // Economy history: untrimmed, one row per hour.
  for (size_t p = 0; p < world.processes.size(); ++p)
    rec.hour_rate.push_back(world.processes[p].design_rate_t_h > 0.0
                                ? static_cast<float>(state.proc[p].rate_t_h /
                                                     world.processes[p].design_rate_t_h)
                                : 0.f);
  for (const double idx : state.price_index) rec.hour_price.push_back(static_cast<float>(idx));
  double rejected_t = 0, rejected_usd = 0;
  Recorder::rejectedTotals(world, state, rejected_t, rejected_usd);
  rec.hour_totals.push_back({state.cum_demand_t, state.cum_unmet_t, state.cum_unmet_usd,
                             state.cum_freight_usd, state.cum_energy_usd, state.cum_shutdown_h,
                             rejected_t, rejected_usd});
}

void Recorder::rejectedTotals(const World& world, const State& state, double& tonnes,
                              double& usd) {
  tonnes = usd = 0;
  for (size_t t = 0; t < world.tanks.size() && t < state.tank.size(); ++t) {
    if (!world.tanks[t].reject_when_full) continue;
    tonnes += state.tank[t].rejected_t;
    usd += state.tank[t].rejected_t * world.catalog.materials[world.tanks[t].material].base_price;
  }
}

void logEvent(Recorder& rec, uint64_t tick, const std::string& type, const std::string& site,
              const std::string& unit, const std::string& text) {
  if (rec.muted) return;
  rec.log.push_back({rec.next_seq++, tick, type, site, unit, text, rec.actor_id, rec.actor_name});
}

namespace {
// Text that may carry a player's name goes into JSON escaped.
std::string escaped(const std::string& s) {
  std::string out;
  for (const char c : s) {
    if (c == '"' || c == '\\') {
      out += '\\';
      out += c;
    } else if (static_cast<unsigned char>(c) < 0x20) {
      out += ' ';
    } else {
      out += c;
    }
  }
  return out;
}
}  // namespace

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
           "\",\"text\":\"" + escaped(e.text) + "\"";
    if (!e.player.empty())
      out += ",\"player\":\"" + escaped(e.player) + "\",\"playerName\":\"" +
             escaped(e.player_name) + "\"";
    out += "}";
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
  for (size_t i = 0; i < state.tank.size(); ++i) {
    const TankState& t = state.tank[i];
    h.mixF64(t.level_t);
    h.mixF64(t.inbound_t);
    h.mixF64(t.reserved_out_t);
    h.mixF64(t.lead_time_h);
    h.mixF64(t.caution);
    h.mixU64(t.next_eta_tick);
    h.mixU64(t.last_pickup_tick);
    if (t.paid_avg != 0.0) h.mixF64(t.paid_avg);
    // Rejected product is state only where a tank can reject: worlds without
    // the flag hash exactly as they always have.
    if (i < world.tanks.size() && world.tanks[i].reject_when_full) h.mixF64(t.rejected_t);
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
    if (e.edge != UINT32_MAX) h.mixU32(e.edge);  // only edge breaks carry one
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
  // Only sites with a markup enter the hash, so a run nobody priced hashes
  // exactly as it did before markups existed.
  for (const uint64_t b : state.trade_blocks) h.mixU64(b);
  if (state.hurricane_until != 0) h.mixU64(state.hurricane_until ^ 0x4855525249ull);
  if (state.water_stop_until != 0) h.mixU64(state.water_stop_until ^ 0x5741544552ull);
  for (size_t s = 0; s < state.site_markup.size(); ++s)
    if (state.site_markup[s] != 0.0) {
      h.mixU32(static_cast<uint32_t>(s));
      h.mixF64(state.site_markup[s]);
    }
  // M2 logistics: edge availability, market indices, vehicles and orders
  // are all mutable state that must fork exactly (determinism rules 4 and 6).
  h.mix(state.edge_open.data(), state.edge_open.size());
  for (const double p : state.price_index) h.mixF64(p);
  h.mix(&state.adaptation, sizeof state.adaptation);
  for (const VehicleState& v : state.vehicle) {
    h.mix(&v.status, sizeof v.status);
    h.mixU32(v.order);
    h.mixU32(v.cargo_material);
    h.mixF64(v.cargo_t);
    h.mixU32(v.at_node);
    h.mixU32(v.leg);
    h.mixU32(v.edge);
    h.mixF64(v.edge_pos_km);
    h.mixF64(v.x_km);
    h.mixF64(v.y_km);
    h.mixF64(v.dir_x);
    h.mixF64(v.dir_y);
    h.mixU64(v.queue_since_tick);
    h.mixF64(v.moved_t);
    h.mixU32(v.route_nodes.size());
    for (const uint32_t n : v.route_nodes) h.mixU32(n);
  }
  for (const Order& o : state.order) {
    h.mixU32(o.from);
    h.mixU32(o.to);
    h.mixU32(o.material);
    h.mixF64(o.qty_t);
    h.mixF64(o.price);
    h.mixF64(o.freight_usd);
    h.mixF64(o.urgency);
    h.mixU32(o.cls);
    h.mixU32(o.vehicle);
    h.mixU64(o.created_tick);
    h.mixU64(o.eta_tick);
    h.mix(&o.status, sizeof o.status);
  }
  return finish(h);
}

}  // namespace sim
}  // namespace crx
