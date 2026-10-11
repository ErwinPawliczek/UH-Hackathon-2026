// crx-server route tests (§7.4): the real server on an ephemeral port,
// exercised over HTTP. Runs without a web build, so "/" serves the placeholder.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include "crx_server.h"

#include <httplib.h>
#include <nlohmann/json.hpp>

#include <chrono>
#include <cstring>
#include <string>
#include <thread>

namespace {

using json = nlohmann::json;

// Server harness: registers routes, binds to a free port, serves in background.
struct TestServer {
  crx::server::SessionRegistry sessions{16, std::chrono::minutes(10)};
  httplib::Server svr;
  int port = 0;
  std::thread thread;

  explicit TestServer(const std::string& webDir = "/nonexistent/web/dist") {
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

TEST_CASE("session cap of 16 rejects further sessions with 503") {
  TestServer srv;
  auto cli = client(srv.port);

  std::string firstId;
  for (int i = 0; i < 16; ++i) {
    const auto res = cli.Post("/api/sim", R"({"seed":1})", "application/json");
    REQUIRE(res);
    REQUIRE(res->status == 200);
    if (i == 0) firstId = json::parse(res->body).at("id").get<std::string>();
  }
  CHECK(cli.Post("/api/sim", R"({"seed":2})", "application/json")->status == 503);
  // Forking is a create too: a full table refuses it the same way.
  CHECK(cli.Post("/api/sim/" + firstId + "/fork", "", "application/json")->status == 503);
}

TEST_CASE("sessions expire after their inactivity TTL") {
  crx::server::SessionRegistry registry(16, std::chrono::milliseconds(80));
  const auto result = registry.create(R"({"seed":3})");
  REQUIRE(result.status == crx::server::SessionRegistry::CreateStatus::kCreated);
  REQUIRE(registry.size() == 1);

  std::this_thread::sleep_for(std::chrono::milliseconds(120));
  registry.reapExpired();
  CHECK(registry.size() == 0);
  CHECK_FALSE(registry.withSession(result.id, [](crx::server::Session&) {}));
}

TEST_CASE("the placeholder page is served when no web build exists") {
  TestServer srv;  // webDir does not exist
  auto cli = client(srv.port);

  const auto res = cli.Get("/");
  REQUIRE(res);
  CHECK(res->status == 200);
  CHECK(res->body.find("Chain Reaction") != std::string::npos);
}
