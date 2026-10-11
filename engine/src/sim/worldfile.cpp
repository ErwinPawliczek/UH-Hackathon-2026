// Named map worlds: JSON world file → World (see worldfile.h).
#include "sim/worldfile.h"

#include "sim/validate.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cmath>
#include <cstdlib>
#include <deque>
#include <fstream>
#include <limits>
#include <numeric>
#include <set>
#include <sstream>
#include <stdexcept>

using json = nlohmann::json;

namespace crx {
namespace sim {

namespace {

constexpr double kMergeKm = 4.0;    // strip end points this close join up
constexpr double kAttachKm = 12.0;  // a site reaches a network this far away
constexpr double kSnapKm = 1.0;     // a vertex this close to a site is the site's node
constexpr double kMinEdgeKm = 0.01;
constexpr double kSpeedKmh[kModeCount] = {70.0, 12.0, 28.0};  // road, river, sea
constexpr size_t kMaxNodes = 2000;  // the path cache is n x n per mode
constexpr size_t kMaxFileBytes = 16u << 20;
const char* const kModeNames[kModeCount] = {"road", "river", "sea"};

struct Pt {
  double x = 0, y = 0;
};

double dist(Pt a, Pt b) { return std::hypot(a.x - b.x, a.y - b.y); }

// Corner rounding (worldfile.h roundPolylineCorners) on points.
std::vector<Pt> roundCorners(const std::vector<Pt>& in, double radius) {
  if (!(radius > 0.0) || in.size() < 3) return in;
  // Zero-length segments have no direction: drop repeated points first.
  std::vector<Pt> p;
  p.reserve(in.size());
  for (const Pt& q : in)
    if (p.empty() || dist(p.back(), q) > 1e-9) p.push_back(q);
  if (p.size() < 3) return in;

  // A curve is 7 points; very long drawn paths get coarser curves so the
  // point count stays sane.
  const int steps = p.size() > 400 ? 3 : 6;
  const double straight_cos = std::cos(8.0 * 3.14159265358979323846 / 180.0);
  std::vector<Pt> out;
  out.reserve(p.size() * static_cast<size_t>(steps + 1));
  out.push_back(p.front());
  for (size_t i = 1; i + 1 < p.size(); ++i) {
    const double l1 = dist(p[i - 1], p[i]), l2 = dist(p[i], p[i + 1]);
    const Pt u{(p[i].x - p[i - 1].x) / l1, (p[i].y - p[i - 1].y) / l1};
    const Pt v{(p[i + 1].x - p[i].x) / l2, (p[i + 1].y - p[i].y) / l2};
    const double d = std::min({radius, 0.45 * l1, 0.45 * l2});
    if (u.x * v.x + u.y * v.y > straight_cos || d < 1e-6) {
      out.push_back(p[i]);  // near enough straight on, or nothing to round with
      continue;
    }
    const Pt a{p[i].x - u.x * d, p[i].y - u.y * d}, b{p[i].x + v.x * d, p[i].y + v.y * d};
    for (int k = 0; k <= steps; ++k) {
      const double t = static_cast<double>(k) / steps, s = 1.0 - t;
      out.push_back({s * s * a.x + 2.0 * s * t * p[i].x + t * t * b.x,
                     s * s * a.y + 2.0 * s * t * p[i].y + t * t * b.y});
    }
  }
  out.push_back(p.back());
  return out;
}

// Junction rounding (worldfile.h roundJunctionCorner) on points: half of the
// corner's curve for each of the two paths, and the node's new position.
struct JunctionCurve {
  Pt moved;
  std::vector<Pt> toward_a, toward_b;  // from just past the node out to each path
};

bool junctionCurve(Pt node, Pt a, Pt b, double radius, JunctionCurve& out) {
  const double la = dist(node, a), lb = dist(node, b);
  if (!(radius > 0.0) || la < 1e-9 || lb < 1e-9) return false;
  const Pt ua{(a.x - node.x) / la, (a.y - node.y) / la};
  const Pt ub{(b.x - node.x) / lb, (b.y - node.y) / lb};
  // Coming in along a and leaving along b: straight on is ua = -ub.
  const double turn_cos = -(ua.x * ub.x + ua.y * ub.y);
  const double rad = 3.14159265358979323846 / 180.0;
  if (turn_cos > std::cos(8.0 * rad) || turn_cos < std::cos(80.0 * rad)) return false;
  const double d = std::min({radius, 0.45 * la, 0.45 * lb});
  if (d < 1e-6) return false;
  const Pt pa{node.x + ua.x * d, node.y + ua.y * d}, pb{node.x + ub.x * d, node.y + ub.y * d};
  const auto at = [&](double t) {
    const double s = 1.0 - t;
    return Pt{s * s * pa.x + 2.0 * s * t * node.x + t * t * pb.x,
              s * s * pa.y + 2.0 * s * t * node.y + t * t * pb.y};
  };
  constexpr int kHalf = 3;  // the whole curve is 7 points, as for interior corners
  out.moved = at(0.5);
  out.toward_a.clear();
  out.toward_b.clear();
  for (int k = 1; k <= kHalf; ++k) {
    out.toward_a.push_back(at(0.5 - 0.5 * k / kHalf));
    out.toward_b.push_back(at(0.5 + 0.5 * k / kHalf));
  }
  return true;
}

// One route edge while its mode's graph is still being put together.
struct EdgeDraft {
  RouteEdge edge;
  std::vector<Pt> pts;  // from node edge.a to node edge.b
};

// Rounds the turn through each junction: for every node from `first_node`
// on that is not a site's node and has two or more edges, the pair of edges
// that runs straightest through it gets a curve in place of the corner and
// the node moves onto the curve; every other edge at the node is re-ended
// on the moved position. Site nodes never move.
void roundJunctions(World& world, uint32_t first_node, std::vector<EdgeDraft>& drafts,
                    double radius) {
  struct End {
    size_t draft;
    bool front;  // the node is the edge's a end (pts.front())
  };
  for (uint32_t n = first_node; n < world.nodes.size(); ++n) {
    RouteNode& node = world.nodes[n];
    if (node.site >= 0) continue;
    std::vector<End> ends;
    bool loop = false;
    for (size_t i = 0; i < drafts.size(); ++i) {
      const RouteEdge& e = drafts[i].edge;
      if (e.a == n && e.b == n) loop = true;
      if (drafts[i].pts.size() < 2) continue;
      if (e.a == n) ends.push_back({i, true});
      if (e.b == n) ends.push_back({i, false});
    }
    if (loop || ends.size() < 2) continue;
    const Pt here{node.x_km, node.y_km};
    const auto next = [&](const End& e) {
      const std::vector<Pt>& p = drafts[e.draft].pts;
      return e.front ? p[1] : p[p.size() - 2];
    };
    // The straightest way through: the two ends pointing most nearly
    // opposite ways (ties: the first pair found, in edge order).
    size_t bi = 0, bj = 0;
    double best = 2.0;
    for (size_t i = 0; i < ends.size(); ++i) {
      const Pt qi = next(ends[i]);
      const double li = dist(here, qi);
      if (li < 1e-9) continue;
      for (size_t j = i + 1; j < ends.size(); ++j) {
        const Pt qj = next(ends[j]);
        const double lj = dist(here, qj);
        if (lj < 1e-9) continue;
        const double dot = ((qi.x - here.x) * (qj.x - here.x) + (qi.y - here.y) * (qj.y - here.y)) /
                           (li * lj);
        if (dot < best) {
          best = dot;
          bi = i;
          bj = j;
        }
      }
    }
    if (best > 1.5) continue;
    JunctionCurve curve;
    if (!junctionCurve(here, next(ends[bi]), next(ends[bj]), radius, curve)) continue;

    // Each of the pair takes its half of the curve; everything at the node
    // ends on the moved position.
    const auto splice = [&](const End& e, const std::vector<Pt>& half) {
      std::vector<Pt>& p = drafts[e.draft].pts;
      if (e.front) {
        std::vector<Pt> out;
        out.reserve(p.size() + half.size());
        out.push_back(curve.moved);
        out.insert(out.end(), half.begin(), half.end());
        out.insert(out.end(), p.begin() + 1, p.end());
        p = std::move(out);
      } else {
        p.pop_back();
        p.insert(p.end(), half.rbegin(), half.rend());
        p.push_back(curve.moved);
      }
    };
    for (size_t k = 0; k < ends.size(); ++k) {
      if (k == bi) {
        splice(ends[k], curve.toward_a);
      } else if (k == bj) {
        splice(ends[k], curve.toward_b);
      } else {
        std::vector<Pt>& p = drafts[ends[k].draft].pts;
        (ends[k].front ? p.front() : p.back()) = curve.moved;
      }
    }
    node.x_km = curve.moved.x;
    node.y_km = curve.moved.y;
  }
}

[[noreturn]] void bad(const std::string& msg) { throw std::runtime_error(msg); }

// ---- JSON field access with messages that name the place ----

const json& field(const json& j, const char* key, const std::string& ctx) {
  if (!j.is_object()) bad(ctx + " must be an object");
  if (!j.contains(key)) bad(ctx + ": missing \"" + key + "\"");
  return j.at(key);
}

double numField(const json& j, const char* key, const std::string& ctx) {
  const json& v = field(j, key, ctx);
  if (!v.is_number()) bad(ctx + ": \"" + key + "\" must be a number");
  const double d = v.get<double>();
  if (!std::isfinite(d)) bad(ctx + ": \"" + key + "\" must be finite");
  return d;
}

double numFieldOr(const json& j, const char* key, double fallback, const std::string& ctx) {
  if (!j.is_object()) bad(ctx + " must be an object");
  return j.contains(key) ? numField(j, key, ctx) : fallback;
}

std::string strField(const json& j, const char* key, const std::string& ctx) {
  const json& v = field(j, key, ctx);
  if (!v.is_string()) bad(ctx + ": \"" + key + "\" must be a string");
  return v.get<std::string>();
}

const json& arrayFieldOrEmpty(const json& j, const char* key, const std::string& ctx) {
  static const json empty = json::array();
  if (!j.is_object()) bad(ctx + " must be an object");
  if (!j.contains(key)) return empty;
  const json& v = j.at(key);
  if (!v.is_array()) bad(ctx + ": \"" + key + "\" must be an array");
  return v;
}

std::vector<Pt> parsePoints(const json& arr, const std::string& ctx) {
  if (!arr.is_array()) bad(ctx + ": \"points\" must be an array");
  std::vector<Pt> pts;
  pts.reserve(arr.size());
  for (const json& p : arr) {
    if (!p.is_array() || p.size() < 2 || !p[0].is_number() || !p[1].is_number())
      bad(ctx + ": every point must be [x, y]");
    const Pt pt{p[0].get<double>(), p[1].get<double>()};
    if (!std::isfinite(pt.x) || !std::isfinite(pt.y)) bad(ctx + ": point is not finite");
    pts.push_back(pt);
  }
  return pts;
}

bool validWorldName(const std::string& name) {
  if (name.empty() || name.size() > 64) return false;
  for (const char c : name)
    if (!((c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') || c == '-')) return false;
  return true;
}

bool validSiteKey(const std::string& key) {
  if (key.empty() || key.size() > 64) return false;
  for (const char c : key)
    if (!((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_')) return false;
  return true;
}

// ---- One mode's route graph from its drawn strips ----
//
// `bays[s]` > 0 attaches site s; `strict[s]` makes a site with nothing in
// range an error (its bays were written explicitly) instead of quietly
// leaving it off the network. Appends nodes, edges and polyline points to
// the world and sets Site::node for the mode.
void buildModeGraph(World& world, crx::Mode mode, const std::vector<std::vector<Pt>>& strips,
                    const std::vector<int>& bays, const std::vector<uint8_t>& strict,
                    double smooth_km) {
  const int m = modeIndex(mode);

  // 1. Vertices: every strip point, consecutive duplicates dropped.
  std::vector<Pt> vpos;
  std::vector<uint8_t> vend;  // 1 = a strip end point
  std::vector<std::vector<uint32_t>> strip_vs;
  for (const std::vector<Pt>& strip : strips) {
    std::vector<uint32_t> ids;
    for (const Pt& p : strip) {
      if (!ids.empty() && dist(vpos[ids.back()], p) < 1e-9) continue;
      ids.push_back(static_cast<uint32_t>(vpos.size()));
      vpos.push_back(p);
      vend.push_back(0);
    }
    if (ids.size() < 2) {  // a strip of one point joins nothing
      vpos.resize(vpos.size() - ids.size());
      vend.resize(vend.size() - ids.size());
      continue;
    }
    vend[ids.front()] = vend[ids.back()] = 1;
    strip_vs.push_back(std::move(ids));
  }
  const uint32_t nv = static_cast<uint32_t>(vpos.size());

  // 2. Merge: vertices within 4 km join when at least one is an end point.
  // The lowest vertex id is the cluster's root, so its position stands.
  std::vector<uint32_t> parent(nv);
  std::iota(parent.begin(), parent.end(), 0u);
  auto find = [&](uint32_t v) {
    while (parent[v] != v) {
      parent[v] = parent[parent[v]];
      v = parent[v];
    }
    return v;
  };
  for (uint32_t i = 0; i < nv; ++i)
    for (uint32_t j = i + 1; j < nv; ++j) {
      if (!vend[i] && !vend[j]) continue;
      if (dist(vpos[i], vpos[j]) > kMergeKm) continue;
      const uint32_t ri = find(i), rj = find(j);
      if (ri != rj) parent[std::max(ri, rj)] = std::min(ri, rj);
    }

  // Graph vertices: one per cluster, then one per site that does not snap.
  std::vector<uint32_t> cl(nv, 0);
  std::vector<Pt> gpos;
  std::vector<int> gsite;
  {
    std::vector<int> of_root(nv, -1);
    for (uint32_t v = 0; v < nv; ++v) {
      const uint32_t r = find(v);
      if (of_root[r] < 0) {
        of_root[r] = static_cast<int>(gpos.size());
        gpos.push_back(vpos[r]);
        gsite.push_back(-1);
      }
      cl[v] = static_cast<uint32_t>(of_root[r]);
    }
  }
  std::vector<std::vector<uint32_t>> adj(gpos.size());
  auto addSeg = [&](uint32_t a, uint32_t b) {
    if (a == b) return;
    if (std::find(adj[a].begin(), adj[a].end(), b) != adj[a].end()) return;
    adj[a].push_back(b);
    adj[b].push_back(a);
  };

  // 3. Segments between consecutive strip vertices.
  for (const std::vector<uint32_t>& ids : strip_vs)
    for (size_t i = 0; i + 1 < ids.size(); ++i) addSeg(cl[ids[i]], cl[ids[i + 1]]);

  // 4. Sites: the nearest vertex and every strip end within 12 km.
  for (size_t s = 0; s < world.sites.size(); ++s) {
    if (bays[s] <= 0) continue;
    Site& site = world.sites[s];
    const Pt at{site.x_km, site.y_km};
    int nearest = -1;
    double nearest_d = std::numeric_limits<double>::infinity();
    std::vector<uint32_t> ends;
    for (uint32_t v = 0; v < nv; ++v) {
      const double d = dist(at, vpos[v]);
      if (d > kAttachKm) continue;
      const int c = static_cast<int>(cl[v]);
      if (d < nearest_d - 1e-12 || (std::fabs(d - nearest_d) <= 1e-12 && c < nearest)) {
        nearest_d = d;
        nearest = c;
      }
      if (vend[v] && std::find(ends.begin(), ends.end(), cl[v]) == ends.end())
        ends.push_back(cl[v]);
    }
    if (nearest < 0) {
      if (strict[s])
        bad("site " + site.key + " has " + kModeNames[m] + " bays but no " + kModeNames[m] +
            " strip within 12 km");
      site.bays[static_cast<size_t>(m)] = 0;
      continue;
    }
    uint32_t g;
    if (nearest_d <= kSnapKm && gsite[static_cast<size_t>(nearest)] < 0) {
      g = static_cast<uint32_t>(nearest);  // the strip runs through the site
      gsite[g] = static_cast<int>(s);
      gpos[g] = at;
    } else {
      g = static_cast<uint32_t>(gpos.size());
      gpos.push_back(at);
      gsite.push_back(static_cast<int>(s));
      adj.emplace_back();
      addSeg(g, static_cast<uint32_t>(nearest));
    }
    for (const uint32_t e : ends) addSeg(g, e);
  }

  // 5. Contract: site vertices, junctions and dead ends stay nodes; chains
  // of degree-2 vertices fold into one edge. A chain that would loop back
  // to its own node, or double an edge between the same two nodes, keeps a
  // middle vertex as a node so edgeBetween() stays unambiguous.
  const uint32_t ng = static_cast<uint32_t>(gpos.size());
  for (std::vector<uint32_t>& a : adj) std::sort(a.begin(), a.end());
  std::vector<uint8_t> keep(ng, 0);
  for (uint32_t g = 0; g < ng; ++g) keep[g] = gsite[g] >= 0 || adj[g].size() != 2;
  auto key = [](uint32_t a, uint32_t b) { return std::make_pair(std::min(a, b), std::max(a, b)); };
  std::vector<std::vector<uint32_t>> chains;
  for (;;) {
    chains.clear();
    std::set<std::pair<uint32_t, uint32_t>> seen, joined;
    bool restart = false;
    for (uint32_t a = 0; a < ng && !restart; ++a) {
      if (!keep[a]) continue;
      for (const uint32_t n : adj[a]) {
        if (seen.count(key(a, n))) continue;
        std::vector<uint32_t> path{a, n};
        seen.insert(key(a, n));
        uint32_t prev = a, cur = n;
        while (!keep[cur]) {
          const uint32_t next = adj[cur][0] == prev ? adj[cur][1] : adj[cur][0];
          seen.insert(key(cur, next));
          path.push_back(next);
          prev = cur;
          cur = next;
        }
        if (cur == a || joined.count(key(a, cur))) {
          if (path.size() > 2) {
            keep[path[path.size() / 2]] = 1;
            restart = true;
            break;
          }
          continue;  // unreachable: segments are unique per vertex pair
        }
        joined.insert(key(a, cur));
        chains.push_back(std::move(path));
      }
    }
    if (restart) continue;
    // A closed ring with no node on it yet: its lowest vertex becomes one.
    bool promoted = false;
    for (uint32_t g = 0; g < ng && !promoted; ++g)
      for (const uint32_t n : adj[g])
        if (!seen.count(key(g, n))) {
          keep[g] = 1;
          promoted = true;
          break;
        }
    if (!promoted) break;
  }

  // 6. Emit nodes (ascending vertex order) and edges (walk order).
  const uint32_t first_node = static_cast<uint32_t>(world.nodes.size());
  std::vector<uint32_t> node_of(ng, kNoNode);
  for (uint32_t g = 0; g < ng; ++g) {
    if (!keep[g]) continue;
    if (adj[g].empty() && gsite[g] < 0) continue;  // a strip that collapsed to a point
    node_of[g] = static_cast<uint32_t>(world.nodes.size());
    RouteNode node;
    node.x_km = gpos[g].x;
    node.y_km = gpos[g].y;
    node.site = gsite[g];
    world.nodes.push_back(node);
    if (gsite[g] >= 0) world.sites[static_cast<size_t>(gsite[g])].node[static_cast<size_t>(m)] = node_of[g];
  }
  // The drawn path between each pair of nodes. When the world asks for
  // smoothing, corners inside a path are rounded first (the nodes at either
  // end stay put), then the turn through each junction (the junction node
  // moves a little; site nodes never do). An edge is as long as the path
  // that is drawn and driven.
  std::vector<EdgeDraft> drafts;
  drafts.reserve(chains.size());
  for (const std::vector<uint32_t>& path : chains) {
    EdgeDraft d;
    d.edge.a = node_of[path.front()];
    d.edge.b = node_of[path.back()];
    d.edge.mode = mode;
    d.edge.speed_kmh = kSpeedKmh[m];
    d.pts.reserve(path.size());
    for (const uint32_t g : path) d.pts.push_back(gpos[g]);
    if (smooth_km > 0.0) d.pts = roundCorners(d.pts, smooth_km);
    drafts.push_back(std::move(d));
  }
  if (smooth_km > 0.0) roundJunctions(world, first_node, drafts, smooth_km);
  for (EdgeDraft& d : drafts) {
    RouteEdge e = d.edge;
    e.polyline = Range<uint32_t>{static_cast<uint32_t>(world.polyline_xy.size() / 2),
                                 static_cast<uint32_t>(d.pts.size())};
    double length = 0;
    for (size_t i = 0; i < d.pts.size(); ++i) {
      world.polyline_xy.push_back(d.pts[i].x);
      world.polyline_xy.push_back(d.pts[i].y);
      if (i > 0) length += dist(d.pts[i - 1], d.pts[i]);
    }
    e.length_km = std::max(length, kMinEdgeKm);
    world.edges.push_back(e);
  }
}

// ---- The file ----

bool loadWorld(const std::string& name, const std::string& text, uint64_t seed, World& out,
               std::string& error) {
  Catalog catalog;
  if (!loadCatalogFromDir(CRX_DATA_DIR, catalog, error)) return false;

  const json doc = json::parse(text, nullptr, true, true);
  if (!doc.is_object()) bad("the file must hold one JSON object");
  if (numFieldOr(doc, "format", 1, "world") != 1) bad("unsupported \"format\" (this engine reads 1)");
  const double w_km = numFieldOr(doc, "wKm", 600, "world");
  const double h_km = numFieldOr(doc, "hKm", 400, "world");
  const double cell_km = numFieldOr(doc, "cellKm", 10, "world");
  // Corner rounding radius for routes and pipelines, km; 0 (or no key)
  // leaves every path exactly as drawn.
  const double smooth_km = numFieldOr(doc, "smooth_km", 0, "world");
  if (!(smooth_km >= 0.0 && smooth_km <= 100.0)) bad("\"smooth_km\" must be from 0 to 100");
  if (w_km <= 0 || h_km <= 0 || cell_km <= 0) bad("wKm, hKm and cellKm must be > 0");

  // WorldSpec holds C strings; the pool keeps them alive until the build.
  std::deque<std::string> pool;
  auto keepStr = [&](const std::string& s) {
    pool.push_back(s);
    return pool.back().c_str();
  };

  WorldSpec spec;
  std::vector<std::array<uint8_t, kModeCount>> strict;

  if (!doc.contains("sites") || !doc.at("sites").is_array() || doc.at("sites").empty())
    bad("\"sites\" must be a non-empty array");
  const json& sites = doc.at("sites");
  if (sites.size() > 1000) bad("too many sites");
  for (const json& js : sites) {
    const std::string key = strField(js, "key", "site");
    if (!validSiteKey(key)) bad("site key \"" + key + "\" must match [A-Z0-9_]+");
    const std::string ctx = "site " + key;
    SiteSpec ss{};
    ss.key = keepStr(key);
    ss.name = keepStr(js.contains("name") ? strField(js, "name", ctx) : key);
    ss.x_km = numField(js, "x", ctx);
    ss.y_km = numField(js, "y", ctx);
    int preset = -1;
    if (js.contains("preset")) {
      const std::string pk = strField(js, "preset", ctx);
      preset = catalog.findPreset(pk);
      if (preset < 0) bad(ctx + ": unknown preset " + pk);
      ss.preset = keepStr(pk);
    }

    std::array<uint8_t, kModeCount> site_strict{0, 0, 0};
    if (js.contains("bays")) {
      const json& jb = js.at("bays");
      if (!jb.is_object()) bad(ctx + ": \"bays\" must be an object");
      for (int m = 0; m < kModeCount; ++m) {
        const double b = numFieldOr(jb, kModeNames[m], 0, ctx + " bays");
        if (b < 0 || b > 255 || b != std::floor(b)) bad(ctx + ": bays must be whole numbers 0-255");
        ss.bays[static_cast<size_t>(m)] = static_cast<int>(b);
        site_strict[static_cast<size_t>(m)] = b > 0;
      }
    } else {
      // No bays written: the preset's, attached wherever a strip is in reach.
      for (int m = 0; m < kModeCount; ++m)
        ss.bays[static_cast<size_t>(m)] =
            preset >= 0 ? catalog.site_presets[static_cast<size_t>(preset)].bays[m]
                        : (m == 0 ? 2 : 0);
    }
    strict.push_back(site_strict);

    for (const json& jp : arrayFieldOrEmpty(js, "processes", ctx)) {
      ProcSpec ps;
      ps.type = keepStr(strField(jp, "type", ctx + " process"));
      const std::string pctx = ctx + " " + ps.type;
      ps.design_t_h = numField(jp, "design_t_h", pctx);
      if (jp.contains("trains")) {
        const json& jt = jp.at("trains");
        if (!jt.is_array() || jt.empty()) bad(pctx + ": \"trains\" must be a non-empty array");
        for (const json& n : jt) {
          if (!n.is_number_unsigned() || n.get<uint64_t>() > 255)
            bad(pctx + ": trains must be whole numbers 0-255");
          ps.trains_by_mode.push_back(static_cast<uint8_t>(n.get<uint64_t>()));
        }
      } else {
        ps.trains_by_mode = {1};
      }
      ss.procs.push_back(std::move(ps));
    }

    for (const json& jt : arrayFieldOrEmpty(js, "tanks", ctx)) {
      const std::string mat = strField(jt, "material", ctx + " tank");
      const std::string tctx = ctx + " tank " + mat;
      const std::string role = strField(jt, "role", tctx);
      TankSpec ts{};
      ts.material = keepStr(mat);
      if (role == "feed") ts.role = TankRole::Feed;
      else if (role == "product") ts.role = TankRole::Product;
      else if (role == "both") ts.role = TankRole::Both;
      else bad(tctx + ": role must be feed, product or both");
      ts.cover_days = numField(jt, "cover_days", tctx);
      ts.target_frac = numFieldOr(jt, "target_frac", 0.7, tctx);
      ts.init_frac = numFieldOr(jt, "init_frac", -1.0, tctx);
      ts.lead_time_h = numFieldOr(jt, "lead_time_h", -1.0, tctx);
      ts.pickup_gap_h = numFieldOr(jt, "pickup_gap_h", -1.0, tctx);
      if (jt.contains("reject_when_full")) {
        if (!jt.at("reject_when_full").is_boolean())
          bad(tctx + ": \"reject_when_full\" must be true or false");
        ts.reject_when_full = jt.at("reject_when_full").get<bool>();
      }
      ss.tanks.push_back(ts);
    }
    spec.sites.push_back(std::move(ss));
  }

  for (const json& jp : arrayFieldOrEmpty(doc, "pipelines", "world")) {
    const std::string mat = strField(jp, "material", "pipeline");
    const std::string from = strField(jp, "from", "pipeline " + mat);
    const std::string to = strField(jp, "to", "pipeline " + mat);
    const std::string ctx = "pipeline " + mat + " " + from + " to " + to;
    PipeSpec ps{};
    ps.material = keepStr(mat);
    // Ends are site keys; a full "SITE/MATERIAL" tank key also works.
    ps.from = keepStr(from.find('/') == std::string::npos ? from + "/" + mat : from);
    ps.to = keepStr(to.find('/') == std::string::npos ? to + "/" + mat : to);
    ps.cap_t_h = numField(jp, "cap_t_h", ctx);
    if (jp.contains("points")) {
      std::vector<Pt> pts = parsePoints(jp.at("points"), ctx);
      if (smooth_km > 0.0) pts = roundCorners(pts, smooth_km);
      if (pts.size() >= 2)
        for (const Pt& p : pts) {
          ps.points_xy.push_back(p.x);
          ps.points_xy.push_back(p.y);
        }
    }
    spec.pipes.push_back(std::move(ps));
  }

  std::array<std::vector<std::vector<Pt>>, kModeCount> strips;
  size_t strip_points = 0;
  for (const json& jn : arrayFieldOrEmpty(doc, "network", "world")) {
    const std::string mode = strField(jn, "mode", "network strip");
    int m = -1;
    for (int i = 0; i < kModeCount; ++i)
      if (mode == kModeNames[i]) m = i;
    if (m < 0) bad("network strip: unknown mode \"" + mode + "\"");
    std::vector<Pt> pts = parsePoints(field(jn, "points", "network strip"), mode + " strip");
    strip_points += pts.size();
    if (strip_points > 200000) bad("network has too many points");
    if (pts.size() >= 2) strips[static_cast<size_t>(m)].push_back(std::move(pts));
  }

  size_t fleet_total = 0;
  for (const json& jf : arrayFieldOrEmpty(doc, "fleet", "world")) {
    const std::string cls = strField(jf, "class", "fleet entry");
    const std::string home = strField(jf, "home", "fleet " + cls);
    const double count = numFieldOr(jf, "count", 1, "fleet " + cls);
    if (count < 0 || count > 1000 || count != std::floor(count))
      bad("fleet " + cls + " at " + home + ": count must be a whole number 0-1000");
    fleet_total += static_cast<size_t>(count);
    if (fleet_total > 5000) bad("fleet is too large (over 5000 vehicles)");
    const char* cls_c = keepStr(cls);
    const char* home_c = keepStr(home);
    for (int i = 0; i < static_cast<int>(count); ++i) spec.fleet.push_back({cls_c, home_c});
  }

  for (const json& jc : arrayFieldOrEmpty(doc, "contracts", "world"))
    spec.contracts.push_back({keepStr(strField(jc, "buyer", "contract")),
                              keepStr(strField(jc, "seller", "contract"))});

  for (const json& jm : arrayFieldOrEmpty(doc, "stranded_materials", "world")) {
    if (!jm.is_string()) bad("stranded_materials must be material keys");
    spec.stranded_materials.push_back(keepStr(jm.get<std::string>()));
  }

  // Optional market settings; a key this engine does not know is an error
  // so a typo cannot silently leave a default in place.
  World::Market market;
  if (doc.contains("market")) {
    const json& jm = doc.at("market");
    if (!jm.is_object()) bad("\"market\" must be an object");
    for (auto it = jm.begin(); it != jm.end(); ++it) {
      const std::string& k = it.key();
      double* slot = k == "value_of_time_usd_t_h" ? &market.value_of_time_usd_t_h
                     : k == "switch_cost_frac"    ? &market.switch_cost_frac
                     : k == "beta"                ? &market.beta
                     : k == "min_lot_cap_frac"    ? &market.min_lot_cap_frac
                     : k == "min_lot_target_frac" ? &market.min_lot_target_frac
                     : k == "max_lots_per_tank"   ? &market.max_lots_per_tank
                     : k == "dispatch_urgency_boost_h" ? &market.dispatch_urgency_boost_h
                     : k == "price_aware_buying" ? &market.price_aware_buying
                     : k == "price_cheap_ratio"  ? &market.price_cheap_ratio
                     : k == "price_dear_ratio"   ? &market.price_dear_ratio
                     : k == "price_cheap_fill"   ? &market.price_cheap_fill
                     : k == "price_dear_fill"    ? &market.price_dear_fill
                     : k == "price_cheap_cover"  ? &market.price_cheap_cover
                     : k == "price_dear_cover"   ? &market.price_dear_cover
                     : k == "demand_elasticity"  ? &market.demand_elasticity
                     : k == "demand_min_frac"    ? &market.demand_min_frac
                     : k == "demand_max_frac"    ? &market.demand_max_frac
                                                       : nullptr;
      if (slot == nullptr) bad("market: unknown key \"" + k + "\"");
      // Switches may be written true / false.
      *slot = it.value().is_boolean() ? (it.value().get<bool>() ? 1.0 : 0.0)
                                      : numField(jm, k.c_str(), "market");
      if (*slot < 0) bad("market: \"" + k + "\" must be >= 0");
    }
    if (jm.contains("max_lots_per_tank") && market.max_lots_per_tank < 1)
      bad("market: \"max_lots_per_tank\" must be >= 1");
  }

  // Plants, tanks, pipelines, fleet and contracts: the common builder.
  if (!buildWorld(catalog, seed, spec, out, error)) return false;
  out.market = market;

  // The route graph comes from the drawn strips, not one road node a site.
  out.nodes.clear();
  out.edges.clear();
  for (Site& s : out.sites) s.node = {kNoNode, kNoNode, kNoNode};
  const crx::Mode modes[kModeCount] = {crx::Mode::Road, crx::Mode::River, crx::Mode::Sea};
  for (int m = 0; m < kModeCount; ++m) {
    std::vector<int> bays(out.sites.size());
    std::vector<uint8_t> must(out.sites.size());
    for (size_t s = 0; s < out.sites.size(); ++s) {
      bays[s] = out.sites[s].bays[static_cast<size_t>(m)];
      must[s] = strict[s][static_cast<size_t>(m)];
    }
    buildModeGraph(out, modes[m], strips[static_cast<size_t>(m)], bays, must, smooth_km);
  }
  if (out.polyline_xy.size() / 2 > 400000) bad("the network has too many points once smoothed");
  if (out.nodes.size() > kMaxNodes)
    bad("route graph has " + std::to_string(out.nodes.size()) + " nodes (limit " +
        std::to_string(kMaxNodes) + ")");

  // A vehicle starts at its home site's node for its mode: that must exist.
  for (const World::FleetEntry& f : out.fleet) {
    const VehicleClass& vc = out.catalog.vehicle_classes[f.cls];
    const int m = modeIndex(vc.mode);
    const Site& home = out.sites[f.home.v];
    if (m < 0 || m >= kModeCount) bad("fleet: " + vc.key + " is not a vehicle class");
    if (home.node[static_cast<size_t>(m)] == kNoNode)
      bad("fleet: " + vc.key + " cannot be based at " + home.key + " (the site has no " +
          kModeNames[m] + " access)");
  }

  if (doc.contains("warm_start")) {
    if (!doc.at("warm_start").is_boolean()) bad("\"warm_start\" must be true or false");
    out.warm_start = doc.at("warm_start").get<bool>();
  }

  // Render-only map data.
  out.name = name;
  out.w_km = w_km;
  out.h_km = h_km;
  const double cols_d = std::ceil(w_km / cell_km), rows_d = std::ceil(h_km / cell_km);
  if (cols_d * rows_d > 4.0e6) bad("water grid is too fine");
  out.water_cell_km = cell_km;
  out.water_cols = static_cast<uint32_t>(cols_d);
  out.water_rows = static_cast<uint32_t>(rows_d);
  out.water.assign(static_cast<size_t>(out.water_cols) * out.water_rows, 0);
  for (const json& cell : arrayFieldOrEmpty(doc, "water", "world")) {
    if (!cell.is_array() || cell.size() < 2 || !cell[0].is_number() || !cell[1].is_number())
      bad("water cells must be [col, row]");
    const double c = cell[0].get<double>(), r = cell[1].get<double>();
    if (!(c >= 0 && c < out.water_cols && r >= 0 && r < out.water_rows)) continue;  // off the map
    out.water[static_cast<size_t>(r) * out.water_cols + static_cast<size_t>(c)] = 1;
  }

  return validateWorld(out, spec, error);
}

}  // namespace

bool roundJunctionCorner(double node_x, double node_y, double ax, double ay, double bx, double by,
                         double radius_km, std::vector<double>& moved,
                         std::vector<double>& toward_a, std::vector<double>& toward_b) {
  moved.clear();
  toward_a.clear();
  toward_b.clear();
  JunctionCurve curve;
  if (!junctionCurve({node_x, node_y}, {ax, ay}, {bx, by}, radius_km, curve)) return false;
  moved = {curve.moved.x, curve.moved.y};
  for (const Pt& p : curve.toward_a) {
    toward_a.push_back(p.x);
    toward_a.push_back(p.y);
  }
  for (const Pt& p : curve.toward_b) {
    toward_b.push_back(p.x);
    toward_b.push_back(p.y);
  }
  return true;
}

std::vector<double> roundPolylineCorners(const std::vector<double>& xy, double radius_km) {
  std::vector<Pt> pts;
  pts.reserve(xy.size() / 2);
  for (size_t i = 0; i + 1 < xy.size(); i += 2) pts.push_back({xy[i], xy[i + 1]});
  const std::vector<Pt> rounded = roundCorners(pts, radius_km);
  std::vector<double> out;
  out.reserve(rounded.size() * 2);
  for (const Pt& p : rounded) {
    out.push_back(p.x);
    out.push_back(p.y);
  }
  return out;
}

bool buildWorldFromJson(const std::string& name, const std::string& json_text, uint64_t seed,
                        World& out, std::string& error) {
  bool ok = false;
  try {
    ok = loadWorld(name, json_text, seed, out, error);
  } catch (const std::exception& e) {
    error = e.what();
  } catch (...) {
    error = "unknown failure";
  }
  if (ok) return true;
  out = World{};
  error = "world " + name + ": " + error;
  return false;
}

bool buildNamedWorld(const std::string& name, uint64_t seed, World& out, std::string& error) {
  std::string text;
  if (!readNamedWorldText(name, text, error)) return false;
  return buildWorldFromJson(name, text, seed, out, error);
}

bool readNamedWorldText(const std::string& name, std::string& text, std::string& error) {
  if (!validWorldName(name)) {
    error = "world name must be 1-64 characters of a-z, 0-9 and '-'";
    return false;
  }
  const char* dir_env = std::getenv("CRX_WORLDS_DIR");
  const std::string dir =
      dir_env != nullptr && dir_env[0] != '\0' ? std::string(dir_env)
                                               : std::string(CRX_DATA_DIR) + "/../worlds";
  const std::string path = dir + "/" + name + ".json";
  std::ifstream in(path, std::ios::binary);
  if (!in) {
    error = "world " + name + ": no such world (looked for " + path + ")";
    return false;
  }
  std::ostringstream buf;
  buf << in.rdbuf();
  text = buf.str();
  if (text.size() > kMaxFileBytes) {
    error = "world " + name + ": file is too large";
    return false;
  }
  return true;
}

}  // namespace sim
}  // namespace crx
