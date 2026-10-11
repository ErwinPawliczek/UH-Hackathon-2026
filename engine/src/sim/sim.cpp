// Chain Reaction — sim integration implementation.
#include "sim/sim.h"

#include "sim/layout.h"
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
