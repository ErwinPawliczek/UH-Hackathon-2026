// Chain Reaction — sim integration implementation.
#include "sim/sim.h"

#include "sim/inspect.h"
#include "sim/layout.h"
#include "sim/market.h"
#include "sim/sixsite.h"
#include "sim/worldfile.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>

using json = nlohmann::json;

namespace crx {
namespace sim {

std::unique_ptr<Sim> Sim::create(uint64_t seed, std::string& error) {
  return createNamed("sixsite", seed, error);
}

std::unique_ptr<Sim> Sim::createNamed(const std::string& world_name, uint64_t seed,
                                      std::string& error) {
  auto world = std::make_shared<World>();
  if (world_name.empty() || world_name == "sixsite") {
    if (!buildSixSiteWorld(seed, *world, error)) return nullptr;
  } else if (!buildNamedWorld(world_name, seed, *world, error)) {
    return nullptr;
  }
  return createOn(std::move(world), seed);
}

std::unique_ptr<Sim> Sim::createWithLayout(const std::string& world_name,
                                           const std::string& layout_json, uint64_t seed,
                                           std::string& error) {
  auto world = std::make_shared<World>();
  LayoutReport report;
  if (!buildWorldWithLayout(world_name, layout_json, seed, *world, report)) {
    error = report.errors.empty() ? "the layout could not be used" : report.errors.front().text;
    return nullptr;
  }
  return createOn(std::move(world), seed);
}

std::unique_ptr<Sim> Sim::createOn(std::shared_ptr<World> world, uint64_t seed) {

  auto sim = std::unique_ptr<Sim>(new Sim());
  world->seed = seed;  // stamped through the non-const pointer before the move
  sim->world_ = std::move(world);
  sim->state_.rng = Rng(seed);

  // Initial state (§4.4): tanks at their target level, all rates cold at
  // zero — the run ramps up to design through the normal control path, so
  // the first day shows a physically clean start-up.
  const World& w = *sim->world_;
  sim->state_.tank.resize(w.tanks.size());
  for (size_t t = 0; t < w.tanks.size(); ++t) {
    TankState& ts = sim->state_.tank[t];
    const double fill =
        w.tanks[t].init_frac >= 0 ? std::min(w.tanks[t].init_frac, 1.0) : w.tanks[t].target_frac;
    ts.level_t = fill * w.tanks[t].capacity_t;
    ts.inbound_t = 0;
    ts.reserved_out_t = 0;
    ts.lead_time_h = w.tanks[t].init_lead_time_h;
    ts.pickup_gap_h = w.tanks[t].init_pickup_gap_h;
    ts.caution = 1;
  }
  sim->state_.proc.resize(w.processes.size());
  if (w.warm_start)
    for (size_t p = 0; p < w.processes.size(); ++p)
      sim->state_.proc[p].rate_t_h = w.processes[p].design_rate_t_h;
  sim->state_.unit.resize(w.units.size());
  sim->state_.pipe_flow_t_h.assign(w.pipelines.size(), 0.0);
  sim->state_.ledger.resize(w.sites.size());
  sim->state_.sink_starved.assign(w.processes.size(), 0);
  sim->state_.rate_override.assign(w.processes.size(), -1.0);
  sim->state_.proc_totals.assign(w.processes.size(), ProcTotals{});
  sim->state_.site_markup.assign(w.sites.size(), 0.0);
  sim->state_.site_rate_share.assign(w.sites.size(), 1.0);
  sim->state_.site_trade.assign(w.sites.size(), SiteTrade{});
  sim->state_.pipe_moved_t.assign(w.pipelines.size(), 0.0);
  sim->state_.demand_factor.assign(w.processes.size(), 1.0);
  sim->state_.cost_delta.assign(w.tanks.size(), 0.0);
  sim->state_.ask_floor.assign(w.tanks.size(), 0.0);
  sim->state_.margin_signal.assign(w.processes.size(), 1.0);
  sim->state_.proc_margin.assign(w.processes.size(), 0.0);
  sim->state_.proc_revenue.assign(w.processes.size(), 0.0);
  sim->state_.proc_feed_cost.assign(w.processes.size(), 0.0);
  sim->state_.proc_energy.assign(w.processes.size(), 0.0);
  sim->state_.proc_margin_base.assign(w.processes.size(), 0.0);
  sim->state_.mat_bought_t.assign(w.catalog.materials.size(), 0.0);
  sim->state_.mat_bought_usd.assign(w.catalog.materials.size(), 0.0);
  // M2 logistics (§4.4): all edges open, market index at par, the fleet at
  // its home sites, no orders.
  sim->state_.edge_open.assign(w.edges.size(), 1);
  sim->state_.price_index.assign(w.catalog.materials.size(), 1.0);
  sim->state_.adaptation = true;
  sim->state_.vehicle.resize(w.fleet.size());
  for (size_t v = 0; v < w.fleet.size(); ++v) {
    VehicleState& vs = sim->state_.vehicle[v];
    const VehicleClass& vc = w.catalog.vehicle_classes[w.fleet[v].cls];
    const Site& home = w.sites[w.fleet[v].home.v];
    vs.at_node = home.node[modeIndex(vc.mode)];
    if (vs.at_node != kNoNode) {
      vs.x_km = w.nodes[vs.at_node].x_km;
      vs.y_km = w.nodes[vs.at_node].y_km;
    }
  }
  // Per-world market settings override the engine defaults.
  const World::Market& mk = w.market;
  MarketParams& mp = sim->market_params_;
  if (mk.value_of_time_usd_t_h >= 0) mp.value_of_time_usd_t_h = mk.value_of_time_usd_t_h;
  if (mk.switch_cost_frac >= 0) mp.switch_cost_frac = mk.switch_cost_frac;
  if (mk.beta >= 0) mp.beta = mk.beta;
  if (mk.min_lot_cap_frac >= 0) mp.min_lot_cap_frac = mk.min_lot_cap_frac;
  if (mk.min_lot_target_frac >= 0) mp.min_lot_target_frac = mk.min_lot_target_frac;
  if (mk.dispatch_urgency_boost_h >= 0) mp.dispatch_urgency_boost_h = mk.dispatch_urgency_boost_h;
  if (mk.price_aware_buying >= 0) mp.price_aware_buying = mk.price_aware_buying > 0;
  if (mk.price_cheap_ratio >= 0) mp.price_cheap_ratio = mk.price_cheap_ratio;
  if (mk.price_dear_ratio >= 0) mp.price_dear_ratio = mk.price_dear_ratio;
  if (mk.price_cheap_fill >= 0) mp.price_cheap_fill = mk.price_cheap_fill;
  if (mk.price_dear_fill >= 0) mp.price_dear_fill = mk.price_dear_fill;
  if (mk.price_cheap_cover >= 0) mp.price_cheap_cover = mk.price_cheap_cover;
  if (mk.price_dear_cover >= 0) mp.price_dear_cover = mk.price_dear_cover;
  if (mk.demand_elasticity >= 0) mp.demand_elasticity = mk.demand_elasticity;
  if (mk.demand_min_frac >= 0) mp.demand_min_frac = mk.demand_min_frac;
  if (mk.demand_max_frac >= 0) mp.demand_max_frac = mk.demand_max_frac;
  if (mk.margin_control >= 0) mp.margin_control = mk.margin_control > 0;
  sim->state_.margin_control = mp.margin_control;
  sim->state_.demand_elasticity = mp.demand_elasticity;
  sim->state_.demand_min = mp.demand_min_frac;
  sim->state_.demand_max = mp.demand_max_frac;
  if (mk.max_lots_per_tank >= 1)
    mp.max_lots_per_tank = static_cast<uint32_t>(std::min(mk.max_lots_per_tank, 100000.0));
  sim->signals.assign(w.tanks.size(), TankSignals{});
  sim->rec_.tank_fill.resize(w.tanks.size());
  sim->rec_.proc_rate.resize(w.processes.size());
  return sim;
}

std::unique_ptr<Sim> Sim::createFromConfig(const char* config_json, std::string& error) {
  uint64_t seed = 42;  // §7.1: NULL or missing seed = defaults
  bool adaptation_override = true;
  std::string world_name = "sixsite";
  std::string layout_json;  // a redrawn map over the named world (layout.h)
  if (config_json != nullptr && config_json[0] != '\0') {
    try {
      const json cfg = json::parse(config_json);
      if (cfg.contains("seed")) {
        if (!cfg.at("seed").is_number_unsigned()) {
          error = "config seed must be a non-negative integer";
          return nullptr;
        }
        cfg.at("seed").get_to(seed);
      }
      for (auto it = cfg.begin(); it != cfg.end(); ++it) {
        if (it.key() == "seed") continue;
        if (it.key() == "adaptation") {
          // §5.8 global switch: false gives comparison runs with all three
          // learned parameters frozen at their world initials.
          if (!it.value().is_boolean()) {
            error = "config adaptation must be a boolean";
            return nullptr;
          }
          adaptation_override = it.value().get<bool>();
          continue;
        }
        if (it.key() == "world") {
          // A named world from engine/data/worlds (worldfile.h); "sixsite"
          // or no key at all is the hand-written six-site world.
          if (!it.value().is_string()) {
            error = "config world must be a world name (a string)";
            return nullptr;
          }
          world_name = it.value().get<std::string>();
          continue;
        }
        if (it.key() == "layout") {
          if (!it.value().is_object()) {
            error = "config layout must be an object";
            return nullptr;
          }
          layout_json = it.value().dump();
          continue;
        }
        // §7.1 also names "gen" (M3 worldgen); it is not a surface yet —
        // reject instead of silently ignoring.
        error = "config key \"" + it.key() + "\" is not supported (only \"seed\", "
                "\"adaptation\" and \"world\")";
        return nullptr;
      }
    } catch (const json::exception& e) {
      error = std::string("bad config json: ") + e.what();
      return nullptr;
    }
  }
  auto sim = layout_json.empty() ? createNamed(world_name, seed, error)
                                 : createWithLayout(world_name, layout_json, seed, error);
  if (sim) sim->state().adaptation = adaptation_override;
  return sim;
}

void Sim::step(uint32_t ticks) {
  const World& w = *world_;
  std::vector<ControlDecision> control;
  std::vector<ProductionResult> production;
  for (uint32_t i = 0; i < ticks; ++i) {
    ++state_.tick;
    stepEvents(w, state_, rec_);
    computeSignals(w, state_, signals);
    if (state_.tick % 4 == 0) stepMarket(w, state_);
    stepControl(w, state_, signals, rec_, control);
    // §5.10 shutdown hours: every plant (not a source or a sink) that is
    // shut down or restarting this tick counts its quarter hour.
    for (size_t p = 0; p < w.processes.size(); ++p) {
      const ProcStatus st = state_.proc[p].status;
      if (st != ProcStatus::Shutdown && st != ProcStatus::Restarting) continue;
      if (w.catalog.process_types[w.processes[p].type].boundary != Boundary::None) continue;
      state_.cum_shutdown_h += kTickHours;
      state_.proc_totals[p].down_h += kTickHours;
    }
    // Per-site stopped hours (summary view; not hashed).
    for (size_t s = 0; s < w.sites.size(); ++s) {
      bool any = false, down = false, running = false;
      for (size_t p = 0; p < w.processes.size(); ++p) {
        if (w.processes[p].site.v != s) continue;
        any = true;
        const ProcStatus st = state_.proc[p].status;
        down = down || st == ProcStatus::Shutdown || st == ProcStatus::Restarting;
        running = running || state_.proc[p].rate_t_h > 1e-9;
      }
      if (any && (down || !running)) state_.site_trade[s].stopped_h += kTickHours;
    }
    stepPipelines(w, state_);
    stepProduction(w, state_, control, production, rec_);
    // M2 logistics (§5.1 ordering): procurement and dispatch run hourly,
    // transport and adaptation every tick.
    if (state_.tick % 4 == 0) {
      ProcurementStats pstats;
      stepProcurement(w, state_, paths_, signals, market_params_, pstats, rec_);
      stepDispatch(w, state_, paths_, rec_, market_params_.dispatch_urgency_boost_h);
    }
    stepTransport(w, state_, paths_, rec_);
    stepAdaptation(w, state_);
    if (state_.tick % 4 == 0) recordHourly(w, state_, rec_);
  }
}

std::string Sim::command(const std::string& json_cmd) {
  try {
    const json cmd = json::parse(json_cmd);
    // M0 legacy envelope: the server settings channel posts {"cmd":"set",...}
    // key/value pairs the engine does not own — accept and ignore (§7.2 owns
    // only the "type" commands below).
    if (cmd.is_object() && cmd.contains("cmd") && !cmd.contains("type"))
      return json{{"ok", true}}.dump();
    if (!cmd.is_object() || !cmd.contains("type") || !cmd.at("type").is_string())
      return R"({"ok":false,"error":"command must be an object with a string \"type\""})";
    const std::string type = cmd.at("type").get<std::string>();
    // A command sent for a named player: the log lines it writes carry the
    // player, and say who did it.
    struct ActorScope {
      Recorder& rec;
      ~ActorScope() {
        rec.actor_id.clear();
        rec.actor_name.clear();
      }
    } actor_scope{rec_};
    if (cmd.contains("player") && cmd.at("player").is_string() && cmd.contains("player_name") &&
        cmd.at("player_name").is_string()) {
      rec_.actor_id = cmd.at("player").get<std::string>();
      rec_.actor_name = cmd.at("player_name").get<std::string>();
    }
    const std::string& actor = rec_.actor_name;

