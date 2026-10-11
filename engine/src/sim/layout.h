// Chain Reaction — a redrawn map on top of a named world.
//
// The map builder lets a person move the world's sites and redraw its roads,
// lanes, pipelines and water. Plants, sizes, tanks, berth counts, market
// settings and options stay the named world's; the layout supplies where
// things are. This merges the two, checks the result in plain words (no
// exception ever leaves here) and scales the fleet to the new distances.
#ifndef CRX_SIM_LAYOUT_H
#define CRX_SIM_LAYOUT_H

#include "sim/world.h"

#include <cstdint>
#include <string>
#include <vector>

namespace crx {
namespace sim {

constexpr size_t kMaxLayoutBytes = 1024 * 1024;

struct LayoutIssue {
  int site = 0;      // layout site id (1-based), 0 = not about one site
  std::string mode;  // "road", "river", "sea" or empty
  std::string text;  // a plain sentence
};

struct LayoutReport {
  std::vector<LayoutIssue> errors, warnings;
  double road_km = 0, river_km = 0, sea_km = 0;
  size_t vehicles = 0;
  bool ok() const { return errors.empty(); }
};

// Builds `out` from the named world's file with the layout laid over it.
// Site ids in the layout are the world file's sites in order, starting at 1.
// Returns false with report.errors filled when the layout cannot be used.
bool buildWorldWithLayout(const std::string& world_name, const std::string& layout_json,
                          uint64_t seed, World& out, LayoutReport& report);

// The map builder's check: the report as JSON, and when the world builds a
// 30-day trial run of it (service, the worst customer, plants that stopped).
// {"ok", "errors", "warnings", "summary", "trial"}.
std::string checkLayoutJson(const std::string& world_name, const std::string& layout_json);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_LAYOUT_H
