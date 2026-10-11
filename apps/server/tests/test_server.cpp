// crx-server route tests (§7.4): the real server on an ephemeral port,
// exercised over HTTP. Runs without a web build, so "/" serves the placeholder.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include "crx_server.h"
#include "rooms.h"

#include <httplib.h>
#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <cmath>
#include <cstring>
#include <fstream>
#include <set>
#include <map>
#include <cctype>
#include <sstream>
#include <string>
#include <thread>

namespace {

using json = nlohmann::json;

// Server harness: registers routes, binds to a free port, serves in background.
// Capacity and TTL default to the production values so route-level tests run
// against what main.cpp would construct.
struct TestServer {
  crx::server::SessionRegistry sessions;
  httplib::Server svr;
  int port = 0;
  std::thread thread;

  explicit TestServer(
      size_t capacity = 200,
      std::chrono::steady_clock::duration ttl = std::chrono::minutes(2),
      const std::string& webDir = "/nonexistent/web/dist")
      : sessions(capacity, ttl) {
    crx::server::registerRoutes(svr, sessions, webDir);
    port = svr.bind_to_any_port("127.0.0.1");
    thread = std::thread([this] { svr.listen_after_bind(); });
  }
  ~TestServer() {
    svr.stop();
    thread.join();
  }
};

httplib::Client client(int port) { return httplib::Client("127.0.0.1", port); }

// Snapshot header (§7.3): magic "CRXS" at 0, little-endian uint64 tick at 8.
uint64_t tickOf(const std::string& snapshot) {
  uint64_t tick = 0;
  std::memcpy(&tick, snapshot.data() + 8, sizeof tick);
  return tick;
}

std::string createSession(httplib::Client& cli, const std::string& config) {
  const auto res = cli.Post("/api/sim", config, "application/json");
  REQUIRE(res);
  REQUIRE(res->status == 200);
  return json::parse(res->body).at("id").get<std::string>();
}

}  // namespace

TEST_CASE("create then step returns the CRXS snapshot and advances the tick") {
  TestServer srv;
  auto cli = client(srv.port);

  const std::string id = createSession(cli, R"({"seed":7})");

  auto step = cli.Post("/api/sim/" + id + "/step", R"({"ticks":10})", "application/json");
  REQUIRE(step);
  CHECK(step->status == 200);
  REQUIRE(step->body.size() >= 20);
  CHECK(std::memcmp(step->body.data(), "CRXS", 4) == 0);
  CHECK(tickOf(step->body) == 10);

  auto again = cli.Post("/api/sim/" + id + "/step", R"({"ticks":5})", "application/json");
  REQUIRE(again);
  CHECK(std::memcmp(again->body.data(), "CRXS", 4) == 0);
  CHECK(tickOf(again->body) == 15);
}

TEST_CASE("world, events, series and kpis serve the engine's data") {
  TestServer srv;
  auto cli = client(srv.port);
  const std::string id = createSession(cli, "{}");
  REQUIRE(cli.Post("/api/sim/" + id + "/step", R"({"ticks":10})", "application/json"));

  auto world = cli.Get("/api/sim/" + id + "/world");
  REQUIRE(world);
  CHECK(world->status == 200);
  CHECK(world->body.find("\"sites\"") != std::string::npos);

  auto events = cli.Get("/api/sim/" + id + "/events?since=0");
  REQUIRE(events);
  CHECK(events->status == 200);
  CHECK(json::parse(events->body).is_array());

  auto series = cli.Get("/api/sim/" + id + "/series?kind=0&id=0");
  REQUIRE(series);
  CHECK(series->status == 200);
  CHECK(series->body.size() % sizeof(float) == 0);
  CHECK(series->body.size() > 0);  // 10 ticks cover two hourly records

  auto kpis = cli.Get("/api/sim/" + id + "/kpis");
  REQUIRE(kpis);
  CHECK(kpis->status == 200);
  CHECK(kpis->body.size() == 8 * sizeof(double));  // KPI vector of §5.10
}

TEST_CASE("command posts through to the engine and fork copies the run") {
  TestServer srv;
  auto cli = client(srv.port);
  const std::string id = createSession(cli, "{}");
  REQUIRE(cli.Post("/api/sim/" + id + "/step", R"({"ticks":10})", "application/json"));

  auto command = cli.Post("/api/sim/" + id + "/command",
                          R"({"cmd":"set","key":"adaptive","value":false})",
                          "application/json");
  REQUIRE(command);
  CHECK(command->status == 200);
  CHECK(json::parse(command->body).at("ok") == true);

  auto fork = cli.Post("/api/sim/" + id + "/fork", "", "application/json");
  REQUIRE(fork);
  CHECK(fork->status == 200);
  const std::string forkId = json::parse(fork->body).at("id").get<std::string>();
  CHECK(forkId != id);

  // The fork starts at its parent's tick; a zero-tick step returns the snapshot.
  auto forkSnapshot = cli.Post("/api/sim/" + forkId + "/step", R"({"ticks":0})", "application/json");
  REQUIRE(forkSnapshot);
  CHECK(std::memcmp(forkSnapshot->body.data(), "CRXS", 4) == 0);
  CHECK(tickOf(forkSnapshot->body) == 10);
}

TEST_CASE("rewind rebuilds an earlier tick exactly and forgets what came after") {
  TestServer srv;
  auto cli = client(srv.port);
  const auto post = [&cli](const std::string& path, const std::string& body) {
    auto res = cli.Post(path, body, "application/json");
    REQUIRE(res);
    return *res;
  };
  const auto snapshotAt = [&post](const std::string& id) {
    return post("/api/sim/" + id + "/step", R"({"ticks":0})").body;
  };
  const std::string outage =
      R"({"type":"unit_outage","site":"STEAM_CRACKER","unit":"SC-CGC","trains":1,"duration_h":48})";

  // Run A: 40 ticks, an outage, 60 more ticks.
  const std::string a = createSession(cli, R"({"seed":7})");
  post("/api/sim/" + a + "/step", R"({"ticks":40})");
  CHECK(json::parse(post("/api/sim/" + a + "/command", outage).body).at("ok") == true);
  post("/api/sim/" + a + "/step", R"({"ticks":60})");

  // Back to tick 70, after the outage was issued: identical to a run that
  // did the same things and stopped at 70.
  const auto back = post("/api/sim/" + a + "/rewind", R"({"tick":70})");
  CHECK(back.status == 200);
  CHECK(json::parse(back.body).at("tick") == 70);
  const std::string b = createSession(cli, R"({"seed":7})");
  post("/api/sim/" + b + "/step", R"({"ticks":40})");
  post("/api/sim/" + b + "/command", outage);
  post("/api/sim/" + b + "/step", R"({"ticks":30})");
  CHECK(tickOf(snapshotAt(a)) == 70);
  CHECK(snapshotAt(a) == snapshotAt(b));

  // Back to tick 40, the moment the outage was issued: the outage is
  // forgotten, so running on matches a run that never had it.
  CHECK(post("/api/sim/" + a + "/rewind", R"({"tick":40})").status == 200);
  post("/api/sim/" + a + "/step", R"({"ticks":60})");
  const std::string c = createSession(cli, R"({"seed":7})");
  post("/api/sim/" + c + "/step", R"({"ticks":100})");
  CHECK(snapshotAt(a) == snapshotAt(c));
  CHECK(snapshotAt(a) != post("/api/sim/" + b + "/step", R"({"ticks":30})").body);

  // A fork can go back into its parent's past.
  const std::string f = json::parse(post("/api/sim/" + b + "/fork", "").body).at("id");
  CHECK(post("/api/sim/" + f + "/rewind", R"({"tick":70})").status == 200);
  const std::string d = createSession(cli, R"({"seed":7})");
  post("/api/sim/" + d + "/step", R"({"ticks":40})");
  post("/api/sim/" + d + "/command", outage);
  post("/api/sim/" + d + "/step", R"({"ticks":30})");
  CHECK(snapshotAt(f) == snapshotAt(d));

  // Refusals: the future, malformed bodies, unknown sessions.
  CHECK(post("/api/sim/" + a + "/rewind", R"({"tick":101})").status == 400);
  CHECK(post("/api/sim/" + a + "/rewind", R"({"tick":-1})").status == 400);
  CHECK(post("/api/sim/" + a + "/rewind", R"({"ticks":5})").status == 400);
  CHECK(post("/api/sim/" + a + "/rewind", "not json").status == 400);
  CHECK(post("/api/sim/nope/rewind", R"({"tick":0})").status == 404);
  CHECK(tickOf(snapshotAt(a)) == 100);
}