    // end_events: every running or queued disruption ends at the next tick
    // (outages repair, routes reopen, shocks and weather stop). Units a
    // player switched off by hand have no event and stay as they are.
    if (type == "end_events") {
      const uint64_t now = state_.tick + 1;
      if (state_.hurricane_until > now) state_.hurricane_until = now;
      if (state_.water_stop_until > now) state_.water_stop_until = now;
      for (EventDef& def : state_.active) {
        if (def.end_tick <= now) continue;
        for (UnitState& us : state_.unit)
          if (us.trains_down != 0 && us.back_at_tick == def.end_tick) us.back_at_tick = now;
        def.end_tick = now;
      }
      state_.pending.clear();
      logEvent(rec_, state_.tick, "events_ended", "", "", "Every running event was ended");
      return R"({"ok":true})";
    }

    if (type == "hurricane" || type == "water_restriction") {
      const bool storm = type == "hurricane";
      double hours = storm ? 72.0 : 120.0;
      if (cmd.contains("duration_h")) {
        if (!cmd.at("duration_h").is_number() || !(cmd.at("duration_h").get<double>() > 0.0) ||
            cmd.at("duration_h").get<double>() > 24.0 * 365.0)
          return R"({"ok":false,"error":"duration_h must be a number of hours above zero"})";
        hours = cmd.at("duration_h").get<double>();
      }
      const uint64_t until =
          state_.tick + std::max<uint64_t>(1, static_cast<uint64_t>(std::llround(hours / kTickHours)));
      uint64_t& slot = storm ? state_.hurricane_until : state_.water_stop_until;
      const bool running = slot > state_.tick;
      slot = until;
      if (!running)
        logEvent(rec_, state_.tick, type, "", "",
                 storm ? "A hurricane has slowed every road to a quarter speed"
                       : "A water restriction has stopped all barges and ships");
      return json{{"ok", true}, {"until_tick", until}}.dump();
    }

