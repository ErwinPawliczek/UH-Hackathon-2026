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

Mode modeOf(const std::string& s, bool& ok) {
  ok = true;
  if (s == "Road") return Mode::Road;
  if (s == "River") return Mode::River;
  if (s == "Sea") return Mode::Sea;
  if (s == "Pipeline") return Mode::Pipeline;
  ok = false;
  return Mode::Road;
}

TankRole roleOf(const std::string& s, bool& ok) {
  ok = true;
  if (s == "Feed") return TankRole::Feed;
  if (s == "Product") return TankRole::Product;
  if (s == "Internal") return TankRole::Internal;
  if (s == "Both") return TankRole::Both;
  ok = false;
  return TankRole::Feed;
}

NodeId nodeOf(const nlohmann::json& j, bool& ok) {
  ok = true;
  if (j.is_null()) return NodeId{};
  if (!j.is_number_unsigned()) {
    ok = false;
    return NodeId{};
  }
  return NodeId{j.get<uint32_t>()};
}

template <typename T>
Range<T> rangeOf(const nlohmann::json& j, bool& ok) {
  // Accept both encodings: the writer's object form {"begin":B,"count":C}
  // and the array form [B, C].
  if (ok && j.is_object() && j.contains("begin") && j.contains("count") &&
      j["begin"].is_number_unsigned() && j["count"].is_number_unsigned()) {
    return Range<T>{j["begin"].get<uint32_t>(), j["count"].get<uint32_t>()};
  }
  ok = ok && j.is_array() && j.size() == 2 && j[0].is_number_unsigned() && j[1].is_number_unsigned();
  if (!ok) return Range<T>{};
  return Range<T>{j[0].get<uint32_t>(), j[1].get<uint32_t>()};
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

  // Terrain frame (§6.1): sea edge + river feature, so a frozen world file
  // rebuilds the height field the renderer classifies land/water with.
  j["frame"] = json{{"sea_edge", w.sea_edge}, {"river", w.river_xy}};

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

bool fromWorldJson(const std::string& text, GeneratedWorld& out, std::string& error) {
  using nlohmann::json;

  json j;
  try {
    j = json::parse(text);
  } catch (const json::parse_error& e) {
    error = std::string("world json: parse error: ") + e.what();
    return false;
  }

  auto fail = [&error](const char* what) {
    error = std::string("world json: ") + what;
    return false;
  };

  if (!j.is_object() || !j.contains("seed") || !j["seed"].is_number_unsigned())
    return fail("missing unsigned 'seed'");
  out.seed = j["seed"].get<uint64_t>();

  const auto params = j.value("params", json::object());
  if (!params.is_object()) return fail("'params' must be an object");
  out.params.map_w_km = params.value("map_w_km", 600.0);
  out.params.map_h_km = params.value("map_h_km", 400.0);
  out.params.n_cities = params.value("n_cities", 5);
  out.params.demand_scale = params.value("demand_scale", 1.0);
  out.params.target_utilisation = params.value("target_utilisation", 0.88);
  out.params.cover_multiplier = params.value("cover_multiplier", 1.0);

  if (j.contains("frame")) {
    const auto& fr = j["frame"];
    if (!fr.is_object()) return fail("'frame' must be an object");
    out.sea_edge = fr.value("sea_edge", 0);
    if (fr.contains("river")) {
      if (!fr["river"].is_array()) return fail("'frame.river' must be an array");
      out.river_xy = fr["river"].get<std::vector<float>>();
    }
  }

  if (!j.contains("nodes") || !j["nodes"].is_array()) return fail("missing 'nodes' array");
  out.nodes.clear();
  for (const auto& n : j["nodes"]) {
    if (!n.is_array() || n.size() != 2) return fail("node must be [x,y]");
    out.nodes.push_back(WNode{n[0].get<float>(), n[1].get<float>()});
  }

  if (j.contains("polyline_xy")) {
    if (!j["polyline_xy"].is_array()) return fail("'polyline_xy' must be an array");
    out.polyline_xy = j["polyline_xy"].get<std::vector<float>>();
  }

  if (!j.contains("edges") || !j["edges"].is_array()) return fail("missing 'edges' array");
  out.edges.clear();
  for (const auto& e : j["edges"]) {
    if (!e.is_object()) return fail("edge must be an object");
    bool ok = true;
    WEdge edge;
    edge.a = nodeOf(e.at("a"), ok);
    if (!ok) return fail("edge 'a' invalid node id");
    edge.b = nodeOf(e.at("b"), ok);
    if (!ok) return fail("edge 'b' invalid node id");
    edge.mode = modeOf(e.value("mode", "Road"), ok);
    if (!ok) return fail("edge 'mode' unknown");
    edge.length_km = e.value("length_km", 0.f);
    edge.speed_kmh = e.value("speed_kmh", 0.f);
    const auto pl = e.value("polyline", json::object());
    edge.polyline = rangeOf<uint32_t>(pl, ok);
    if (!ok) return fail("edge 'polyline' must be [begin,count]");
    out.edges.push_back(edge);
  }

  if (j.contains("overseas_node")) {
    bool ok = true;
    out.overseas_node = nodeOf(j["overseas_node"], ok);
    if (!ok) return fail("'overseas_node' invalid");
  }

  if (!j.contains("sites") || !j["sites"].is_array()) return fail("missing 'sites' array");
  out.sites.clear();
  for (const auto& s : j["sites"]) {
    if (!s.is_object()) return fail("site must be an object");
    WSite ws;
    ws.name = s.value("name", "");
    ws.preset = s.value("preset", "");
    ws.variant = s.value("variant", "");
    ws.x_km = s.value("x_km", 0.f);
    ws.y_km = s.value("y_km", 0.f);
    ws.region = static_cast<uint16_t>(s.value("region", 0));
    const auto node = s.value("node", json::array());
    if (!node.is_array() || node.size() != 3) return fail("site 'node' must be [road,river,sea]");
    for (int i = 0; i < 3; ++i) {
      bool ok = true;
      ws.node[i] = nodeOf(node[i], ok);
      if (!ok) return fail("site 'node' entry invalid");
    }
    const auto bays = s.value("bays", json::array());
    if (!bays.is_array() || bays.size() != 3) return fail("site 'bays' must be 3 entries");
    for (int i = 0; i < 3; ++i) {
      if (!bays[i].is_number_integer()) return fail("site 'bays' entry invalid");
      const int b = bays[i].get<int>();
      if (b < 0 || b > 255) return fail("site 'bays' entry out of range");
      ws.bays[i] = static_cast<uint8_t>(b);
    }
    if (!s.contains("city") || !s["city"].is_number_integer()) return fail("site 'city' invalid");
    ws.city = s["city"].get<int>();
    bool ok = true;
    const auto tanks = s.value("tanks", json::array());
    ws.tanks = rangeOf<TankId>(tanks, ok);
    if (!ok) return fail("site 'tanks' must be [begin,count]");
    const auto procs = s.value("processes", json::array());
    ws.processes = rangeOf<ProcessId>(procs, ok);
    if (!ok) return fail("site 'processes' must be [begin,count]");
    out.sites.push_back(ws);
  }

  if (!j.contains("tanks") || !j["tanks"].is_array()) return fail("missing 'tanks' array");
  out.tanks.clear();
  for (const auto& t : j["tanks"]) {
    if (!t.is_object()) return fail("tank must be an object");
    WTank wt;
    if (!t.contains("site") || !t["site"].is_number_unsigned()) return fail("tank 'site' invalid");
    wt.site = SiteId{t["site"].get<uint32_t>()};
    wt.material = t.value("material", "");
    bool ok = true;
    wt.role = roleOf(t.value("role", "Feed"), ok);
    if (!ok) return fail("tank 'role' unknown");
    wt.capacity_t = t.value("capacity_t", 0.0);
    wt.target_frac = t.value("target_frac", 0.0);
    wt.design_in_t_h = t.value("design_in_t_h", 0.0);
    wt.design_out_t_h = t.value("design_out_t_h", 0.0);
    wt.piped_in = t.value("piped_in", false);
    wt.piped_out = t.value("piped_out", false);
    out.tanks.push_back(wt);
  }

  if (!j.contains("processes") || !j["processes"].is_array()) return fail("missing 'processes' array");
  out.processes.clear();
  for (const auto& p2 : j["processes"]) {
    if (!p2.is_object()) return fail("process must be an object");
    WProcess wp;
    if (!p2.contains("site") || !p2["site"].is_number_unsigned()) return fail("process 'site' invalid");
    wp.site = SiteId{p2["site"].get<uint32_t>()};
    wp.type = p2.value("type", "");
    wp.design_rate_t_h = p2.value("design_rate_t_h", 0.0);
    const auto units = p2.value("units", json::array());
    bool ok = true;
    wp.units = rangeOf<UnitId>(units, ok);
    if (!ok) return fail("process 'units' must be [begin,count]");
    if (p2.contains("tank_of")) {
      if (!p2["tank_of"].is_array()) return fail("process 'tank_of' must be an array");
      for (const auto& t : p2["tank_of"]) {
        if (!t.is_number_unsigned()) return fail("process 'tank_of' entry invalid");
        wp.tank_of.push_back(TankId{t.get<uint32_t>()});
      }
    }
    if (p2.contains("schedule")) {
      if (!p2["schedule"].is_number_unsigned()) return fail("process 'schedule' invalid");
      wp.schedule = p2["schedule"].get<uint32_t>();
    }
    if (p2.contains("mode_share")) {
      if (!p2["mode_share"].is_array()) return fail("process 'mode_share' must be an array");
      wp.mode_share = p2["mode_share"].get<std::vector<double>>();
    }
    out.processes.push_back(wp);
  }

  if (j.contains("units")) {
    if (!j["units"].is_array()) return fail("'units' must be an array");
    out.units.clear();
    for (const auto& u : j["units"]) {
      if (!u.is_object()) return fail("unit must be an object");
      WUnit wu;
      if (!u.contains("process") || !u["process"].is_number_unsigned())
        return fail("unit 'process' invalid");
      wu.process = ProcessId{u["process"].get<uint32_t>()};
      if (!u.contains("slot") || !u["slot"].is_number_integer()) return fail("unit 'slot' invalid");
      wu.slot = u["slot"].get<uint8_t>();
      wu.cap_per_train_t_h = u.value("cap_per_train_t_h", 0.0);
      out.units.push_back(wu);
    }
  }

  if (j.contains("pipelines")) {
    if (!j["pipelines"].is_array()) return fail("'pipelines' must be an array");
    out.pipelines.clear();
    for (const auto& pl : j["pipelines"]) {
      if (!pl.is_object()) return fail("pipeline must be an object");
      WPipeline wpl;
      if (!pl.contains("from") || !pl["from"].is_number_unsigned()) return fail("pipeline 'from' invalid");
      wpl.from = TankId{pl["from"].get<uint32_t>()};
      if (!pl.contains("to") || !pl["to"].is_number_unsigned()) return fail("pipeline 'to' invalid");
      wpl.to = TankId{pl["to"].get<uint32_t>()};
      wpl.cap_t_h = pl.value("cap_t_h", 0.0);
      wpl.length_km = pl.value("length_km", 0.f);
      const auto polyline = pl.value("polyline", json::object());
      bool ok = true;
      wpl.polyline = rangeOf<uint32_t>(polyline, ok);
      if (!ok) return fail("pipeline 'polyline' must be [begin,count]");
      out.pipelines.push_back(wpl);
    }
  }

  if (j.contains("fleet")) {
    if (!j["fleet"].is_array()) return fail("'fleet' must be an array");
    out.fleet.clear();
    for (const auto& v : j["fleet"]) {
      if (!v.is_object()) return fail("fleet entry must be an object");
      WVehicleSpec wv;
      wv.cls = v.value("cls", "");
      bool ok = true;
      wv.home = nodeOf(v.value("home", json()), ok);
      if (!ok) return fail("fleet 'home' invalid node id");
      out.fleet.push_back(wv);
    }
  }

  if (j.contains("contracts")) {
    if (!j["contracts"].is_array()) return fail("'contracts' must be an array");
    out.contracts.clear();
    for (const auto& c : j["contracts"]) {
      if (!c.is_object()) return fail("contract must be an object");
      WContract wc;
      if (!c.contains("buyer") || !c["buyer"].is_number_unsigned()) return fail("contract 'buyer' invalid");
      wc.buyer = TankId{c["buyer"].get<uint32_t>()};
      if (!c.contains("seller") || !c["seller"].is_number_unsigned()) return fail("contract 'seller' invalid");
      wc.seller = TankId{c["seller"].get<uint32_t>()};
      out.contracts.push_back(wc);
    }
  }

  if (j.contains("schedules")) {
    if (!j["schedules"].is_array()) return fail("'schedules' must be an array");
    out.schedules.clear();
    for (const auto& s : j["schedules"]) {
      if (!s.is_array()) return fail("schedule must be an array");
      out.schedules.push_back(s.get<std::vector<float>>());
    }
  }

  return true;
}

}  // namespace worldgen
}  // namespace crx