TEST_CASE("forecast: with and without the disruptions, cost and countdown, session untouched") {
  TestServer srv;
  auto cli = client(srv.port);
  const auto post = [&cli](const std::string& path, const std::string& body) {
    auto res = cli.Post(path, body, "application/json");
    REQUIRE(res);
    return *res;
  };
  const std::string id = createSession(cli, R"({"seed":42,"world":"erwin-world-v1"})");
  post("/api/sim/" + id + "/step", R"({"ticks":960})");  // day 10

  // Nothing broken: the two futures are the same run.
  const auto calm = post("/api/sim/" + id + "/forecast", R"({"days":30})");
  REQUIRE(calm.status == 200);
  const json quiet = json::parse(calm.body);
  CHECK(quiet.at("tick") == 960);
  CHECK(quiet.at("to_tick") == 960 + 30 * 96);
  CHECK(quiet.at("disruptions") == 0);
  CHECK(quiet.at("countdown").empty());
  for (const auto& item : quiet.at("delta").items()) CHECK(item.value().get<double>() == 0.0);
  CHECK(quiet.at("with") == quiet.at("without"));
  CHECK(quiet.at("with").at("customers").size() == 15);

  // Ethane cracker compressor down for ten days.
  CHECK(json::parse(post("/api/sim/" + id + "/command",
                         R"({"type":"unit_outage","site":"CRACKER_ETHANE","unit":"SC-CGC",)"
                         R"("trains":1,"duration_h":240})")
                        .body)
            .at("ok") == true);
  const std::string before = post("/api/sim/" + id + "/step", R"({"ticks":0})").body;
  const auto first = post("/api/sim/" + id + "/forecast", R"({"days":30})");
  const auto second = post("/api/sim/" + id + "/forecast", R"({"days":30})");
  REQUIRE(first.status == 200);
  CHECK(first.body == second.body);  // repeatable
  CHECK(post("/api/sim/" + id + "/step", R"({"ticks":0})").body == before);  // run untouched

  const json f = json::parse(first.body);
  CHECK(f.at("disruptions") == 1);
  CHECK(f.at("delta").at("cost_usd").get<double>() > 0.0);
  CHECK(f.at("delta").at("shutdown_h").get<double>() >= 240.0);
  CHECK(f.at("without").at("totals").at("shutdown_h").get<double>() == 0.0);
  CHECK(f.at("without") == quiet.at("without"));  // "without" is the run nobody broke
  bool pe_stops = false;
  uint64_t last_tick = 0;
  for (const json& c : f.at("countdown")) {
    CHECK(c.at("tick").get<uint64_t>() >= last_tick);  // soonest first
    last_tick = c.at("tick").get<uint64_t>();
    CHECK(c.at("hours_from_now").get<double>() == doctest::Approx((last_tick - 960) * 0.25));
    if (c.at("site") == "POLYETHYLENE" && c.at("kind") == "shuts_down") pe_stops = true;
  }
  CHECK(pe_stops);

  // Default window, bounds and refusals.
  CHECK(json::parse(post("/api/sim/" + id + "/forecast", "").body).at("days") == 30);
  CHECK(json::parse(post("/api/sim/" + id + "/forecast", R"({"days":1})").body).at("to_tick") ==
        960 + 96);
  CHECK(post("/api/sim/" + id + "/forecast", R"({"days":0})").status == 400);
  CHECK(post("/api/sim/" + id + "/forecast", R"({"days":121})").status == 400);
  CHECK(post("/api/sim/" + id + "/forecast", R"({"days":"ten"})").status == 400);
  CHECK(post("/api/sim/" + id + "/forecast", "not json").status == 400);
  CHECK(post("/api/sim/nope/forecast", R"({"days":5})").status == 404);

  // The six-site world forecasts too.
  const std::string six = createSession(cli, R"({"seed":42})");
  post("/api/sim/" + six + "/step", R"({"ticks":200})");
  CHECK(post("/api/sim/" + six + "/forecast", R"({"days":10})").status == 200);
}

TEST_CASE("vehicle: where it is going, where from, and what it holds") {
  TestServer srv;
  auto cli = client(srv.port);
  const std::string id = createSession(cli, R"({"seed":42})");
  const auto get = [&](const std::string& query) {
    auto res = cli.Get("/api/sim/" + id + "/vehicle" + query);
    REQUIRE(res);
    return *res;
  };
  const auto world = cli.Get("/api/sim/" + id + "/world");
  REQUIRE(world);
  const json sites = json::parse(world->body).at("sites");

  // At rest: no order, no path.
  const json parked = json::parse(get("?index=0").body);
  CHECK(parked.at("status") == "idle");
  CHECK(parked.at("cls") == "TRUCK_TANK");
  CHECK(parked.at("capacityT") == 25);
  CHECK(parked.at("order").is_null());
  CHECK(parked.at("cargo").is_null());
  CHECK(parked.at("legDestination").is_null());
  CHECK(parked.at("path").empty());
  CHECK(parked.at("at").at("site").is_number());

  // Run until a truck is on the road with cargo aboard (the fuel-oil lane
  // from the cracker to the port), an hour at a time.
  json moving;
  for (int hour = 0; hour < 24 * 30 && moving.is_null(); ++hour) {
    REQUIRE(cli.Post("/api/sim/" + id + "/step", R"({"ticks":4})", "application/json"));
    for (int v = 0; v < 2 && moving.is_null(); ++v) {
      const json doc = json::parse(get("?index=" + std::to_string(v)).body);
      if (doc.at("status") == "to_dropoff" && doc.at("path").size() >= 2) moving = doc;
    }
  }
  REQUIRE(!moving.is_null());
  const json& order = moving.at("order");
  CHECK(order.at("material") == "FUEL_OIL");
  CHECK(order.at("from").at("key") == "STEAM_CRACKER");
  CHECK(order.at("to").at("key") == "PORT_TERMINAL");
  CHECK(order.at("tonnes").get<double>() > 0.0);
  CHECK(order.at("tonnes").get<double>() <= 25.0);
  CHECK(order.at("etaTick").get<uint64_t>() >= order.at("createdTick").get<uint64_t>());
  CHECK(order.at("priceUsdT").get<double>() > 0.0);
  CHECK(order.at("freightUsd").get<double>() > 0.0);
  // Loaded and on its way: the cargo is the order's lot, bound for the buyer.
  CHECK(moving.at("cargo").at("material") == "FUEL_OIL");
  CHECK(moving.at("cargo").at("tonnes").get<double>() ==
        doctest::Approx(order.at("tonnes").get<double>()));
  CHECK(moving.at("legDestination").at("key") == "PORT_TERMINAL");

  // The path starts where the vehicle is, ends at the destination site, and
  // its length is the distance left.
  const json& path = moving.at("path");
  CHECK(path.front() == moving.at("position"));
  const json& port = sites.at(order.at("to").at("site").get<size_t>());
  CHECK(path.back().at(0).get<double>() == doctest::Approx(port.at("x").get<double>()));
  CHECK(path.back().at(1).get<double>() == doctest::Approx(port.at("y").get<double>()));
  double length = 0;
  for (size_t i = 1; i < path.size(); ++i)
    length += std::hypot(path[i].at(0).get<double>() - path[i - 1].at(0).get<double>(),
                         path[i].at(1).get<double>() - path[i - 1].at(1).get<double>());
  CHECK(length == doctest::Approx(moving.at("remainingKm").get<double>()).epsilon(1e-6));
  CHECK(moving.at("remainingKm").get<double>() > 0.0);
  CHECK(moving.at("remainingKm").get<double>() <= moving.at("tripKm").get<double>() + 1e-9);

  // Refusals.
  CHECK(get("").status == 400);
  CHECK(get("?index=abc").status == 400);
  CHECK(get("?index=2").status == 400);  // the six-site world has two trucks
  auto unknown = cli.Get("/api/sim/nope/vehicle?index=0");
  REQUIRE(unknown);
  CHECK(unknown->status == 404);
}

TEST_CASE("economy: the run so far in time buckets, cut back by a rewind") {
  TestServer srv;
  auto cli = client(srv.port);
  const std::string id = createSession(cli, R"({"seed":42,"world":"erwin-world-v1"})");
  const auto economy = [&](const std::string& query) {
    auto res = cli.Get("/api/sim/" + id + "/economy" + query);
    REQUIRE(res);
    return *res;
  };

  // Before the first tick there is nothing to show.
  CHECK(json::parse(economy("").body).at("buckets") == 0);

  REQUIRE(cli.Post("/api/sim/" + id + "/step", R"({"ticks":1000})", "application/json"));
  const json daily = json::parse(economy("").body);  // default bucket: a day
  CHECK(daily.at("bucketH") == 24);
  CHECK(daily.at("tick") == 1000);
  CHECK(daily.at("buckets") == 11);  // ten full days and a part
  CHECK(!daily.at("materials").empty());
  CHECK(daily.at("materials")[0].at("orderedT").size() == 11);
  CHECK(daily.at("totals").at("energyUsd").size() == 11);
  CHECK(daily.at("plants")[0].at("rateMax").size() == 11);
  CHECK(json::parse(economy("?bucket_h=6").body).at("buckets") == 42);
  CHECK(json::parse(economy("?bucket_h=168").body).at("buckets") == 2);

  // A rewind shortens the history to the moment gone back to.
  REQUIRE(cli.Post("/api/sim/" + id + "/rewind", R"({"tick":300})", "application/json"));
  const json earlier = json::parse(economy("").body);
  CHECK(earlier.at("tick") == 300);
  CHECK(earlier.at("buckets") == 4);
  CHECK(earlier.at("totals").at("demandT").size() == 4);

  CHECK(economy("?bucket_h=0").status == 400);
  CHECK(economy("?bucket_h=169").status == 400);
  CHECK(economy("?bucket_h=day").status == 400);
  auto unknown = cli.Get("/api/sim/nope/economy");
  REQUIRE(unknown);
  CHECK(unknown->status == 404);
}