    if (type == "trade_block") {
      const auto siteOf = [&](const char* key) -> int {
        if (!cmd.contains(key)) return -1;
        const json& v = cmd.at(key);
        if (v.is_number_unsigned())
          return v.get<uint64_t>() < world_->sites.size() ? static_cast<int>(v.get<uint64_t>()) : -1;
        return v.is_string() ? world_->findSite(v.get<std::string>()) : -1;
      };
      const int site = siteOf("site"), partner = siteOf("partner");
      if (site < 0 || partner < 0) return R"({"ok":false,"error":"There is no such site"})";
      const std::string direction =
          cmd.contains("direction") && cmd.at("direction").is_string() ? cmd.at("direction").get<std::string>() : "";
      if (direction != "sell" && direction != "buy")
        return R"({"ok":false,"error":"Say whether to stop selling to them or buying from them"})";
      if (!cmd.contains("blocked") || !cmd.at("blocked").is_boolean())
        return R"({"ok":false,"error":"Say whether the block goes on or comes off"})";
      const bool sell = direction == "sell", on = cmd.at("blocked").get<bool>();
      const Site& me = world_->sites[static_cast<size_t>(site)];
      const Site& them = world_->sites[static_cast<size_t>(partner)];
      const uint32_t seller = static_cast<uint32_t>(sell ? site : partner);
      const uint32_t buyer = static_cast<uint32_t>(sell ? partner : site);
      if (tradedMaterials(*world_, seller, buyer).empty())
        return json{{"ok", false},
                    {"error", me.name + (sell ? " does not sell to " : " does not buy from ") + them.name}}
            .dump();
      const uint64_t key = (static_cast<uint64_t>(seller) << 32) | buyer;
      auto& blocks = state_.trade_blocks;
      const auto at = std::lower_bound(blocks.begin(), blocks.end(), key);
      const bool was = at != blocks.end() && *at == key;
      if (was == on)
        return json{{"ok", false},
                    {"error", on ? me.name + " has already stopped " + (sell ? "selling to " : "buying from ") + them.name
                                 : me.name + " is not blocking " + them.name}}
            .dump();
      if (on) blocks.insert(at, key);
      else blocks.erase(at);
      logEvent(rec_, state_.tick, "trade_block", me.key, them.key,
               (actor.empty() ? me.name : actor) + (on ? " stopped " : " resumed ") +
                   (sell ? "selling to " : "buying from ") + them.name);
      return json{{"ok", true}}.dump();
    }

