#include "world/worldgen/WorldJson.h"

#include <nlohmann/json.hpp>

namespace crx {
namespace worldgen {

namespace {

const char* modeName(Mode m) {
  switch (m) {
    case Mode::Road: return "Road";
    case Mode::River: return "River";
    case Mode::Sea: return "Sea";
    case Mode::Pipeline: return "Pipeline";
  }
  return "Road";
}

const char* roleName(TankRole r) {
  switch (r) {
    case TankRole::Feed: return "Feed";
    case TankRole::Product: return "Product";
    case TankRole::Internal: return "Internal";
    case TankRole::Both: return "Both";
  }
  return "Feed";
}

nlohmann::json idOr(const NodeId& n) { return n.valid() ? nlohmann::json(n.v) : nlohmann::json(nullptr); }

nlohmann::json polylineRef(const Range<uint32_t>& r) {
  return nlohmann::json{{"begin", r.begin}, {"count", r.count}};
}

}  // namespace

nlohmann::json toWorldJson(const GeneratedWorld& w) {
  using nlohmann::json;

  const auto& p = w.params;
  json j;
  j["seed"] = w.seed;
  j["params"] = {
      {"map_w_km", p.map_w_km},
      {"map_h_km", p.map_h_km},
      {"n_cities", p.n_cities},
      {"demand_scale", p.demand_scale},
      {"target_utilisation", p.target_utilisation},
      {"cover_multiplier", p.cover_multiplier},
  };

  j["nodes"] = json::array();
  for (const WNode& n : w.nodes) j["nodes"].push_back(json::array({n.x_km, n.y_km}));

  j["polyline_xy"] = w.polyline_xy;

  j["edges"] = json::array();
  for (const WEdge& e : w.edges) {
    j["edges"].push_back(json{
        {"a", e.a.v}, {"b", e.b.v}, {"mode", modeName(e.mode)},
        {"length_km", e.length_km}, {"speed_kmh", e.speed_kmh},
        {"polyline", polylineRef(e.polyline)},
    });
  }

  j["overseas_node"] = idOr(w.overseas_node);

  j["sites"] = json::array();
  for (const WSite& s : w.sites) {
    j["sites"].push_back(json{
        {"name", s.name}, {"preset", s.preset}, {"variant", s.variant},
        {"x_km", s.x_km}, {"y_km", s.y_km}, {"region", s.region},
        {"node", json::array({idOr(s.node[0]), idOr(s.node[1]), idOr(s.node[2])})},
        {"bays", json::array({static_cast<int>(s.bays[0]), static_cast<int>(s.bays[1]),
                               static_cast<int>(s.bays[2])})},
        {"city", s.city},
        {"tanks", json::array({s.tanks.begin, s.tanks.count})},
        {"processes", json::array({s.processes.begin, s.processes.count})},
    });
  }

  j["tanks"] = json::array();
  for (const WTank& t : w.tanks) {
    j["tanks"].push_back(json{
        {"site", t.site.v}, {"material", t.material}, {"role", roleName(t.role)},
        {"capacity_t", t.capacity_t}, {"target_frac", t.target_frac},
        {"design_in_t_h", t.design_in_t_h}, {"design_out_t_h", t.design_out_t_h},
        {"piped_in", t.piped_in}, {"piped_out", t.piped_out},
    });
  }

  j["processes"] = json::array();
  for (const WProcess& p2 : w.processes) {
    json tank_of = json::array();
    for (const TankId& t : p2.tank_of) tank_of.push_back(t.v);
    j["processes"].push_back(json{
        {"site", p2.site.v}, {"type", p2.type}, {"design_rate_t_h", p2.design_rate_t_h},
        {"units", json::array({p2.units.begin, p2.units.count})},
        {"tank_of", tank_of}, {"schedule", p2.schedule},
    });
  }

  j["units"] = json::array();
  for (const WUnit& u : w.units) {
    j["units"].push_back(json{
        {"process", u.process.v}, {"slot", u.slot}, {"cap_per_train_t_h", u.cap_per_train_t_h},
    });
  }

  j["pipelines"] = json::array();
  for (const WPipeline& pl : w.pipelines) {
    j["pipelines"].push_back(json{
        {"from", pl.from.v}, {"to", pl.to.v}, {"cap_t_h", pl.cap_t_h},
        {"length_km", pl.length_km}, {"polyline", polylineRef(pl.polyline)},
    });
  }

  j["fleet"] = json::array();
  for (const WVehicleSpec& v : w.fleet) {
    j["fleet"].push_back(json{{"cls", v.cls}, {"home", idOr(v.home)}});
  }

  j["contracts"] = json::array();
  for (const WContract& c : w.contracts) {
    j["contracts"].push_back(json{{"buyer", c.buyer.v}, {"seller", c.seller.v}});
  }

  j["schedules"] = w.schedules;

  return j;
}

}  // namespace worldgen
}  // namespace crx
