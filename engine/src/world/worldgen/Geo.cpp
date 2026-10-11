#include "world/worldgen/Geo.h"

#include <algorithm>
#include <cmath>

namespace crx {
namespace worldgen {

namespace {
constexpr double kPi = 3.14159265358979323846;
}  // namespace

double roundTo(double v, double step) {
  if (step <= 0.0) return v;
  return std::nearbyint(v / step) * step;
}

double distKM(Vec2 a, Vec2 b) {
  const double dx = a.x - b.x, dy = a.y - b.y;
  return std::sqrt(dx * dx + dy * dy);
}

double polylineLength(const std::vector<Vec2>& pts) {
  double len = 0.0;
  for (size_t i = 1; i < pts.size(); ++i) len += distKM(pts[i - 1], pts[i]);
  return len;
}

double polylineMinDist(Vec2 p, const std::vector<Vec2>& pts) {
  if (pts.size() < 2) return pts.empty() ? 1e18 : distKM(p, pts[0]);
  double best = 1e18;
  for (size_t i = 1; i < pts.size(); ++i) {
    const Vec2 a = pts[i - 1], b = pts[i];
    const double abx = b.x - a.x, aby = b.y - a.y;
    const double ab2 = abx * abx + aby * aby;
    double t = ab2 > 0.0 ? ((p.x - a.x) * abx + (p.y - a.y) * aby) / ab2 : 0.0;
    t = std::clamp(t, 0.0, 1.0);
    const double dx = p.x - (a.x + abx * t), dy = p.y - (a.y + aby * t);
    best = std::min(best, std::sqrt(dx * dx + dy * dy));
  }
  return best;
}

std::vector<Vec2> wigglePolyline(Vec2 a, Vec2 b, double detourTarget, Rng& rng) {
  const double span = distKM(a, b);
  if (span <= 0.0) return {a, b};

  // One vertex per ~40 km so long edges bend; smooth harmonics so the road
  // reads as terrain-following, not zigzag.
  const int n = std::max(8, static_cast<int>(std::ceil(span / 40.0)));
  const double ax = b.x - a.x, ay = b.y - a.y;
  const double len = std::sqrt(ax * ax + ay * ay);
  const double ux = len > 0 ? ax / len : 1.0, uy = len > 0 ? ay / len : 0.0;
  const double px = -uy, py = ux;  // unit perpendicular

  struct Wave {
    double base_amp, freq, phase;
  };
  const Wave waves[3] = {{0.10 * len, 1.3, rng.uniform01() * 2 * kPi},
                         {0.05 * len, 2.9, rng.uniform01() * 2 * kPi},
                         {0.025 * len, 5.7, rng.uniform01() * 2 * kPi}};

  const auto build = [&](double scale) {
    std::vector<Vec2> pts(static_cast<size_t>(n) + 1);
    pts[0] = a;
    pts[static_cast<size_t>(n)] = b;
    for (int i = 1; i < n; ++i) {
      const double t = static_cast<double>(i) / n;
      double off = 0.0;
      for (const auto& w : waves)
        off += scale * w.base_amp * std::sin(2 * kPi * w.freq * t + w.phase);
      const double bx = a.x + ax * t, by = a.y + ay * t;
      pts[static_cast<size_t>(i)] = {roundTo(bx + px * off, 0.1), roundTo(by + py * off, 0.1)};
    }
    return pts;
  };

  // The detour excess grows ~linearly in the offset scale for these smooth
  // waves, so solve scale from the target and refine once.
  const auto detourOf = [&](const std::vector<Vec2>& pts) {
    const double arc = polylineLength(pts);
    return arc > 0.0 ? arc / span : 1.0;
  };

  // detour(scale) is monotone in the wave scale; bisect it onto the target.
  // A closed-form linear solve is ill-conditioned for short spans, where the
  // base detour is ~1.0 and (target-1)/(detour-1) explodes the amplitude.
  double lo = 0.0, hi = 4.0;
  for (int it = 0; it < 12; ++it) {
    const double mid = 0.5 * (lo + hi);
    if (detourOf(build(mid)) < detourTarget) lo = mid; else hi = mid;
  }
  return build(lo);
}

std::vector<Vec2> straightPolyline(Vec2 a, Vec2 b) {
  const double span = distKM(a, b);
  const int n = std::max(1, static_cast<int>(std::ceil(span / 40.0)));
  std::vector<Vec2> pts(static_cast<size_t>(n) + 1);
  for (int i = 0; i <= n; ++i) {
    const double t = static_cast<double>(i) / n;
    pts[static_cast<size_t>(i)] = {roundTo(a.x + (b.x - a.x) * t, 0.1),
                                   roundTo(a.y + (b.y - a.y) * t, 0.1)};
  }
  return pts;
}

// Collinear overlap length between two polylines: how many km of one lie
// along a piece of the other (either direction), within a 1 m corridor.
// Shared endpoints and plain crossings contribute nothing.
double overlapAlong(const std::vector<Vec2>& a, const std::vector<Vec2>& b) {
  double total = 0.0;
  for (size_t i = 1; i < a.size(); ++i) {
    const Vec2 p = a[i - 1], q = a[i];
    const double qx = q.x - p.x, qy = q.y - p.y;
    const double ql = std::hypot(qx, qy);
    if (ql < 1e-9) continue;
    for (size_t j = 1; j < b.size(); ++j) {
      const Vec2 u = b[j - 1], v = b[j];
      const double ux = v.x - u.x, uy = v.y - u.y;
      const double ul = std::hypot(ux, uy);
      if (ul < 1e-9) continue;
      const double cross = qx * uy - qy * ux;
      if (std::abs(cross) > 1e-3 * ql * ul) continue;  // not collinear
      const double off_u = std::abs(qx * (u.y - p.y) - qy * (u.x - p.x)) / ql;
      if (off_u > 1.0) continue;  // parallel but in a different corridor
      const double pu = ((u.x - p.x) * qx + (u.y - p.y) * qy) / ql;
      const double pv = pu + (qx * ux + qy * uy) / ql;
      const double lo = std::max(0.0, std::min(pu, pv));
      const double hi = std::min(ql, std::max(pu, pv));
      if (hi > lo) total += hi - lo;
    }
  }
  return total;
}

}  // namespace worldgen
}  // namespace crx
