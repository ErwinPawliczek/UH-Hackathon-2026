// Freeze the default demo world (see Freeze.h).
//
// Strategy: generate seed 709's layout (deterministic, passes the structural
// gate), cut it to the showcase site set, then rebuild everything downstream
// of the layout by explicit hand arithmetic:
//   * every material flow is a fixed table entry (t/h, mode),
//   * consumers are sized to supplier output (forward balance) — a consumer
//     tank's inflow is always >= its process draw, so starvation is
//     structurally impossible and surplus only accumulates slowly,
//   * surplus goes to port export sinks, which are optional outlets,
//   * the fleet is derived per lane with 30% spare vehicles,
//   * every pipeline is a bent >=4-point polyline kept clear of roads and
//     other pipelines; river edges are snapped onto the river channel and
//     sea edges bent seaward.
// The same seed and catalog always produce a byte-identical world.
#include "world/worldgen/Freeze.h"

#include "world/worldgen/Geo.h"
#include "world/worldgen/WorldGen.h"

#include <algorithm>
#include <cmath>
#include <map>
#include <set>
#include <string>
#include <utility>
#include <vector>

namespace crx {
namespace worldgen {
namespace {

struct FlowDef {
  const char* material;
  const char* from;
  const char* to;
  double t_h;
  Mode mode;
};

// The hand-balanced flow table. All numbers derive from the catalog recipes
// at the chosen process rates: sources at full wellhead/mine output, plants
// at 88% utilisation, the flex cracker on a 60/20/20 ETHANE/LPG/NAPHTHA
// blend, surplus to port export. Gases, olefins and crude move by pipeline
// (olefins are piped like methane, never shipped by road or vessel).
constexpr FlowDef kFlows[] = {
    // Pipelines.
    {"CRUDE", "Oil field A", "Refinery A", 300.0, Mode::Pipeline},
    {"CRUDE", "Oil field A", "Refinery B", 200.0, Mode::Pipeline},
    {"RAW_GAS", "Gas field A", "Gas plant A", 400.0, Mode::Pipeline},
    {"METHANE", "Gas plant A", "Gas grid", 314.8, Mode::Pipeline},
    {"ETHANE", "Gas plant A", "Cracker A (gas)", 20.0, Mode::Pipeline},
    {"ETHANE", "Gas plant A", "Cracker B (flex)", 9.0, Mode::Pipeline},
    {"ETHANE", "Gas plant A", "Port Brackenmouth", 2.2, Mode::Pipeline},
    {"ETHYLENE", "Cracker A (gas)", "PE plant A", 8.0, Mode::Pipeline},
    {"ETHYLENE", "Cracker A (gas)", "Vinyls plant", 5.6, Mode::Pipeline},
    {"ETHYLENE", "Cracker A (gas)", "Styrenics plant A", 1.65, Mode::Pipeline},
    {"ETHYLENE", "Cracker A (gas)", "Port Brackenmouth", 0.35, Mode::Pipeline},
    {"ETHYLENE", "Cracker B (flex)", "PE plant A", 7.225, Mode::Pipeline},
    {"ETHYLENE", "Cracker B (flex)", "Vinyls plant", 1.9, Mode::Pipeline},
    {"ETHYLENE", "Cracker B (flex)", "Port Brackenmouth", 0.115, Mode::Pipeline},
    {"PROPYLENE", "Refinery A", "PP plant", 3.75, Mode::Pipeline},
    {"PROPYLENE", "Refinery B", "PP plant", 2.5, Mode::Pipeline},
    {"PROPYLENE", "Cracker A (gas)", "PP plant", 0.6, Mode::Pipeline},
    {"PROPYLENE", "Cracker B (flex)", "PP plant", 1.26, Mode::Pipeline},
    {"LPG", "Gas plant A", "FUEL_DEPOT_Ashcombe", 12.0, Mode::Pipeline},
    {"LPG", "Gas plant A", "FUEL_DEPOT_Belvale", 8.0, Mode::Pipeline},
    {"LPG", "Gas plant A", "Cracker B (flex)", 3.0, Mode::Pipeline},
    {"LPG", "Gas plant A", "Port Brackenmouth", 6.6, Mode::Pipeline},
    {"LPG", "Refinery A", "Port Brackenmouth", 17.37, Mode::Pipeline},
    {"LPG", "Refinery B", "Port Brackenmouth", 11.58, Mode::Pipeline},
    {"LPG", "Cracker A (gas)", "Port Brackenmouth", 0.6, Mode::Pipeline},
    {"LPG", "Cracker B (flex)", "Port Brackenmouth", 0.69, Mode::Pipeline},
    {"CHLORINE", "Chlor-alkali plant", "Vinyls plant", 9.44, Mode::Pipeline},
    {"CAUSTIC", "Chlor-alkali plant", "Port Brackenmouth", 2.65, Mode::Pipeline},
    {"NAPHTHA", "Gas plant A", "Port Brackenmouth", 5.4, Mode::Pipeline},
    // Road trucks: solids (pellets, salt) and short liquid lanes.
    {"SALT", "Salt mine A", "Chlor-alkali plant", 15.56, Mode::Road},
    {"GASOLINE", "Refinery A", "FUEL_DEPOT_Ashcombe", 62.91, Mode::Road},
    {"DIESEL", "Refinery A", "FUEL_DEPOT_Ashcombe", 73.5, Mode::Road},
    {"JET", "Refinery A", "FUEL_DEPOT_Ashcombe", 30.0, Mode::Road},
    {"GASOLINE", "Cracker A (gas)", "Port Brackenmouth", 0.26, Mode::Road},
    {"NAPHTHA", "Gas plant A", "Cracker B (flex)", 3.0, Mode::Road},
    {"CAUSTIC", "Chlor-alkali plant", "PROCESS_INDUSTRIES_Eastbrook", 8.0, Mode::Road},
    {"BENZENE", "Cracker A (gas)", "Styrenics plant A", 0.14, Mode::Road},
    {"BENZENE", "Cracker B (flex)", "Styrenics plant A", 0.483, Mode::Road},
    {"PE", "PE plant A", "PACKAGING_Ashcombe", 15.0, Mode::Road},
    {"PVC", "Vinyls plant", "CONSTRUCTION_Belvale", 15.81, Mode::Road},
    {"PP", "PP plant", "CONSUMER_GOODS_Carrowmore", 7.95, Mode::Road},
    {"PS", "Styrenics plant A", "CONSUMER_GOODS_Carrowmore", 5.73, Mode::Road},
    // River barges: inland liquid lanes along the river channel.
    {"GASOLINE", "Refinery B", "FUEL_DEPOT_Belvale", 41.94, Mode::River},
    {"DIESEL", "Refinery B", "FUEL_DEPOT_Belvale", 49.0, Mode::River},
    {"JET", "Refinery B", "FUEL_DEPOT_Belvale", 20.0, Mode::River},
    {"BENZENE", "Refinery B", "Styrenics plant A", 1.56, Mode::Road},
    {"NAPHTHA", "Refinery B", "Port Brackenmouth", 14.0, Mode::River},
    {"FUEL_OIL", "Refinery B", "Port Brackenmouth", 39.5, Mode::River},
    {"SOLVENT", "Refinery B", "Port Brackenmouth", 2.6, Mode::River},
    // Sea ships: coastal lanes to the port's export berths.
    {"NAPHTHA", "Refinery A", "Port Brackenmouth", 21.0, Mode::Sea},
    {"FUEL_OIL", "Refinery A", "Port Brackenmouth", 59.45, Mode::Sea},
    {"SOLVENT", "Refinery A", "Port Brackenmouth", 3.9, Mode::Sea},
    {"FUEL_OIL", "Cracker B (flex)", "Port Brackenmouth", 0.33, Mode::Sea},
};

// Process design rates by site name → type → t/h of the process basis.
const std::map<std::string, std::map<std::string, double>>& rateTable() {
  static const std::map<std::string, std::map<std::string, double>> kRates = {
      {"Gas plant A", {{"NGL_RECOVERY", 400.0}}},
      {"Refinery A",
       {{"CRUDE_DISTILLATION", 300.0}, {"REFORMING", 39.0}, {"FCC", 75.0}, {"DIESEL_HDT", 75.0}}},
      {"Refinery B",
       {{"CRUDE_DISTILLATION", 200.0}, {"REFORMING", 26.0}, {"FCC", 50.0}, {"DIESEL_HDT", 50.0}}},
      {"Cracker A (gas)", {{"OLEFINS_GAS", 20.0}}},
      {"Cracker B (flex)", {{"OLEFINS_FLEX", 15.0}}},
      {"PE plant A", {{"PE_POLYMERISATION", 15.0}}},
      {"PP plant", {{"PP_POLYMERISATION", 7.95}}},
      {"Vinyls plant", {{"VCM", 16.129}, {"PVC", 15.81}}},
      {"Styrenics plant A", {{"STYRENE", 5.79}, {"PS", 5.73}}},
      {"Chlor-alkali plant", {{"ELECTROLYSIS", 9.44}}},
      {"Gas grid", {{"GAS_GRID_METHANE", 314.8}}},
      {"FUEL_DEPOT_Ashcombe",
       {{"FUEL_DEPOT_GASOLINE", 62.91},
        {"FUEL_DEPOT_DIESEL", 73.5},
        {"FUEL_DEPOT_JET", 30.0},
        {"FUEL_DEPOT_LPG", 12.0}}},
      {"FUEL_DEPOT_Belvale",
       {{"FUEL_DEPOT_GASOLINE", 41.94},
        {"FUEL_DEPOT_DIESEL", 49.0},
        {"FUEL_DEPOT_JET", 20.0},
        {"FUEL_DEPOT_LPG", 8.0}}},
      {"PACKAGING_Ashcombe", {{"PACKAGING_PE", 15.0}, {"PACKAGING_PP", 2.0}}},
      {"CONSUMER_GOODS_Carrowmore", {{"CONSUMER_GOODS_PP", 5.95}, {"CONSUMER_GOODS_PS", 5.73}}},
      {"CONSTRUCTION_Belvale", {{"CONSTRUCTION_PVC", 15.81}}},
      {"PROCESS_INDUSTRIES_Eastbrook", {{"PROCESS_INDUSTRIES_CAUSTIC", 8.0}}},
  };
  return kRates;
}

// Vehicle class per (mode, material phase).
std::string vehicleClass(Mode mode, Phase phase) {
  if (mode == Mode::Road) {
    if (phase == Phase::LiquefiedGas) return "TRUCK_PRESS";
    if (phase == Phase::Solid) return "TRUCK_BULK";
    return "TRUCK_TANK";
  }
  if (mode == Mode::River) return phase == Phase::Solid ? "BARGE_DRY" : "BARGE_TANK";
  if (phase == Phase::Solid) return "SHIP_DRY";
  if (phase == Phase::LiquefiedGas) return "SHIP_GAS";
  return "SHIP_TANK";
}

// Perpendicular displacement candidates for the bend, tried in order: two
// harmonic amplitudes (fundamental, second harmonic). Deterministic.
constexpr double kAmpTable[][2] = {
    {2.0, 1.0},  {-2.0, 1.0},  {2.0, -1.0},  {-2.0, -1.0}, {4.0, 2.0},
    {-4.0, 2.0}, {4.0, -2.0},  {-4.0, -2.0}, {6.0, 3.0},   {-6.0, 3.0},
    {6.0, -3.0}, {-6.0, -3.0}, {9.0, 5.0},   {-9.0, 5.0},  {9.0, -5.0},
    {-9.0, -5.0},
};

// Bent a→b polyline with 7 points. Clears every obstacle polyline by min_sep
// and every site by min_site_sep away from the endpoints; `bias` pushes the
// mid-span offsets one way (seaward for coastal lanes).
std::vector<Vec2> bendPolyline(Vec2 a, Vec2 b, const std::vector<std::vector<Vec2>>& obstacles,
                               const std::vector<Vec2>& sites, double min_sep, double min_site_sep,
                               Vec2 bias) {
  const double dx = b.x - a.x, dy = b.y - a.y;
  const double len = std::sqrt(dx * dx + dy * dy);
  const Vec2 n = len > 1e-9 ? Vec2{-dy / len, dx / len} : Vec2{1.0, 0.0};
  auto tryAmps = [&](double amp1, double amp2) {
    std::vector<Vec2> pts;
    constexpr int kSegs = 6;
    for (int i = 0; i <= kSegs; ++i) {
      const double t = static_cast<double>(i) / kSegs;
      const double off = amp1 * std::sin(M_PI * t) + amp2 * std::sin(2 * M_PI * t);
      pts.push_back(Vec2{a.x + dx * t + n.x * off + bias.x * t * (1 - t) * 4,
                         a.y + dy * t + n.y * off + bias.y * t * (1 - t) * 4});
    }
    return pts;
  };
  auto clear = [&](const std::vector<Vec2>& pts) {
    for (size_t i = 1; i < pts.size(); ++i) {
      for (int k = 0; k <= 4; ++k) {
        const double t = (static_cast<double>(i - 1) + k / 4.0) / pts.size();
        const Vec2 p = pts[i - 1] + (pts[i] - pts[i - 1]) * (k / 4.0);
        for (const auto& obs : obstacles)
          if (polylineMinDist(p, obs) < min_sep) return false;
        if (t > 0.12 && t < 0.88)
          for (const auto& s : sites)
            if (distKM(p, s) < min_site_sep) return false;
      }
    }
    return true;
  };
  std::vector<Vec2> best;
  for (const auto* amps : kAmpTable) {
    std::vector<Vec2> pts = tryAmps(amps[0], amps[1]);
    if (clear(pts)) return pts;
    best = std::move(pts);
  }
  return best;
}

void appendPolyline(GeneratedWorld& w, Range<uint32_t>& range, const std::vector<Vec2>& pts,
                    float& length_km) {
  range = Range<uint32_t>{static_cast<uint32_t>(w.polyline_xy.size() / 2),
                          static_cast<uint32_t>(pts.size())};
  double len = 0.0;
  for (size_t k = 0; k < pts.size(); ++k) {
    w.polyline_xy.push_back(static_cast<float>(pts[k].x));
    w.polyline_xy.push_back(static_cast<float>(pts[k].y));
    if (k > 0) len += distKM(pts[k - 1], pts[k]);
  }
  length_km = static_cast<float>(len);
}

// Route polyline for a lane between two berth positions: river lanes snap to
// the river channel, sea lanes bend seaward (away from the map interior per
// sea_edge), roads bend over land clear of obstacles.
std::vector<Vec2> lanePolyline(Mode mode, Vec2 a, Vec2 b, int sea_edge,
                               const std::vector<Vec2>& river,
                               const std::vector<std::vector<Vec2>>& obstacles,
                               const std::vector<Vec2>& sites) {
  if (mode == Mode::River && river.size() >= 2) {
    auto project = [&](Vec2 p) {
      size_t best_i = 1;
      double best_d = 1e18;
      Vec2 best_p = river.front();
      for (size_t i = 1; i < river.size(); ++i) {
        const Vec2 ab = river[i] - river[i - 1];
        const double ab2 = ab.x * ab.x + ab.y * ab.y;
        const double dot = (p.x - river[i - 1].x) * ab.x + (p.y - river[i - 1].y) * ab.y;
        double t = ab2 > 0.0 ? dot / ab2 : 0.0;
        t = std::clamp(t, 0.0, 1.0);
        const Vec2 q = river[i - 1] + ab * t;
        const double d = distKM(p, q);
        if (d < best_d) {
          best_d = d;
          best_i = i;
          best_p = q;
        }
      }
      return std::make_pair(best_i, best_p);
    };
    const auto pa = project(a);
    const auto pb = project(b);
    std::vector<Vec2> pts;
    pts.push_back(a);
    pts.push_back(pa.second);
    const size_t lo = std::min(pa.first, pb.first), hi = std::max(pa.first, pb.first);
    if (pa.first <= pb.first) {
      for (size_t i = lo; i <= hi; ++i) pts.push_back(river[i]);
    } else {
      for (size_t i = hi;; --i) {
        pts.push_back(river[i]);
        if (i == lo) break;
      }
    }
    pts.push_back(pb.second);
    pts.push_back(b);
    return pts;
  }
  Vec2 bias{0.0, 0.0};
  if (sea_edge == 2) bias = Vec2{12.0, 0.0};
  if (sea_edge == 0) bias = Vec2{0.0, 12.0};
  if (sea_edge == 1) bias = Vec2{0.0, -12.0};
  if (sea_edge == 3) bias = Vec2{-12.0, 0.0};
  std::vector<Vec2> pts = bendPolyline(a, b, obstacles, sites, 1.5, 2.5, bias);
  if (pts.size() < 4) pts = bendPolyline(a, b, {}, sites, 1.5, 2.5, bias);
  return pts;
}

}  // namespace

bool freezeGulfBasin(uint64_t seed, const CatalogView& catalog, GeneratedWorld& out,
                     std::string& error) {
  // 1. Deterministic base layout (the structural gate runs inside).
  const GenResult base = generateWorld(seed, GenParams{}, catalog);
  if (!base.ok) {
    error = "base generator rejected seed " + std::to_string(seed);
    return false;
  }
  const GeneratedWorld& w = base.world;

  // 2. The showcase site set (by generated name).
  const std::set<std::string> kKeep = {
      "Port Brackenmouth",     "Refinery A",                "Refinery B",
      "Cracker A (gas)",       "Cracker B (flex)",          "PE plant A",
      "PP plant",              "Vinyls plant",              "Styrenics plant A",
      "Chlor-alkali plant",    "Gas plant A",               "Gas field A",
      "Oil field A",           "Salt mine A",               "Gas grid",
      "FUEL_DEPOT_Ashcombe",   "PACKAGING_Ashcombe",        "FUEL_DEPOT_Belvale",
      "CONSTRUCTION_Belvale",  "CONSUMER_GOODS_Carrowmore", "PROCESS_INDUSTRIES_Eastbrook",
  };
  std::map<std::string, int> byName;
  for (size_t i = 0; i < w.sites.size(); ++i) byName[w.sites[i].name] = static_cast<int>(i);
  for (const FlowDef& f : kFlows) {
    if (byName.count(f.from) == 0 || byName.count(f.to) == 0) {
      error = std::string("flow references unknown site: ") + f.material;
      return false;
    }
  }
  for (const std::string& k : kKeep)
    if (byName.count(k) == 0) {
      error = "generated world lacks showcase site '" + k + "'";
      return false;
    }

  // 3. Cut: keep only showcase sites and their records; drop foreign edges.
  std::vector<char> keepSite(w.sites.size(), 0);
  for (const std::string& k : kKeep) keepSite[byName[k]] = 1;
  std::map<uint32_t, uint32_t> nodeSite;  // node id → OLD site id
  for (size_t s = 0; s < w.sites.size(); ++s)
    for (int m = 0; m < 3; ++m)
      if (w.sites[s].node[m].valid()) nodeSite[w.sites[s].node[m].v] = static_cast<uint32_t>(s);

  GeneratedWorld o;
  o.seed = seed;
  o.params = w.params;
  o.schedules = w.schedules;
  o.sea_edge = w.sea_edge;
  o.river_xy = w.river_xy;

  std::vector<int> siteMap(w.sites.size(), -1), nodeMap(w.nodes.size(), -1);
  auto remapNode = [&](NodeId n) -> NodeId {
    if (!n.valid()) return n;
    if (nodeMap[n.v] < 0) {
      nodeMap[n.v] = static_cast<int>(o.nodes.size());
      o.nodes.push_back(w.nodes[n.v]);
    }
    return NodeId{static_cast<uint32_t>(nodeMap[n.v])};
  };
  auto nodePos = [&](NodeId n) { return Vec2{w.nodes[n.v].x_km, w.nodes[n.v].y_km}; };

  for (size_t s = 0; s < w.sites.size(); ++s) {
    if (!keepSite[s]) continue;
    WSite ws = w.sites[s];
    for (int m = 0; m < 3; ++m) ws.node[m] = remapNode(w.sites[s].node[m]);
    siteMap[s] = static_cast<int>(o.sites.size());
    o.sites.push_back(ws);
  }
  o.overseas_node = remapNode(w.overseas_node);

  std::vector<int> tankMap(w.tanks.size(), -1), procMap(w.processes.size(), -1);
  for (size_t t = 0; t < w.tanks.size(); ++t) {
    if (siteMap[w.tanks[t].site.v] < 0) continue;
    tankMap[t] = static_cast<int>(o.tanks.size());
    WTank wt = w.tanks[t];
    wt.site = SiteId{static_cast<uint32_t>(siteMap[w.tanks[t].site.v])};
    o.tanks.push_back(wt);
  }
  // Port sink processes the frozen table doesn't use are skipped outright —
  // the generator instantiates an export sink per material its own plan
  // shipped; unused ones would idle at rate 0 (decided from kFlows before
  // any index is built).
  std::set<std::string> usedPort;
  for (const FlowDef& f : kFlows) {
    if (std::string(f.to) != "Port Brackenmouth") continue;
    usedPort.insert("PORT_EXPORT_" + std::string(f.material));
    if (std::string(f.material) == "FUEL_OIL") usedPort.insert("PORT_BUNKER_FUEL_OIL");
  }
  const int portOrig = byName.at("Port Brackenmouth");
  for (size_t p = 0; p < w.processes.size(); ++p) {
    if (siteMap[w.processes[p].site.v] < 0) continue;
    if (w.processes[p].site.v == static_cast<uint32_t>(portOrig) &&
        usedPort.count(w.processes[p].type) == 0)
      continue;
    procMap[p] = static_cast<int>(o.processes.size());
    WProcess wp = w.processes[p];
    wp.site = SiteId{static_cast<uint32_t>(siteMap[w.processes[p].site.v])};
    // tank_of is material-indexed and holds tank ids from the GENERATED id
    // space; dropped sites shift the frozen ids, so remap every real entry
    // through tankMap (the sentinel 4294967295 stays "no tank").
    for (TankId& t : wp.tank_of)
      if (t.v < tankMap.size() && tankMap[t.v] >= 0) t = TankId{static_cast<uint32_t>(tankMap[t.v])};
      else t = TankId{4294967295u};
    wp.units = Range<UnitId>{};  // rebuilt below
    wp.design_rate_t_h = 0.0;  // must be re-covered by table/setRate/ensureProc
    o.processes.push_back(wp);
  }

  // Edges: keep those whose endpoint nodes belong to kept sites, remembering
  // the endpoint positions (old node ids) for the polyline rebuilds.
  struct KeptEdge {
    WEdge e;
    Vec2 a, b;  // endpoint geometry in the source node graph
  };
  std::vector<KeptEdge> kept;
  for (const WEdge& e : w.edges) {
    const auto ia = nodeSite.count(e.a.v) ? nodeSite.at(e.a.v) : UINT32_MAX;
    const auto ib = nodeSite.count(e.b.v) ? nodeSite.at(e.b.v) : UINT32_MAX;
    if (ia == UINT32_MAX || ib == UINT32_MAX || !keepSite[ia] || !keepSite[ib]) continue;
    KeptEdge k;
    k.a = nodePos(e.a);
    k.b = nodePos(e.b);
    k.e.mode = e.mode;
    k.e.speed_kmh = e.speed_kmh;
    k.e.a = remapNode(e.a);
    k.e.b = remapNode(e.b);
    kept.push_back(k);
  }

  // Road polylines copy from the source world (geometry the generator drew)
  // so pipelines can avoid them.
  std::vector<std::vector<Vec2>> roadPolys;
  {
    size_t ki = 0;
    for (const WEdge& src : w.edges) {
      const auto ia = nodeSite.count(src.a.v) ? nodeSite.at(src.a.v) : UINT32_MAX;
      const auto ib = nodeSite.count(src.b.v) ? nodeSite.at(src.b.v) : UINT32_MAX;
      if (ia == UINT32_MAX || ib == UINT32_MAX || !keepSite[ia] || !keepSite[ib]) continue;
      if (ki >= kept.size()) break;
      if (src.mode == Mode::Road) {
        std::vector<Vec2> pts;
        if (src.polyline.count > 0) {
          for (uint32_t k = 0; k < src.polyline.count; ++k)
            pts.push_back(Vec2{w.polyline_xy[2 * (src.polyline.begin + k)],
                               w.polyline_xy[2 * (src.polyline.begin + k) + 1]});
        } else {
          pts.push_back(kept[ki].a);
          pts.push_back(kept[ki].b);
        }
        roadPolys.push_back(pts);
      }
      ++ki;
    }
  }

  // Materialise edges: roads keep their polylines, water edges re-route via
  // lanePolyline (river snap / seaward bend).
  const std::vector<Vec2> riverPoly = [&] {
    std::vector<Vec2> pts;
    for (size_t i = 0; i < o.river_xy.size(); i += 2)
      pts.push_back(Vec2{o.river_xy[i], o.river_xy[i + 1]});
    return pts;
  }();
  for (size_t ki = 0; ki < kept.size(); ++ki) {
    KeptEdge& k = kept[ki];
    if (k.e.mode == Mode::Road) continue;  // polylines copied below in order
    std::vector<Vec2> pts =
        lanePolyline(k.e.mode, k.a, k.b, o.sea_edge, riverPoly, roadPolys, {});
    float len = 0.f;
    appendPolyline(o, k.e.polyline, pts, len);
    k.e.length_km = len;
  }
  // Now append ALL kept edges (roads after water edges, preserving order).
  {
    size_t ki = 0;
    for (const WEdge& src : w.edges) {
      const auto ia = nodeSite.count(src.a.v) ? nodeSite.at(src.a.v) : UINT32_MAX;
      const auto ib = nodeSite.count(src.b.v) ? nodeSite.at(src.b.v) : UINT32_MAX;
      if (ia == UINT32_MAX || ib == UINT32_MAX || !keepSite[ia] || !keepSite[ib]) continue;
      KeptEdge& k = kept[ki++];
      if (k.e.mode == Mode::Road) {
        std::vector<Vec2> pts;
        if (src.polyline.count > 0) {
          for (uint32_t q = 0; q < src.polyline.count; ++q)
            pts.push_back(Vec2{w.polyline_xy[2 * (src.polyline.begin + q)],
                               w.polyline_xy[2 * (src.polyline.begin + q) + 1]});
        } else {
          pts.push_back(k.a);
          pts.push_back(k.b);
        }
        float len = 0.f;
        appendPolyline(o, k.e.polyline, pts, len);
        k.e.length_km = len;
      }
      o.edges.push_back(k.e);
    }
  }

  // 4. Tank designs from the flow table.
  struct Acc {
    double in = 0.0, out = 0.0;
  };
  std::map<std::pair<uint32_t, std::string>, Acc> acc;  // NEW site id → flows
  for (const FlowDef& f : kFlows) {
    acc[{static_cast<uint32_t>(siteMap[byName[f.to]]), f.material}].in += f.t_h;
    acc[{static_cast<uint32_t>(siteMap[byName[f.from]]), f.material}].out += f.t_h;
  }
  auto tankAt = [&](uint32_t site, const std::string& material) -> int {
    for (size_t t = 0; t < o.tanks.size(); ++t)
      if (o.tanks[t].site.v == site && o.tanks[t].material == material) return static_cast<int>(t);
    return -1;
  };
  // The flow table may reference (site, material) pairs the generated world
  // never tanked (e.g. ethylene export at the port) — create those tanks;
  // the design pass below fills their rates and capacity.
  for (const FlowDef& f : kFlows) {
    for (const char* side : {f.from, f.to}) {
      const uint32_t site = static_cast<uint32_t>(siteMap[byName[side]]);
      if (tankAt(site, f.material) >= 0) continue;
      WTank nt;
      nt.site = SiteId{site};
      nt.material = f.material;
      nt.role = side == f.to ? TankRole::Feed : TankRole::Product;
      o.tanks.push_back(nt);
    }
  }
  for (const auto& [key, a] : acc) {
    const int t = tankAt(key.first, key.second);
    if (t < 0) {
      error = "site '" + o.sites[key.first].name + "' lacks a tank for '" + key.second + "'";
      return false;
    }
    WTank& tank = o.tanks[t];
    tank.design_in_t_h = a.in;
    tank.design_out_t_h = a.out;
    tank.role = a.in > 0 && a.out > 0 ? TankRole::Both
                : a.in > 0            ? TankRole::Feed
                : a.out > 0           ? TankRole::Product
                                      : tank.role;
    tank.capacity_t = 24.0 * 7.0 * std::max(std::max(a.in, a.out), 0.1);
    if (tank.target_frac <= 0.0) tank.target_frac = 0.5;
  }

  // 5. Process rates; every kept process must end with a positive rate (the
  // zero-rate check below is the authority — the table plus setRate calls
  // must jointly cover every kept process).
  for (auto& p : o.processes) {
    const auto sit = rateTable().find(o.sites[p.site.v].name);
    if (sit == rateTable().end()) continue;  // sources and port sinks via setRate
    const auto pit = sit->second.find(p.type);
    if (pit == sit->second.end()) {
      std::string have;
      for (const auto& q : o.processes)
        if (q.site == p.site) have += " " + q.type;
      error = "no rate table entry for '" + p.type + "' at '" + o.sites[p.site.v].name +
              "'; site has:" + have;
      return false;
    }
    p.design_rate_t_h = pit->second;
  }
  for (auto& p : o.processes)
    if (p.type == "OLEFINS_FLEX") p.mode_share = {0.6, 0.2, 0.2};  // [ETHANE, LPG, NAPHTHA]
  // Unit slots per process (from the source world); processes this tool
  // creates get one slot each.
  std::map<int, std::vector<uint8_t>> slots;
  for (size_t u = 0; u < w.units.size(); ++u)
    if (procMap[w.units[u].process.v] >= 0)
      slots[procMap[w.units[u].process.v]].push_back(w.units[u].slot);
  auto setRate = [&](const char* site, const char* type, double rate) {
    for (size_t i = 0; i < o.processes.size(); ++i)
      if (o.sites[o.processes[i].site.v].name == site && o.processes[i].type == type) {
        o.processes[i].design_rate_t_h = rate;
        return true;
      }
    error = std::string("missing process '") + type + "' at '" + site + "'";
    return false;
  };
  // Port export sinks: the generator instantiates only the sinks its own
  // plan uses; the frozen table needs every export outlet, so create the
  // missing ones (one unit each; the units pass fills the cap).
  auto ensureProc = [&](const char* site, const char* type, double rate) {
    for (size_t i = 0; i < o.processes.size(); ++i)
      if (o.sites[o.processes[i].site.v].name == site && o.processes[i].type == type) {
        o.processes[i].design_rate_t_h = rate;
        return true;
      }
    for (size_t si = 0; si < o.sites.size(); ++si)
      if (o.sites[si].name == site) {
        WProcess np;
        np.site = SiteId{static_cast<uint32_t>(si)};
        np.type = type;
        np.design_rate_t_h = rate;
        np.schedule = 0;
        const auto idx = static_cast<int>(o.processes.size());
        o.processes.push_back(np);
        slots[idx] = {0};
        return true;
      }
    error = std::string("missing site '") + site + "'";
    return false;
  };
  if (!setRate("Gas field A", "GAS_PRODUCTION", 400.0) ||
      !setRate("Oil field A", "OIL_PRODUCTION", 500.0) ||
      !setRate("Salt mine A", "SALT_MINING", 15.56) ||
      !ensureProc("Port Brackenmouth", "PORT_EXPORT_ETHANE", 2.2) ||
      !ensureProc("Port Brackenmouth", "PORT_EXPORT_ETHYLENE", 0.465) ||
      !ensureProc("Port Brackenmouth", "PORT_EXPORT_LPG", 36.84) ||
      !ensureProc("Port Brackenmouth", "PORT_EXPORT_NAPHTHA", 40.4) ||
      !ensureProc("Port Brackenmouth", "PORT_EXPORT_FUEL_OIL", 99.28) ||
      !ensureProc("Port Brackenmouth", "PORT_EXPORT_SOLVENT", 6.5) ||
      !ensureProc("Port Brackenmouth", "PORT_EXPORT_CAUSTIC", 2.65) ||
      !ensureProc("Port Brackenmouth", "PORT_EXPORT_GASOLINE", 1.232) ||
      !setRate("Port Brackenmouth", "PORT_BUNKER_FUEL_OIL", 15.0)) {
    return false;  // error already names the missing process
  }
  for (const auto& p : o.processes)
    if (p.design_rate_t_h <= 0.0) {
      error = "process '" + p.type + "' at '" + o.sites[p.site.v].name + "' has rate 0";
      return false;
    }

  // Units: one per source train, caps at 88% utilisation, slots preserved
  // (the slots map was filled above; created processes already have a slot).
  for (size_t j = 0; j < o.processes.size(); ++j) {
    WProcess& p = o.processes[j];
    const auto st = slots.find(static_cast<int>(j));
    if (st == slots.end() || st->second.empty()) {
      error = "process '" + p.type + "' at '" + o.sites[p.site.v].name + "' has no units";
      return false;
    }
    const size_t n = st->second.size();
    p.units = Range<UnitId>{static_cast<uint32_t>(o.units.size()), static_cast<uint32_t>(n)};
    for (size_t k = 0; k < n; ++k) {
      WUnit wu;
      wu.process = ProcessId{static_cast<uint32_t>(j)};
      wu.slot = st->second[k];
      wu.cap_per_train_t_h = p.design_rate_t_h / static_cast<double>(n) / 0.88;
      o.units.push_back(wu);
    }
  }

  // Sink draws ride their tanks: the pipeline pull keys off the destination
  // tank's design_out, so add every sink process's rate to the tank it draws
  // from (mirrors the generator's tank sizing).
  {
    std::map<uint32_t, double> draw;
    for (const WProcess& p : o.processes) {
      const ProcessInfo* info = catalog.process(p.type);
      if (info == nullptr || info->boundary != Boundary::Sink) continue;
      // tank_of is material-indexed; a sink draws its basis material.
      for (size_t m = 0; m < catalog.materials.size(); ++m)
        if (catalog.materials[m].key == info->basis && m < p.tank_of.size() &&
            p.tank_of[m].v < o.tanks.size())
          draw[p.tank_of[m].v] += p.design_rate_t_h;
    }
    for (const auto& [tid, d] : draw) o.tanks[tid].design_out_t_h += d;
  }

  // 6. Pipelines: one per pipeline flow, bent clear of roads and other pipes.
  std::vector<Vec2> sitePts;
  for (const auto& s : o.sites) sitePts.push_back(Vec2{s.x_km, s.y_km});
  std::vector<std::vector<Vec2>> pipePolys;
  for (const FlowDef& f : kFlows) {
    if (f.mode != Mode::Pipeline) continue;
    const int si = siteMap[byName[f.from]], ti = siteMap[byName[f.to]];
    const int st = tankAt(static_cast<uint32_t>(si), f.material);
    const int tt = tankAt(static_cast<uint32_t>(ti), f.material);
    if (st < 0 || tt < 0) {
      error = std::string("pipeline flow missing tank: ") + f.material;
      return false;
    }
    WPipeline pl;
    pl.from = TankId{static_cast<uint32_t>(st)};
    pl.to = TankId{static_cast<uint32_t>(tt)};
    pl.cap_t_h = f.t_h * 1.3;
    const std::vector<Vec2> a{Vec2{o.sites[si].x_km, o.sites[si].y_km}};
    const std::vector<Vec2> b{Vec2{o.sites[ti].x_km, o.sites[ti].y_km}};
    std::vector<std::vector<Vec2>> obstacles = roadPolys;
    obstacles.insert(obstacles.end(), pipePolys.begin(), pipePolys.end());
    std::vector<Vec2> pts =
        bendPolyline(a[0], b[0], obstacles, sitePts, 1.5, 2.5, Vec2{});
    float len = 0.f;
    appendPolyline(o, pl.polyline, pts, len);
    pl.length_km = len;
    pipePolys.push_back(pts);
    o.pipelines.push_back(pl);
    o.tanks[st].piped_out = true;
    o.tanks[tt].piped_in = true;
  }

  // 7. Fleet: per non-pipeline flow, enough vehicles to carry t/h with 30%
  // spare given the round-trip time on the lane.
  std::map<std::string, const VehicleClassInfo*> vcls;
  for (const auto& v : catalog.vehicles) vcls[v.key] = &v;
  for (const FlowDef& f : kFlows) {
    if (f.mode == Mode::Pipeline) continue;
    const int si = siteMap[byName[f.from]], ti = siteMap[byName[f.to]];
    const int mIdx = f.mode == Mode::River ? 1 : (f.mode == Mode::Sea ? 2 : 0);
    // Shortest edge of the mode between the two sites; create a road when the
    // generator lacks one (any two road-berthed sites can get a lane).
    double km = 1e18;
    float speed = 0.f;
    for (const auto& e : o.edges) {
      if (e.mode != f.mode) continue;
      const auto ea = nodeSite.count(e.a.v) ? nodeSite.at(e.a.v) : UINT32_MAX;
      const auto eb = nodeSite.count(e.b.v) ? nodeSite.at(e.b.v) : UINT32_MAX;
      const bool match = (ea == static_cast<uint32_t>(byName[f.from]) &&
                          eb == static_cast<uint32_t>(byName[f.to])) ||
                         (eb == static_cast<uint32_t>(byName[f.from]) &&
                          ea == static_cast<uint32_t>(byName[f.to]));
      if (!match) continue;
      km = std::min(km, static_cast<double>(e.length_km));
      speed = e.speed_kmh;
    }
    if (km > 1e17) {
      const std::vector<std::vector<Vec2>> obs = [&] {
        std::vector<std::vector<Vec2>> v = roadPolys;
        for (const auto& e : o.edges) {
          if (e.mode != Mode::Road || e.polyline.count == 0) continue;
          std::vector<Vec2> pts2;
          for (uint32_t q = 0; q < e.polyline.count; ++q)
            pts2.push_back(Vec2{o.polyline_xy[2 * (e.polyline.begin + q)],
                                o.polyline_xy[2 * (e.polyline.begin + q) + 1]});
          v.push_back(pts2);
        }
        return v;
      }();
      const std::vector<Vec2> pts = lanePolyline(
          f.mode, Vec2{o.sites[si].x_km, o.sites[si].y_km},
          Vec2{o.sites[ti].x_km, o.sites[ti].y_km}, o.sea_edge, riverPoly, obs, sitePts);
      WEdge ne;
      ne.a = o.sites[si].node[mIdx];
      ne.b = o.sites[ti].node[mIdx];
      ne.mode = f.mode;
      ne.speed_kmh = f.mode == Mode::Road ? 70.f : (f.mode == Mode::River ? 18.f : 24.f);
      float len = 0.f;
      appendPolyline(o, ne.polyline, pts, len);
      ne.length_km = len;
      o.edges.push_back(ne);
      if (f.mode == Mode::Road) roadPolys.push_back(pts);
      km = len;
      speed = ne.speed_kmh;
    }
    Phase phase = Phase::Liquid;
    for (const auto& m : catalog.materials)
      if (m.key == f.material) phase = m.phase;
    const std::string cls = vehicleClass(f.mode, phase);
    const VehicleClassInfo* v = vcls[cls];
    if (v == nullptr) {
      error = "catalog lacks vehicle class " + cls;
      return false;
    }
    if (!o.sites[si].node[mIdx].valid() || !o.sites[ti].node[mIdx].valid()) {
      error = std::string("flow site lacks a berth for ") + f.material + " " + f.from + "->" +
              f.to;
      return false;
    }
    const double rt = 2.0 * km / (speed > 0 ? speed : v->speed_kmh) +
                      2.0 * v->capacity_t / v->load_t_h;
    const double need = 1.3 * f.t_h * rt / v->capacity_t;
    const int count = std::max(1, static_cast<int>(std::ceil(need)));
    for (int k = 0; k < count; ++k) {
      WVehicleSpec vs;
      vs.cls = cls;
      vs.home = o.sites[si].node[mIdx];
      o.fleet.push_back(vs);
    }
  }

  // 8. Contracts and flow records.
  for (const FlowDef& f : kFlows) {
    const int st = tankAt(static_cast<uint32_t>(siteMap[byName[f.from]]), f.material);
    const int tt = tankAt(static_cast<uint32_t>(siteMap[byName[f.to]]), f.material);
    o.contracts.push_back(
        WContract{TankId{static_cast<uint32_t>(tt)}, TankId{static_cast<uint32_t>(st)}});
    WFlowRecord fr;
    fr.material = f.material;
    fr.from_site = siteMap[byName[f.from]];
    fr.to_site = siteMap[byName[f.to]];
    fr.t_d = f.t_h * 24.0;
    fr.piped = f.mode == Mode::Pipeline;
    o.flows.push_back(fr);
  }

  // Rebuild per-site tank and process ranges: skipped port sinks and
  // ensureProc appends leave the copied [begin,count] ranges stale.
  {
    // processes first, then tanks — each site's [begin,count] range is
    // recomputed from the compacted lists.
    {
      std::map<uint32_t, uint32_t> first, cnt;
      for (size_t i = 0; i < o.processes.size(); ++i) {
        const uint32_t s2 = o.processes[i].site.v;
        if (!first.count(s2)) first[s2] = static_cast<uint32_t>(i);
        ++cnt[s2];
      }
      for (size_t s2 = 0; s2 < o.sites.size(); ++s2) {
        auto f2 = first.find(static_cast<uint32_t>(s2));
        o.sites[s2].processes =
            f2 == first.end()
                ? Range<ProcessId>{}
                : Range<ProcessId>{f2->second, cnt[static_cast<uint32_t>(s2)]};
      }
    }
    {
      std::map<uint32_t, uint32_t> first, cnt;
      for (size_t i = 0; i < o.tanks.size(); ++i) {
        const uint32_t s2 = o.tanks[i].site.v;
        if (!first.count(s2)) first[s2] = static_cast<uint32_t>(i);
        ++cnt[s2];
      }
      for (size_t s2 = 0; s2 < o.sites.size(); ++s2) {
        auto f2 = first.find(static_cast<uint32_t>(s2));
        o.sites[s2].tanks =
            f2 == first.end() ? Range<TankId>{}
                              : Range<TankId>{f2->second, cnt[static_cast<uint32_t>(s2)]};
      }
    }
  }

  out = std::move(o);
  return true;
}

}  // namespace worldgen
}  // namespace crx
