// Chain Reaction — world JSON and terrain for the client (§7.3): the six-site
// world keeps its seeded terrain and straight pipelines; a named map world
// reports its name and extent, draws pipelines along their drawn paths and
// turns its water mask into terrain that is below sea level exactly where
// the mask says water.
#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include "api_world.h"
#include "sim/sixsite.h"

#include <nlohmann/json.hpp>

#include <cmath>
#include <string>
#include <vector>

using json = nlohmann::json;
using crx::TerrainGrid;
using crx::sim::World;

namespace {

World sixSite() {
  World world;
  std::string error;
  REQUIRE_MESSAGE(crx::sim::buildSixSiteWorld(42, world, error), error);
  return world;
}

// The client's bilinear sampler (web/src/engine/world.ts sampleHeight).
double sampleHeight(const json& terrain, double x_km, double y_km) {
  const int cols = terrain["cols"], rows = terrain["rows"];
  const double cell = terrain["cellKm"];
  const auto& h = terrain["height"];
  const double fx = std::clamp(x_km / cell, 0.0, cols - 1.0);
  const double fy = std::clamp(y_km / cell, 0.0, rows - 1.0);
  const int x0 = static_cast<int>(std::floor(fx)), y0 = static_cast<int>(std::floor(fy));
  const int x1 = std::min(cols - 1, x0 + 1), y1 = std::min(rows - 1, y0 + 1);
  const double tx = fx - x0, ty = fy - y0;
  const auto at = [&](int c, int r) { return h[static_cast<size_t>(r) * cols + c].get<double>(); };
  const double top = at(x0, y0) * (1 - tx) + at(x1, y0) * tx;
  const double bottom = at(x0, y1) * (1 - tx) + at(x1, y1) * tx;
  return top * (1 - ty) + bottom * ty;
}

json describe(const World& world) {
  TerrainGrid terrain;
  crx::buildTerrain(world, terrain);
  std::vector<uint32_t> edge_route;
  return json::parse(crx::buildWorldJson(world, terrain, edge_route));
}

}  // namespace

TEST_CASE("six-site world: seeded terrain, straight pipelines, site-to-site routes") {
  const World world = sixSite();
  const json doc = describe(world);

  CHECK(doc["world"] == "sixsite");
  CHECK(doc["wKm"].get<double>() == doctest::Approx(600.0));
  CHECK(doc["hKm"].get<double>() == doctest::Approx(400.0));
  CHECK(doc["terrain"]["cols"] == 61);
  CHECK(doc["terrain"]["rows"] == 41);
  CHECK(doc["terrain"]["cellKm"].get<double>() == doctest::Approx(10.0));
  CHECK(doc["terrain"]["height"].size() == 61u * 41u);

  // Sites carry their engine key: the client addresses commands by it.
  REQUIRE(doc["sites"].size() == world.sites.size());
  for (size_t s = 0; s < world.sites.size(); ++s) CHECK(doc["sites"][s]["key"] == world.sites[s].key);

  REQUIRE(doc["pipelines"].size() == world.pipelines.size());
  for (const auto& pipe : doc["pipelines"]) CHECK(pipe["points"].size() == 2);
  REQUIRE(doc["routes"].size() == world.edges.size());
  for (const auto& route : doc["routes"]) {
    CHECK(route["junction"] == json::array({false, false}));
    CHECK(route["sites"][0].is_number());
  }
  REQUIRE(doc["vehicles"].size() == world.fleet.size());
  for (const auto& veh : doc["vehicles"]) CHECK(veh["home"].is_number());
}

TEST_CASE("map world: name, extent, drawn pipeline path, junction names") {
  World world = sixSite();
  world.name = "test-map";
  world.w_km = 80;
  world.h_km = 60;

  // A drawn three-point path for the first pipeline.
  const uint32_t begin = static_cast<uint32_t>(world.polyline_xy.size() / 2);
  for (double v : {10.0, 10.0, 25.0, 40.0, 70.0, 50.0}) world.polyline_xy.push_back(v);
  world.pipelines[0].polyline.begin = begin;
  world.pipelines[0].polyline.count = 3;

  // Detach one route end from its site: it becomes a named junction.
  REQUIRE(!world.edges.empty());
  const uint32_t node = world.edges[0].a;
  const int was_site = world.nodes[node].site;
  REQUIRE(was_site >= 0);
  world.nodes[node].site = -1;

  const json doc = describe(world);
  CHECK(doc["world"] == "test-map");
  CHECK(doc["wKm"].get<double>() == doctest::Approx(80.0));
  CHECK(doc["hKm"].get<double>() == doctest::Approx(60.0));

  const auto& pts = doc["pipelines"][0]["points"];
  REQUIRE(pts.size() == 3);
  CHECK(pts[1][0].get<double>() == doctest::Approx(25.0));
  CHECK(pts[1][1].get<double>() == doctest::Approx(40.0));
  CHECK(doc["pipelines"][1]["points"].size() == 2);  // the rest stay straight

  const auto& route = doc["routes"][0];
  CHECK(route["sites"][0].is_null());
  CHECK(route["junction"][0] == true);
  CHECK(route["ends"][0] == "near " + world.sites[was_site].name);
}

TEST_CASE("map world: terrain is below sea level exactly where the mask says water") {
  World world = sixSite();
  world.name = "test-map";
  world.w_km = 80;
  world.h_km = 60;
  world.water_cell_km = 10;
  world.water_cols = 8;
  world.water_rows = 6;
  world.water.assign(8 * 6, 0);
  const auto set = [&](int c, int r) { world.water[static_cast<size_t>(r) * 8 + c] = 1; };
  // A one-cell-wide river with a bend, and open water along the east edge.
  for (int c = 0; c <= 3; ++c) set(c, 2);
  set(3, 3);
  set(3, 4);
  set(3, 5);
  for (int r = 0; r < 6; ++r) set(7, r);

  const json doc = describe(world);
  const auto& terrain = doc["terrain"];
  CHECK(terrain["cols"] == 17);
  CHECK(terrain["rows"] == 13);
  CHECK(terrain["cellKm"].get<double>() == doctest::Approx(5.0));
  CHECK(terrain["seaLevelM"] == 0);
  REQUIRE(terrain["height"].size() == 17u * 13u);

  // Every point strictly inside a mask cell has the cell's sign.
  for (int r = 0; r < 6; ++r) {
    for (int c = 0; c < 8; ++c) {
      const bool water = world.water[static_cast<size_t>(r) * 8 + c] != 0;
      for (double fy : {0.08, 0.5, 0.93}) {
        for (double fx : {0.06, 0.5, 0.91}) {
          const double h = sampleHeight(terrain, (c + fx) * 10.0, (r + fy) * 10.0);
          CAPTURE(c);
          CAPTURE(r);
          CAPTURE(fx);
          CAPTURE(fy);
          if (water)
            CHECK(h < 0.0);
          else
            CHECK(h > 0.0);
        }
      }
    }
  }
  // Land stays gentle: no cliffs for the hex board to turn into walls.
  for (const auto& h : terrain["height"]) CHECK(h.get<double>() <= 30.0);
}