    if (type == "unit_outage" || type == "site_shutdown" || type == "demand_shock" ||
        type == "supply_shock" || type == "route_break") {
      std::string error;
      if (!queueEvent(*world_, cmd.dump(), state_, error)) {
        return json{{"ok", false}, {"error", error}}.dump();
      }
      return json{{"ok", true}}.dump();
    }

    if (type == "set") {
      if (!cmd.contains("key") || !cmd.contains("value"))
        return R"({"ok":false,"error":"set needs key and value"})";
      const std::string key = cmd.at("key").get<std::string>();
      if (key == "random_failures") {
        state_.random_failures = cmd.at("value").get<bool>();
        return json{{"ok", true}}.dump();
      }
      return json{{"ok", false}, {"error", "unknown setting: " + key}}.dump();
    }

    if (type == "rate_override") {
      // §7.2 override: absolute R_max cap on one process, in t/h of basis.
      if (!cmd.contains("site") || !cmd.contains("process") || !cmd.contains("rate_t_h"))
        return R"({"ok":false,"error":"rate_override needs site, process and rate_t_h"})";
      const int site = world_->findSite(cmd.at("site").get<std::string>());
      const std::string proc_key = cmd.at("process").get<std::string>();
      const double rate = cmd.at("rate_t_h").get<double>();
      if (rate < 0)
        return R"({"ok":false,"error":"rate_t_h must be >= 0; omit the command to clear"})";
      for (size_t p = 0; p < world_->processes.size(); ++p) {
        const Process& proc = world_->processes[p];
        if (proc.site.v != static_cast<uint32_t>(site)) continue;
        if (world_->catalog.process_types[proc.type].key != proc_key) continue;
        state_.rate_override[p] = rate;
        return json{{"ok", true}}.dump();
      }
      return json{{"ok", false}, {"error", "no process " + proc_key + " at site"}}.dump();
    }

