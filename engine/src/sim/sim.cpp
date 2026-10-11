// Chain Reaction — sim integration implementation.
#include "sim/sim.h"

#include "sim/sixsite.h"
#include "world/worldgen/HandDrawn.h"
#include "world/worldgen/WorldJson.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <fstream>
#include <sstream>

using json = nlohmann::json;

namespace crx {
namespace sim {

std::unique_ptr<Sim> Sim::create(uint64_t seed, std::string& error) {
  auto world = std::make_shared<World>();
  if (!buildSixSiteWorld(seed, *world, error)) return nullptr;
  world->seed = seed;
  return fromWorld(world, error);
}

std::unique_ptr<Sim> Sim::createGenerated(uint64_t seed, std::string& error) {
  return createGenerated(seed, worldgen::GenParams{}, error);
}

std::unique_ptr<Sim> Sim::createGenerated(uint64_t seed, const worldgen::GenParams& params,
                                          std::string& error) {
  crx::Catalog catalog;
  if (!loadCatalogFromDir(CRX_DATA_DIR, catalog, error)) return nullptr;
  const crx::worldgen::CatalogView view = crx::worldgen::makeCatalogView(catalog);
  // Runtime session creation performs NO warm-up (PR #25 plan step 2): the
  // real-Sim gate runs in tests only; structurally feasible worlds build as-is.
  const crx::worldgen::GenResult r = crx::worldgen::generateWorld(seed, params, view);
  if (!r.ok) {
    error = "world generation rejected seed " + std::to_string(seed) + ":";
    for (const std::string& e : r.gate_errors) error += "\n  - " + e;
    return nullptr;
  }
  auto world = std::make_shared<World>();
  if (!buildGeneratedWorld(catalog, r.world, *world, error)) return nullptr;
  world->seed = r.world.seed;
  return fromWorld(world, error);
}

// The default session world: the frozen gulf-basin file (engine/data/catalog/
// gulf-basin.json), frozen from generator seed 709 and hand-balanced. No
// generation at runtime — the file is the world (sixsite pattern).
std::unique_ptr<Sim> Sim::createHandDrawn(std::string& error) {
  crx::Catalog catalog;
  if (!loadCatalogFromDir(CRX_DATA_DIR, catalog, error)) return nullptr;
  crx::worldgen::GeneratedWorld gen;
  std::vector<crx::worldgen::HandDrawnGap> gaps;
  const std::string path = std::string(CRX_DATA_DIR) + "/worlds/erwin-world-v1.json";
  if (!crx::worldgen::loadHandDrawnWorld(path, crx::worldgen::makeCatalogView(catalog), gen, gaps,
                                         error))
    return nullptr;
  auto world = std::make_shared<World>();
  if (!buildGeneratedWorld(catalog, gen, *world, error)) return nullptr;
  world->seed = gen.seed;  // 0: the drawn world is seedless and deterministic
  return fromWorld(world, error);
}

std::unique_ptr<Sim> Sim::fromWorld(std::shared_ptr<const World> world, std::string& error) {
  (void)error;  // cannot fail: the world is already built and validated
  auto sim = std::unique_ptr<Sim>(new Sim());
  sim->world_ = std::move(world);
  sim->state_.rng = Rng(sim->world_->seed);

  // Initial state (§4.4): tanks at their target level, all rates cold at
  // zero — the run ramps up to design through the normal control path, so
  // the first day shows a physically clean start-up.
  const World& w = *sim->world_;
  sim->state_.tank.resize(w.tanks.size());
  for (size_t t = 0; t < w.tanks.size(); ++t) {
    TankState& ts = sim->state_.tank[t];
    ts.level_t = w.tanks[t].target_frac * w.tanks[t].capacity_t;
    ts.inbound_t = 0;
    ts.reserved_out_t = 0;
    ts.lead_time_h = 24;
    ts.pickup_gap_h = 4;
    ts.caution = 1;
  }
  sim->state_.proc.resize(w.processes.size());
  sim->state_.unit.resize(w.units.size());
  sim->state_.pipe_flow_t_h.assign(w.pipelines.size(), 0.0);
  sim->state_.ledger.resize(w.sites.size());
  sim->state_.sink_starved.assign(w.processes.size(), 0);
  sim->state_.rate_override.assign(w.processes.size(), -1.0);
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
  sim->signals.assign(w.tanks.size(), TankSignals{});
  sim->rec_.tank_fill.resize(w.tanks.size());
  sim->rec_.proc_rate.resize(w.processes.size());
  return sim;
}

std::unique_ptr<Sim> Sim::createFromConfig(const char* config_json, std::string& error) {
  uint64_t seed = 42;  // §7.1: NULL or missing seed = defaults
  bool adaptation_override = true;
  std::string world_kind = "default";  // hand-drawn world unless told otherwise
  bool have_gen = false;
  worldgen::GenParams params;
  bool have_seed = false;  // config-key flag
  if (config_json != nullptr && config_json[0] != '\0') {
    try {
      const json cfg = json::parse(config_json);
      for (auto it = cfg.begin(); it != cfg.end(); ++it) {
        if (it.key() == "seed") {
          if (!it.value().is_number_unsigned()) {
            error = "config seed must be a non-negative integer";
            return nullptr;
          }
          it.value().get_to(seed);
          have_seed = true;
        } else if (it.key() == "adaptation") {
          // §5.8 global switch: false gives comparison runs with all three
          // learned parameters frozen at their world initials.
          if (!it.value().is_boolean()) {
            error = "config adaptation must be a boolean";
            return nullptr;
          }
          adaptation_override = it.value().get<bool>();
        } else if (it.key() == "world") {
          if (!it.value().is_string()) {
            error = "config world must be a string";
            return nullptr;
          }
          world_kind = it.value().get<std::string>();
          if (world_kind != "default" && world_kind != "sixsite" &&
              world_kind != "generator") {
            error = "config world must be \"default\" (hand-drawn), \"sixsite\", or \"generator\"";
            return nullptr;
          }
        } else if (it.key() == "preset") {
          // Named presets were dropped with the frozen-world experiment.
          error = "config key \"preset\" is not supported; the default world is the "
                  "hand-drawn layout (use \"world\": \"sixsite\" or \"generator\")";
          return nullptr;
        } else if (it.key() == "gen") {
          if (!it.value().is_object()) {
            error = "config gen must be an object";
            return nullptr;
          }
          have_gen = true;
          for (auto g = it.value().begin(); g != it.value().end(); ++g) {
            bool ok = true;
            const std::string& k = g.key();
            const json& v = g.value();
            if (k == "n_cities" || k == "max_gate_attempts") {
              if (v.is_number_integer())
                ok = v.get<int>() >= 1;
              else
                ok = false;
              if (ok && k == "n_cities") params.n_cities = v.get<int>();
              if (ok && k == "max_gate_attempts") params.max_gate_attempts = v.get<int>();
            } else if (k == "map_w_km") {
              ok = v.is_number() && v.get<double>() > 0;
              if (ok) params.map_w_km = v.get<double>();
            } else if (k == "map_h_km") {
              ok = v.is_number() && v.get<double>() > 0;
              if (ok) params.map_h_km = v.get<double>();
            } else if (k == "demand_scale") {
              ok = v.is_number() && v.get<double>() > 0;
              if (ok) params.demand_scale = v.get<double>();
            } else if (k == "target_utilisation") {
              ok = v.is_number() && v.get<double>() > 0 && v.get<double>() <= 1;
              if (ok) params.target_utilisation = v.get<double>();
            } else if (k == "cover_multiplier") {
              ok = v.is_number() && v.get<double>() > 0;
              if (ok) params.cover_multiplier = v.get<double>();
            } else if (k == "top_population_m") {
              ok = v.is_number() && v.get<double>() > 0;
              if (ok) params.top_population_m = v.get<double>();
            } else if (k == "rank_size_exponent") {
              ok = v.is_number() && v.get<double>() > 0;
              if (ok) params.rank_size_exponent = v.get<double>();
            } else if (k == "city_min_spacing_km") {
              ok = v.is_number() && v.get<double>() > 0;
              if (ok) params.city_min_spacing_km = v.get<double>();
            } else if (k == "cracker_cluster_km") {
              ok = v.is_number() && v.get<double>() > 0;
              if (ok) params.cracker_cluster_km = v.get<double>();
            } else if (k == "sea_leg_days") {
              ok = v.is_number() && v.get<double>() > 0;
              if (ok) params.sea_leg_days = v.get<double>();
            } else if (k == "ship_speed_kmh") {
              ok = v.is_number() && v.get<double>() > 0;
              if (ok) params.ship_speed_kmh = v.get<double>();
            } else {
              ok = false;
            }
            if (!ok) {
              error = "config gen.\"" + k + "\" is not a supported generation override";
              return nullptr;
            }
          }
        } else {
          // §7.1: unknown keys are rejected so typos do not silently default.
          error = "config key \"" + it.key() + "\" is not supported (only \"seed\", "
                  "\"adaptation\", \"world\", \"preset\", \"gen\")";
          return nullptr;
        }
      }
    } catch (const json::exception& e) {
      error = std::string("bad config json: ") + e.what();
      return nullptr;
    }
  }
  if (world_kind == "sixsite" && have_gen) {
    error = "config gen applies only to the generator world (\"world\": \"generator\")";
    return nullptr;
  }
  if (world_kind != "generator" && have_gen) {
    error = "config gen applies only to the generator world (\"world\": \"generator\")";
    return nullptr;
  }
  std::unique_ptr<Sim> sim;
  if (world_kind == "sixsite") {
    sim = create(seed, error);
  } else if (world_kind == "generator") {
    // Development path for arbitrary generator seeds (unsupported for demos
    // by design — README); requires an explicit world choice.
    if (!have_seed) {
      error = "config world \"generator\" requires a seed";
      return nullptr;
    }
    sim = have_gen ? createGenerated(seed, params, error) : createGenerated(seed, error);
  } else {
    // Default (and explicit "default"): the hand-drawn layout — deterministic
    // by construction; a config seed does not apply to it.
    sim = createHandDrawn(error);
  }
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
    stepPipelines(w, state_);
    stepProduction(w, state_, control, production, rec_);
    // M2 logistics (§5.1 ordering): procurement and dispatch run hourly,
    // transport and adaptation every tick.
    if (state_.tick % 4 == 0) {
      ProcurementStats pstats;
      stepProcurement(w, state_, paths_, signals, market_params_, pstats, rec_);
      stepDispatch(w, state_, paths_, rec_);
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