TEST_CASE("sourcing: the buying tanks, one tank's options, and refusals") {
  TestServer srv;
  auto cli = client(srv.port);
  const std::string id = createSession(cli, R"({"seed":42,"world":"erwin-world-v1"})");
  REQUIRE(cli.Post("/api/sim/" + id + "/step", R"({"ticks":480})", "application/json"));
  const auto get = [&](const std::string& query) {
    auto res = cli.Get("/api/sim/" + id + "/sourcing" + query);
    REQUIRE(res);
    return *res;
  };
  const std::string before =
      cli.Post("/api/sim/" + id + "/step", R"({"ticks":0})", "application/json")->body;

  const auto list = get("");
  CHECK(list.status == 200);
  CHECK(json::parse(list.body).at("tanks").size() == 20);

  const auto one = get("?site=VINYLS&material=CHLORINE");
  CHECK(one.status == 200);
  const json doc = json::parse(one.body);
  CHECK(doc.at("tick") == 480);
  CHECK(doc.at("tank").at("name") == "Vinyls (VCM + PVC)");
  REQUIRE(doc.at("options").size() == 1);  // chlorine has one maker and goes by pressurised truck
  CHECK(doc.at("options")[0].at("seller") == "CHLOR_ALKALI");
  CHECK(doc.at("options")[0].at("cls") == "TRUCK_PRESS");
  CHECK(doc.at("options")[0].at("usual") == true);
  CHECK(get("?site=11&material=CHLORINE").body == one.body);  // site by index

  CHECK(get("?site=NOPE&material=PE").status == 400);
  CHECK(get("?site=VINYLS&material=NOPE").status == 400);
  CHECK(get("?site=VINYLS").status == 400);
  CHECK(get("?material=PE").status == 400);
  auto unknown = cli.Get("/api/sim/nope/sourcing");
  REQUIRE(unknown);
  CHECK(unknown->status == 404);

  // Asking never moves the run.
  CHECK(cli.Post("/api/sim/" + id + "/step", R"({"ticks":0})", "application/json")->body == before);
}

TEST_CASE("route_break by edge: the index is the route's position in the world JSON") {
  TestServer srv;
  auto cli = client(srv.port);
  const std::string id = createSession(cli, R"({"seed":42,"world":"erwin-world-v1"})");
  const auto world = cli.Get("/api/sim/" + id + "/world");
  REQUIRE(world);
  const json routes = json::parse(world->body).at("routes");
  REQUIRE(routes.size() == 88);
  size_t river = routes.size();
  for (size_t i = 0; i < routes.size() && river == routes.size(); ++i)
    if (routes[i].at("mode") == "river") river = i;
  REQUIRE(river < routes.size());

  const auto command = [&](const json& cmd) {
    auto res = cli.Post("/api/sim/" + id + "/command", cmd.dump(), "application/json");
    REQUIRE(res);
    return json::parse(res->body);
  };
  CHECK(command({{"type", "route_break"}, {"edge", river}, {"duration_h", 48}}).at("ok") == true);
  CHECK(command({{"type", "route_break"}, {"edge", routes.size()}, {"duration_h", 48}}).at("ok") ==
        false);
  REQUIRE(cli.Post("/api/sim/" + id + "/step", R"({"ticks":8})", "application/json"));
  const auto events = cli.Get("/api/sim/" + id + "/events?since=0");
  REQUIRE(events);
  bool closed = false;
  for (const json& e : json::parse(events->body))
    if (e.at("type") == "route_break" && e.at("unit") == std::to_string(river))
      closed = e.at("text").get<std::string>().rfind("River lane ", 0) == 0 &&
               e.at("text").get<std::string>().find(" closed for 2 days") != std::string::npos;
  CHECK(closed);

  // A rewind to before the closure forgets it, like any other disruption.
  REQUIRE(cli.Post("/api/sim/" + id + "/rewind", R"({"tick":0})", "application/json"));
  REQUIRE(cli.Post("/api/sim/" + id + "/step", R"({"ticks":8})", "application/json"));
  const auto after = cli.Get("/api/sim/" + id + "/events?since=0");
  REQUIRE(after);
  for (const json& e : json::parse(after->body)) CHECK(e.at("type") != "route_break");
}

TEST_CASE("place_order over HTTP: booked, replayed by a rewind, kept by the forecast") {
  TestServer srv;
  auto cli = client(srv.port);
  const auto post = [&cli](const std::string& path, const std::string& body) {
    auto res = cli.Post(path, body, "application/json");
    REQUIRE(res);
    return *res;
  };
  const std::string order =
      R"({"type":"place_order","site":"STYRENICS","material":"BENZENE","seller":"REFINERY",)"
      R"("cls":"TRUCK_TANK","tonnes":25})";
  const std::string cfg = R"({"seed":42,"world":"erwin-world-v1"})";

  const std::string a = createSession(cli, cfg);
  post("/api/sim/" + a + "/step", R"({"ticks":100})");
  const json reply = json::parse(post("/api/sim/" + a + "/command", order).body);
  REQUIRE(reply.at("ok") == true);
  CHECK(reply.at("order").at("tonnes") == 25.0);
  post("/api/sim/" + a + "/step", R"({"ticks":20})");

  // The refusal carries its reason and books nothing.
  const json bad = json::parse(
      post("/api/sim/" + a + "/command",
           R"({"type":"place_order","site":"STYRENICS","material":"BENZENE","seller":"REFINERY",)"
           R"("cls":"TRUCK_BULK","tonnes":25})")
          .body);
  CHECK(bad.at("ok") == false);
  CHECK(bad.at("blocked") == "not_possible");

  // A rewind to after the order replays it: same as a run that placed it and stopped there.
  CHECK(post("/api/sim/" + a + "/rewind", R"({"tick":110})").status == 200);
  const std::string b = createSession(cli, cfg);
  post("/api/sim/" + b + "/step", R"({"ticks":100})");
  post("/api/sim/" + b + "/command", order);
  post("/api/sim/" + b + "/step", R"({"ticks":10})");
  CHECK(post("/api/sim/" + a + "/step", R"({"ticks":0})").body ==
        post("/api/sim/" + b + "/step", R"({"ticks":0})").body);

  // It is not a disruption: with none issued, the forecast's two futures are one.
  const json f = json::parse(post("/api/sim/" + a + "/forecast", R"({"days":2})").body);
  CHECK(f.at("disruptions") == 0);
  CHECK(f.at("with") == f.at("without"));
}

TEST_CASE("unit_outage by unit_index: the world JSON's unit index, forgotten by a rewind") {
  TestServer srv;
  auto cli = client(srv.port);
  const std::string id = createSession(cli, R"({"seed":42,"world":"erwin-world-v1"})");
  const auto world = cli.Get("/api/sim/" + id + "/world");
  REQUIRE(world);
  // Every unit in the world JSON carries its own index; find the jet block.
  int jet = -1;
  std::set<int> seen;
  const json world_doc = json::parse(world->body);
  for (const json& site : world_doc.at("sites"))
    for (const json& proc : site.at("processes"))
      for (const json& unit : proc.at("units")) {
        CHECK(seen.insert(unit.at("index").get<int>()).second);  // no two units share one
        if (proc.at("key") == "FUEL_DEPOT_JET") jet = unit.at("index").get<int>();
      }
  REQUIRE(jet >= 0);
  const auto post = [&cli](const std::string& path, const std::string& body) {
    auto res = cli.Post(path, body, "application/json");
    REQUIRE(res);
    return *res;
  };
  post("/api/sim/" + id + "/step", R"({"ticks":96})");
  const std::string outage =
      json{{"type", "unit_outage"}, {"unit_index", jet}, {"trains", 1}, {"duration_h", 240}}.dump();
  CHECK(json::parse(post("/api/sim/" + id + "/command", outage).body).at("ok") == true);
  post("/api/sim/" + id + "/step", R"({"ticks":8})");
  const auto events = cli.Get("/api/sim/" + id + "/events?since=0");
  REQUIRE(events);
  int failures = 0;
  for (const json& e : json::parse(events->body))
    if (e.at("type") == "unit_failed") {
      ++failures;
      CHECK(e.at("text").get<std::string>().find("City jet fuel demand") != std::string::npos);
    }
  CHECK(failures == 1);

  // It is a disruption like any other: the forecast counts it, a rewind forgets it.
  CHECK(json::parse(post("/api/sim/" + id + "/forecast", R"({"days":5})").body).at("disruptions") == 1);
  REQUIRE(post("/api/sim/" + id + "/rewind", R"({"tick":96})").status == 200);
  post("/api/sim/" + id + "/step", R"({"ticks":8})");
  const auto after = cli.Get("/api/sim/" + id + "/events?since=0");
  REQUIRE(after);
  for (const json& e : json::parse(after->body)) CHECK(e.at("type") != "unit_failed");
  CHECK(json::parse(post("/api/sim/" + id + "/forecast", R"({"days":5})").body).at("disruptions") == 0);
}

