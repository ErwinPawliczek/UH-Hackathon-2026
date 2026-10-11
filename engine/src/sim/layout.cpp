// Chain Reaction — a redrawn map on top of a named world: implementation.
#include "sim/layout.h"

#include "sim/routes.h"
#include "sim/sim.h"
#include "sim/window.h"
#include "sim/words.h"
#include "sim/worldfile.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <map>
#include <set>

namespace crx {
namespace sim {

namespace {

using nlohmann::json;

constexpr double kAttachKm = 12.0;     // a berth needs a lane this close (worldfile.cpp)
constexpr double kPipeEndKm = 15.0;    // a pipeline end must be this close to its site
constexpr size_t kMaxPoints = 20000;
const char* const kModes[kModeCount] = {"road", "river", "sea"};
const char* const kLaneWords[kModeCount] = {"a road", "a river lane", "a sea lane"};
const char* const kByWords[kModeCount] = {"by road", "by river", "by sea"};

struct Xy {
  double x = 0, y = 0;
};

bool readPoint(const json& p, Xy& out) {
  if (!p.is_array() || p.size() < 2 || !p[0].is_number() || !p[1].is_number()) return false;
  out = {p[0].get<double>(), p[1].get<double>()};
  return std::isfinite(out.x) && std::isfinite(out.y);
}

struct Merge {
  json doc;                         // the world file with the layout laid over it
  std::vector<std::string> names;   // site names by index, for messages
  std::vector<int> ids;             // layout id by site index
};

void add(std::vector<LayoutIssue>& list, int site, const std::string& mode, const std::string& text) {
  list.push_back({site, mode, text});
}

// Lays the layout over the world file's document. Fills report.errors with
// everything wrong that can be told without building the world.
bool mergeLayout(const json& base, const json& layout, Merge& m, LayoutReport& report) {
  std::vector<LayoutIssue>& errors = report.errors;
  m.doc = base;
  if (!layout.is_object()) {
    add(errors, 0, "", "The layout is not a map: it must be one JSON object");
    return false;
  }
  const auto number = [&](const char* key, double fallback) {
    return layout.contains(key) && layout[key].is_number() ? layout[key].get<double>() : fallback;
  };
  const double w_km = number("wKm", base.value("wKm", 600.0));
  const double h_km = number("hKm", base.value("hKm", 400.0));
  const double cell_km = number("cellKm", base.value("cellKm", 10.0));
  if (!(w_km >= 50 && w_km <= 5000 && h_km >= 50 && h_km <= 5000)) {
    add(errors, 0, "", "The map must be between 50 and 5,000 km on each side");
    return false;
  }
  if (!(cell_km >= 1 && cell_km <= 100)) {
    add(errors, 0, "", "Water cells must be between 1 and 100 km across");
    return false;
  }
  m.doc["wKm"] = w_km;
  m.doc["hKm"] = h_km;
  m.doc["cellKm"] = cell_km;
  // Lanes may run a little past the edge (a sea lane leaving the map does);
  // anything further out is a mistake.
  constexpr double kEdgeKm = 60.0;
  const auto onMap = [&](const Xy& p) {
    return p.x >= -kEdgeKm && p.y >= -kEdgeKm && p.x <= w_km + kEdgeKm && p.y <= h_km + kEdgeKm;
  };

  // Water: a set of cells, also needed to tell whether a site stands in it.
  std::set<std::pair<long, long>> wet;
  json water = json::array();
  if (layout.contains("water")) {
    if (!layout["water"].is_array()) {
      add(errors, 0, "", "The water in the layout must be a list of cells");
    } else if (layout["water"].size() > 400000) {
      add(errors, 0, "", "The layout has too many water cells");
    } else {
      for (const json& cell : layout["water"]) {
        Xy c;
        if (!readPoint(cell, c)) continue;
        wet.insert({std::lround(std::floor(c.x)), std::lround(std::floor(c.y))});
        water.push_back({std::floor(c.x), std::floor(c.y)});
      }
    }
  }
  m.doc["water"] = water;
  const auto inWater = [&](const Xy& p) {
    return wet.count({std::lround(std::floor(p.x / cell_km)), std::lround(std::floor(p.y / cell_km))}) > 0;
  };

  // Sites: the world's sites in order are ids 1, 2, 3, ...
  json& sites = m.doc["sites"];
  const size_t n = sites.size();
  std::vector<Xy> pos(n);
  std::vector<uint8_t> have(n, 0);
  for (size_t i = 0; i < n; ++i) {
    m.names.push_back(sites[i].value("name", sites[i].value("key", std::string("site"))));
    m.ids.push_back(static_cast<int>(i) + 1);
    pos[i] = {sites[i].value("x", 0.0), sites[i].value("y", 0.0)};
  }
  if (!layout.contains("sites") || !layout["sites"].is_array()) {
    add(errors, 0, "", "The layout has no sites");
    return false;
  }
  for (const json& s : layout["sites"]) {
    if (!s.is_object() || !s.contains("id") || !s["id"].is_number_integer()) {
      add(errors, 0, "", "A site in the layout has no id");
      continue;
    }
    const long long id = s["id"].get<long long>();
    if (id < 1 || id > static_cast<long long>(n)) {
      add(errors, 0, "", "The layout has a site with id " + std::to_string(id) +
                             ", which this world does not have (ids run from 1 to " +
                             std::to_string(n) + ")");
      continue;
    }
    const size_t i = static_cast<size_t>(id - 1);
    if (have[i]) {
      add(errors, static_cast<int>(id), "", m.names[i] + " (site " + std::to_string(id) +
                                                ") is in the layout twice");
      continue;
    }
    have[i] = 1;
    if (s.contains("preset") && s["preset"].is_string() && sites[i].contains("preset") &&
        s["preset"] != sites[i]["preset"]) {
      add(errors, static_cast<int>(id), "",
          "Site " + std::to_string(id) + " is the world's " + m.names[i] +
              " and cannot be changed into another kind of site");
      continue;
    }
    if (s.contains("name") && s["name"].is_string()) {
      const std::string name = s["name"].get<std::string>();
      if (!name.empty() && name.size() <= 60) {
        m.names[i] = name;
        sites[i]["name"] = name;
      }
    }
    Xy p;
    if (!s.contains("x") || !s.contains("y") || !s["x"].is_number() || !s["y"].is_number()) {
      add(errors, static_cast<int>(id), "", m.names[i] + " has no position");
      continue;
    }
    p = {s["x"].get<double>(), s["y"].get<double>()};
    if (!std::isfinite(p.x) || !std::isfinite(p.y) || p.x < 0 || p.y < 0 || p.x > w_km || p.y > h_km) {
      add(errors, static_cast<int>(id), "", m.names[i] + " is off the map");
      continue;
    }
    if (inWater(p)) add(errors, static_cast<int>(id), "", m.names[i] + " is on water; move it onto land");
    pos[i] = p;
    sites[i]["x"] = p.x;
    sites[i]["y"] = p.y;
  }
  for (size_t i = 0; i < n; ++i)
    if (!have[i])
      add(errors, static_cast<int>(i) + 1, "",
          m.names[i] + " (site " + std::to_string(i + 1) + ") is missing from the layout");

  // Network strips.
  std::array<std::vector<Xy>, kModeCount> vertices;
  json network = json::array();
  size_t points = 0;
  if (layout.contains("network") && layout["network"].is_array()) {
    for (const json& strip : layout["network"]) {
      const std::string mode = strip.is_object() ? strip.value("mode", std::string()) : std::string();
      int mi = -1;
      for (int k = 0; k < kModeCount; ++k)
        if (mode == kModes[k]) mi = k;
      if (mi < 0 && mode != "rail") {
        add(errors, 0, "", "A strip in the layout is neither a road, a river lane, a sea lane nor a railway");
        continue;
      }
      const std::string what = mi < 0 ? "A railway" : mi == 0 ? "A road" : mi == 1 ? "A river lane" : "A sea lane";
      const std::string mode_out = mi < 0 ? "" : kModes[mi];
      if (!strip.contains("points") || !strip["points"].is_array() || strip["points"].size() < 2) {
        add(errors, 0, mode_out, what + " has fewer than 2 points; draw it again or delete it");
        continue;
      }
      bool good = true, off = false;
      for (const json& p : strip["points"]) {
        Xy q;
        if (!readPoint(p, q)) {
          good = false;
          break;
        }
        off = off || !onMap(q);
        if (mi >= 0) vertices[static_cast<size_t>(mi)].push_back(q);
        ++points;
      }
      if (!good) {
        add(errors, 0, mode_out, what + " has a point that is not a position");
        continue;
      }
      if (off) {
        add(errors, 0, mode_out, what + " runs far off the map");
        continue;
      }
      network.push_back({{"mode", mode}, {"points", strip["points"]}});
    }
  }
  m.doc["network"] = network;

  // Pipelines: the world's own, each drawn by the layout's matching connection.
  std::map<std::string, size_t> index_of;
  for (size_t i = 0; i < n; ++i) index_of[sites[i].value("key", std::string())] = i;
  std::vector<uint8_t> used;
  const json empty = json::array();
  const json& conns = layout.contains("connections") && layout["connections"].is_array()
                          ? layout["connections"] : empty;
  used.assign(conns.size(), 0);
  for (json& pipe : m.doc["pipelines"]) {
    const std::string material = pipe.value("material", std::string());
    std::string from = pipe.value("from", std::string()), to = pipe.value("to", std::string());
    from = from.substr(0, from.find('/'));
    to = to.substr(0, to.find('/'));
    if (!index_of.count(from) || !index_of.count(to)) continue;  // the world file's own business
    const size_t a = index_of[from], b = index_of[to];
    const std::string label = "The " + materialWord(material) + " pipeline from " + m.names[a] +
                              " to " + m.names[b];
    const json* found = nullptr;
    for (size_t c = 0; c < conns.size(); ++c) {
      const json& cn = conns[c];
      if (used[c] || !cn.is_object() || !cn.contains("from") || !cn.contains("to")) continue;
      if (!cn["from"].is_number_integer() || !cn["to"].is_number_integer()) continue;
      if (cn["from"].get<long long>() != static_cast<long long>(a) + 1 ||
          cn["to"].get<long long>() != static_cast<long long>(b) + 1)
        continue;
      if (cn.value("material", std::string()) != material) continue;
      used[c] = 1;
      found = &cn;
      break;
    }
    if (found == nullptr) {
      add(errors, static_cast<int>(a) + 1, "", label + " is missing; draw it again");
      continue;
    }
    std::vector<Xy> pts;
    bool good = found->contains("points") && (*found)["points"].is_array();
    if (good)
      for (const json& p : (*found)["points"]) {
        Xy q;
        if (!readPoint(p, q) || !onMap(q)) {
          good = false;
          break;
        }
        pts.push_back(q);
      }
    points += pts.size();
    if (!good || pts.size() < 2) {
      add(errors, static_cast<int>(a) + 1, "", label + " has fewer than 2 points on the map");
      continue;
    }
    if (std::hypot(pts.front().x - pos[a].x, pts.front().y - pos[a].y) > kPipeEndKm ||
        std::hypot(pts.back().x - pos[b].x, pts.back().y - pos[b].y) > kPipeEndKm) {
      add(errors, static_cast<int>(a) + 1, "",
          label + " must start at " + m.names[a] + " and end at " + m.names[b]);
      continue;
    }
    pts.front() = pos[a];  // the ends sit exactly on the two sites
    pts.back() = pos[b];
    json out = json::array();
    for (const Xy& p : pts) out.push_back({p.x, p.y});
    pipe["points"] = out;
  }
  for (size_t c = 0; c < conns.size(); ++c)
    if (!used[c])
      add(errors, 0, "", "The layout has a pipeline this world does not have; delete it");
  if (points > kMaxPoints)
    add(errors, 0, "", "The layout has " + std::to_string(points) + " points; the limit is " +
                           std::to_string(kMaxPoints));

  // Berths: a site that loads trucks, barges or ships needs its lane nearby.
  for (size_t i = 0; i < n && have[i]; ++i) {
    const json bays = sites[i].value("bays", json::object());
    for (int k = 0; k < kModeCount; ++k) {
      if (!bays.is_object() || bays.value(kModes[k], 0.0) <= 0) continue;
      bool near = false;
      for (const Xy& v : vertices[static_cast<size_t>(k)])
        near = near || std::hypot(v.x - pos[i].x, v.y - pos[i].y) <= kAttachKm;
      if (!near)
        add(errors, static_cast<int>(i) + 1, kModes[k],
            m.names[i] + " needs " + kLaneWords[k] + " within 12 km");
    }
  }
  return errors.empty();
}

// Mean route distance between every pair of sites on a mode's network, and
// (through `islands`) the sites the largest connected piece does not reach.
struct ModeReach {
  double mean_km = 0;
  std::vector<std::pair<uint32_t, uint32_t>> cut;  // (site left out, a site in the main piece)
};

ModeReach reachOf(const World& w, int mode) {
  State open;
  open.edge_open.assign(w.edges.size(), 1);
  PathCache paths;
  refreshPaths(w, open, paths);
  const crx::Mode md = mode == 0 ? crx::Mode::Road : mode == 1 ? crx::Mode::River : crx::Mode::Sea;
  std::vector<uint32_t> on;
  for (uint32_t s = 0; s < w.sites.size(); ++s)
    if (w.sites[s].node[static_cast<size_t>(mode)] != kNoNode) on.push_back(s);
  ModeReach r;
  if (on.size() < 2) return r;
  const auto km = [&](uint32_t a, uint32_t b) {
    return travelKm(w, paths, md, w.sites[a].node[static_cast<size_t>(mode)],
                    w.sites[b].node[static_cast<size_t>(mode)]);
  };
  // The main piece: the site that reaches the most others, and those it reaches.
  uint32_t hub = on[0];
  size_t best = 0;
  for (const uint32_t a : on) {
    size_t reach = 0;
    for (const uint32_t b : on) reach += std::isfinite(km(a, b)) ? 1 : 0;
    if (reach > best) {
      best = reach;
      hub = a;
    }
  }
  double sum = 0;
  size_t pairs = 0;
  for (size_t i = 0; i < on.size(); ++i) {
    if (!std::isfinite(km(hub, on[i]))) {
      // Name a trading partner in the main piece if there is one.
      uint32_t partner = hub;
      bool found = false;
      for (const uint32_t b : on) {
        if (found || !std::isfinite(km(hub, b))) continue;
        for (uint32_t ta = w.sites[on[i]].tanks.begin; ta < rangeEnd(w.sites[on[i]].tanks) && !found; ++ta)
          for (uint32_t tb = w.sites[b].tanks.begin; tb < rangeEnd(w.sites[b].tanks) && !found; ++tb) {
            const Tank& x = w.tanks[ta];
            const Tank& y = w.tanks[tb];
            if (x.material != y.material || x.piped_in || y.piped_in) continue;
            const bool x_buys = x.role == TankRole::Feed, y_sells = y.role == TankRole::Product;
            const bool y_buys = y.role == TankRole::Feed, x_sells = x.role == TankRole::Product;
            if ((x_buys && y_sells) || (y_buys && x_sells)) {
              partner = b;
              found = true;
            }
          }
      }
      r.cut.emplace_back(on[i], partner);
      continue;
    }
    for (size_t j = i + 1; j < on.size(); ++j) {
      const double d = km(on[i], on[j]);
      if (!std::isfinite(d)) continue;
      sum += d;
      ++pairs;
    }
  }
  r.mean_km = pairs > 0 ? sum / static_cast<double>(pairs) : 0;
  return r;
}

bool isWaterAt(const World& w, double x, double y) {
  if (w.water_cell_km <= 0) return false;
  const long c = std::lround(std::floor(x / w.water_cell_km)), r = std::lround(std::floor(y / w.water_cell_km));
  if (c < 0 || r < 0 || c >= static_cast<long>(w.water_cols) || r >= static_cast<long>(w.water_rows))
    return false;
  return w.water[static_cast<size_t>(r) * w.water_cols + static_cast<size_t>(c)] != 0;
}

}  // namespace

bool buildWorldWithLayout(const std::string& world_name, const std::string& layout_json,
                          uint64_t seed, World& out, LayoutReport& report) {
  report = LayoutReport{};
  try {
    if (layout_json.size() > kMaxLayoutBytes) {
      add(report.errors, 0, "", "The layout is too large (over 1 MB)");
      return false;
    }
    if (world_name.empty() || world_name == "sixsite") {
      add(report.errors, 0, "", "A layout needs a named world to lay over");
      return false;
    }
    std::string text, error;
    if (!readNamedWorldText(world_name, text, error)) {
      add(report.errors, 0, "", "There is no world called " + world_name);
      return false;
    }
    const json base = json::parse(text, nullptr, false);
    const json layout = json::parse(layout_json, nullptr, false);
    if (base.is_discarded() || !base.is_object()) {
      add(report.errors, 0, "", "The world file could not be read");
      return false;
    }
    if (layout.is_discarded()) {
      add(report.errors, 0, "", "The layout is not valid JSON");
      return false;
    }
    Merge m;
    if (!mergeLayout(base, layout, m, report)) return false;

    World built;
    if (!buildWorldFromJson(world_name, m.doc.dump(), seed, built, error)) {
      add(report.errors, 0, "", "The world could not be built from this map: " + error);
      return false;
    }
    // Every mode's sites must reach each other: nothing can trade across a gap.
    std::array<ModeReach, kModeCount> reach;
    for (int k = 0; k < kModeCount; ++k) {
      reach[static_cast<size_t>(k)] = reachOf(built, k);
      for (const auto& cut : reach[static_cast<size_t>(k)].cut)
        add(report.errors, static_cast<int>(cut.first) + 1, kModes[k],
            m.names[cut.first] + " cannot be reached " + kByWords[k] + " from " + m.names[cut.second]);
    }
    if (!report.errors.empty()) return false;

    // Fleet: scale each class by how much longer or shorter its mode's trips
    // are than on the world as shipped (mean route distance between every
    // pair of sites on that mode), between half and three times, never
    // below one vehicle. Homes stay where they are.
    World shipped;
    std::array<double, kModeCount> ratio{1.0, 1.0, 1.0};
    if (buildWorldFromJson(world_name, text, seed, shipped, error)) {
      bool changed = false;
      for (int k = 0; k < kModeCount; ++k) {
        const double was = reachOf(shipped, k).mean_km, now = reach[static_cast<size_t>(k)].mean_km;
        if (was > 0 && now > 0) ratio[static_cast<size_t>(k)] = std::clamp(now / was, 0.5, 3.0);
        changed = changed || std::fabs(ratio[static_cast<size_t>(k)] - 1.0) > 1e-9;
      }
      if (changed && m.doc.contains("fleet") && m.doc["fleet"].is_array()) {
        for (json& f : m.doc["fleet"]) {
          const int cls = built.catalog.findVehicle(f.value("class", std::string()));
          if (cls < 0) continue;
          const int mode = modeIndex(built.catalog.vehicle_classes[static_cast<size_t>(cls)].mode);
          if (mode < 0 || mode >= kModeCount) continue;
          const double count = f.value("count", 1.0);
          if (count <= 0) continue;
          f["count"] = std::max(1.0, std::round(count * ratio[static_cast<size_t>(mode)]));
        }
        World scaled;
        if (buildWorldFromJson(world_name, m.doc.dump(), seed, scaled, error)) built = std::move(scaled);
      }
      for (int k = 0; k < kModeCount; ++k) {
        const double r = ratio[static_cast<size_t>(k)];
        const char* trips = k == 0 ? "Road trips" : k == 1 ? "River trips" : "Sea trips";
        const char* fleet = k == 0 ? "trucks" : k == 1 ? "barges" : "ships";
        char buf[160];
        if (r > 1.5) {
          std::snprintf(buf, sizeof buf, "%s are about %.1f times longer than on the default map; more %s were added",
                        trips, r, fleet);
          add(report.warnings, 0, kModes[k], buf);
        }
      }
    }

    // Things that work but look wrong.
    for (int k = 1; k < kModeCount; ++k) {
      double total = 0, dry = 0;
      for (const RouteEdge& e : built.edges) {
        if (modeIndex(e.mode) != k) continue;
        for (uint32_t i = e.polyline.begin; i + 1 < e.polyline.begin + e.polyline.count; ++i) {
          const double ax = built.polyline_xy[2 * i], ay = built.polyline_xy[2 * i + 1];
          const double bx = built.polyline_xy[2 * i + 2], by = built.polyline_xy[2 * i + 3];
          const double len = std::hypot(bx - ax, by - ay);
          const int steps = std::max(1, static_cast<int>(std::ceil(len / 2.0)));
          for (int s = 0; s < steps; ++s) {
            const double t = (s + 0.5) / steps;
            total += len / steps;
            if (!isWaterAt(built, ax + (bx - ax) * t, ay + (by - ay) * t)) dry += len / steps;
          }
        }
      }
      if (total > 0 && dry > 0.5 * total)
        add(report.warnings, 0, kModes[k],
            std::string(k == 1 ? "River lanes" : "Sea lanes") +
                " run over land for more than half their length; paint water under them");
    }
    for (const RouteEdge& e : built.edges) {
      const int k = modeIndex(e.mode);
      (k == 0 ? report.road_km : k == 1 ? report.river_km : report.sea_km) += e.length_km;
    }
    report.vehicles = built.fleet.size();
    out = std::move(built);
    return true;
  } catch (const std::exception& e) {
    add(report.errors, 0, "", std::string("The layout could not be read: ") + e.what());
  } catch (...) {
    add(report.errors, 0, "", "The layout could not be read");
  }
  return false;
}

std::string checkLayoutJson(const std::string& world_name, const std::string& layout_json) {
  LayoutReport report;
  json trial = nullptr;
  try {
    std::string error;
    auto sim = Sim::createWithLayout(world_name, layout_json, 42, error);
    // The report (all the errors, not just the first) comes from a second,
    // cheap pass over the same inputs.
    World scratch;
    buildWorldWithLayout(world_name, layout_json, 42, scratch, report);
    if (sim != nullptr && report.ok()) {
      const World& w = sim->world();
      const WindowReport r = runWindow(*sim, 30 * 96);
      json worst = nullptr;
      double worst_service = 2.0;
      for (const WindowCustomer& c : r.customers) {
        const double service = c.demand_t > 0 ? c.served_t / c.demand_t : 1.0;
        if (service >= worst_service) continue;
        worst_service = service;
        const Process& proc = w.processes[c.process];
        worst = {{"name", w.sites[proc.site.v].name},
                 {"site", proc.site.v + 1},
                 {"material", w.catalog.process_types[proc.type].basis_key},
                 {"service", service}};
      }
      json stopped = json::array();
      std::set<uint32_t> seen;
      for (const WindowPlant& pl : r.plants) {
        const uint32_t site = w.processes[pl.process].site.v;
        if (pl.down_h > 0 && seen.insert(site).second) stopped.push_back(w.sites[site].name);
      }
      trial = {{"days", 30},
               {"service", r.service},
               {"pass", r.service >= 0.95 && worst_service >= 0.9},
               {"worst", worst},
               {"stopped", stopped}};
    }
  } catch (const std::exception& e) {
    report.errors.push_back({0, "", std::string("The check could not finish: ") + e.what()});
  } catch (...) {
    report.errors.push_back({0, "", "The check could not finish"});
  }
  const auto list = [](const std::vector<LayoutIssue>& issues, bool with_mode) {
    json out = json::array();
    for (const LayoutIssue& i : issues) {
      json row = {{"site", i.site > 0 ? json(i.site) : json(nullptr)}, {"text", i.text}};
      if (with_mode) row["mode"] = i.mode.empty() ? json(nullptr) : json(i.mode);
      out.push_back(std::move(row));
    }
    return out;
  };
  return json{{"ok", report.ok()},
              {"errors", list(report.errors, true)},
              {"warnings", list(report.warnings, true)},
              {"summary",
               {{"roadKm", std::round(report.road_km * 10) / 10},
                {"riverKm", std::round(report.river_km * 10) / 10},
                {"seaKm", std::round(report.sea_km * 10) / 10},
                {"vehicles", report.vehicles}}},
              {"trial", trial}}
      .dump();
}

}  // namespace sim
}  // namespace crx