    if (type == "set_price" || type == "site_rate") {
      // A site's own commercial levers: a markup on what it asks for its
      // products, and the share of design it runs at.
      const bool price = type == "set_price";
      int site = -1;
      if (cmd.contains("site")) {
        const json& v = cmd.at("site");
        if (v.is_number_unsigned() && v.get<uint64_t>() < world_->sites.size())
          site = static_cast<int>(v.get<uint64_t>());
        else if (v.is_string())
          site = world_->findSite(v.get<std::string>());
      }
      if (site < 0) return R"({"ok":false,"error":"There is no such site"})";
      const Site& s = world_->sites[static_cast<size_t>(site)];
      if (price) {
        if (!cmd.contains("markup") || !cmd.at("markup").is_number())
          return R"({"ok":false,"error":"Give a markup from -0.2 to 0.3"})";
        const double markup = std::clamp(cmd.at("markup").get<double>(), -0.2, 0.3);
        state_.site_markup[static_cast<size_t>(site)] = markup;
        const int pct = static_cast<int>(std::lround(markup * 100.0));
        logEvent(rec_, state_.tick, "price_set", s.key, "",
                 !actor.empty()
                     ? (pct == 0 ? actor + " put " + s.name + "'s price back to the market rule"
                                 : actor + (pct > 0 ? " raised " : " lowered ") + s.name + "'s price to " +
                                       (pct > 0 ? "+" : "-") + std::to_string(std::abs(pct)) + "%")
                     : s.name + ": asking price set " +
                           (pct == 0 ? std::string("back to the market rule")
                                     : std::to_string(std::abs(pct)) + "% " +
                                           (pct > 0 ? "above" : "below") + " the market rule"));
        return json{{"ok", true}, {"markup", markup}}.dump();
      }
      if (!cmd.contains("share") || !cmd.at("share").is_number())
        return R"({"ok":false,"error":"Give a rate as a share of design, up to 1"})";
      // Below a process's turndown it would shut down, so the share stops at
      // the highest turndown among the site's processes.
      double floor = 0.0;
      bool any = false;
      for (const Process& proc : world_->processes)
        if (proc.site.v == static_cast<uint32_t>(site)) {
          floor = std::max(floor, world_->catalog.process_types[proc.type].turndown);
          any = true;
        }
      if (!any) return json{{"ok", false}, {"error", s.name + " has nothing to run"}}.dump();
      const double share = std::clamp(cmd.at("share").get<double>(), floor, 1.0);
      for (size_t p = 0; p < world_->processes.size(); ++p)
        if (world_->processes[p].site.v == static_cast<uint32_t>(site))
          state_.rate_override[p] = share >= 1.0 ? -1.0 : share * world_->processes[p].design_rate_t_h;
      const double share_before = state_.site_rate_share[static_cast<size_t>(site)];
      state_.site_rate_share[static_cast<size_t>(site)] = share;
      const std::string pct = std::to_string(static_cast<int>(std::lround(share * 100.0))) + "%";
      logEvent(rec_, state_.tick, "rate_set", s.key, "",
               !actor.empty() ? (share >= 1.0 ? actor + " put " + s.name + " back to full rate"
                                              : actor + (share < share_before ? " cut " : " raised ") +
                                                    s.name + " to " + pct)
                              : s.name + ": running at " + pct + " of design at most");
      return json{{"ok", true}, {"share", share}, {"min_share", floor}}.dump();
    }