TEST_CASE("sourcing after a closure: the cut-off tank stays listed and says route_closed") {
  TestServer srv;
  auto cli = client(srv.port);
  const std::string id = createSession(cli, R"({"seed":42,"world":"erwin-world-v1"})");
  const auto post = [&cli](const std::string& path, const std::string& body) {
    auto res = cli.Post(path, body, "application/json");
    REQUIRE(res);
    return *res;
  };
  const auto get = [&](const std::string& query) {
    auto res = cli.Get("/api/sim/" + id + "/sourcing" + query);
    REQUIRE(res);
    return json::parse(res->body);
  };
  post("/api/sim/" + id + "/step", R"({"ticks":480})");
  CHECK(get("").at("tanks").size() == 20);

  // Find the road edges into Vinyls by closing each road in turn on a fork
  // until the chlorine option reports a closed route; then do it for real.
  const json routes = json::parse(cli.Get("/api/sim/" + id + "/world")->body).at("routes");
  int cutting = -1;
  for (size_t e = 0; e < routes.size() && cutting < 0; ++e) {
    if (routes[e].at("mode") != "road") continue;
    const std::string fork = json::parse(post("/api/sim/" + id + "/fork", "").body).at("id");
    post("/api/sim/" + fork + "/command",
         json{{"type", "route_break"}, {"edge", e}, {"duration_h", 240}}.dump());
    post("/api/sim/" + fork + "/step", R"({"ticks":2})");
    auto res = cli.Get("/api/sim/" + fork + "/sourcing?site=VINYLS&material=CHLORINE");
    REQUIRE(res);
    const json doc = json::parse(res->body);
    if (doc.at("options").size() == 1 && doc.at("options")[0].at("blocked") == "route_closed")
      cutting = static_cast<int>(e);
    cli.Delete("/api/sim/" + fork);
  }
  REQUIRE(cutting >= 0);
  post("/api/sim/" + id + "/command",
       json{{"type", "route_break"}, {"edge", cutting}, {"duration_h", 240}}.dump());
  post("/api/sim/" + id + "/step", R"({"ticks":2})");

  CHECK(get("").at("tanks").size() == 20);  // nobody dropped out of the list
  const json doc = get("?site=VINYLS&material=CHLORINE");
  REQUIRE(doc.at("options").size() == 1);
  CHECK(doc.at("options")[0].at("feasible_now") == false);
  CHECK(doc.at("options")[0].at("blocked") == "route_closed");
  CHECK(doc.at("options")[0].at("blocked_reason") == "the road to this site is closed");
  const json refused = json::parse(
      post("/api/sim/" + id + "/command",
           R"({"type":"place_order","site":"VINYLS","material":"CHLORINE","seller":"CHLOR_ALKALI",)"
           R"("cls":"TRUCK_PRESS","tonnes":20})")
          .body);
  CHECK(refused.at("ok") == false);
  CHECK(refused.at("blocked") == "route_closed");
  CHECK(refused.at("error") == "place_order: the road to this site is closed");
}

TEST_CASE("snapshot site status: 5 marks a site held back by a shock") {
  TestServer srv;
  auto cli = client(srv.port);
  const std::string id = createSession(cli, R"({"seed":42,"world":"erwin-world-v1"})");
  const auto post = [&cli](const std::string& path, const std::string& body) {
    auto res = cli.Post(path, body, "application/json");
    REQUIRE(res);
    return *res;
  };
  const json world = json::parse(cli.Get("/api/sim/" + id + "/world")->body);
  size_t gas_field = world.at("sites").size();
  for (size_t i = 0; i < world.at("sites").size(); ++i)
    if (world.at("sites")[i].at("key") == "GAS_FIELD") gas_field = i;
  REQUIRE(gas_field < world.at("sites").size());
  // Snapshot (§7.3): magic, version, tick, count, then {scalars, offset} per
  // array; array 4 is one status byte per site.
  const auto siteStatus = [&](const std::string& snap, size_t site) {
    uint32_t offset = 0;
    std::memcpy(&offset, snap.data() + 20 + 4 * 8 + 4, sizeof offset);
    return static_cast<int>(static_cast<uint8_t>(snap[offset + site]));
  };
  CHECK(siteStatus(post("/api/sim/" + id + "/step", R"({"ticks":8})").body, gas_field) == 0);
  post("/api/sim/" + id + "/command",
       R"({"type":"supply_shock","site":"GAS_FIELD","multiplier":0.5,"duration_h":24})");
  CHECK(siteStatus(post("/api/sim/" + id + "/step", R"({"ticks":4})").body, gas_field) == 5);
  CHECK(siteStatus(post("/api/sim/" + id + "/step", R"({"ticks":100})").body, gas_field) == 0);
}

TEST_CASE("world json: every unit and process stream has a plain name") {
  TestServer srv;
  auto cli = client(srv.port);
  const std::string id = createSession(cli, R"({"seed":42,"world":"erwin-world-v1"})");
  const json world = json::parse(cli.Get("/api/sim/" + id + "/world")->body);
  std::map<std::string, std::string> names;
  for (const json& site : world.at("sites"))
    for (const json& proc : site.at("processes")) {
      for (const char* side : {"in", "out"})
        for (const json& st : proc.at(side)) names[st.at("key").get<std::string>()] = st.at("name");
      for (const json& unit : proc.at("units"))
        for (const char* side : {"in", "out"})
          for (const json& st : unit.at(side)) {
            const std::string key = st.at("key"), name = st.at("name");
            names[key] = name;
            CHECK(!name.empty());
            if (key != "LPG" && key != "PVC") CHECK(name != key);  // never a raw key (these two are words)
            CHECK(name.find('_') == std::string::npos);
            CHECK(std::isupper(static_cast<unsigned char>(name[0])) != 0);
          }
    }
  CHECK(names.at("edc") == "Ethylene dichloride");
  CHECK(names.at("hcl") == "Hydrogen chloride");
  CHECK(names.at("eb") == "Ethylbenzene");
  CHECK(names.at("wet_cl2") == "Wet chlorine gas");
  CHECK(names.at("ygrade") == "Mixed gas liquids");
  CHECK(names.at("resid") == "Atmospheric residue");
  CHECK(names.at("AIR_O2") == "Air");
  CHECK(names.at("PE") == "Polyethylene");
  CHECK(names.at("CAUSTIC") == "Caustic soda");
}

TEST_CASE("map builder: check a layout, then run, rewind and inspect a session on it") {
  TestServer srv;
  auto cli = client(srv.port);
  std::ifstream in(std::string(CRX_TEST_LAYOUT_DIR) + "/erwin-world-v1.json");
  REQUIRE(static_cast<bool>(in));
  std::ostringstream buf;
  buf << in.rdbuf();
  json layout = json::parse(buf.str());
  const auto post = [&cli](const std::string& path, const std::string& body) {
    auto res = cli.Post(path, body, "application/json");
    REQUIRE(res);
    return *res;
  };

  // The default layout checks clean and its trial passes.
  const auto ok = post("/api/worlds/check", json{{"layout", layout}}.dump());
  CHECK(ok.status == 200);
  const json good = json::parse(ok.body);
  CHECK(good.at("ok") == true);
  CHECK(good.at("errors").empty());
  CHECK(good.at("summary").at("vehicles") == 82);
  CHECK(good.at("trial").at("pass") == true);
  CHECK(good.at("trial").at("days") == 30);
  CHECK(good.at("trial").at("worst").at("service").get<double>() >= 0.9);

  // A broken one is an answer, never a failure.
  json broken = layout;
  broken["sites"].erase(21);
  const auto bad = post("/api/worlds/check", json{{"layout", broken}}.dump());
  CHECK(bad.status == 200);
  const json why = json::parse(bad.body);
  CHECK(why.at("ok") == false);
  CHECK(why.at("trial").is_null());
  CHECK(why.at("errors")[0].at("text") == "Port terminal B (site 22) is missing from the layout");
  CHECK(why.at("errors")[0].at("site") == 22);
  CHECK(json::parse(post("/api/worlds/check", "not json").body).at("ok") == false);
  CHECK(json::parse(post("/api/worlds/check", R"({"map":1})").body).at("ok") == false);
  CHECK(post("/api/worlds/check", std::string(1100000, ' ')).status == 200);
  CHECK(post("/api/sim", json{{"seed", 42}, {"world", "erwin-world-v1"}, {"layout", broken}}.dump())
            .status == 400);

  // A session on a redrawn map: step, command, rewind, and the read-only views.
  for (json& s : layout["sites"])
    if (s.at("id") == 19) s["name"] = "Paint works";
  const std::string cfg = json{{"seed", 42}, {"world", "erwin-world-v1"}, {"layout", layout}}.dump();
  const std::string id = createSession(cli, cfg);
  const json world = json::parse(cli.Get("/api/sim/" + id + "/world")->body);
  CHECK(world.at("sites")[18].at("name") == "Paint works");
  post("/api/sim/" + id + "/step", R"({"ticks":480})");
  post("/api/sim/" + id + "/command",
       R"({"type":"unit_outage","site":"CRACKER_ETHANE","unit":"SC-CGC","trains":1,"duration_h":48})");
  post("/api/sim/" + id + "/step", R"({"ticks":96})");
  CHECK(post("/api/sim/" + id + "/forecast", R"({"days":5})").status == 200);
  CHECK(cli.Get("/api/sim/" + id + "/economy")->status == 200);
  CHECK(json::parse(cli.Get("/api/sim/" + id + "/sourcing")->body).at("tanks").size() == 20);
  CHECK(cli.Get("/api/sim/" + id + "/vehicle?index=3")->status == 200);
  CHECK(post("/api/sim/" + id + "/rewind", R"({"tick":500})").status == 200);
  // The rewound run is the layout's run: same as a fresh one stepped there.
  const std::string twin = createSession(cli, cfg);
  post("/api/sim/" + twin + "/step", R"({"ticks":480})");
  post("/api/sim/" + twin + "/command",
       R"({"type":"unit_outage","site":"CRACKER_ETHANE","unit":"SC-CGC","trains":1,"duration_h":48})");
  post("/api/sim/" + twin + "/step", R"({"ticks":20})");
  CHECK(post("/api/sim/" + id + "/step", R"({"ticks":0})").body ==
        post("/api/sim/" + twin + "/step", R"({"ticks":0})").body);
}

