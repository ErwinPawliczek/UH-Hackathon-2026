// Chain Reaction — §5.9 events.
#include "sim/events.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>

namespace crx {
namespace sim {

using json = nlohmann::json;

namespace {

// Resolves a site reference (index or key); -1 when unresolvable.
int resolveSite(const World& world, const json& j) {
  if (j.is_number_unsigned()) {
    const uint64_t v = j.get<uint64_t>();
    return v < world.sites.size() ? static_cast<int>(v) : -1;
  }
  if (j.is_string()) {
    const std::string key = j.get<std::string>();
    for (size_t i = 0; i < world.sites.size(); ++i)
      if (world.sites[i].key == key) return static_cast<int>(i);
  }
  return -1;
}

// The site a route node belongs to, or failing that the site closest to it.
uint32_t nearestSite(const World& world, uint32_t node) {
  if (node >= world.nodes.size()) return 0;
  if (world.nodes[node].site >= 0) return static_cast<uint32_t>(world.nodes[node].site);
  uint32_t best = 0;
  double best_d = 1e300;
  for (uint32_t s = 0; s < world.sites.size(); ++s) {
    const double d = std::hypot(world.sites[s].x_km - world.nodes[node].x_km,
                                world.sites[s].y_km - world.nodes[node].y_km);
    if (d < best_d) {
      best_d = d;
      best = s;
    }
  }
  return best;
}

// Resolves a unit key within a site's processes; -1 when absent.
int resolveUnit(const World& world, int site, const std::string& key) {
  if (site < 0) return -1;
  const Range<ProcessId> procs = world.sites[static_cast<size_t>(site)].processes;
  for (uint32_t p = procs.begin; p < rangeEnd(procs); ++p) {
    const Range<UnitId> units = world.processes[p].units;
    for (uint32_t u = units.begin; u < rangeEnd(units); ++u) {
      const Unit& unit = world.units[u];
      const ProcessType& type = world.catalog.process_types[world.processes[p].type];
      if (type.units[unit.slot].key == key) return static_cast<int>(u);
    }
  }
  return -1;
}

}  // namespace

bool queueEvent(const World& world, const std::string& body, State& state, std::string& error) {
  json j;
  try {
    j = json::parse(body);
  } catch (const std::exception& e) {
    error = std::string("event: bad JSON: ") + e.what();
    return false;
  }
  if (!j.is_object() || !j.contains("type") || !j["type"].is_string()) {
    error = "event: missing 'type'";
    return false;
  }
  const std::string type = j["type"].get<std::string>();

  EventDef def;
  uint64_t duration_h = 0;
  // unit_outage names its unit by key within the site ('unit') or by the
  // unit's own index in the world ('unit_index', the index the world JSON
  // gives each unit). The index is the one that is always unambiguous: a
  // site can hold several units with the same key (the fuel depot's four
  // demand blocks are all FD-OUT), and the key picks the first.
  int unit_by_index = -1;
  if (type == "unit_outage") {
    def.type = EventDef::Type::UnitOutage;
    const bool has_key = j.contains("unit") && j["unit"].is_string();
    if (j.contains("unit_index")) {
      if (!j["unit_index"].is_number_unsigned() ||
          j["unit_index"].get<uint64_t>() >= world.units.size()) {
        error = "unit_outage: 'unit_index' must be a unit index from 0 to " +
                std::to_string(world.units.empty() ? 0 : world.units.size() - 1);
        return false;
      }
      unit_by_index = static_cast<int>(j["unit_index"].get<uint64_t>());
    }
    if ((!has_key && unit_by_index < 0) || !j.contains("trains") ||
        !j["trains"].is_number_unsigned()) {
      error = "unit_outage: need 'unit' (key) or 'unit_index', and 'trains'";
      return false;
    }
    def.trains = j["trains"].get<uint32_t>();
  } else if (type == "site_shutdown") {
    def.type = EventDef::Type::SiteShutdown;
  } else if (type == "demand_shock") {
    def.type = EventDef::Type::DemandShock;
  } else if (type == "supply_shock") {
    def.type = EventDef::Type::SupplyShock;
  } else if (type == "route_break") {
    def.type = EventDef::Type::RouteBreak;
    if (j.contains("edge")) {
      // One route edge by its index (the position of the route in the world
      // JSON): the form that works on any network, where most edges join
      // junctions rather than two sites.
      if (!j["edge"].is_number_unsigned() || j["edge"].get<uint64_t>() >= world.edges.size()) {
        error = "route_break: 'edge' must be a route index from 0 to " +
                std::to_string(world.edges.empty() ? 0 : world.edges.size() - 1);
        return false;
      }
      def.edge = j["edge"].get<uint32_t>();
    } else {
      if (!j.contains("site2") ||
          (!j["site2"].is_number_unsigned() && !j["site2"].is_string())) {
        error = "route_break: need 'edge' (a route index), or 'site' and 'site2' (site keys "
                "or indices)";
        return false;
      }
      const int s2 = resolveSite(world, j["site2"]);
      if (s2 < 0) {
        error = "route_break: unresolvable site2";
        return false;
      }
      def.site2 = static_cast<uint32_t>(s2);
    }
  } else {
    error = "event: unknown type '" + type + "'";
    return false;
  }

  if (def.edge != UINT32_MAX && !j.contains("site")) {
    // An edge break needs no site; the log files it under the site nearest
    // the edge's first end.
    def.site = nearestSite(world, world.edges[def.edge].a);
  } else if (unit_by_index >= 0 && !j.contains("site")) {
    // A unit named by index brings its own site.
    def.site = world.processes[world.units[static_cast<size_t>(unit_by_index)].process.v].site.v;
  } else {
    if (!j.contains("site")) {
      error = "event: missing 'site'";
      return false;
    }
    const int site = resolveSite(world, j["site"]);
    if (site < 0) {
      error = "event: unresolvable site";
      return false;
    }
    def.site = static_cast<uint32_t>(site);
  }
  if (unit_by_index >= 0) {
    // The index wins over a key; with a site given it must be that site's unit.
    if (world.processes[world.units[static_cast<size_t>(unit_by_index)].process.v].site.v != def.site) {
      error = "unit_outage: unit " + std::to_string(unit_by_index) + " is not at " +
              world.sites[def.site].key;
      return false;
    }
    def.unit = unit_by_index;
  } else if (j.contains("unit") && j["unit"].is_string()) {
    def.unit = resolveUnit(world, static_cast<int>(def.site), j["unit"].get<std::string>());
  }
  if (j.contains("multiplier") && j["multiplier"].is_number())
    def.multiplier = j["multiplier"].get<double>();
  if (j.contains("duration_h") && j["duration_h"].is_number())
    duration_h = static_cast<uint64_t>(j["duration_h"].get<double>());

  def.start_tick = state.tick + 1;
  def.end_tick = def.start_tick + static_cast<uint64_t>(duration_h / kTickHours);
  state.pending.push_back(def);
  return true;
}

namespace {

// Takes `trains` more trains down (saturating at the unit's train count)
// and books the repair tick; the latest event wins on overlap (M1 scope).
void takeDown(const World& world, State& state, uint32_t u, uint32_t trains, uint64_t back_at) {
  UnitState& us = state.unit[u];
  const Unit& unit = world.units[u];
  const ProcessType& type = world.catalog.process_types[world.processes[unit.process.v].type];
  const int limit = type.units[unit.slot].trains;
  us.trains_down = static_cast<uint8_t>(std::min(limit, us.trains_down + static_cast<int>(trains)));
  us.back_at_tick = back_at;
}

void applyOutage(const World& world, State& state, Recorder& rec, const EventDef& def) {
  const Site& site = world.sites[def.site];

  if (def.type == EventDef::Type::UnitOutage) {
    if (def.unit < 0) return;  // unresolvable key: queued, then skipped
    const Unit& unit = world.units[static_cast<size_t>(def.unit)];
    const ProcessType& type =
        world.catalog.process_types[world.processes[unit.process.v].type];
    takeDown(world, state, static_cast<uint32_t>(def.unit), def.trains, def.end_tick);
    // Process and unit both: several units at a site can share a name.
    logEvent(rec, state.tick, "unit_failed", site.key, type.units[unit.slot].key,
             site.name + ": " + type.name + ", " + type.units[unit.slot].name + " failed (" +
                 std::to_string(def.trains) + " train(s) down)");
    return;
  }

  // site_shutdown: every unit at the site, one log entry.
  const Range<ProcessId> procs = site.processes;
  for (uint32_t p = procs.begin; p < rangeEnd(procs); ++p)
    for (uint32_t u = world.processes[p].units.begin; u < rangeEnd(world.processes[p].units); ++u)
      takeDown(world, state, u, 255, def.end_tick);
  logEvent(rec, state.tick, "site_shutdown", site.key, "", site.name + ": site shut down by operator");
}

// Restores trains whose repair tick matches the expiring event.
void expireOutage(const World& world, State& state, Recorder& rec, const EventDef& def) {
  const Site& site = world.sites[def.site];
  const Range<ProcessId> procs = site.processes;
  for (uint32_t p = procs.begin; p < rangeEnd(procs); ++p)
    for (uint32_t u = world.processes[p].units.begin; u < rangeEnd(world.processes[p].units); ++u) {
      UnitState& us = state.unit[u];
      if (us.back_at_tick != def.end_tick || us.trains_down == 0) continue;
      const Unit& unit = world.units[u];
      const ProcessType& type =
          world.catalog.process_types[world.processes[unit.process.v].type];
      us.trains_down = 0;
      us.back_at_tick = 0;
      logEvent(rec, state.tick, "unit_repaired", site.key, type.units[unit.slot].key,
               site.name + ": " + type.name + ", " + type.units[unit.slot].name + " repaired");
    }
}

// Toggles every edge between two sites' nodes (all modes) and bumps the
// graph version so path caches rebuild (§5.9 route_break).
void setSpanEdges(const World& world, State& state, const EventDef& def, bool open) {
  if (def.edge != UINT32_MAX) {  // one edge, named by index
    if (def.edge < state.edge_open.size() && state.edge_open[def.edge] != (open ? 1 : 0)) {
      state.edge_open[def.edge] = open ? 1 : 0;
      state.graph_version += 1;
    }
    return;
  }
  if (def.site2 >= world.sites.size()) return;
  for (uint32_t e = 0; e < world.edges.size(); ++e) {
    const RouteEdge& edge = world.edges[e];
    const uint32_t na = world.sites[def.site].node[modeIndex(edge.mode)];
    const uint32_t nb = world.sites[def.site2].node[modeIndex(edge.mode)];
    const bool spans = (edge.a == na && edge.b == nb) || (edge.a == nb && edge.b == na);
    if (spans && state.edge_open[e] != (open ? 1 : 0)) {
      state.edge_open[e] = open ? 1 : 0;
      state.graph_version += 1;
    }
  }
}

// Another active route_break on the same span forbids reopening it yet.
bool spanStillHeld(const State& state, const EventDef& def) {
  for (const EventDef& d : state.active) {
    if (d.type != EventDef::Type::RouteBreak || &d == &def) continue;
    if (d.edge != def.edge) continue;  // edge breaks hold edges, span breaks hold spans
    if (def.edge != UINT32_MAX && d.end_tick > state.tick) return true;
    if (d.site == def.site && d.site2 == def.site2 && d.end_tick > state.tick) return true;
  }
  return false;
}

}  // namespace

void stepEvents(const World& world, State& state, Recorder& rec) {
  // Promote pending events whose start tick has arrived.
  for (const EventDef& def : state.pending)
    if (def.start_tick <= state.tick) state.active.push_back(def);
  state.pending.erase(std::remove_if(state.pending.begin(), state.pending.end(),
                                     [&](const EventDef& d) { return d.start_tick <= state.tick; }),
                      state.pending.end());

  // Apply outage effects once (the applied flag makes this idempotent).
  for (EventDef& def : state.active) {
    if (def.applied) continue;
    if (def.type != EventDef::Type::UnitOutage && def.type != EventDef::Type::SiteShutdown &&
        def.type != EventDef::Type::RouteBreak)
      continue;
    def.applied = true;
    if (def.type == EventDef::Type::RouteBreak) {
      setSpanEdges(world, state, def, false);
      if (def.edge != UINT32_MAX) {
        const RouteEdge& edge = world.edges[def.edge];
        const char* what = edge.mode == crx::Mode::River ? "River lane"
                           : edge.mode == crx::Mode::Sea ? "Sea lane" : "Road";
        const std::string a = world.sites[nearestSite(world, edge.a)].name;
        const std::string b = world.sites[nearestSite(world, edge.b)].name;
        logEvent(rec, state.tick, "route_break", world.sites[def.site].key,
                 std::to_string(def.edge),
                 std::string(what) + " closed " + (a == b ? "near " + a : "between " + a + " and " + b));
      } else {
        logEvent(rec, state.tick, "route_break", world.sites[def.site].key, "",
                 world.sites[def.site].key + " - " + world.sites[def.site2].key +
                     ": route closed for repairs");
      }
    } else {
      applyOutage(world, state, rec, def);
    }
  }

  // Expire finished events, restoring trains. The tick guard matters: the
  // repair match (back_at_tick == def.end_tick) is true from the outage's
  // first tick, so without it every outage would undo itself immediately.
  for (const EventDef& def : state.active)
    if ((def.type == EventDef::Type::UnitOutage || def.type == EventDef::Type::SiteShutdown) &&
        def.end_tick <= state.tick)
      expireOutage(world, state, rec, def);
  // Route breaks reopen their span on expiry, unless a second break on the
  // same span is still active.
  for (const EventDef& def : state.active)
    if (def.type == EventDef::Type::RouteBreak && def.end_tick <= state.tick &&
        !spanStillHeld(state, def)) {
      setSpanEdges(world, state, def, true);
      if (def.edge != UINT32_MAX) {
        const RouteEdge& edge = world.edges[def.edge];
        const char* what = edge.mode == crx::Mode::River ? "River lane"
                           : edge.mode == crx::Mode::Sea ? "Sea lane" : "Road";
        logEvent(rec, state.tick, "route_reopened", world.sites[def.site].key,
                 std::to_string(def.edge),
                 std::string(what) + " reopened near " + world.sites[def.site].name);
      }
    }
  state.active.erase(std::remove_if(state.active.begin(), state.active.end(),
                                    [&](const EventDef& d) { return d.end_tick <= state.tick; }),
                     state.active.end());

  // Repair sweep for outages without an owning event def (random failures):
  // a unit whose repair tick has passed and that no active event still holds
  // comes back online. Event-owned outages restore via expireOutage.
  auto heldByEvent = [&](uint32_t u) {
    for (const EventDef& d : state.active) {
      if (d.type != EventDef::Type::UnitOutage && d.type != EventDef::Type::SiteShutdown)
        continue;
      if (d.type == EventDef::Type::UnitOutage && d.unit == static_cast<int>(u)) return true;
      if (d.type == EventDef::Type::SiteShutdown &&
          world.processes[world.units[u].process.v].site.v == d.site)
        return true;
    }
    return false;
  };
  for (size_t u = 0; u < world.units.size(); ++u) {
    UnitState& us = state.unit[u];
    if (us.trains_down == 0 || us.back_at_tick > state.tick ||
        heldByEvent(static_cast<uint32_t>(u)))
      continue;
    const Unit& unit = world.units[u];
    const ProcessType& type =
        world.catalog.process_types[world.processes[unit.process.v].type];
    us.trains_down = 0;
    us.back_at_tick = 0;
    const Site& site = world.sites[world.processes[unit.process.v].site.v];
    logEvent(rec, state.tick, "unit_repaired", site.key, type.units[unit.slot].key,
             site.name + ": " + type.name + ", " + type.units[unit.slot].name + " repaired");
  }

  // Optional random failures (§5.9): Bernoulli per tick at trains·dt/mtbf.
  if (state.random_failures) {
    for (size_t u = 0; u < world.units.size(); ++u) {
      const Unit& unit = world.units[u];
      const UnitSlot& slot = world.catalog
                                 .process_types[world.processes[unit.process.v].type]
                                 .units[unit.slot];
      if (slot.mtbf_h <= 0 || state.unit[u].trains_down > 0) continue;
      const double p_fail = slot.trains * kTickHours / slot.mtbf_h;
      if (state.rng.uniform01() < p_fail) {
        const double mttr = slot.mttr_h > 0 ? slot.mttr_h : 12.0;
        takeDown(world, state, static_cast<uint32_t>(u), 1,
                 state.tick + static_cast<uint64_t>(mttr / kTickHours));
        const Site& site = world.sites[world.processes[unit.process.v].site.v];
        logEvent(rec, state.tick, "unit_failed", site.key, slot.key,
                 site.name + ": " +
                     world.catalog.process_types[world.processes[unit.process.v].type].name +
                     ", " + slot.name + " failed (random)");
      }
    }
  }
}

double shockFactor(const State& state, uint32_t site, EventDef::Type kind) {
  double f = 1.0;
  for (const EventDef& def : state.active)
    if (def.type == kind && def.site == site) f = def.multiplier;  // last wins
  return f;
}

}  // namespace sim
}  // namespace crx
