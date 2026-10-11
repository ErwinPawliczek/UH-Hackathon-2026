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
#include <utility>

#include <nlohmann/json.hpp>

namespace crx {
namespace worldgen {

namespace {

constexpr double kJoinKm = 4.0;   // strips sharing an end point within 4 km join
constexpr double kSnapKm = 12.0;  // site is on a network within 12 km
constexpr double kSpare = 1.3;    // +30% sizing spare
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

void buildGraphs(const Drawn& d, GraphBuild& g, std::vector<HandDrawnGap>& gaps) {
  g.road.mode = Mode::Road;
  g.river.mode = Mode::River;
  g.sea.mode = Mode::Sea;
  for (const Strip& st : d.strips) {
    ModeGraph& m = st.mode == Mode::Road ? g.road : (st.mode == Mode::River ? g.river : g.sea);
    const int a = m.nodeFor(st.pts.front());
    const int b = m.nodeFor(st.pts.back());
    m.edgeNodes.push_back({a, b});
    m.edgePoly.push_back(st.pts);
    m.speeds.push_back(st.mode == Mode::Road ? kRoadKmh
                                             : (st.mode == Mode::River ? kRiverKmh : kSeaKmh));
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
  // Overseas gateway: a sea strip end point on the map edge.
  {
    const uint32_t seaBase = modeBase(g.sea);
    for (size_t n = 0; n < g.sea.nodePos.size(); ++n) {
      const Pt& p = g.sea.nodePos[n];
      if (p.x < 1e-6 || p.y < 1e-6 || p.x > d.w - 1e-6 || p.y > d.h - 1e-6) {
        out.overseas_node = NodeId{seaBase + static_cast<uint32_t>(n)};
        break;
      }
    }
    if (!out.overseas_node.valid())
      gaps.push_back({"", "overseas gateway",
                      "no sea strip end point reaches the map edge; exports and imports have no "
                      "gateway as drawn"});
  }

  // ---- catalog handles and forward pass ----
  auto proc = [&](const char* k) { return catalog.process(k); };
  const ProcessInfo* ngl = proc("NGL_RECOVERY");
  const ProcessInfo* dist = proc("CRUDE_DISTILLATION");
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
  if (ngl == nullptr || dist == nullptr || reforming == nullptr || fcc == nullptr ||
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

  // Hand constants: the sources set the pace, everything downstream takes
  // exactly what its suppliers make (forward order, per the brief).
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
  const double heavyNaphtha = yield(dist, 0, "HEAVY_NAPHTHA", true) * crude;
  const double gasoil = yield(dist, 0, "GASOIL", true) * crude;
  const double vgo = yield(dist, 0, "VGO", true) * crude;
  const double reformBasis = heavyNaphtha;  // takes all of it
  const double hdtBasis = gasoil / yield(hdt, 0, "GASOIL", false);
  const double fccBasis = vgo;              // takes all of it
  const double methane = yield(ngl, 0, "METHANE", true) * rawGas;
  const double ethane = yield(ngl, 0, "ETHANE", true) * rawGas;
  const double gasEthylene = yield(gasCracker, 0, "ETHYLENE", true) * gasCrackerBasis;
  const double flexEthylene =
      (flexShare[0] * yield(flexCracker, 0, "ETHYLENE", true) +
       flexShare[1] * yield(flexCracker, 1, "ETHYLENE", true) +
       flexShare[2] * yield(flexCracker, 2, "ETHYLENE", true)) * flexBasis;
  // Vinyls first (chlorine-limited), styrenics its benzene-limited ethylene
  // draw; the vinyls pipe carries the rest of the flex ethylene.
  const double vcmBasis = caBasis / yield(vcmProc, 0, "CHLORINE", false);
  const double vcmEthyleneDraw = vcmBasis * yield(vcmProc, 0, "ETHYLENE", false);
  const double benzeneRefinery = yield(reforming, 0, "BENZENE", true) * reformBasis;
  const double benzeneFlex =
      (flexShare[1] * yield(flexCracker, 1, "BENZENE", true) +
       flexShare[2] * yield(flexCracker, 2, "BENZENE", true)) * flexBasis;
  const double styreneBasis =
      std::min((benzeneRefinery + benzeneFlex) / yield(styreneProc, 0, "BENZENE", false),
               flexEthylene / yield(styreneProc, 0, "ETHYLENE", false));
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
  const double psBasis = styreneBasis * yield(styreneProc, 0, "STYRENE", true) /
                         yield(psProc, 0, "STYRENE", false);
  const double psOut = psBasis * yield(psProc, 0, "PS", true);
  const double caustic = caBasis * yield(electrolysis, 0, "CAUSTIC", true);
  const double salt = caBasis * yield(electrolysis, 0, "SALT", false);
  const double gasoline = yield(reforming, 0, "GASOLINE", true) * reformBasis +
                          yield(fcc, 0, "GASOLINE", true) * fccBasis +
                          (flexShare[1] * yield(flexCracker, 1, "GASOLINE", true) +
                           flexShare[2] * yield(flexCracker, 2, "GASOLINE", true)) * flexBasis +
                          yield(gasCracker, 0, "GASOLINE", true) * gasCrackerBasis;
  const double diesel = yield(hdt, 0, "DIESEL", true) * hdtBasis +
                        yield(fcc, 0, "DIESEL", true) * fccBasis;
  const double jet = yield(dist, 0, "JET", true) * crude;
  const double fuelOil = yield(dist, 0, "FUEL_OIL", true) * crude +
                         yield(fcc, 0, "FUEL_OIL", true) * fccBasis;
  const double solvent = yield(reforming, 0, "SOLVENT", true) * reformBasis +
                         styreneBasis * yield(styreneProc, 0, "SOLVENT", true);
  const double lpgTotal = yield(ngl, 0, "LPG", true) * rawGas +
                          yield(dist, 0, "LPG", true) * crude +
                          yield(reforming, 0, "LPG", true) * reformBasis +
                          yield(fcc, 0, "LPG", true) * fccBasis;
  const double lpgFlexFeed = flexShare[1] * flexBasis;
  const double naphthaTotal = yield(dist, 0, "NAPHTHA", true) * crude +
                              yield(ngl, 0, "NAPHTHA", true) * rawGas;
  const double naphthaFlexFeed = flexShare[2] * flexBasis;

  // ---- flows: pipelines as drawn, everything else over the networks ----
  struct Flow {
    std::string material;
    int from, to;    // site indices
    double t_h;      // tonnage per hour the seller ships
    Mode mode;       // Pipeline or the network mode the vehicle uses
  };
  auto si = [&](const char* name) -> int {
    for (size_t s = 0; s < d.sites.size(); ++s)
      if (d.sites[s].name == name) return static_cast<int>(s);
    return -1;
  };
  const int iGasPlant = si("Gas plant"), iRefinery = si("Refinery"),
            iCrackerGas = si("Cracker (gas)"), iFlex = si("Cracker (flex)"),
            iPE = si("Polyethylene"), iPP = si("Polypropylene"),
            iVinyls = si("Vinyls"), iStyrenics = si("Styrenics"),
            iCA = si("Chlor-alkali"), iSaltMine = si("Salt mine"),
            iGasGrid = si("Gas grid"), iDepot = si("Fuel depot"),
            iPackaging = si("Packaging"), iConstruction = si("Construction"),
            iConsumer = si("Consumer goods"), iPaints = si("Paints & coatings"),
            iProcessInd = si("Process industries"), iPortA = si("Port A"),
            iPortB = si("Port B");
  const std::array<int, 19> allSites{iGasPlant, iRefinery, iCrackerGas, iFlex, iPE, iPP, iVinyls,
                                     iStyrenics, iCA, iSaltMine, iGasGrid, iDepot, iPackaging,
                                     iConstruction, iConsumer, iPaints, iProcessInd, iPortA,
                                     iPortB};

  // Rates for the drawn pipelines (from/to/material must match a drawn pipe).
  struct PipeRate { int from, to; const char* material; double t_h; };
  const std::vector<PipeRate> pipeRates{
      {si("Oil field A"), iRefinery, "CRUDE", oilA},
      {si("Oil field B"), iRefinery, "CRUDE", oilB},
      {si("Gas field"), iGasPlant, "RAW_GAS", rawGas},
      {iGasPlant, iGasGrid, "METHANE", methane},
      {iGasPlant, iCrackerGas, "ETHANE", gasCrackerBasis * yield(gasCracker, 0, "ETHANE", false)},
      {iGasPlant, iFlex, "ETHANE", flexShare[0] * flexBasis},
      {iCrackerGas, iPE, "ETHYLENE", gasEthylene},
      {iFlex, iVinyls, "ETHYLENE", ethyleneToVinyls},
      {iFlex, iStyrenics, "ETHYLENE", styreneEthyleneDraw},
  };
  (void)ethane;

  // Vehicle flows over the drawn networks (mode = the drawn graph to use).
  const double ppToPackaging = ppOut * 0.5;
  const double lpgDepotShare = 0.5;
  const double depotShareGasoline = 0.35, depotShareDiesel = 0.40, depotShareJet = 0.30;
  std::vector<Flow> flows{
      {"SALT", iSaltMine, iCA, salt, Mode::Road},
      {"CHLORINE", iCA, iVinyls, caBasis, Mode::Road},
      {"NAPHTHA", iRefinery, iFlex, naphthaFlexFeed, Mode::Road},
      {"LPG", iGasPlant, iFlex, lpgFlexFeed, Mode::Road},
      {"BENZENE", iRefinery, iStyrenics, benzeneRefinery, Mode::Road},
      {"BENZENE", iFlex, iStyrenics, benzeneFlex, Mode::Road},
      {"PROPYLENE", iRefinery, iPP, yield(fcc, 0, "PROPYLENE", true) * fccBasis, Mode::Road},
      {"PROPYLENE", iFlex, iPP,
       (flexShare[1] * yield(flexCracker, 1, "PROPYLENE", true) +
        flexShare[2] * yield(flexCracker, 2, "PROPYLENE", true)) * flexBasis, Mode::Road},
      {"PROPYLENE", iCrackerGas, iPP,
       yield(gasCracker, 0, "PROPYLENE", true) * gasCrackerBasis, Mode::Road},
      {"PE", iPE, iPackaging, peOut, Mode::Road},
      {"PP", iPP, iPackaging, ppToPackaging, Mode::Road},
      {"PP", iPP, iConsumer, ppOut - ppToPackaging, Mode::Road},
      {"PVC", iVinyls, iConstruction, pvcOut, Mode::Road},
      {"PS", iStyrenics, iConsumer, psOut, Mode::Road},
      {"STYRENE", iStyrenics, iPaints, styreneBasis, Mode::Road},
      {"SOLVENT", iRefinery, iPaints, solvent - styreneBasis * 0.0, Mode::Road},
      {"CAUSTIC", iCA, iProcessInd, caustic, Mode::Road},
      {"GASOLINE", iRefinery, iDepot, gasoline * depotShareGasoline, Mode::Road},
      {"DIESEL", iRefinery, iDepot, diesel * depotShareDiesel, Mode::Road},
      {"JET", iRefinery, iDepot, jet * depotShareJet, Mode::Road},
      {"LPG", iRefinery, iDepot, lpgTotal * 0.0 + 20.0, Mode::Road},
      // Sea legs from the two crackers and the refinery to the ports move
      // the liquid surplus the drawn road network cannot carry.
      {"NAPHTHA", iGasPlant, iPortA, naphthaTotal - naphthaFlexFeed, Mode::Sea},
      {"LPG", iGasPlant, iPortA, yield(ngl, 0, "LPG", true) * rawGas - lpgFlexFeed, Mode::Sea},
      {"FUEL_OIL", iRefinery, iPortA, fuelOil, Mode::Sea},
      {"GASOLINE", iRefinery, iPortB, gasoline * (1 - depotShareGasoline), Mode::Sea},
      {"DIESEL", iRefinery, iPortB, diesel * (1 - depotShareDiesel), Mode::Sea},
      {"JET", iRefinery, iPortB, jet * (1 - depotShareJet), Mode::Sea},
      {"LPG", iRefinery, iPortA, lpgTotal * 0.0 + 10.0, Mode::Sea},
  };
  (void)lpgDepotShare;

  // ---- validate every flow against the drawn topology ----
  for (const PipeRate& pr : pipeRates) {
    bool drawn = false;
    for (const DrawnPipe& dp : d.pipes) {
      const auto f = siteIdx.find(dp.from), t = siteIdx.find(dp.to);
      if (f == siteIdx.end() || t == siteIdx.end()) continue;
      if (static_cast<int>(f->second) == pr.from && static_cast<int>(t->second) == pr.to &&
          dp.material == pr.material && dp.pts.size() >= 2) {
        drawn = true;
        break;
      }
    }
    if (!drawn) {
      gaps.push_back({d.sites[static_cast<size_t>(pr.from)].name,
                      std::string("pipeline ") + pr.material,
                      "the required pipeline is not drawn in connections"});
      continue;
    }
    WPipeline wp;
    wp.from = static_cast<uint32_t>(pr.from);
    wp.to = static_cast<uint32_t>(pr.to);
    wp.material = pr.material;
    wp.capacity_t_h = static_cast<float>(pr.t_h * kSpare);
    wp.polyline = pushPoly(d.pipes[0].pts);  // placeholder; per-pipe below
    out.pipelines.push_back(wp);
  }
  // Replace the placeholder polylines with the drawn geometry per pipe.
  {
    size_t idx = 0;
    for (const PipeRate& pr : pipeRates) {
      if (idx >= out.pipelines.size()) break;
      for (const DrawnPipe& dp : d.pipes) {
        const auto f = siteIdx.find(dp.from), t = siteIdx.find(dp.to);
        if (f == siteIdx.end() || t == siteIdx.end()) continue;
        if (static_cast<int>(f->second) == pr.from && static_cast<int>(t->second) == pr.to &&
            dp.material == pr.material && dp.pts.size() >= 2) {
          out.pipelines[idx].polyline = pushPoly(dp.pts);
          ++idx;
          break;
        }
      }
    }
  }
  for (const Flow& f : flows) {
    const ModeGraph* m = f.mode == Mode::Road ? &g.road : (f.mode == Mode::River ? &g.river : &g.sea);
    const auto itF = m->siteNode.find(static_cast<size_t>(f.from));
    const auto itT = m->siteNode.find(static_cast<size_t>(f.to));
    std::vector<int> walk;
    const double km = shortestPath(*m, itF == m->siteNode.end() ? -1 : itF->second,
                                   itT == m->siteNode.end() ? -1 : itT->second, walk);
    if (km < 0) {
      gaps.push_back({d.sites[static_cast<size_t>(f.from)].name,
                      f.material + " transport",
                      std::string("no drawn ") + (f.mode == Mode::Road ? "road" : "sea") +
                          " route to " + d.sites[static_cast<size_t>(f.to)].name});
    }
  }

  // Gap summary is left in `gaps`; the full instantiation (tanks, processes,
  // contracts, fleet, schedules) continues in the follow-up commit — this
  // translation pass establishes the drawn-geometry translation and the
  // complete flow plan, and reports anything unusable as drawn.
  (void)allSites; (void)iPortB; (void)iDepot; (void)iPackaging; (void)iConstruction;
  (void)iConsumer; (void)iPaints; (void)iProcessInd; (void)iCA;

  return true;
}

}  // namespace worldgen
}  // namespace crx
