// Geometry primitives for the layout generator.
//
// Every distance in a generated world is an arc length along a polyline (§6.4)
// — these helpers are the only place Euclidean geometry is allowed, and the
// wiggle is normalized so the road detour factor lands exactly in its band.
#ifndef CRX_WORLDGEN_GEO_H
#define CRX_WORLDGEN_GEO_H

#include "crx/rng.h"

#include <vector>

namespace crx {
namespace worldgen {

struct Vec2 {
  double x = 0.0, y = 0.0;
};

inline Vec2 operator+(Vec2 a, Vec2 b) { return {a.x + b.x, a.y + b.y}; }
inline Vec2 operator-(Vec2 a, Vec2 b) { return {a.x - b.x, a.y - b.y}; }
inline Vec2 operator*(Vec2 a, double k) { return {a.x * k, a.y * k}; }

double distKM(Vec2 a, Vec2 b);

// Sum of segment lengths — the arc length the sim actually travels.
double polylineLength(const std::vector<Vec2>& pts);

// Shortest distance from p to the polyline's segments.
double polylineMinDist(Vec2 p, const std::vector<Vec2>& pts);

// Straight line a→b bent by seeded harmonic offsets perpendicular to the axis,
// then rescaled so arc == detourTarget × |b−a| (within 0.1%). Endpoints are
// exact. Coordinates rounded to 0.1 km for stable serialization.
std::vector<Vec2> wigglePolyline(Vec2 a, Vec2 b, double detourTarget, Rng& rng);

// Straight polyline with intermediate vertices every ~40 km (pipelines: short,
// straight links — the vertices only give the renderer something to draw).
std::vector<Vec2> straightPolyline(Vec2 a, Vec2 b);

// Collinear overlap length between two polylines: how many km of one lie
// along a piece of the other (either direction), within a 1 m corridor.
// Shared endpoints and plain crossings contribute nothing.
double overlapAlong(const std::vector<Vec2>& a, const std::vector<Vec2>& b);

double roundTo(double v, double step);

}  // namespace worldgen
}  // namespace crx

#endif  // CRX_WORLDGEN_GEO_H