    if (type == "unit_state") {
      if (!cmd.contains("unit_index") || !cmd.at("unit_index").is_number_unsigned() ||
          !cmd.contains("down") || !cmd.at("down").is_boolean())
        return R"({"ok":false,"error":"Say which unit, and whether it goes down or comes back"})";
      std::string error;
      const uint64_t unit = cmd.at("unit_index").get<uint64_t>();
      if (!setUnitHeld(*world_, state_, rec_, static_cast<uint32_t>(std::min<uint64_t>(unit, UINT32_MAX)),
                       cmd.at("down").get<bool>(), error))
        return json{{"ok", false}, {"error", error}}.dump();
      return json{{"ok", true}}.dump();
    }

    if (type == "place_order") {
      // A buyer's own order: one lot from a named seller by a named vehicle
      // class, booked exactly as the hourly pass books one (reservation,
      // inbound, dispatch queue). The tonnes are clamped to one vehicle
      // load, to the seller's free stock and to the room in the tank; where
      // the pass could not book the lot it is refused, with the same word
      // the sourcing view uses for the reason.
      const auto refuse = [](const char* blocked, const std::string& why) {
        return json{{"ok", false}, {"error", "place_order: " + why}, {"blocked", blocked}}.dump();
      };
      const auto siteOf = [&](const char* key) -> int {
        if (!cmd.contains(key)) return -1;
        const json& v = cmd.at(key);
        if (v.is_number_unsigned())
          return v.get<uint64_t>() < world_->sites.size() ? static_cast<int>(v.get<uint64_t>()) : -1;
        return v.is_string() ? world_->findSite(v.get<std::string>()) : -1;
      };
      const int buyer_site = siteOf("site");
      const int seller_site = cmd.contains("seller") ? siteOf("seller") : siteOf("from");
      if (buyer_site < 0) return refuse("bad_request", "need 'site', the buying site (key or index)");
      if (seller_site < 0)
        return refuse("bad_request", "need 'seller', the selling site (key or index)");
      if (!cmd.contains("material") || !cmd.at("material").is_string())
        return refuse("bad_request", "need 'material' (a material key)");
      const int mat = world_->catalog.findMaterial(cmd.at("material").get<std::string>());
      if (mat < 0) return refuse("bad_request", "unknown material");
      if (!cmd.contains("cls") || !cmd.at("cls").is_string())
        return refuse("bad_request", "need 'cls' (a vehicle class key)");
      const int cls = world_->catalog.findVehicle(cmd.at("cls").get<std::string>());
      if (cls < 0) return refuse("bad_request", "unknown vehicle class");
      if (!cmd.contains("tonnes") || !cmd.at("tonnes").is_number())
        return refuse("bad_request", "need 'tonnes'");
      const double asked = cmd.at("tonnes").get<double>();
      if (!(asked > 0.0)) return refuse("bad_request", "tonnes must be above zero");
      if (buyer_site == seller_site)
        return refuse("bad_request", "buyer and seller are the same site");
      const VehicleClass& vc = world_->catalog.vehicle_classes[static_cast<size_t>(cls)];

      int buyer_tank = -1, seller_tank = -1;
      for (uint32_t t = 0; t < world_->tanks.size(); ++t) {
        const Tank& tk = world_->tanks[t];
        if (tk.material != static_cast<uint16_t>(mat)) continue;
        if (tk.site.v == static_cast<uint32_t>(buyer_site) &&
            (tk.role == TankRole::Feed || tk.role == TankRole::Both))
          buyer_tank = static_cast<int>(t);
        if (tk.site.v == static_cast<uint32_t>(seller_site) &&
            (tk.role == TankRole::Product || tk.role == TankRole::Both))
          seller_tank = static_cast<int>(t);
      }
      if (buyer_tank < 0)
        return refuse("bad_request", "the buying site has no tank that takes that material");
      if (seller_tank < 0)
        return refuse("bad_request", "the selling site has no tank that sells that material");
      const Tank& buyer = world_->tanks[static_cast<size_t>(buyer_tank)];
      const TankState& bts = state_.tank[static_cast<size_t>(buyer_tank)];
      const TankState& sts = state_.tank[static_cast<size_t>(seller_tank)];

      // Can this class carry this material between these two sites at all,
      // and is there a vehicle to do it? (Priced for a token lot first, so
      // the answer does not depend on stock.)
      constexpr double kSmallestLot = 0.5;  // tonnes: below this nothing is worth a vehicle
      refreshPaths(*world_, state_, paths_);  // a fresh run has not built them yet
      std::vector<TankSignals> now;
      computeSignals(*world_, state_, now);
      const double urgency = now[static_cast<size_t>(buyer_tank)].u;
      int contract_seller = -1;
      for (const World::Contract& c : world_->contracts)
        if (c.buyer.v == static_cast<uint32_t>(buyer_tank)) contract_seller = c.seller.v;
      const std::vector<std::vector<uint32_t>> class_nodes = classNodes(*world_, state_);
      const auto quote = [&](double want) {
        return quoteLot(*world_, state_, paths_, market_params_, class_nodes,
                        static_cast<uint32_t>(buyer_tank), static_cast<uint32_t>(seller_tank),
                        static_cast<size_t>(cls), want, urgency, contract_seller, true);
      };
      const Quote reach = quote(0.0);
      if (!reach.possible) {
        // Possible with every edge open? Then a closure is all that is wrong.
        bool closures = false;
        for (const uint8_t open : state_.edge_open) closures = closures || !open;
        if (closures) {
          const Quote normal =
              routeClosedQuote(*world_, state_, allOpenPaths(*world_), market_params_, class_nodes,
                               static_cast<uint32_t>(buyer_tank), static_cast<uint32_t>(seller_tank),
                               static_cast<size_t>(cls), 0.0, urgency, contract_seller);
          if (normal.possible)
            return refuse("route_closed", blockSentence(Quote::Block::RouteClosed, vc.mode));
        }
        return refuse("not_possible",
                      "that vehicle class cannot carry this material between these two sites");
      }
      if (reach.blocked == Quote::Block::NoVehicles)
        return refuse("no_vehicles", "there are no vehicles of that class");
      if (reach.blocked == Quote::Block::Unreachable)
        return refuse("unreachable", "no vehicle of that class can reach the seller");
      if (reach.blocked == Quote::Block::ExportFill)
        return refuse("export_fill", "the seller is below its export fill line");

      // One vehicle load at most, no more than the seller can spare, no more
      // than the tank can take on top of what is already on its way.
      const double free_t = sts.level_t - sts.reserved_out_t;
      const double room_t = buyer.capacity_t - (bts.level_t + bts.inbound_t);
      if (free_t < kSmallestLot)
        return refuse("seller_short", "the seller has no free stock to sell");
      if (room_t < kSmallestLot)
        return refuse("no_room", "the tank has no room on top of what is inbound");
      const double lot_t = std::min({asked, vc.capacity_t, free_t, room_t});
      if (lot_t < kSmallestLot)
        return refuse("bad_request", "tonnes must be at least half a tonne");
      const Quote q = quote(lot_t);
      if (!q.bookable())
        return refuse("seller_short", "the seller does not have that much free stock");

      const double price = (q.ask + q.bid) / 2.0;
      const double freight_usd = q.lot_t * vc.freight * q.km;
      const uint32_t id = bookLot(*world_, state_, static_cast<uint32_t>(buyer_tank),
                                  static_cast<uint32_t>(seller_tank), static_cast<size_t>(cls),
                                  q.lot_t, price, freight_usd, q.eta_h, q.km, urgency);
      refreshEtas(*world_, state_);
      return json{{"ok", true},
                  {"order",
                   {{"id", id},
                    {"tonnes", q.lot_t},
                    {"requestedTonnes", asked},
                    {"material", world_->catalog.materials[static_cast<size_t>(mat)].key},
                    {"seller", world_->sites[static_cast<size_t>(seller_site)].key},
                    {"site", world_->sites[static_cast<size_t>(buyer_site)].key},
                    {"cls", vc.key},
                    {"priceUsdT", price},
                    {"freightUsd", freight_usd},
                    {"km", q.km},
                    {"etaTick", state_.order[id].eta_tick}}}}
          .dump();
    }

    return json{{"ok", false}, {"error", "unknown command type: " + type}}.dump();
  } catch (const json::exception& e) {
    return json{{"ok", false}, {"error", std::string("bad json: ") + e.what()}}.dump();
  }
}

void Sim::computeKpis(std::vector<double>& out) const {
  out.resize(kKpiCount);
  out[0] = state_.cum_demand_t > 0.0
               ? 1.0 - state_.cum_unmet_t / state_.cum_demand_t
               : 1.0;  // §5.10: perfect service while nothing is demanded
  out[1] = state_.cum_unmet_t;
  out[2] = state_.cum_unmet_usd;
  out[3] = state_.last_production_index;
  out[4] = state_.cum_shutdown_h;
  out[5] = state_.stockouts;
  out[6] = state_.cum_freight_usd;
  out[7] = state_.cum_energy_usd;
}

}  // namespace sim
}  // namespace crx