TEST_CASE("world json: fleet manifest without a fabricated shuttle schedule") {
  TestServer srv;
  auto cli = client(srv.port);
  const std::string id = createSession(cli, "{}");

  auto world = cli.Get("/api/sim/" + id + "/world");
  REQUIRE(world);
  const json doc = json::parse(world->body);
  REQUIRE(doc.contains("routes"));
  REQUIRE(doc.contains("vehicles"));
  // The former display-lane fields fabricated a <4 h shuttle loop that never
  // matched the dispatch ledger's multi-hour deliveries; movement now lives
  // only in snapshot arrays 12–14.
  for (const auto& v : doc.at("vehicles")) {
    CHECK(v.contains("cls"));
    CHECK(v.contains("cargo"));
    CHECK(v.find("loopTicks") == v.end());
    CHECK(v.find("phase") == v.end());
    CHECK(v.find("route") == v.end());
  }
  // Every edge gets a client route (any mode) so vehicles on river/sea legs
  // can be mapped by the snapshot's route id.
  const size_t nRoutes = doc.at("routes").size();
  size_t namedModes = 0;
  for (const auto& r : doc.at("routes")) {
    const std::string mode = r.at("mode").get<std::string>();
    // doctest chokes on chained || in CHECK; fold it into one boolean.
    const bool knownMode =
        mode == "road" || mode == "river" || mode == "sea";
    CHECK(knownMode);
    ++namedModes;
  }
  CHECK(nRoutes > 0);
  CHECK(namedModes == nRoutes);
}

TEST_CASE("step: snapshot v2 serves route, progress and eta arrays") {
  TestServer srv;
  auto cli = client(srv.port);
  const std::string id = createSession(cli, R"({"seed":7})");

  auto step = cli.Post("/api/sim/" + id + "/step", R"({"ticks":600})", "application/json");
  REQUIRE(step);
  REQUIRE(step->body.size() > 20 + 8 * 15);
  uint32_t version = 0, count = 0;
  std::memcpy(&version, step->body.data() + 4, 4);
  std::memcpy(&count, step->body.data() + 16, 4);
  CHECK(version == 2);
  CHECK(count == 15);
}

TEST_CASE("bad requests: unknown session 404, malformed body 400") {
  TestServer srv;
  auto cli = client(srv.port);

  CHECK(cli.Post("/api/sim/nope/step", R"({"ticks":1})", "application/json")->status == 404);
  CHECK(cli.Get("/api/sim/nope/world")->status == 404);
  CHECK(cli.Get("/api/sim/nope/events?since=0")->status == 404);
  CHECK(cli.Get("/api/sim/nope/series?kind=0&id=0")->status == 404);
  CHECK(cli.Get("/api/sim/nope/kpis")->status == 404);
  CHECK(cli.Post("/api/sim/nope/fork", "", "application/json")->status == 404);

  const std::string id = createSession(cli, "{}");
  CHECK(cli.Post("/api/sim/" + id + "/step", "not json", "application/json")->status == 400);
  CHECK(cli.Post("/api/sim/" + id + "/step", R"({"ticks":"ten"})", "application/json")->status == 400);
  CHECK(cli.Post("/api/sim/" + id + "/step", R"({"ticks":999999999})", "application/json")
            ->status == 400);  // above the per-request cap
  CHECK(cli.Get("/api/sim/" + id + "/series?kind=zero&id=0")->status == 400);
  CHECK(cli.Get("/api/sim/" + id + "/events?since=-1")->status == 400);
}

TEST_CASE("DELETE releases a session immediately and frees the slot") {
  TestServer srv;
  auto cli = client(srv.port);
  const std::string id = createSession(cli, "{}");
  REQUIRE(cli.Post("/api/sim/" + id + "/step", R"({"ticks":10})", "application/json"));
  REQUIRE(srv.sessions.size() == 1);

  auto del = cli.Delete("/api/sim/" + id);
  REQUIRE(del);
  CHECK(del->status == 200);
  CHECK(json::parse(del->body).at("released").get<bool>() == true);
  CHECK(srv.sessions.size() == 0);  // slot freed at once, not at the TTL

  // The id is gone for every route — including a repeated DELETE.
  CHECK(cli.Delete("/api/sim/" + id)->status == 404);
  CHECK(cli.Post("/api/sim/" + id + "/step", R"({"ticks":1})", "application/json")->status == 404);
  CHECK(cli.Post("/api/sim/" + id + "/fork", "", "application/json")->status == 404);
}

TEST_CASE("DELETE of an unknown or already-released session answers a clean 404") {
  TestServer srv;
  auto cli = client(srv.port);

  const auto res = cli.Delete("/api/sim/nope");
  REQUIRE(res);
  CHECK(res->status == 404);
  CHECK(json::parse(res->body).at("error").get<std::string>() == "unknown session");
}

TEST_CASE("at capacity the least recently used session is evicted, newest kept") {
  crx::server::SessionRegistry registry(3, std::chrono::minutes(2));
  std::chrono::steady_clock::time_point fake{};
  registry.setNowSource([&fake] { return fake; });

  const auto a = registry.create(R"({"seed":1})");
  fake += std::chrono::seconds(1);
  const auto b = registry.create(R"({"seed":2})");
  fake += std::chrono::seconds(1);
  const auto c = registry.create(R"({"seed":3})");
  fake += std::chrono::seconds(1);
  // Touch A then B — C is now the least recently used.
  registry.withSession(a.id, [](crx::server::Session&) {});
  fake += std::chrono::seconds(1);
  registry.withSession(b.id, [](crx::server::Session&) {});
  fake += std::chrono::seconds(1);

  const auto d = registry.create(R"({"seed":4})");
  REQUIRE(d.status == crx::server::SessionRegistry::CreateStatus::kCreated);
  CHECK(registry.size() == 3);
  CHECK_FALSE(registry.withSession(c.id, [](crx::server::Session&) {}));  // evicted
  CHECK(registry.withSession(a.id, [](crx::server::Session&) {}));
  CHECK(registry.withSession(b.id, [](crx::server::Session&) {}));
  CHECK(registry.withSession(d.id, [](crx::server::Session&) {}));
}

TEST_CASE("forking at capacity evicts the LRU session instead of refusing") {
  TestServer srv(2);
  auto cli = client(srv.port);
  const std::string a = createSession(cli, "{}");
  const std::string b = createSession(cli, "{}");
  // Touch only B: A becomes the least recently used.
  REQUIRE(cli.Post("/api/sim/" + b + "/step", R"({"ticks":1})", "application/json"));

  auto fork = cli.Post("/api/sim/" + b + "/fork", "", "application/json");
  REQUIRE(fork);
  CHECK(fork->status == 200);  // was a 503 before LRU eviction
  CHECK(srv.sessions.size() == 2);
  CHECK(cli.Post("/api/sim/" + a + "/step", R"({"ticks":1})", "application/json")->status == 404);
}

