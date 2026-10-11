// Named map worlds loaded from JSON at runtime (engine/data/worlds/*.json).
//
// A world file carries what a hand-written WorldSpec carries — sites with
// processes and tanks, pipelines, a fleet, contracts — plus the map itself:
// the drawn road, river and sea strips the route graph is built from, the
// pipelines' drawn paths and a water mask. Plants, tanks and pipelines go
// through buildWorld() exactly like the six-site world; the route graph is
// then replaced by one derived from the strips:
//
//   1. every strip point is a vertex; two vertices of a mode merge when
//      they lie within 4 km and at least one is a strip end point;
//   2. a site with bays in a mode attaches when a vertex of that mode lies
//      within 12 km — to the nearest vertex and to every strip end point in
//      range;
//   3. chains of degree-2 vertices fold into one edge whose polyline is the
//      drawn path and whose length is its arc length, so the graph stays
//      small (the path cache is three n x n tables per session).
#ifndef CRX_SIM_WORLDFILE_H
#define CRX_SIM_WORLDFILE_H

#include "sim/world.h"

#include <string>
#include <vector>

namespace crx {
namespace sim {

// Loads the catalog and `<worlds dir>/<name>.json`, builds and validates the
// world. `name` must match ^[a-z0-9-]+$. The worlds directory sits next to
// the catalog (CRX_DATA_DIR/../worlds); the CRX_WORLDS_DIR environment
// variable overrides it. Returns false with `error` set on any failure —
// a missing, malformed or inconsistent file never throws or crashes.
bool buildNamedWorld(const std::string& name, uint64_t seed, World& out, std::string& error);

// The same, from JSON text already in memory (tests, tools). `name` only
// labels the world (World::name) and the error messages.
bool buildWorldFromJson(const std::string& name, const std::string& json_text, uint64_t seed,
                        World& out, std::string& error);

// Rounds the interior corners of a polyline given as a flat x,y list (a
// world file's "smooth_km"). Each interior vertex that turns by more than
// about 8 degrees becomes a short curve: a quadratic Bezier from a point d
// back along the incoming segment to a point d along the outgoing one, with
// the old vertex as control point, where d = min(radius, 0.45 x either
// segment's length). The two end points never move. A radius of 0, or fewer
// than three points, returns the input unchanged.
std::vector<double> roundPolylineCorners(const std::vector<double>& xy, double radius_km);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_WORLDFILE_H
