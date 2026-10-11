// Hand-drawn world loader — see HandDrawn.h. Implements the PR #27 format
// spec: strips joined per mode on shared end points (4 km), sites snapped at
// 12 km, pipelines verbatim, sea lanes to the map edge as the overseas
// gateway, rail ignored. Rates are assigned FORWARD (sources first), never
// demand-backwards; consumers take exactly what their suppliers make, and
// every surplus tonne flows to a port export (or bunker) outlet. Tanks, bays
// and vehicles are sized from those flows with 30% spare.
#include "world/worldgen/HandDrawn.h"

#include <algorithm>
#include <array>
#include <cmath>
#include <fstream>
#include <map>
#include <queue>
#include <set>
#include <utility>

#include <nlohmann/json.hpp>

namespace crx {
namespace worldgen {

namespace {

constexpr double kJoinKm = 4.0;   // strips sharing an end point within 4 km join
constexpr double kSnapKm = 12.0;  // site is on a network within 12 km
constexpr double kSpare = 1.3;    // +30% sizing spare
constexpr double kFleetSpare = 3.0;  // fleet multiplier over the cyclic minimum:
                                     // bay queues, order races, and route
                                     // variance eat the naive 30% spare
constexpr double kUtilisation = 0.88;  // design rate is hit at 88% utilisation
constexpr float kRoadKmh = 70.f, kRiverKmh = 18.f, kSeaKmh = 24.f;

struct Pt { double x, y; };
double dist(const Pt& a, const Pt& b) { return std::hypot(a.x - b.x, a.y - b.y); }

double arcLength(const std::vector<Pt>& p) {
  double len = 0;
  for (size_t i = 1; i < p.size(); ++i) len += dist(p[i - 1], p[i]);
  return len;
}

// Closest point on segment ab to p.
Pt closestOnSegment(const Pt& a, const Pt& b, const Pt& p) {
  const double dx = b.x - a.x, dy = b.y - a.y;
  const double dd = dx * dx + dy * dy;
  if (dd < 1e-12) return a;
  double t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / dd;
  t = std::clamp(t, 0.0, 1.0);
  return Pt{a.x + t * dx, a.y + t * dy};
}

struct Strip {
  Mode mode;
  std::vector<Pt> pts;
};

struct DrawnPipe {
  int from, to;  // site ids as drawn (1-based)
  std::string material;
  std::vector<Pt> pts;
};

struct Drawn {
  double w = 600, h = 400;
  struct Site { int id; std::string name, preset; double x, y; };
  std::vector<Site> sites;
  std::vector<Strip> strips;
  std::vector<DrawnPipe> pipes;
};

void parseDrawn(const std::string& path, Drawn& d, std::string& error) {
  std::ifstream in(path);
  if (!in) {
    error = "cannot open hand-drawn world file: " + path;
    return;
  }
  nlohmann::json j;
  try {
    in >> j;
  } catch (const std::exception& e) {
    error = std::string("hand-drawn world parse error: ") + e.what();
    return;
  }
  d.w = j.value("wKm", 600.0);
  d.h = j.value("hKm", 400.0);
  for (const auto& s : j["sites"]) {
    Drawn::Site ds;
    ds.id = s["id"].get<int>();
    ds.name = s["name"].get<std::string>();
    ds.preset = s["preset"].get<std::string>();
    ds.x = s["x"].get<double>();
    ds.y = s["y"].get<double>();
    d.sites.push_back(ds);
  }
  static const std::map<std::string, Mode> modeMap{{"road", Mode::Road},
                                                   {"river", Mode::River},
                                                   {"sea", Mode::Sea}};
  for (const auto& n : j["network"]) {
    const std::string m = n["mode"].get<std::string>();
    if (m == "rail") continue;  // no engine rail mode; drawn strips stay in the file
    const auto it = modeMap.find(m);
    if (it == modeMap.end()) {
      error = "unknown network mode '" + m + "'";
      return;
    }
    Strip st;
    st.mode = it->second;
    for (const auto& p : n["points"]) st.pts.push_back({p[0].get<double>(), p[1].get<double>()});
    if (st.pts.size() >= 2) d.strips.push_back(st);
  }
  for (const auto& c : j["connections"]) {
    DrawnPipe dp;
    dp.from = c["from"].get<int>();
    dp.to = c["to"].get<int>();
    dp.material = c["material"].get<std::string>();
    for (const auto& p : c["points"]) dp.pts.push_back({p[0].get<double>(), p[1].get<double>()});
    d.pipes.push_back(dp);
  }
}

// One joined mode graph: nodes are strip endpoints (merged when within 4 km),
// edges are the drawn strips themselves. `siteNode` maps site index → graph
// node per mode, created by splitting the strip at the snap point.
struct ModeGraph {
  Mode mode = Mode::Road;
  std::vector<Pt> nodePos;
  std::vector<std::pair<int, int>> edgeNodes;  // per strip
  std::vector<std::vector<Pt>> edgePoly;       // per strip (drawn geometry)
  std::vector<float> speeds;
  std::map<size_t, int> siteNode;              // site index → node