TEST_CASE("no 503 under cap pressure: the 201st visitor succeeds and the oldest session is gone") {
  TestServer srv(200);
  auto cli = client(srv.port);

  std::string firstId;
  for (int i = 0; i < 201; ++i) {
    const auto res = cli.Post("/api/sim", R"({"seed":1})", "application/json");
    REQUIRE(res);
    REQUIRE(res->status == 200);  // every create succeeds — never a 503
    if (i == 0) firstId = json::parse(res->body).at("id").get<std::string>();
  }
  CHECK(srv.sessions.size() == 200);
  // The oldest session made room for the newest visitor.
  CHECK(cli.Post("/api/sim/" + firstId + "/step", R"({"ticks":1})", "application/json")->status == 404);
}

TEST_CASE("sessions expire after the inactivity TTL (injected clock, no sleeps)") {
  crx::server::SessionRegistry registry(16, std::chrono::minutes(2));
  std::chrono::steady_clock::time_point fake{};
  registry.setNowSource([&fake] { return fake; });

  const auto result = registry.create(R"({"seed":3})");
  REQUIRE(result.status == crx::server::SessionRegistry::CreateStatus::kCreated);
  REQUIRE(registry.size() == 1);

  fake += std::chrono::minutes(2) + std::chrono::seconds(1);
  registry.reapExpired();
  CHECK(registry.size() == 0);
  CHECK_FALSE(registry.withSession(result.id, [](crx::server::Session&) {}));
}

TEST_CASE("production defaults: capacity 200, two-minute idle expiry") {
  crx::server::SessionRegistry registry;  // what main.cpp constructs
  std::chrono::steady_clock::time_point fake{};
  registry.setNowSource([&fake] { return fake; });

  for (int i = 0; i < 201; ++i) {
    const auto result = registry.create(R"({"seed":1})");
    REQUIRE(result.status == crx::server::SessionRegistry::CreateStatus::kCreated);
  }
  CHECK(registry.size() == 200);  // the 201st evicted instead of failing

  fake += std::chrono::minutes(2) + std::chrono::seconds(1);
  registry.reapExpired();
  CHECK(registry.size() == 0);  // 2-minute default TTL
}

TEST_CASE("hammer: concurrent step, DELETE, fork and eviction on one session stay safe") {
  crx::server::SessionRegistry registry(4, std::chrono::minutes(2));
  const auto first = registry.create(R"({"seed":1})");
  REQUIRE(first.status == crx::server::SessionRegistry::CreateStatus::kCreated);

  // The id the client is currently using: every thread races around it, and
  // the stepper recreates on a miss exactly like the web client's 404
  // recovery, so both the alive and the just-erased paths are hammered.
  std::mutex idMutex;
  std::string currentId = first.id;

  constexpr int kIters = 120;
  std::atomic<int> stepOk{0}, stepGone{0}, createOk{0};

  std::thread stepper([&] {
    for (int i = 0; i < kIters; ++i) {
      std::string id;
      {
        const std::lock_guard<std::mutex> lock(idMutex);
        id = currentId;
      }
      if (registry.withSession(id, [&](crx::server::Session& s) { crx_step(s.sim, 1); })) {
        ++stepOk;
        continue;
      }
      ++stepGone;  // released or evicted mid-use
      const auto fresh = registry.create(R"({"seed":1})");
      if (fresh.status == crx::server::SessionRegistry::CreateStatus::kCreated) {
        const std::lock_guard<std::mutex> lock(idMutex);
        currentId = fresh.id;
      }
    }
  });

  std::thread churn([&] {
    for (int i = 0; i < kIters; ++i) {
      std::string id;
      {
        const std::lock_guard<std::mutex> lock(idMutex);
        id = currentId;
      }
      registry.release(id);  // wins or loses the race — both must be safe
      if (i % 2 == 0) registry.forkFrom(id);  // parent may be evicted mid-fork
      if (registry.create(R"({"seed":1})").status ==
          crx::server::SessionRegistry::CreateStatus::kCreated) {
        ++createOk;  // never refused — no 503 path under churn
      }
      registry.reapExpired();  // expiry sweep under the same pressure
    }
  });

  stepper.join();
  churn.join();

  CHECK(stepOk + stepGone == kIters);  // every attempt returned: no deadlock
  CHECK(createOk == kIters);           // every create succeeded: no 503
  CHECK(registry.size() <= 4);         // the cap held under concurrent churn
}

TEST_CASE("the placeholder page is served when no web build exists") {
  TestServer srv;  // webDir does not exist
  auto cli = client(srv.port);

  const auto res = cli.Get("/");
  REQUIRE(res);
  CHECK(res->status == 200);
  CHECK(res->body.find("Chain Reaction") != std::string::npos);
}

// --- Multiplayer rooms ------------------------------------------------------

namespace {

struct RoomServer {
  crx::server::RoomRegistry rooms;
  httplib::Server svr;
  int port = 0;
  std::thread thread;

  explicit RoomServer(bool runClocks, size_t capacity = 4,
                      std::chrono::steady_clock::duration ttl = std::chrono::minutes(30))
      : rooms(capacity, ttl, runClocks) {
    crx::server::registerRoomRoutes(svr, rooms);
    port = svr.bind_to_any_port("127.0.0.1");
    thread = std::thread([this] { svr.listen_after_bind(); });
  }
  ~RoomServer() {
    svr.stop();
    thread.join();
  }
};

json postJson(httplib::Client& cli, const std::string& path, const json& body) {
  const auto res = cli.Post(path, body.dump(), "application/json");
  REQUIRE(res);
  return json::parse(res->body);
}

json getJson(httplib::Client& cli, const std::string& path) {
  const auto res = cli.Get(path);
  REQUIRE(res);
  return json::parse(res->body);
}

// The first playable site nobody owns yet.
int freePlant(const json& state) {
  for (const json& s : state.at("sites"))
    if (s.at("playable").get<bool>() && s.at("owner").is_null()) return s.at("index").get<int>();
  return -1;
}

}  // namespace

TEST_CASE("R1 room: create, join, claim, and the lobby state") {
  RoomServer ts(false);
  auto cli = client(ts.port);
  const json made = postJson(cli, "/api/room", json::object());
  const std::string code = made.at("code").get<std::string>();
  CHECK(code.size() == 4);
  CHECK(made.at("hostToken").get<std::string>().size() >= 16);
  const std::string base = "/api/room/" + code;

  json state = getJson(cli, base);
  CHECK(state.at("phase") == "lobby");
  CHECK(state.at("tick") == 0);
  CHECK(state.at("players").empty());
  int playable = 0;
  for (const json& s : state.at("sites")) playable += s.at("playable").get<bool>() ? 1 : 0;
  CHECK(playable == 13);  // 9 plants and 4 sources; customers, ports and the gas grid are not

  // The code is not case sensitive; an unknown one is a plain 404.
  std::string lower = code;
  for (char& c : lower) c = static_cast<char>(std::tolower(c));
  CHECK(getJson(cli, "/api/room/" + lower).at("code") == code);
  const auto missing = cli.Get(code == "ZZZZ" ? "/api/room/YYYY" : "/api/room/ZZZZ");
  REQUIRE(missing);
  CHECK(missing->status == 404);

  const json sam = postJson(cli, base + "/join", {{"name", "  Sam "}});
  const json sam2 = postJson(cli, base + "/join", {{"name", "Sam"}});
  CHECK(sam.at("name") == "Sam");
  CHECK(sam2.at("name") == "Sam 2");
  CHECK(sam.at("token") != sam2.at("token"));
  CHECK(postJson(cli, base + "/join", {{"name", "   "}}).at("ok") == false);
  CHECK(postJson(cli, base + "/join", {{"name", std::string(21, 'x')}}).at("ok") == false);

  const int plant = freePlant(state);
  REQUIRE(plant >= 0);
  CHECK(postJson(cli, base + "/claim", {{"token", "nope"}, {"site", plant}}).at("ok") == false);
  CHECK(postJson(cli, base + "/claim", {{"token", sam.at("token")}, {"site", plant}}).at("ok") == true);
  // Taken: the second player is told by whom.
  const json taken = postJson(cli, base + "/claim", {{"token", sam2.at("token")}, {"site", plant}});
  CHECK(taken.at("ok") == false);
  CHECK(taken.at("error").get<std::string>().find("taken by Sam") != std::string::npos);
  // A customer cannot be claimed.
  int customer = -1;
  for (const json& s : state.at("sites"))
    if (!s.at("playable").get<bool>()) customer = s.at("index").get<int>();
  REQUIRE(customer >= 0);
  CHECK(postJson(cli, base + "/claim", {{"token", sam2.at("token")}, {"site", customer}}).at("ok") == false);
  CHECK(postJson(cli, base + "/claim", {{"token", sam2.at("token")}, {"site", 9999}}).at("ok") == false);

  state = getJson(cli, base + "?token=" + sam.at("token").get<std::string>());
  CHECK(state.at("sites").at(static_cast<size_t>(plant)).at("owner") == sam.at("playerId"));
  CHECK(state.at("players").at(0).at("site") == plant);
  CHECK(state.at("players").at(0).at("connected") == true);
  CHECK(state.at("players").at(1).at("site").is_null());

  // In the lobby a player may swap or give the plant up.
  CHECK(postJson(cli, base + "/claim", {{"token", sam.at("token")}, {"site", nullptr}}).at("ok") == true);
  state = getJson(cli, base);
  CHECK(state.at("sites").at(static_cast<size_t>(plant)).at("owner").is_null());
  CHECK(postJson(cli, base + "/claim", {{"token", sam2.at("token")}, {"site", plant}}).at("ok") == true);
}

