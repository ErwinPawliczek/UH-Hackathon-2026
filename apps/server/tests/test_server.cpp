// crx-server route tests (§7.4): the real server on an ephemeral port,
// exercised over HTTP. Runs without a web build, so "/" serves the placeholder.

#define DOCTEST_CONFIG_IMPLEMENT_WITH_MAIN
#include <doctest/doctest.h>

#include "crx_server.h"

#include <httplib.h>
#include <nlohmann/json.hpp>

#include <atomic>
#include <chrono>
#include <cstring>
#include <fstream>
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