  int findNode(const Pt& p) const {
    for (size_t i = 0; i < nodePos.size(); ++i)
      if (dist(nodePos[i], p) <= kJoinKm) return static_cast<int>(i);
    return -1;
  }
  int addNode(const Pt& p) {
    nodePos.push_back(p);
    return static_cast<int>(nodePos.size()) - 1;
  }
  int nodeFor(const Pt& p) {
    const int n = findNode(p);
    return n >= 0 ? n : addNode(p);
  }
};

struct GraphBuild {
  ModeGraph road, river, sea;
};

// Merge a mode graph per the drawn join rule: strips sharing an end point
// within 4 km are one junction, and a strip end point may touch another
// strip's interior (T-junction). Merging keeps the lower node id's position
// and pulls touching polyline ends onto it, so drawn geometry continues
// through the junction.
void joinGraph(ModeGraph& m, double tol) {
  auto repoint = [&](int oldN, int newN) {
    for (auto& [a, b] : m.edgeNodes) {
      if (a == oldN) a = newN;
      if (b == oldN) b = newN;
    }
  };
  // dead[n] = the node this node was merged into (chain-resolved on use).
  std::vector<int> dead(m.nodePos.size(), -1);
  auto live = [&](int n) {
    while (dead[static_cast<size_t>(n)] >= 0) n = dead[static_cast<size_t>(n)];
    return n;
  };
  // Endpoint-to-endpoint merges within the tolerance, then T-joins (a live
  // node within the tolerance of another edge's interior splits that edge at
  // the touch point). Repeat until stable — splits create new nodes that may
  // themselves share endpoints with neighbours.
  bool changed = true;
  int guard = 0;
  while (changed && guard++ < 64) {
    changed = false;
    for (size_t i = 0; i < m.nodePos.size(); ++i) {
      if (dead[i] >= 0) continue;
      for (size_t k = i + 1; k < m.nodePos.size(); ++k) {
        if (dead[k] >= 0) continue;
        if (dist(m.nodePos[i], m.nodePos[k]) > tol) continue;
        repoint(static_cast<int>(k), static_cast<int>(i));
        dead[k] = static_cast<int>(i);
        for (size_t e = 0; e < m.edgePoly.size(); ++e) {
          if (dist(m.edgePoly[e].front(), m.nodePos[k]) <= tol)
            m.edgePoly[e].front() = m.nodePos[i];
          if (dist(m.edgePoly[e].back(), m.nodePos[k]) <= tol)
            m.edgePoly[e].back() = m.nodePos[i];
        }
        changed = true;
      }
    }
    for (size_t n = 0; n < m.nodePos.size() && !changed; ++n) {
      if (dead[n] >= 0) continue;
      const Pt p = m.nodePos[n];
      for (size_t e = 0; e < m.edgeNodes.size() && !changed; ++e) {
        const auto [a, b] = m.edgeNodes[e];
        if (live(a) == static_cast<int>(n) || live(b) == static_cast<int>(n)) continue;
        size_t seg = 1;
        double segBest = 1e18;
        Pt bestPt{};
        for (size_t i = 1; i < m.edgePoly[e].size(); ++i) {
          const Pt c = closestOnSegment(m.edgePoly[e][i - 1], m.edgePoly[e][i], p);
          const double dd = dist(c, p);
          if (dd < segBest) {
            segBest = dd;
            seg = i;
            bestPt = c;
          }
        }
        if (segBest > tol) continue;
        const int sn = m.addNode(bestPt);
        dead.resize(m.nodePos.size(), -1);  // addNode grew the node list
        const auto old = m.edgeNodes[e];
        std::vector<Pt> pts = m.edgePoly[e];
        std::vector<Pt> first(pts.begin(), pts.begin() + static_cast<long>(seg));
        first.push_back(bestPt);
        std::vector<Pt> second{bestPt};
        second.insert(second.end(), pts.begin() + static_cast<long>(seg), pts.end());
        m.edgeNodes[e] = {live(old.first), sn};
        m.edgePoly[e] = first;
        m.edgeNodes.push_back({sn, live(old.second)});
        m.edgePoly.push_back(second);
        m.speeds.push_back(m.speeds[e]);
        repoint(static_cast<int>(n), sn);
        dead[n] = sn;
        changed = true;
      }
    }
  }
}

void buildGraphs(const Drawn& d, GraphBuild& g, std::vector<HandDrawnGap>& gaps) {
  g.road.mode = Mode::Road;
  g.river.mode = Mode::River;
  g.sea.mode = Mode::Sea;
  for (const Strip& st : d.strips) {
    ModeGraph& m = st.mode == Mode::Road ? g.road : (st.mode == Mode::River ? g.river : g.sea);
    const int a = m.addNode(st.pts.front());
    const int b = m.addNode(st.pts.back());
    m.edgeNodes.push_back({a, b});
    m.edgePoly.push_back(st.pts);
    m.speeds.push_back(st.mode == Mode::Road ? kRoadKmh
                                             : (st.mode == Mode::River ? kRiverKmh : kSeaKmh));
  }
  joinGraph(g.road, kJoinKm);
  joinGraph(g.river, kJoinKm);
  joinGraph(g.sea, kJoinKm);
  // Sea lanes reaching the map edge share ONE ocean node — the overseas
  // gateway every port's lane connects through (off-map connectivity, per
  // the design spec's "sea lanes to the map edge are gateways").
  {
    ModeGraph& sea = g.sea;
    std::vector<int> edgeIds;
    for (size_t n = 0; n < sea.nodePos.size(); ++n) {
      const Pt& p = sea.nodePos[n];
      if (p.x < 1e-6 || p.y < 1e-6 || p.x > d.w - 1e-6 || p.y > d.h - 1e-6)
        edgeIds.push_back(static_cast<int>(n));
    }
    for (size_t k = 1; k < edgeIds.size(); ++k) {
      const int victim = edgeIds[k];
      const int ocean = edgeIds.front();
      for (auto& [a, b] : sea.edgeNodes) {
        if (a == victim) a = ocean;
        if (b == victim) b = ocean;
      }
      for (auto& pts : sea.edgePoly) {
        if (dist(pts.front(), sea.nodePos[victim]) <= 1e-6) pts.front() = sea.nodePos[ocean];
        if (dist(pts.back(), sea.nodePos[victim]) <= 1e-6) pts.back() = sea.nodePos[ocean];
      }
    }
  }
  // Site snap: the site is on a mode when any drawn point of that mode is
  // within 12 km. The site node splits the nearest strip at the closest point
  // on its polyline — the drawn geometry passes through unchanged.
  for (size_t s = 0; s < d.sites.size(); ++s) {
    const Pt site{d.sites[s].x, d.sites[s].y};
    for (ModeGraph* m : {&g.road, &g.river, &g.sea}) {
      double best = 1e18;
      size_t bestStrip = SIZE_MAX;
      Pt bestPt{};
      for (size_t e = 0; e < m->edgePoly.size(); ++e)
        for (size_t i = 1; i < m->edgePoly[e].size(); ++i) {
          const Pt c = closestOnSegment(m->edgePoly[e][i - 1], m->edgePoly[e][i], site);
          const double dd = dist(c, site);
          if (dd < best) {
            best = dd;
            bestStrip = e;
            bestPt = c;
          }
        }
      if (bestStrip == SIZE_MAX || best > kSnapKm) {
        if (m == &g.road)  // every site needs its road connection as drawn
          gaps.push_back({d.sites[s].name, "road connection",
                          "no road strip point within 12 km of the site as drawn"});
        continue;
      }
      // Split edge bestStrip at bestPt.
      const int sn = m->addNode(bestPt);
      const auto old = m->edgeNodes[bestStrip];
      std::vector<Pt> pts = m->edgePoly[bestStrip];
      size_t seg = 1;
      double segBest = 1e18;
      for (size_t i = 1; i < pts.size(); ++i) {
        const Pt c = closestOnSegment(pts[i - 1], pts[i], site);
        const double dd = dist(c, site);
        if (dd < segBest) {
          segBest = dd;
          seg = i;
        }
      }
      std::vector<Pt> first(pts.begin(), pts.begin() + static_cast<long>(seg));
      first.push_back(bestPt);
      std::vector<Pt> second{bestPt};
      second.insert(second.end(), pts.begin() + static_cast<long>(seg), pts.end());
      m->edgeNodes[bestStrip] = {old.first, sn};
      m->edgePoly[bestStrip] = first;
      m->edgeNodes.push_back({sn, old.second});
      m->edgePoly.push_back(second);
      m->speeds.push_back(m->speeds[bestStrip]);
      m->siteNode[s] = sn;
    }
  }
}

// Shortest path over one mode graph (Dijkstra on arc length). Returns the
// total km and the node walk; distance < 0 when unreachable.
double shortestPath(const ModeGraph& m, int from, int to, std::vector<int>& walk) {
  walk.clear();
  if (from < 0 || to < 0) return -1.0;
  if (from == to) {
    walk.push_back(from);
    return 0.0;
  }
  std::vector<double> best(m.nodePos.size(), 1e18);
  std::vector<int> prev(m.nodePos.size(), -1);
  std::priority_queue<std::pair<double, int>, std::vector<std::pair<double, int>>,
                      std::greater<>> pq;
  best[static_cast<size_t>(from)] = 0;
  pq.push({0.0, from});
  while (!pq.empty()) {
    const auto [dcur, cur] = pq.top();
    pq.pop();
    if (dcur > best[static_cast<size_t>(cur)]) continue;
    for (size_t e = 0; e < m.edgeNodes.size(); ++e) {
      const auto [a, b] = m.edgeNodes[e];
      const int nxt = a == cur ? b : (b == cur ? a : -1);
      if (nxt < 0) continue;
      const double w = arcLength(m.edgePoly[e]);
      if (dcur + w < best[static_cast<size_t>(nxt)]) {
        best[static_cast<size_t>(nxt)] = dcur + w;
        prev[static_cast<size_t>(nxt)] = cur;
        pq.push({dcur + w, nxt});
      }
    }
  }
  if (best[static_cast<size_t>(to)] >= 1e18) return -1.0;
  for (int n = to; n >= 0; n = prev[static_cast<size_t>(n)]) walk.push_back(n);
  std::reverse(walk.begin(), walk.end());
  return best[static_cast<size_t>(to)];
}

// Vehicle class per mode and material phase (the drawn network decides the
// mode; the phase picks the class, e.g. pellets on a truck, chemicals a tank).
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

}  // namespace

bool loadHandDrawnWorld(const std::string& jsonPath, const CatalogView& catalog,
                        GeneratedWorld& out, std::vector<HandDrawnGap>& gaps,
                        std::string& error) {
  Drawn d;
  parseDrawn(jsonPath, d, error);
  if (!error.empty()) return false;
  if (d.sites.empty()) {
    error = "hand-drawn world has no sites";
    return false;
  }

  // ---- geometry: joined route graphs, site snaps, overseas gateway ----
  GraphBuild g;
  buildGraphs(d, g, gaps);

  out = GeneratedWorld{};
  out.seed = 0;  // the drawn world is seedless

  auto pushPoly = [&](const std::vector<Pt>& pts) -> Range<uint32_t> {
    const auto begin = static_cast<uint32_t>(out.polyline_xy.size() / 2);
    for (const Pt& p : pts) {
      out.polyline_xy.push_back(static_cast<float>(p.x));
      out.polyline_xy.push_back(static_cast<float>(p.y));
    }
    return Range<uint32_t>{begin, static_cast<uint32_t>(pts.size())};
  };

  auto emitGraph = [&](const ModeGraph& m) {
    for (size_t i = 0; i < m.nodePos.size(); ++i) {
      WNode n;
      n.x_km = static_cast<float>(m.nodePos[i].x);
      n.y_km = static_cast<float>(m.nodePos[i].y);
      out.nodes.push_back(n);
    }
    const size_t base = out.nodes.size() - m.nodePos.size();
    for (size_t e = 0; e < m.edgeNodes.size(); ++e) {
      WEdge we;
      we.a = NodeId{static_cast<uint32_t>(base + m.edgeNodes[e].first)};
      we.b = NodeId{static_cast<uint32_t>(base + m.edgeNodes[e].second)};
      we.mode = m.mode;
      we.speed_kmh = m.speeds[e];
      we.length_km = static_cast<float>(arcLength(m.edgePoly[e]));
      we.polyline = pushPoly(m.edgePoly[e]);
      out.edges.push_back(we);
    }
  };
  emitGraph(g.road);
  emitGraph(g.river);
  emitGraph(g.sea);

  // Sites in drawn id order.
  std::map<int, size_t> siteIdx;  // drawn id → index
  for (size_t s = 0; s < d.sites.size(); ++s) {
    const Drawn::Site& ds = d.sites[s];
    siteIdx[ds.id] = s;
    WSite ws;
    ws.name = ds.name;
    ws.preset = ds.preset;
    ws.x_km = static_cast<float>(ds.x);
    ws.y_km = static_cast<float>(ds.y);
    out.sites.push_back(ws);
  }
  auto modeBase = [&](const ModeGraph& m) {
    size_t base = 0;
    if (m.mode == Mode::River) base = g.road.nodePos.size();
    if (m.mode == Mode::Sea) base = g.road.nodePos.size() + g.river.nodePos.size();
    return static_cast<uint32_t>(base);
  };
  for (size_t s = 0; s < d.sites.size(); ++s) {
    if (const auto it = g.road.siteNode.find(s); it != g.road.siteNode.end())
      out.sites[s].node[0] = NodeId{modeBase(g.road) + static_cast<uint32_t>(it->second)};
    if (const auto it = g.river.siteNode.find(s); it != g.river.siteNode.end())
      out.sites[s].node[1] = NodeId{modeBase(g.river) + static_cast<uint32_t>(it->second)};
    if (const auto it = g.sea.siteNode.find(s); it != g.sea.siteNode.end())
      out.sites[s].node[2] = NodeId{modeBase(g.sea) + static_cast<uint32_t>(it->second)};
  }
  // Overseas gateway: a sea strip end point on the map edge (imports and
  // exports enter and leave there). Nearest to the coast graphics wins among
  // the drawn candidates; ties break by lowest node id for determinism.
  {
    const uint32_t seaBase = modeBase(g.sea);
    for (size_t n = 0; n < g.sea.nodePos.size(); ++n) {
      const Pt& p = g.sea.nodePos[n];
      if (p.x < 1e-6 || p.y < 1e-6 || p.x > d.w - 1e-6 || p.y > d.h - 1e-6) {
        out.overseas_node = NodeId{seaBase + static_cast<uint32_t>(n)};
        break;
      }
    }
  }

  // Terrain frame: the sea edge with the most water cells and the assembled
  // river polyline from the drawn river strips (chain greedily from the
  // first strip whose start touches no other strip's end — the drawn river
  // is one chain).
  {
    // Sea edge vote needs the water grid; the drawn file lists water cells
    // only in the design source, so pick by the sea strips' own edge exits.
    int votes[4] = {0, 0, 0, 0};
    for (const Strip& st : d.strips) {
      if (st.mode != Mode::Sea || st.pts.empty()) continue;
      for (const Pt& p : st.pts) {
        if (p.y >= d.h - 1e-6) votes[0]++;
        if (p.y <= 1e-6) votes[1]++;
        if (p.x >= d.w - 1e-6) votes[2]++;
        if (p.x <= 1e-6) votes[3]++;
      }
    }
    out.sea_edge = static_cast<int>(std::max_element(votes, votes + 4) - votes);
    // River: chain the river strips into one polyline.
    std::vector<std::vector<Pt>> rest;
    for (const Strip& st : d.strips)
      if (st.mode == Mode::River) rest.push_back(st.pts);
    if (!rest.empty()) {
      std::vector<Pt> river = rest.front();
      rest.erase(rest.begin());
      bool grew = true;
      while (grew && !rest.empty()) {
        grew = false;
        for (size_t i = 0; i < rest.size(); ++i) {
          const Pt& head = river.front();
          const Pt& tail = river.back();
          const Pt& a0 = rest[i].front();
          const Pt& a1 = rest[i].back();
          if (dist(tail, a0) <= kJoinKm) {
            river.insert(river.end(), rest[i].begin() + 1, rest[i].end());
          } else if (dist(tail, a1) <= kJoinKm) {
            river.insert(river.end(), rest[i].rbegin(), rest[i].rend() - 1);
          } else if (dist(head, a1) <= kJoinKm) {
            river.insert(river.begin(), rest[i].begin(), rest[i].end() - 1);
          } else if (dist(head, a0) <= kJoinKm) {
            river.insert(river.begin(), rest[i].rbegin() + 1, rest[i].rend());
          } else {
            continue;
          }
          rest.erase(rest.begin() + static_cast<long>(i));
          grew = true;
          break;
        }
      }
      for (const Pt& p : river) {
        out.river_xy.push_back(static_cast<float>(p.x));
        out.river_xy.push_back(static_cast<float>(p.y));
      }
    }
  }

  // ---- catalog handles ----
  auto proc = [&](const char* k) { return catalog.process(k); };
  const ProcessInfo* ngl = proc("NGL_RECOVERY");
  const ProcessInfo* distill = proc("CRUDE_DISTILLATION");
  const ProcessInfo* reforming = proc("REFORMING");
  const ProcessInfo* fcc = proc("FCC");
  const ProcessInfo* hdt = proc("DIESEL_HDT");
  const ProcessInfo* gasCracker = proc("OLEFINS_GAS");
  const ProcessInfo* flexCracker = proc("OLEFINS_FLEX");
  const ProcessInfo* electrolysis = proc("ELECTROLYSIS");
  const ProcessInfo* pePoly = proc("PE_POLYMERISATION");
  const ProcessInfo* ppPoly = proc("PP_POLYMERISATION");
  const ProcessInfo* vcmProc = proc("VCM");
  const ProcessInfo* pvcProc = proc("PVC");
  const ProcessInfo* styreneProc = proc("STYRENE");
  const ProcessInfo* psProc = proc("PS");
  if (ngl == nullptr || distill == nullptr || reforming == nullptr || fcc == nullptr ||
      hdt == nullptr || gasCracker == nullptr || flexCracker == nullptr ||
      electrolysis == nullptr || pePoly == nullptr || ppPoly == nullptr ||
      vcmProc == nullptr || pvcProc == nullptr || styreneProc == nullptr || psProc == nullptr) {
    error = "catalog lacks a process type the hand-drawn world needs";
    return false;
  }
  auto yield = [](const ProcessInfo* p, size_t mode, const char* material, bool producer) {
    if (p == nullptr || mode >= p->by_mode.size()) return 0.0;
    const NetRecipe& r = p->by_mode[mode];
    for (const NetStream& s : producer ? r.out : r.in)
      if (s.material == material) return s.t_per_t;
    return 0.0;
  };
  // Material ids index tank_of (the bridge assigns per material id).
  std::map<std::string, size_t> matId;
  for (size_t m = 0; m < catalog.materials.size(); ++m) matId[catalog.materials[m].key] = m;
  auto phaseOf = [&](const std::string& key) {
    const MaterialInfo* mi = catalog.material(key);
    return mi != nullptr ? mi->phase : Phase::Liquid;
  };
  auto isPseudo = [&](const std::string& key) {
    const MaterialInfo* mi = catalog.material(key);
    return mi == nullptr || mi->kind != MatKind::Traded;
  };

  // ---- forward pass: rates in supply order (hand, per the brief) ----
  const double oilA = 480.0;    // CRUDE t/h, pipeline to the refinery as drawn
  const double oilB = 380.0;    // CRUDE t/h, pipeline to the refinery as drawn
  const double rawGas = 640.0;  // RAW_GAS t/h, pipeline to the gas plant as drawn
  const double caBasis = 50.0;  // ELECTROLYSIS basis t/h (CHLORINE)
  const double gasCrackerBasis = 30.0;  // hand: the ethane pipe split
  const double flexBasis = 100.0;       // hand: ethylene draws cap the flex cracker
  // Flex cracker mode shares (ETHANE, LPG, NAPHTHA): ethane is piped as
  // drawn; the LPG and naphtha legs arrive over the drawn network.
  const double flexShare[3] = {0.18, 0.41, 0.41};

  const double crude = oilA + oilB;  // the refinery distills all drawn crude
  const double heavyNaphtha = yield(distill, 0, "HEAVY_NAPHTHA", true) * crude;
  const double gasoil = yield(distill, 0, "GASOIL", true) * crude;
  const double vgo = yield(distill, 0, "VGO", true) * crude;
  const double reformBasis = heavyNaphtha;  // takes all of it
  const double hdtBasis = gasoil / yield(hdt, 0, "GASOIL", false);
  const double fccBasis = vgo;              // takes all of it
  const double methane = yield(ngl, 0, "METHANE", true) * rawGas;
  const double ethaneTotal = yield(ngl, 0, "ETHANE", true) * rawGas;
  if (ethaneTotal <
      flexShare[0] * flexBasis + gasCrackerBasis * yield(gasCracker, 0, "ETHANE", false))
    gaps.push_back({"Gas plant", "ETHANE capacity",
                    "the drawn ethane pipes draw more than the gas plant makes"});
  const double nglLpg = yield(ngl, 0, "LPG", true) * rawGas;
  const double nglNaphtha = yield(ngl, 0, "NAPHTHA", true) * rawGas;
  const double gasEthylene = yield(gasCracker, 0, "ETHYLENE", true) * gasCrackerBasis;
  const double flexEthylene =
      (flexShare[0] * yield(flexCracker, 0, "ETHYLENE", true) +
       flexShare[1] * yield(flexCracker, 1, "ETHYLENE", true) +
       flexShare[2] * yield(flexCracker, 2, "ETHYLENE", true)) * flexBasis;
  // Vinyls first (chlorine-limited), styrenics its benzene-limited ethylene
  // draw; the vinyls pipe carries the rest of the flex ethylene.
  const double vcmBasis = caBasis / yield(vcmProc, 0, "CHLORINE", false);
  const double benzeneRefinery = yield(reforming, 0, "BENZENE", true) * reformBasis;
  const double benzeneFlex =
      (flexShare[1] * yield(flexCracker, 1, "BENZENE", true) +
       flexShare[2] * yield(flexCracker, 2, "BENZENE", true)) * flexBasis;
  const double styreneBasis =
      std::min((benzeneRefinery + benzeneFlex) / yield(styreneProc, 0, "BENZENE", false),
               flexEthylene / yield(styreneProc, 0, "ETHYLENE", false));
  const double styreneOut = styreneBasis * yield(styreneProc, 0, "STYRENE", true);
  const double styreneEthyleneDraw = styreneBasis * yield(styreneProc, 0, "ETHYLENE", false);
  const double ethyleneToVinyls = flexEthylene - styreneEthyleneDraw;
  const double peBasis = gasEthylene / yield(pePoly, 0, "ETHYLENE", false);
  const double peOut = peBasis * yield(pePoly, 0, "PE", true);
  const double propylene = yield(fcc, 0, "PROPYLENE", true) * fccBasis +
                           (flexShare[1] * yield(flexCracker, 1, "PROPYLENE", true) +
                            flexShare[2] * yield(flexCracker, 2, "PROPYLENE", true)) * flexBasis +
                           yield(gasCracker, 0, "PROPYLENE", true) * gasCrackerBasis;
  const double ppBasis = propylene / yield(ppPoly, 0, "PROPYLENE", false);
  const double ppOut = ppBasis * yield(ppPoly, 0, "PP", true);
  const double pvcBasis = vcmBasis * yield(vcmProc, 0, "VCM", true) /
                          yield(pvcProc, 0, "VCM", false);
  const double pvcOut = pvcBasis * yield(pvcProc, 0, "PVC", true);
  // Styrene splits: 40% ships to paints, the rest feeds the PS plant.
  const double styreneToPaints = styreneOut * 0.4;
  const double psBasis = (styreneOut - styreneToPaints) / yield(psProc, 0, "STYRENE", false);
  const double psOut = psBasis * yield(psProc, 0, "PS", true);
  const double caustic = caBasis * yield(electrolysis, 0, "CAUSTIC", true);
  const double salt = caBasis * yield(electrolysis, 0, "SALT", false);
  const double gasolineRefinery = yield(reforming, 0, "GASOLINE", true) * reformBasis +
                                  yield(fcc, 0, "GASOLINE", true) * fccBasis;
  const double gasolineCrackers =
      (flexShare[1] * yield(flexCracker, 1, "GASOLINE", true) +
       flexShare[2] * yield(flexCracker, 2, "GASOLINE", true)) * flexBasis +
      yield(gasCracker, 0, "GASOLINE", true) * gasCrackerBasis;
  const double diesel = yield(hdt, 0, "DIESEL", true) * hdtBasis +
                        yield(fcc, 0, "DIESEL", true) * fccBasis;
  const double jet = yield(distill, 0, "JET", true) * crude;
  const double fuelOil = yield(distill, 0, "FUEL_OIL", true) * crude +
                         yield(fcc, 0, "FUEL_OIL", true) * fccBasis;
  const double solventRefinery = yield(reforming, 0, "SOLVENT", true) * reformBasis;
  const double solventStyrenics = styreneBasis * yield(styreneProc, 0, "SOLVENT", true);
  const double distLpg = yield(distill, 0, "LPG", true) * crude;
  const double reformLpg = yield(reforming, 0, "LPG", true) * reformBasis;
  const double fccLpg = yield(fcc, 0, "LPG", true) * fccBasis;
  const double refineryLpg = distLpg + reformLpg + fccLpg;
  const double distNaphtha = yield(distill, 0, "NAPHTHA", true) * crude;
  const double naphthaFlexFeed = flexShare[2] * flexBasis;
  const double lpgFlexFeed = flexShare[1] * flexBasis;
  const double bunker = 60.0;  // hand: the port bunker takes this much fuel oil
  // Depot shares of the refinery's fuels (hand).
  const double depotGasoline = gasolineRefinery * 0.35;
  const double depotDiesel = diesel * 0.40;
  const double depotJet = jet * 0.30;
  const double depotLpg = 20.0;

  // ---- flow plan: pipelines as drawn, everything else over the networks ----
  auto si = [&](const char* name) -> int {
    for (size_t s = 0; s < d.sites.size(); ++s)
      if (d.sites[s].name == name) return static_cast<int>(s);
    return -1;
  };
  const int iOilA = si("Oil field"), iOilB = si("Oil field B"), iGasField = si("Gas field"),
            iSaltMine = si("Salt mine"), iGasPlant = si("Gas plant"), iRefinery = si("Refinery"),
            iCrackerGas = si("Steam cracker (ethane)"),
            iFlex = si("Steam cracker (flex)"), iCA = si("Chlor-alkali"),
            iPE = si("Polyethylene"), iPP = si("Polypropylene"), iVinyls = si("Vinyls (VCM + PVC)"),
            iStyrenics = si("Styrenics"), iDepot = si("Fuel depot"), iGasGrid = si("Gas grid"),
            iPackaging = si("Packaging"), iConstruction = si("Construction"),
            iConsumer = si("Consumer goods"), iPaints = si("Paints and coatings"),
            iProcessInd = si("Process industries"), iPortA = si("Port terminal"),
            iPortB = si("Port terminal B");
  for (const int i : {iOilA, iOilB, iGasField, iSaltMine, iGasPlant, iRefinery, iCrackerGas,
                      iFlex, iCA, iPE, iPP, iVinyls, iStyrenics, iDepot, iGasGrid, iPackaging,
                      iConstruction, iConsumer, iPaints, iProcessInd, iPortA, iPortB}) {
    if (i < 0) {
      error = "hand-drawn world file lacks a site the loader plan names";
      return false;
    }
  }

  // Rates for the drawn pipelines (from/to/material must match a drawn pipe).
  struct PipeRate { int from, to; const char* material; double t_h; };
  const std::vector<PipeRate> pipeRates{
      {iOilA, iRefinery, "CRUDE", oilA},
      {iOilB, iRefinery, "CRUDE", oilB},
      {iGasField, iGasPlant, "RAW_GAS", rawGas},
      {iGasPlant, iGasGrid, "METHANE", methane},
      {iGasPlant, iCrackerGas, "ETHANE",
       gasCrackerBasis * yield(gasCracker, 0, "ETHANE", false)},
      {iGasPlant, iFlex, "ETHANE", flexShare[0] * flexBasis},
      {iCrackerGas, iPE, "ETHYLENE", gasEthylene},
      {iFlex, iVinyls, "ETHYLENE", ethyleneToVinyls},
      {iFlex, iStyrenics, "ETHYLENE", styreneEthyleneDraw},
  };
  if (pipeRates.size() != d.pipes.size())
    gaps.push_back({"", "pipeline plan",
                    "the drawn file has " + std::to_string(d.pipes.size()) +
                        " pipelines but the loader plan rates " +
                        std::to_string(pipeRates.size())});

  struct Flow {
    std::string material;
    int from, to;  // site indices
    double t_h;    // tonnage per hour the seller ships
    Mode mode;     // the drawn network the vehicle uses
  };
  std::vector<Flow> flows{
      {"SALT", iSaltMine, iCA, salt, Mode::Road},
      {"CHLORINE", iCA, iVinyls, caBasis, Mode::Road},
      // Liquids ride the drawn river when both ends are river-adjacent
      // (barge), the sea lanes for export legs (ship), and trucks only for
      // short urban legs — per the four-mode plan.
      {"NAPHTHA", iRefinery, iFlex, naphthaFlexFeed, Mode::River},
      {"LPG", iGasPlant, iFlex, lpgFlexFeed, Mode::River},
      {"BENZENE", iRefinery, iStyrenics, benzeneRefinery, Mode::Road},
      {"BENZENE", iFlex, iStyrenics, benzeneFlex, Mode::Road},
      // Propylene moves by pipeline only (catalog P-only); no pipeline to the
      // polypropylene plant is drawn — recorded as a gap below.
      {"PE", iPE, iPackaging, peOut, Mode::Road},
      {"PP", iPP, iPackaging, ppOut * 0.5, Mode::Road},
      {"PP", iPP, iConsumer, ppOut * 0.5, Mode::Road},
      {"PVC", iVinyls, iConstruction, pvcOut, Mode::Road},
      {"PS", iStyrenics, iConsumer, psOut, Mode::Road},
      {"STYRENE", iStyrenics, iPaints, styreneToPaints, Mode::Road},
      {"SOLVENT", iRefinery, iPaints, solventRefinery, Mode::Road},
      {"SOLVENT", iStyrenics, iPaints, solventStyrenics, Mode::Road},
      {"CAUSTIC", iCA, iProcessInd, caustic, Mode::River},
      {"GASOLINE", iRefinery, iDepot, depotGasoline, Mode::River},
      {"DIESEL", iRefinery, iDepot, depotDiesel, Mode::River},
      {"JET", iRefinery, iDepot, depotJet, Mode::River},
      {"LPG", iRefinery, iDepot, depotLpg, Mode::River},
      // Export legs: the gas plant and refinery surpluses to the ports.
      {"NAPHTHA", iGasPlant, iPortA, nglNaphtha, Mode::Sea},
      {"LPG", iGasPlant, iPortA, nglLpg - lpgFlexFeed, Mode::Sea},
      {"NAPHTHA", iRefinery, iPortA, distNaphtha - naphthaFlexFeed, Mode::Sea},
      {"LPG", iRefinery, iPortA, refineryLpg - depotLpg, Mode::Sea},
      {"GASOLINE", iRefinery, iPortB, gasolineRefinery - depotGasoline, Mode::Sea},
      {"DIESEL", iRefinery, iPortB, diesel - depotDiesel, Mode::Sea},
      {"JET", iRefinery, iPortB, jet - depotJet, Mode::Sea},
      {"FUEL_OIL", iRefinery, iPortA, fuelOil, Mode::Sea},
      // Cracker byproduct surpluses ride the road network to the nearest
      // port by drawn distance (deterministic, no fabricated routes).
      {"LPG", iCrackerGas, iPortA, yield(gasCracker, 0, "LPG", true) * gasCrackerBasis,
       Mode::Sea},
      {"BENZENE", iCrackerGas, iPortA,
       yield(gasCracker, 0, "BENZENE", true) * gasCrackerBasis, Mode::Sea},
      {"GASOLINE", iCrackerGas, iPortA,
       yield(gasCracker, 0, "GASOLINE", true) * gasCrackerBasis, Mode::Sea},
      {"FUEL_OIL", iCrackerGas, iPortA,
       yield(gasCracker, 0, "FUEL_OIL", true) * gasCrackerBasis, Mode::Sea},
      {"GASOLINE", iFlex, iPortB, gasolineCrackers - gasolineCrackers * 0.0, Mode::Sea},
      {"FUEL_OIL", iFlex, iPortB,
       (flexShare[0] * yield(flexCracker, 0, "FUEL_OIL", true) +
        flexShare[1] * yield(flexCracker, 1, "FUEL_OIL", true) +
        flexShare[2] * yield(flexCracker, 2, "FUEL_OIL", true)) * flexBasis, Mode::Road},
  };
  // Small cracker surpluses go to the nearer port as drawn (Euclidean on the
  // drawn site coordinates — the fleet still routes over the drawn network).
  {
    const Pt pa{d.sites[static_cast<size_t>(iPortA)].x, d.sites[static_cast<size_t>(iPortA)].y};
    const Pt pb{d.sites[static_cast<size_t>(iPortB)].x, d.sites[static_cast<size_t>(iPortB)].y};
    for (Flow& f : flows) {
      if (f.to != iPortA && f.to != iPortB) continue;
      // Keep the explicit refinery/gas-plant splits; retarget only the
      // cracker byproduct rows (marked by their small rates elsewhere).
      if (f.from != iCrackerGas && f.from != iFlex) continue;
      const Pt p0{d.sites[static_cast<size_t>(f.from)].x, d.sites[static_cast<size_t>(f.from)].y};
      f.to = dist(p0, pa) <= dist(p0, pb) ? iPortA : iPortB;
    }
  }
  // Propylene is pipeline-only in the catalog and no pipeline reaches the
  // polypropylene plant: unusable as drawn. The plant still exists (as
  // drawn) and starves after its tank cover — the acceptance run reports it.
  gaps.push_back({"Polypropylene", "PROPYLENE feed",
                  "no drawn pipeline and propylene is pipeline-only in the catalog; the "
                  "polypropylene chain is unsuppliable as drawn — minimal fix: one drawn "
                  "pipeline from a steam cracker"});

  std::map<std::pair<int, int>, int> vehBySiteMode;  // (site, mode) → vehicles
  // Validate every vehicle flow against the drawn topology BEFORE anything
  // is built: the gap list is the brief's primary output.
  for (const Flow& f : flows) {
    const ModeGraph& m = f.mode == Mode::Road ? g.road : (f.mode == Mode::River ? g.river : g.sea);
    const auto itF = m.siteNode.find(static_cast<size_t>(f.from));
    const auto itT = m.siteNode.find(static_cast<size_t>(f.to));
    std::vector<int> walk;
    const double km = shortestPath(m, itF == m.siteNode.end() ? -1 : itF->second,
                                   itT == m.siteNode.end() ? -1 : itT->second, walk);
    if (km < 0)
      gaps.push_back({d.sites[static_cast<size_t>(f.from)].name, f.material + " transport",
                      std::string("no drawn ") + (f.mode == Mode::Road ? "road" : "sea") +
                          " route to " + d.sites[static_cast<size_t>(f.to)].name});
  }

  // ---- site instantiation: processes, tanks, units ----
  // Per-site process plan: preset key decides the process list (the drawn
  // preset column); rates come from the forward pass by site name.
  struct SiteRate { const char* site; const char* type; double rate; };
  const std::vector<SiteRate> rates{
      {"Oil field", "OIL_PRODUCTION", oilA},
      {"Oil field B", "OIL_PRODUCTION", oilB},
      {"Gas field", "GAS_PRODUCTION", rawGas},
      {"Salt mine", "SALT_MINING", salt},
      {"Gas plant", "NGL_RECOVERY", rawGas},
      {"Refinery", "CRUDE_DISTILLATION", crude},
      {"Refinery", "REFORMING", reformBasis},
      {"Refinery", "DIESEL_HDT", hdtBasis},
      {"Refinery", "FCC", fccBasis},
      {"Steam cracker (ethane)", "OLEFINS_GAS", gasCrackerBasis},
      {"Steam cracker (flex)", "OLEFINS_FLEX", flexBasis},
      {"Chlor-alkali", "ELECTROLYSIS", caBasis},
      {"Polyethylene", "PE_POLYMERISATION", peBasis},
      {"Polypropylene", "PP_POLYMERISATION", ppBasis},
      {"Vinyls (VCM + PVC)", "VCM", vcmBasis},
      {"Vinyls (VCM + PVC)", "PVC", pvcBasis},
      {"Styrenics", "STYRENE", styreneBasis},
      {"Styrenics", "PS", psBasis},
      {"Fuel depot", "FUEL_DEPOT_GASOLINE", depotGasoline},
      {"Fuel depot", "FUEL_DEPOT_DIESEL", depotDiesel},
      {"Fuel depot", "FUEL_DEPOT_JET", depotJet},
      {"Fuel depot", "FUEL_DEPOT_LPG", depotLpg},
      {"Gas grid", "GAS_GRID_METHANE", methane},
      {"Packaging", "PACKAGING_PE", peOut},
      {"Packaging", "PACKAGING_PP", ppOut * 0.5},
      {"Construction", "CONSTRUCTION_PVC", pvcBasis},
      {"Consumer goods", "CONSUMER_GOODS_PS", psBasis},
      {"Consumer goods", "CONSUMER_GOODS_PP", ppOut * 0.5},
      {"Paints and coatings", "PAINTS_SOLVENT", solventRefinery + solventStyrenics},
      {"Paints and coatings", "PAINTS_STYRENE", styreneToPaints},
      {"Process industries", "PROCESS_INDUSTRIES_CAUSTIC", caustic},
  };
  // Port export/bunker sinks take the surpluses assigned above, split by the
  // port the flows name.
  std::map<std::pair<int, std::string>, double> portIn;  // (site, material) → t/h
  for (const Flow& f : flows)
    if (f.to == iPortA || f.to == iPortB) portIn[{f.to, f.material}] += f.t_h;
  const std::map<std::string, std::string> exportSink{
      {"LPG", "PORT_EXPORT_LPG"},     {"NAPHTHA", "PORT_EXPORT_NAPHTHA"},
      {"GASOLINE", "PORT_EXPORT_GASOLINE"}, {"DIESEL", "PORT_EXPORT_DIESEL"},
      {"JET", "PORT_EXPORT_JET"},     {"FUEL_OIL", "PORT_EXPORT_FUEL_OIL"},
      {"PROPYLENE", "PORT_EXPORT_PROPYLENE"}, {"ETHANE", "PORT_EXPORT_ETHANE"},
      {"ETHYLENE", "PORT_EXPORT_ETHYLENE"}, {"BENZENE", "PORT_EXPORT_BENZENE"},
      {"SOLVENT", "PORT_EXPORT_SOLVENT"}, {"STYRENE", "PORT_EXPORT_STYRENE"},
      {"CAUSTIC", "PORT_EXPORT_CAUSTIC"}, {"PE", "PORT_EXPORT_PE"},
      {"PP", "PORT_EXPORT_PP"},       {"PVC", "PORT_EXPORT_PVC"},
      {"PS", "PORT_EXPORT_PS"},
  };
  std::vector<SiteRate> portRates;
  for (const auto& [key, t_h] : portIn) {
    const int port = key.first;
    const std::string& material = key.second;
    if (material == "FUEL_OIL" && port == iPortA)
      portRates.push_back({d.sites[static_cast<size_t>(port)].name.c_str(),
                           "PORT_BUNKER_FUEL_OIL", bunker});
    const auto it = exportSink.find(material);
    if (it == exportSink.end()) {
      gaps.push_back({d.sites[static_cast<size_t>(port)].name, material + " export sink",
                      "the catalog defines no port export sink for this material"});
      continue;
    }
    const double exportRate = material == "FUEL_OIL" && port == iPortA ? t_h - bunker : t_h;
    if (exportRate > 1e-9)
      portRates.push_back({d.sites[static_cast<size_t>(port)].name.c_str(), it->second.c_str(),
                           exportRate});
  }
  // The port sink names live only on the port the flows reach; drop rows for
  // materials the other port also lists (both ports can take the same sink
  // type — the plan keys on (site, material), so no dedup is needed).

  // Create sites' processes and tanks.
  auto presetOf = [&](const std::string& key) { return catalog.preset(key); };
  std::map<std::pair<int, std::string>, int> tankAt;  // (site, material) → tank id
  std::map<std::pair<int, std::string>, int> procAt;  // (site, process type) → process id
  auto addTank = [&](int site, const std::string& material, TankRole role, double inRate, double outRate,
                     bool pipedIn, bool pipedOut, double coverOverride) {
    const auto key = std::make_pair(site, material);
    if (tankAt.count(key) != 0) {
      WTank& t = out.tanks[static_cast<size_t>(tankAt[key])];
      t.design_in_t_h += inRate;
      t.design_out_t_h += outRate;
      t.piped_in = t.piped_in || pipedIn;
      t.piped_out = t.piped_out || pipedOut;
      if (t.role == TankRole::Feed && role == TankRole::Product) t.role = TankRole::Both;
      if (t.role == TankRole::Product && role == TankRole::Feed) t.role = TankRole::Both;
      return tankAt[key];
    }
    const PresetInfo* ps = presetOf(d.sites[static_cast<size_t>(site)].preset);
    double cover = 7.0;
    if (coverOverride > 0) {
      cover = coverOverride;
    } else if (ps != nullptr) {
      if (role == TankRole::Feed) cover = ps->cover_feed_d;
      else if (role == TankRole::Product) cover = ps->cover_product_d;
      else cover = ps->cover_internal_d;
      if (const auto cm = ps->cover_by_material.find(material); cm != ps->cover_by_material.end())
        cover = cm->second;
    }
    WTank t;
    t.site = SiteId{static_cast<uint32_t>(site)};
    t.material = material;
    t.role = role;
    t.design_in_t_h = inRate;
    t.design_out_t_h = outRate;
    t.piped_in = pipedIn;
    t.piped_out = pipedOut;
    t.capacity_t = kSpare * 24.0 * std::max(inRate, outRate) * cover;
    t.target_frac = 2.0 / 3.0;
    const int id = static_cast<int>(out.tanks.size());
    out.tanks.push_back(t);
    tankAt[key] = id;
    return id;
  };
  auto addProcess = [&](int site, const std::string& type, double rate,
                        const std::vector<double>& shares) -> int {
    WProcess np;
    np.site = SiteId{static_cast<uint32_t>(site)};
    np.type = type;
    np.design_rate_t_h = rate;
    np.schedule = 0;  // flat demand/supply
    np.mode_share = shares;
    const int id = static_cast<int>(out.processes.size());
    out.processes.push_back(np);
    procAt[{site, type}] = id;
    return id;
  };

  // Process tank wiring: one tank per non-pseudo stream material of the
  // process's nets (feed side in, product side out), per the view.
  auto wireProcess = [&](int pid, const ProcessInfo* info) {
    WProcess& p = out.processes[static_cast<size_t>(pid)];
    const int site = static_cast<int>(p.site.v);
    p.tank_of.assign(catalog.materials.size(), TankId{});
    for (size_t mode = 0; mode < info->by_mode.size(); ++mode) {
      const NetRecipe& r = info->by_mode[mode];
      for (const NetStream& s : r.in) {
        if (isPseudo(s.material)) continue;
        const int t = addTank(site, s.material, TankRole::Feed, 0, 0, false, false, 0);
        p.tank_of[matId[s.material]] = TankId{static_cast<uint32_t>(t)};
      }
      for (const NetStream& s : r.out) {
        if (isPseudo(s.material)) continue;
        const int t = addTank(site, s.material, TankRole::Product, 0, 0, false, false, 0);
        p.tank_of[matId[s.material]] = TankId{static_cast<uint32_t>(t)};
      }
    }
  };

  // Pass 1: processes with rates and preset unit trains.
  auto applyRate = [&](const SiteRate& r) {
    const auto it = std::find_if(d.sites.begin(), d.sites.end(),
                                 [&](const Drawn::Site& s) { return s.name == r.site; });
    if (it == d.sites.end()) return;
    const int site = static_cast<int>(std::distance(d.sites.begin(), it));
    const ProcessInfo* info = proc(r.type);
    if (info == nullptr) {
      gaps.push_back({r.site, std::string("process ") + r.type,
                      "the catalog defines no such process type"});
      return;
    }
    std::vector<double> shares;
    if (info->modes.size() > 1) {
      shares.assign(info->modes.size(), 0.0);
      if (info->modes.size() == 3 && std::strcmp(info->modes[0].c_str(), "ETHANE") == 0)
        std::copy(flexShare, flexShare + 3, shares.begin());
      else
        std::fill(shares.begin(), shares.end(), 1.0 / static_cast<double>(shares.size()));
    }
    const int pid = addProcess(site, r.type, r.rate, shares);
    wireProcess(pid, info);
  };
  for (const SiteRate& r : rates) applyRate(r);
  for (const SiteRate& r : portRates) applyRate(r);

  // Port sink tanks hold 1.5 days of cover, not the preset 7: an export
  // outlet is an optional sink, and a week-sized target orders tens of
  // thousands of tonnes that wedge the whole fleet at the port berths.
  for (WTank& t : out.tanks)
    if (t.site.v == static_cast<uint32_t>(iPortA) || t.site.v == static_cast<uint32_t>(iPortB))
      t.capacity_t = std::min(t.capacity_t, kSpare * 24.0 * std::max(t.design_in_t_h, t.design_out_t_h) * 1.5);

  // Pass 2: units and per-process tank flow sizing. Tank design flows come
  // from the process nets × the design rate (feed in, product out), so tank
  // capacities and cover hold for every stream the site touches.
  for (WProcess& p : out.processes) {
    const ProcessInfo* info = proc(p.type.c_str());
    if (info == nullptr) continue;
    size_t unitBegin = out.units.size();
    for (size_t u = 0; u < info->units.size(); ++u) {
      WUnit wu;
      wu.process = ProcessId{static_cast<uint32_t>(&p - out.processes.data())};
      wu.slot = static_cast<uint8_t>(u);
      wu.cap_per_train_t_h = p.design_rate_t_h /
                             static_cast<double>(info->units[u].trains) / kUtilisation;
      out.units.push_back(wu);
    }
    p.units = Range<UnitId>{static_cast<uint32_t>(unitBegin),
                            static_cast<uint32_t>(info->units.size())};
    // Which mode the design rate reflects: the first mode for single-mode
    // types; the flex shares weight the streams.
    std::map<std::string, double> inFlow, outFlow;
    for (size_t mode = 0; mode < info->by_mode.size(); ++mode) {
      const double w = info->by_mode.size() == 1 ? 1.0 : p.mode_share[mode];
      for (const NetStream& s : info->by_mode[mode].in)
        if (!isPseudo(s.material)) inFlow[s.material] += w * s.t_per_t * p.design_rate_t_h;
      for (const NetStream& s : info->by_mode[mode].out)
        if (!isPseudo(s.material)) outFlow[s.material] += w * s.t_per_t * p.design_rate_t_h;
    }
    // Tank design rates are FLOWS AT THE TANK: a process consuming material
    // draws it out of the site's feed tank (design_out), a process producing
    // material fills the site's product tank (design_in). Transport flows add
    // the replenishment side separately.
    for (const auto& [material, t_h] : inFlow) {
      const auto t = tankAt.find({static_cast<int>(p.site.v), material});
      if (t == tankAt.end()) continue;
      out.tanks[static_cast<size_t>(t->second)].design_out_t_h += t_h;
    }
    for (const auto& [material, t_h] : outFlow) {
      const auto t = tankAt.find({static_cast<int>(p.site.v), material});
      if (t == tankAt.end()) continue;
      out.tanks[static_cast<size_t>(t->second)].design_in_t_h += t_h;
    }
  }
  // Tank capacities were sized in addTank from provisional (zero) flows —
  // recompute now that the design flows are known.
  for (WTank& t : out.tanks) {
    const PresetInfo* ps = presetOf(d.sites[t.site.v].preset);
    double cover = 7.0;
    if (ps != nullptr) {
      if (t.role == TankRole::Feed) cover = ps->cover_feed_d;
      else if (t.role == TankRole::Product) cover = ps->cover_product_d;
      else cover = ps->cover_internal_d;
      if (const auto cm = ps->cover_by_material.find(t.material);
          cm != ps->cover_by_material.end()) cover = cm->second;
    }
    if (t.material == "CHLORINE") cover = 1.0;  // catalog override: one day
    t.capacity_t = kSpare * 24.0 * std::max(t.design_in_t_h, t.design_out_t_h) * cover;
  }

  // Bays from the preset; site ranges over tanks/processes/units.
  for (size_t s = 0; s < out.sites.size(); ++s) {
    const PresetInfo* ps = presetOf(out.sites[s].preset);
    if (ps != nullptr) {
      out.sites[s].bays[0] = ps->bays_road;
      out.sites[s].bays[1] = ps->bays_river;
      out.sites[s].bays[2] = ps->bays_sea;
    }
  }
  {
    std::map<uint32_t, uint32_t> tankBegin, tankCount, procBegin, procCount;
    for (size_t t = 0; t < out.tanks.size(); ++t) tankBegin[out.tanks[t].site.v] =
        tankBegin.count(out.tanks[t].site.v) ? tankBegin[out.tanks[t].site.v]
                                             : static_cast<uint32_t>(t);
    for (size_t t = 0; t < out.tanks.size(); ++t) {
      const uint32_t s = out.tanks[t].site.v;
      tankCount[s] = static_cast<uint32_t>(t) - tankBegin[s] + 1;
    }
    for (size_t p = 0; p < out.processes.size(); ++p) procBegin[out.processes[p].site.v] =
        procBegin.count(out.processes[p].site.v) ? procBegin[out.processes[p].site.v]
                                                 : static_cast<uint32_t>(p);
    for (size_t p = 0; p < out.processes.size(); ++p) {
      const uint32_t s = out.processes[p].site.v;
      procCount[s] = static_cast<uint32_t>(p) - procBegin[s] + 1;
    }
    for (size_t s = 0; s < out.sites.size(); ++s) {
      out.sites[s].tanks = tankBegin.count(static_cast<uint32_t>(s))
                               ? Range<TankId>{tankBegin[static_cast<uint32_t>(s)],
                                               tankCount[static_cast<uint32_t>(s)]}
                               : Range<TankId>{static_cast<uint32_t>(out.tanks.size()), 0};
      out.sites[s].processes = procBegin.count(static_cast<uint32_t>(s))
                                   ? Range<ProcessId>{procBegin[static_cast<uint32_t>(s)],
                                                      procCount[static_cast<uint32_t>(s)]}
                                   : Range<ProcessId>{static_cast<uint32_t>(out.processes.size()), 0};
    }
  }

  // ---- pipelines: the drawn connections with the plan's rates ----
  for (const PipeRate& pr : pipeRates) {
    bool drawn = false;
    for (const DrawnPipe& dp : d.pipes) {
      const auto f = siteIdx.find(dp.from), t = siteIdx.find(dp.to);
      if (f == siteIdx.end() || t == siteIdx.end()) continue;
      if (static_cast<int>(f->second) != pr.from || static_cast<int>(t->second) != pr.to ||
          dp.material != pr.material || dp.pts.size() < 2) continue;
      drawn = true;
      const auto tf = tankAt.find({pr.from, pr.material});
      const auto tt = tankAt.find({pr.to, pr.material});
      if (tf == tankAt.end() || tt == tankAt.end()) {
        gaps.push_back({d.sites[static_cast<size_t>(pr.from)].name,
                        std::string("pipeline ") + pr.material,
                        "the pipeline's end site has no tank for the material"});
        break;
      }
      WPipeline wp;
      wp.from = TankId{static_cast<uint32_t>(tf->second)};
      wp.to = TankId{static_cast<uint32_t>(tt->second)};
      wp.cap_t_h = pr.t_h * kSpare;
      wp.length_km = static_cast<float>(arcLength(dp.pts));
      wp.polyline = pushPoly(dp.pts);
      out.pipelines.push_back(wp);
      out.flows.push_back({pr.material, pr.from, pr.to, pr.t_h * 24.0, true});
      // Piped flags so procurement never books vehicles for these.
      out.tanks[static_cast<size_t>(tf->second)].piped_out = true;
      out.tanks[static_cast<size_t>(tt->second)].piped_in = true;
      break;
    }
    if (!drawn)
      gaps.push_back({d.sites[static_cast<size_t>(pr.from)].name,
                      std::string("pipeline ") + pr.material,
                      "the required pipeline is not drawn in connections"});
  }

  // ---- contracts, flows, fleet ----
  for (const Flow& f : flows) {
    const ModeGraph& m = f.mode == Mode::Road ? g.road : (f.mode == Mode::River ? g.river : g.sea);
    const auto itF = m.siteNode.find(static_cast<size_t>(f.from));
    const auto itT = m.siteNode.find(static_cast<size_t>(f.to));
    if (itF == m.siteNode.end() || itT == m.siteNode.end()) continue;  // gap already recorded
    std::vector<int> walk;
    const double km = shortestPath(m, itF->second, itT->second, walk);
    if (km < 0) continue;  // gap already recorded
    const auto tf = tankAt.find({f.from, f.material});
    const auto tt = tankAt.find({f.to, f.material});
    if (tf == tankAt.end() || tt == tankAt.end()) continue;
    WContract c;
    c.seller = TankId{static_cast<uint32_t>(tf->second)};
    c.buyer = TankId{static_cast<uint32_t>(tt->second)};
    out.contracts.push_back(c);
    out.flows.push_back({f.material, f.from, f.to, f.t_h * 24.0, false});
    // Fleet: enough vehicles of the class to move the daily tonnage with a
    // 30% spare, sized on the drawn route distance and the class envelope.
    const std::string cls = vehicleClass(f.mode, phaseOf(f.material));
    const VehicleClassInfo* vc = catalog.vehicle(cls);
    if (vc == nullptr) {
      gaps.push_back({d.sites[static_cast<size_t>(f.from)].name, f.material + " vehicles",
                      "the catalog defines no vehicle class " + cls});
      continue;
    }
    const double t_d = f.t_h * 24.0;
    // Round-trip time in hours; the fleet needed is tonnes/day times the
    // round-trip FRACTION OF A DAY over one vehicle's payload.
    const double rt = 2.0 * km / vc->speed_kmh + 2.0 * vc->capacity_t / vc->load_t_h;
    const int count = std::max(1, static_cast<int>(std::ceil(kFleetSpare * t_d * (rt / 24.0) /
                                                             vc->capacity_t)));
    // Berths are needed at BOTH ends, in EVERY mode the material allows:
    // procurement re-picks the class per order by cost, so a flow planned as
    // river can be served by a ship or a truck — and a ship queued at a site
    // with zero sea berths wedges its whole cargo forever.
    if (const MaterialInfo* fmat = catalog.material(f.material))
      for (int m = 0; m < 3; ++m) {
        if (!(fmat->modes_mask & (1u << m))) continue;
        vehBySiteMode[{f.from, m}] += count;
        vehBySiteMode[{f.to, m}] += count;
      }
    // Trucks are the universal overflow carrier (procurement re-picks the
    // class per order): give every flow a road detachment homed at the
    // seller so a busy primary fleet cannot starve the order book.
    {
      const char* truckCls = phaseOf(f.material) == Phase::LiquefiedGas ? "TRUCK_PRESS"
                             : phaseOf(f.material) == Phase::Solid  ? "TRUCK_BULK"
                                                                    : "TRUCK_TANK";
      const VehicleClassInfo* tv = catalog.vehicle(truckCls);
      if (tv != nullptr && tv->capacity_t > 0) {
        const double trt = 2.0 * km / tv->speed_kmh + 2.0 * tv->capacity_t / tv->load_t_h;
        const int tcount = std::max(1, static_cast<int>(std::ceil(
                                          kFleetSpare * t_d * (trt / 24.0) / tv->capacity_t / 2.0)));
        vehBySiteMode[{f.from, 0}] += tcount;
        vehBySiteMode[{f.to, 0}] += tcount;
        for (int v = 0; v < tcount; ++v) {
          WVehicleSpec tvs;
          tvs.cls = truckCls;
          tvs.home = NodeId{static_cast<uint32_t>(f.from)};
          out.fleet.push_back(tvs);
        }
      }
    }
    for (int v = 0; v < count; ++v) {
      WVehicleSpec vs;
      vs.cls = cls;
      // The bridge reads home as a SITE index (SiteId{v.home.v}); the engine
      // resolves the site's own node per mode.
      vs.home = NodeId{static_cast<uint32_t>(f.from)};
      out.fleet.push_back(vs);
    }
  }

  // Port berths: export legs may be unresolved (isolated sea stub), so the
  // traffic counter never counts the port; give both ports berth floors.
  for (size_t s = 0; s < out.sites.size(); ++s) {
    const auto& pname = d.sites[s].preset;
    if (pname != "PORT_TERMINAL") continue;
    out.sites[s].bays[0] = std::max<uint8_t>(out.sites[s].bays[0], 6);
    out.sites[s].bays[2] = std::max<uint8_t>(out.sites[s].bays[2], 5);
  }

  // Bay floors scale with flow traffic (applied after the fleet loop so the
  // vehicle counts exist): one berth per ~6 vehicles, both endpoints, so
  // loading/unloading does not serialize behind the preset minimums.
  // Berth demand does not follow the planned mode: procurement re-picks the
  // class per order by cost/availability, so road berths must scale from ALL
  // traffic at the site, and river/sea berths from their own.
  for (size_t s = 0; s < out.sites.size(); ++s) {
    int total = 0;
    for (int m = 0; m < 3; ++m) total += vehBySiteMode[{static_cast<int>(s), m}];
    for (int m = 0; m < 3; ++m) {
      const int own = vehBySiteMode[{static_cast<int>(s), m}];
      const int demand = m == 0 ? total : own;  // road: any class may queue
      if (demand <= 0) continue;
      const uint8_t need = static_cast<uint8_t>(std::min(64, 1 + demand / 6));
      out.sites[s].bays[m] = std::max(out.sites[s].bays[m], need);
    }
  }

  // The drawn layout carries no day curves: one flat 24-hour curve, which
  // the bridge normalises to all-1.0 multipliers on every design rate.
  out.schedules.assign(1, std::vector<float>(24, 1.0f));

  return true;
}

}  // namespace worldgen
}  // namespace crx