TEST_CASE("R2 room: only the host starts, pauses and sets the speed; the clock moves the run") {
  RoomServer ts(false);
  auto cli = client(ts.port);
  const json made = postJson(cli, "/api/room", json::object());
  const std::string base = "/api/room/" + made.at("code").get<std::string>();
  const json host = {{"hostToken", made.at("hostToken")}};
  const auto hostDo = [&](json extra) {
    extra.update(host);
    return postJson(cli, base + "/host", extra);
  };
  const std::shared_ptr<crx::server::Room> room = ts.rooms.find(made.at("code").get<std::string>());
  REQUIRE(room);

  CHECK(postJson(cli, base + "/host", {{"hostToken", "wrong"}, {"action", "start"}}).at("ok") == false);
  CHECK(hostDo({{"action", "pause"}}).at("ok") == false);  // not running yet
  CHECK(hostDo({{"action", "scenario"}, {"command", {{"type", "set"}}}}).at("ok") == false);

  // Nothing moves in the lobby.
  room->beat(5.0);
  CHECK(getJson(cli, base).at("tick") == 0);

  CHECK(hostDo({{"action", "start"}}).at("ok") == true);
  CHECK(hostDo({{"action", "start"}}).at("ok") == false);
  CHECK(getJson(cli, base).at("phase") == "running");

  // Speed 1 = one simulated hour = 4 ticks per real second; fractions carry.
  room->beat(1.0);
  CHECK(getJson(cli, base).at("tick") == 4);
  room->beat(0.125);
  CHECK(getJson(cli, base).at("tick") == 4);
  room->beat(0.125);
  CHECK(getJson(cli, base).at("tick") == 5);

  CHECK(hostDo({{"action", "speed"}, {"speed", 8}}).at("speed") == 8.0);
  CHECK(hostDo({{"action", "speed"}, {"speed", 1000}}).at("speed") == 64.0);
  CHECK(hostDo({{"action", "speed"}, {"speed", 0}}).at("speed") == 0.1);
  CHECK(hostDo({{"action", "speed"}}).at("ok") == false);
  hostDo({{"action", "speed"}, {"speed", 8}});
  room->beat(0.5);
  CHECK(getJson(cli, base).at("tick") == 21);

  CHECK(hostDo({{"action", "pause"}}).at("ok") == true);
  room->beat(10.0);
  CHECK(getJson(cli, base).at("tick") == 21);
  CHECK(getJson(cli, base).at("phase") == "paused");
  CHECK(hostDo({{"action", "resume"}}).at("ok") == true);
  room->beat(0.25);
  CHECK(getJson(cli, base).at("tick") == 29);

  // The snapshot is the engine's own, at the room's tick, with the tick as ETag.
  const auto snap = cli.Get(base + "/snapshot");
  REQUIRE(snap);
  CHECK(snap->status == 200);
  CHECK(snap->body.compare(0, 4, "CRXS") == 0);
  CHECK(tickOf(snap->body) == 29);
  CHECK(snap->get_header_value("ETag") == "\"29\"");
  const auto same = cli.Get(base + "/snapshot", {{"If-None-Match", "\"29\""}});
  REQUIRE(same);
  CHECK(same->status == 304);
  CHECK(same->body.empty());

  const json world = getJson(cli, base + "/world");
  CHECK(world.at("sites").size() == getJson(cli, base).at("sites").size());

  // A host scenario is an engine command, applied to the shared run.
  const json shock = hostDo({{"action", "scenario"},
                             {"command", {{"type", "demand_shock"}, {"site", "FUEL_DEPOT"}, {"multiplier", 1.3}, {"duration_h", 36}}}});
  CHECK(shock.at("ok") == true);

  CHECK(hostDo({{"action", "end"}}).at("ok") == true);
  room->beat(10.0);
  CHECK(getJson(cli, base).at("tick") == 29);
  CHECK(getJson(cli, base).at("phase") == "ended");
  CHECK(hostDo({{"action", "start"}}).at("ok") == false);
  CHECK(postJson(cli, base + "/join", {{"name", "Late"}}).at("ok") == false);
}

TEST_CASE("R3 room: the room's own clock thread advances a started room") {
  RoomServer ts(true);
  auto cli = client(ts.port);
  const json made = postJson(cli, "/api/room", json::object());
  const std::string base = "/api/room/" + made.at("code").get<std::string>();
  postJson(cli, base + "/host", {{"hostToken", made.at("hostToken")}, {"action", "speed"}, {"speed", 64}});
  postJson(cli, base + "/host", {{"hostToken", made.at("hostToken")}, {"action", "start"}});
  uint64_t tick = 0;
  for (int i = 0; i < 100 && tick < 20; ++i) {
    std::this_thread::sleep_for(std::chrono::milliseconds(50));
    const auto snap = cli.Get(base + "/snapshot");
    REQUIRE(snap);
    tick = tickOf(snap->body);
  }
  CHECK(tick >= 20);
}

TEST_CASE("R4 room: four at once, the idle one makes way, and old rooms expire") {
  RoomServer ts(false, 2, std::chrono::minutes(30));
  auto now = std::chrono::steady_clock::now();
  ts.rooms.setNowSource([&now] { return now; });
  auto cli = client(ts.port);
  const std::string a = postJson(cli, "/api/room", json::object()).at("code").get<std::string>();
  now += std::chrono::minutes(1);
  const std::string b = postJson(cli, "/api/room", json::object()).at("code").get<std::string>();
  now += std::chrono::minutes(1);
  CHECK(getJson(cli, "/api/room/" + a).at("code") == a);  // a is now the fresher one
  now += std::chrono::minutes(1);
  const std::string c = postJson(cli, "/api/room", json::object()).at("code").get<std::string>();
  CHECK(ts.rooms.size() == 2);
  CHECK(cli.Get("/api/room/" + b)->status == 404);
  CHECK(cli.Get("/api/room/" + a)->status == 200);
  now += std::chrono::minutes(31);
  ts.rooms.reapExpired();
  CHECK(ts.rooms.size() == 0);
  CHECK(cli.Get("/api/room/" + c)->status == 404);
}

TEST_CASE("R5 room: a player acts on their own plant only, and only once the game runs") {
  RoomServer ts(false);
  auto cli = client(ts.port);
  const json made = postJson(cli, "/api/room", json::object());
  const std::string base = "/api/room/" + made.at("code").get<std::string>();
  const std::shared_ptr<crx::server::Room> room = ts.rooms.find(made.at("code").get<std::string>());
  REQUIRE(room);
  const json world = getJson(cli, base + "/world");
  // Two plants and one unit at each.
  int siteA = -1, siteB = -1;
  uint32_t unitA = 0, unitB = 0;
  for (size_t i = 0; i < world.at("sites").size(); ++i) {
    const json& s = world.at("sites").at(i);
    if (s.at("key") == "POLYETHYLENE") {
      siteA = static_cast<int>(i);
      unitA = s.at("processes").at(0).at("units").at(0).at("index").get<uint32_t>();
    }
    if (s.at("key") == "POLYPROPYLENE") {
      siteB = static_cast<int>(i);
      unitB = s.at("processes").at(0).at("units").at(0).at("index").get<uint32_t>();
    }
  }
  REQUIRE(siteA >= 0);
  REQUIRE(siteB >= 0);
  const json ann = postJson(cli, base + "/join", {{"name", "Ann"}});
  const json bob = postJson(cli, base + "/join", {{"name", "Bob"}});
  const json cat = postJson(cli, base + "/join", {{"name", "Cat"}});  // never picks a plant
  const auto play = [&](const json& who, json action) {
    action["token"] = who.at("token");
    return postJson(cli, base + "/play", action);
  };
  REQUIRE(postJson(cli, base + "/claim", {{"token", ann.at("token")}, {"site", siteA}}).at("ok") == true);
  REQUIRE(postJson(cli, base + "/claim", {{"token", bob.at("token")}, {"site", siteB}}).at("ok") == true);

  // Before the start nothing can be done.
  CHECK(play(ann, {{"action", "price"}, {"markup", 0.1}}).at("error") == "The game has not started yet");
  postJson(cli, base + "/host", {{"hostToken", made.at("hostToken")}, {"action", "start"}});
  room->beat(24.0);

  CHECK(play({{"token", "forged"}}, {{"action", "price"}, {"markup", 0.1}}).at("error") == "Join the room first");
  CHECK(play(cat, {{"action", "price"}, {"markup", 0.1}}).at("error") == "Pick a plant first");
  CHECK(play(ann, {{"action", "dance"}}).at("ok") == false);
  CHECK(play(ann, {{"action", "price"}}).at("ok") == false);

  // Price and rate land on the player's own site; out-of-range values are clamped.
  CHECK(play(ann, {{"action", "price"}, {"markup", 0.1}}).at("markup") == 0.1);
  CHECK(play(bob, {{"action", "price"}, {"markup", -5}}).at("markup") == -0.2);
  CHECK(play(ann, {{"action", "rate"}, {"share", 0.9}}).at("share") == 0.9);
  // A site named in the body is ignored: the token decides whose plant it is.
  CHECK(play(ann, {{"action", "price"}, {"markup", 0.2}, {"site", siteB}}).at("ok") == true);

  // The ownership check: Ann cannot touch Bob's unit, nor Bob hers.
  const json theft = play(ann, {{"action", "unit"}, {"unit_index", unitB}, {"down", true}});
  CHECK(theft.at("ok") == false);
  CHECK(theft.at("error") == "That unit is not at Polyethylene, your plant");
  CHECK(play(bob, {{"action", "unit"}, {"unit_index", unitA}, {"down", true}}).at("ok") == false);
  CHECK(play(ann, {{"action", "unit"}, {"unit_index", 4000000}, {"down", true}}).at("ok") == false);
  CHECK(play(ann, {{"action", "unit"}, {"unit_index", unitA}}).at("ok") == false);
  CHECK(play(ann, {{"action", "unit"}, {"unit_index", unitA}, {"down", true}}).at("ok") == true);
  CHECK(play(ann, {{"action", "unit"}, {"unit_index", unitA}, {"down", true}}).at("error") ==
        "That unit is already down");

  // Scores carry the owners and what each set.
  room->beat(24.0 * 3);
  const json scores = getJson(cli, base + "/scores");
  CHECK(scores.at("tick") == getJson(cli, base).at("tick"));
  const json& a = scores.at("scores").at(static_cast<size_t>(siteA));
  const json& b = scores.at("scores").at(static_cast<size_t>(siteB));
  CHECK(a.at("owner") == ann.at("playerId"));
  CHECK(a.at("ownerName") == "Ann");
  CHECK(a.at("markup") == 0.2);  // Ann's second price, on her own site
  CHECK(a.at("rateShare") == 0.9);
  CHECK(b.at("ownerName") == "Bob");
  CHECK(b.at("markup") == -0.2);
  CHECK(b.at("rateShare") == 1.0);
  CHECK(scores.at("scores").at(0).at("owner").is_null());
  for (const char* key : {"profitUsd", "revenueUsd", "feedUsd", "freightUsd", "energyUsd", "soldT", "rank", "name", "site"})
    CHECK(a.contains(key));

  // The actions are in the log with their ticks, as any command.
  const json events = getJson(cli, base + "/events?since=0");
  bool priced = false, down = false;
  const json& list = events.is_array() ? events : events.at("events");
  for (const json& e : list) {
    priced = priced || e.at("type") == "price_set";
    down = down || (e.at("type") == "unit_failed" &&
                    e.at("text").get<std::string>().find("taken down by the operator") != std::string::npos);
  }
  CHECK(priced);
  CHECK(down);

  // The other read-only views answer on a room.
  CHECK(getJson(cli, base + "/economy?bucket_h=24").contains("materials"));
  CHECK(cli.Get(base + "/vehicle?index=0")->status == 200);
  CHECK(cli.Get(base + "/vehicle?index=999999")->status == 400);
  CHECK(cli.Get(base + "/sourcing?site=POLYETHYLENE&material=ETHYLENE")->status == 200);
  const auto series = cli.Get(base + "/series?kind=0&id=0");
  REQUIRE(series);
  CHECK(series->status == 200);
  CHECK(series->body.size() % 4 == 0);

  // After the end nothing more is taken.
  postJson(cli, base + "/host", {{"hostToken", made.at("hostToken")}, {"action", "end"}});
  CHECK(play(ann, {{"action", "price"}, {"markup", 0.0}}).at("error") == "This game has ended");
}

TEST_CASE("R6 room: the forecast leaves out disruptions but keeps the players' prices and rates") {
  RoomServer ts(false);
  auto cli = client(ts.port);
  const json made = postJson(cli, "/api/room", json::object());
  const std::string base = "/api/room/" + made.at("code").get<std::string>();
  const std::shared_ptr<crx::server::Room> room = ts.rooms.find(made.at("code").get<std::string>());
  REQUIRE(room);
  const json state = getJson(cli, base);
  int pe = -1;
  for (const json& s : state.at("sites"))
    if (s.at("key") == "POLYETHYLENE") pe = s.at("index").get<int>();
  REQUIRE(pe >= 0);
  const json ann = postJson(cli, base + "/join", {{"name", "Ann"}});
  postJson(cli, base + "/claim", {{"token", ann.at("token")}, {"site", pe}});
  const json host = {{"hostToken", made.at("hostToken")}};
  json start = host;
  start["action"] = "start";
  postJson(cli, base + "/host", start);
  room->beat(48.0);

  // Only prices and rates so far: nothing was broken, both futures agree.
  CHECK(postJson(cli, base + "/play", {{"token", ann.at("token")}, {"action", "price"}, {"markup", 0.15}}).at("ok") == true);
  CHECK(postJson(cli, base + "/play", {{"token", ann.at("token")}, {"action", "rate"}, {"share", 0.9}}).at("ok") == true);
  room->beat(24.0);
  json f = postJson(cli, base + "/forecast", {{"days", 5}});
  CHECK(f.at("disruptions") == 0);
  CHECK(f.at("tick") == getJson(cli, base).at("tick"));
  CHECK(f.at("delta").at("cost_usd") == 0.0);
  CHECK(f.at("with") == f.at("without"));

  // The host shuts the refinery: now there is something to cost.
  json shut = host;
  shut["action"] = "scenario";
  shut["command"] = {{"type", "site_shutdown"}, {"site", "REFINERY"}, {"duration_h", 240}};
  REQUIRE(postJson(cli, base + "/host", shut).at("ok") == true);
  room->beat(1.0);
  f = postJson(cli, base + "/forecast", {{"days", 5}});
  CHECK(f.at("disruptions") == 1);
  CHECK(f.at("with") != f.at("without"));
  CHECK(f.at("delta").at("shutdown_h").get<double>() > 0.0);
  // Asking never moves the room.
  CHECK(f.at("tick") == getJson(cli, base).at("tick"));
  CHECK(room->commands.size() == 3);

  const auto bad = cli.Post(base + "/forecast", R"({"days":500})", "application/json");
  REQUIRE(bad);
  CHECK(bad->status == 400);
}

TEST_CASE("R7 room: readers, players and the host hammer a running room while its clock steps") {
  RoomServer ts(true);
  std::string code, hostToken, token;
  {
    auto cli = client(ts.port);
    const json made = postJson(cli, "/api/room", json::object());
    code = made.at("code").get<std::string>();
    hostToken = made.at("hostToken").get<std::string>();
    const std::string base = "/api/room/" + code;
    token = postJson(cli, base + "/join", {{"name", "Ann"}}).at("token").get<std::string>();
    REQUIRE(postJson(cli, base + "/claim", {{"token", token}, {"site", freePlant(getJson(cli, base))}}).at("ok") == true);
    postJson(cli, base + "/host", {{"hostToken", hostToken}, {"action", "speed"}, {"speed", 64}});
    postJson(cli, base + "/host", {{"hostToken", hostToken}, {"action", "start"}});
  }
  const std::string base = "/api/room/" + code;
  std::atomic<int> bad{0};
  std::vector<std::thread> threads;
  for (int t = 0; t < 4; ++t)
    threads.emplace_back([&, t] {
      auto cli = client(ts.port);
      uint64_t last = 0;
      for (int i = 0; i < 40; ++i) {
        if (t == 0) {
          const auto snap = cli.Get(base + "/snapshot");
          if (!snap || snap->status != 200 || tickOf(snap->body) < last) ++bad;
          else last = tickOf(snap->body);
        } else if (t == 1) {
          const auto a = cli.Get(base + "?token=" + token);
          const auto b = cli.Get(base + "/scores");
          if (!a || a->status != 200 || !b || b->status != 200) ++bad;
        } else if (t == 2) {
          const json body = {{"token", token}, {"action", i % 2 ? "price" : "rate"},
                             {"markup", 0.01 * (i % 20)}, {"share", 0.8 + 0.005 * (i % 20)}};
          const auto r = cli.Post(base + "/play", body.dump(), "application/json");
          if (!r || r->status != 200) ++bad;
        } else {
          const json body = {{"hostToken", hostToken}, {"action", i % 2 ? "pause" : "resume"}};
          const auto r = cli.Post(base + "/host", body.dump(), "application/json");
          if (!r || r->status != 200) ++bad;
          if (i % 10 == 0) {
            const auto f = cli.Post(base + "/forecast", R"({"days":1})", "application/json");
            if (!f || f->status != 200) ++bad;
          }
        }
      }
    });
  for (std::thread& th : threads) th.join();
  CHECK(bad.load() == 0);
}
