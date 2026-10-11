// crx-server — implementation (§7.4).

#include "crx_server.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdio>
#include <exception>
#include <filesystem>
#include <random>
#include <utility>

namespace crx {
namespace server {

namespace {

namespace json = nlohmann;

// Served at / when the built front end is absent (dev servers, API-only runs).
constexpr const char* kPlaceholderHtml =
    "<!doctype html>\n"
    "<html><head><meta charset=\"utf-8\"><title>Chain Reaction</title>"
    "<style>body{font-family:system-ui,sans-serif;margin:4rem;max-width:36rem}"
    "code{background:#eee;padding:.1rem .3rem}</style></head>"
    "<body><h1>Chain Reaction</h1>"
    "<p>The simulation API is live at <code>/api/sim</code>.</p>"
    "<p>The web front end was not found here. Build it with "
    "<code>cd web &amp;&amp; npm ci &amp;&amp; npm run build</code>, then serve "
    "<code>web/dist</code> from the server root (see deploy/README.md).</p>"
    "</body></html>\n";

std::string jsonError(const char* message) {
  return json::json{{"error", message}}.dump();
}

void sendJson(httplib::Response& res, int status, std::string body) {
  res.status = status;
  res.set_content(std::move(body), "application/json");
}

void sendBinary(httplib::Response& res, std::string blob) {
  res.set_content(std::move(blob), "application/octet-stream");
}

// Blob copy of an engine-owned typed buffer. A null pointer with n == 0 is a
// legitimate empty result (e.g. an unknown series kind), not an error.
template <class T>
std::string blobOf(const T* data, uint32_t n) {
  if (data == nullptr || n == 0) return {};
  const auto* bytes = reinterpret_cast<const char*>(data);
  return std::string(bytes, static_cast<size_t>(n) * sizeof(T));
}

uint32_t parseU32(const std::string& text, bool* ok) {
  if (text.empty()) {
    *ok = false;
    return 0;
  }
  uint64_t value = 0;
  for (const char c : text) {
    if (c < '0' || c > '9') {
      *ok = false;
      return 0;
    }
    value = value * 10u + static_cast<uint64_t>(c - '0');
    if (value > UINT32_MAX) {
      *ok = false;
      return 0;
    }
  }
  *ok = true;
  return static_cast<uint32_t>(value);
}

uint64_t parseU64(const std::string& text, bool* ok) {
  if (text.empty()) {
    *ok = false;
    return 0;
  }
  uint64_t value = 0;
  for (const char c : text) {
    if (c < '0' || c > '9') {
      *ok = false;
      return 0;
    }
    if (value > (UINT64_MAX - 9) / 10) {
      *ok = false;
      return 0;
    }
    value = value * 10u + static_cast<uint64_t>(c - '0');
  }
  *ok = true;
  return value;
}

}  // namespace

Session::~Session() { crx_destroy(sim); }

SessionRegistry::SessionRegistry(size_t capacity, std::chrono::steady_clock::duration ttl)
    : capacity_(std::max<size_t>(capacity, 1)), ttl_(ttl), idEntropy_(std::random_device{}()) {}

size_t SessionRegistry::size() const {
  std::lock_guard<std::mutex> lock(globalMutex_);
  return sessions_.size();
}

std::string SessionRegistry::nextIdLocked() {
  char buf[32];
  std::snprintf(buf, sizeof buf, "%08llx%08llx",
                static_cast<unsigned long long>(++idCounter_),
                static_cast<unsigned long long>(idEntropy_));
  return buf;
}

SessionRegistry::CreateResult SessionRegistry::insertNew(crx_sim* sim, std::string config,
                                                         Session::CommandLog commands) {
  std::shared_ptr<Session> victim;
  std::string id;
  {
    std::lock_guard<std::mutex> lock(globalMutex_);
    if (sessions_.size() >= capacity_) {
      // The table is full: make room by dropping the least-recently-used
      // session. A new visitor is never refused — the 503 path is gone.
      const auto lru = std::min_element(
          sessions_.begin(), sessions_.end(), [](const auto& a, const auto& b) {
            return a.second->lastUsed.load() < b.second->lastUsed.load();
          });
      victim = std::move(lru->second);
      sessions_.erase(lru);
    }
    id = nextIdLocked();
    sessions_.emplace(id, std::make_shared<Session>(sim, nowFn_(), std::move(config),
                                                    std::move(commands)));
  }
  // Eviction takes the registry's reference away with no lock held: the
  // engine handle is freed at once unless a request still holds a reference,
  // in which case the session dies when that request finishes.
  victim.reset();
  return {CreateStatus::kCreated, id};
}

SessionRegistry::CreateResult SessionRegistry::create(const std::string& configJson) {
  reapExpired();  // free capped-out slots that have gone idle
  crx_sim* sim = crx_create(configJson.empty() ? nullptr : configJson.c_str());
  if (sim == nullptr) return {CreateStatus::kBadConfig, {}};
  return insertNew(sim, configJson, {});
}

SessionRegistry::CreateResult SessionRegistry::forkFrom(const std::string& parentId) {
  reapExpired();
  std::shared_ptr<Session> parent;
  {
    std::lock_guard<std::mutex> lock(globalMutex_);
    const auto it = sessions_.find(parentId);
    if (it == sessions_.end()) return {CreateStatus::kNotFound, {}};
    parent = it->second;  // keep the parent alive even if evicted next
  }
  crx_sim* child = nullptr;
  std::string config;
  Session::CommandLog commands;
  {
    std::lock_guard<std::mutex> sessionLock(parent->mutex);
    child = crx_fork(parent->sim);
    config = parent->config;  // the fork shares the parent's past, so it can rewind into it
    commands = parent->commands;
  }
  if (child == nullptr) return {CreateStatus::kBadConfig, {}};
  return insertNew(child, std::move(config), std::move(commands));
}

bool SessionRegistry::release(const std::string& id) {
  std::shared_ptr<Session> doomed;
  {
    std::lock_guard<std::mutex> lock(globalMutex_);
    const auto it = sessions_.find(id);
    if (it == sessions_.end()) return false;
    doomed = std::move(it->second);
    sessions_.erase(it);
  }
  // Dropping the last reference frees the engine handle outside every lock;
  // a request that already copied the reference keeps the session alive
  // until its engine call finishes.
  doomed.reset();
  return true;
}

SessionRegistry::RewindStatus SessionRegistry::rewind(const std::string& id, uint64_t tick) {
  std::shared_ptr<Session> s;
  {
    std::lock_guard<std::mutex> lock(globalMutex_);
    const auto it = sessions_.find(id);
    if (it == sessions_.end()) return RewindStatus::kNotFound;
    s = it->second;
  }
  std::lock_guard<std::mutex> sessionLock(s->mutex);
  s->lastUsed = nowFn_().time_since_epoch().count();
  if (tick > crx_tick(s->sim)) return RewindStatus::kAhead;

  crx_sim* fresh = crx_create(s->config.empty() ? nullptr : s->config.c_str());
  if (fresh == nullptr) return RewindStatus::kFailed;
  const auto stepTo = [fresh](uint64_t target) {
    while (crx_tick(fresh) < target) {
      const uint64_t gap = target - crx_tick(fresh);
      crx_step(fresh, static_cast<uint32_t>(std::min<uint64_t>(gap, 1u << 20)));
    }
  };
  Session::CommandLog kept;
  for (const auto& entry : s->commands) {
    if (entry.first >= tick) break;  // issued at or after the moment asked for
    stepTo(entry.first);
    crx_command(fresh, entry.second.c_str());
    kept.push_back(entry);
  }
  stepTo(tick);

  crx_destroy(s->sim);
  s->sim = fresh;
  s->commands = std::move(kept);
  return RewindStatus::kOk;
}

namespace {

// §5.9 disruptions: the commands a "what if nothing had broken" run leaves out.
bool isDisruption(const std::string& command) {
  const json::json j = json::json::parse(command, nullptr, false);
  if (!j.is_object() || !j.contains("type") || !j["type"].is_string()) return false;
  const std::string type = j["type"].get<std::string>();
  return type == "unit_outage" || type == "site_shutdown" || type == "supply_shock" ||
         type == "demand_shock" || type == "route_break";
}

void stepSimTo(crx_sim* sim, uint64_t target) {
  while (crx_tick(sim) < target) {
    const uint64_t gap = target - crx_tick(sim);
    crx_step(sim, static_cast<uint32_t>(std::min<uint64_t>(gap, 1u << 20)));
  }
}

}  // namespace

SessionRegistry::ForecastStatus SessionRegistry::forecast(const std::string& id, uint32_t days,
                                                          std::string& out) {
  std::shared_ptr<Session> s;
  {
    std::lock_guard<std::mutex> lock(globalMutex_);
    const auto it = sessions_.find(id);
    if (it == sessions_.end()) return ForecastStatus::kNotFound;
    s = it->second;
  }
  // Copy what the two futures need under the session lock, then compute
  // outside it so the run itself is never held up.
  crx_sim* with = nullptr;
  std::string config;
  Session::CommandLog commands;
  uint64_t now = 0;
  {
    std::lock_guard<std::mutex> sessionLock(s->mutex);
    s->lastUsed = nowFn_().time_since_epoch().count();
    with = crx_fork(s->sim);
    config = s->config;
    commands = s->commands;
    now = crx_tick(s->sim);
  }
  if (with == nullptr) return ForecastStatus::kFailed;

  const uint32_t ticks = days * 96u;  // 0.25 h ticks
  json::json futureWith = json::json::parse(crx_step_report(with, ticks), nullptr, false);
  crx_destroy(with);

  size_t disruptions = 0;
  for (const auto& entry : commands) disruptions += isDisruption(entry.second) ? 1 : 0;

  // Nothing was ever broken: the two futures are the same run.
  json::json futureWithout = futureWith;
  if (disruptions > 0) {
    crx_sim* without = crx_create(config.empty() ? nullptr : config.c_str());
    if (without == nullptr) return ForecastStatus::kFailed;
    for (const auto& entry : commands) {
      if (isDisruption(entry.second)) continue;
      stepSimTo(without, entry.first);
      crx_command(without, entry.second.c_str());
    }
    stepSimTo(without, now);
    futureWithout = json::json::parse(crx_step_report(without, ticks), nullptr, false);
    crx_destroy(without);
  }
  if (!futureWith.is_object() || !futureWithout.is_object()) return ForecastStatus::kFailed;

  const json::json& tw = futureWith.at("totals");
  const json::json& to = futureWithout.at("totals");
  const auto diff = [&](const char* key) {
    return tw.at(key).get<double>() - to.at(key).get<double>();
  };
  // What the disruptions cost: sales lost at the customers, plus the stock
  // that is no longer there at the end (product never made, less the feed
  // never used), plus what moving and making things cost more or less than
  // they would have. A stopped plant saves energy, so without the stock term
  // an outage would look like a saving.
  const double lost = diff("unmet_usd"), freight = diff("freight_usd"), energy = diff("energy_usd");
  const double stock = diff("inventory_usd");
  const json::json delta = {{"service", diff("service")},
                            {"unmet_t", diff("unmet_t")},
                            {"unmet_usd", lost},
                            {"freight_usd", freight},
                            {"energy_usd", energy},
                            {"inventory_usd", stock},
                            // Product thrown away at tanks that reject when
                            // full. Shown on its own, not added to cost_usd:
                            // it never reaches stock, so the stock term has
                            // already charged what it was made from.
                            {"rejected_t", diff("rejected_t")},
                            {"rejected_usd", diff("rejected_usd")},
                            {"shutdown_h", diff("shutdown_h")},
                            {"cost_usd", lost + freight + energy - stock}};

  // Countdown: what goes wrong with the disruptions that would not have
  // gone wrong without them, soonest first.
  json::json countdown = json::json::array();
  const auto collect = [&](const char* list, const char* tickKey, const char* startKey,
                           const char* kind, const char* whatKey) {
    const json::json& a = futureWith.at(list);
    const json::json& b = futureWithout.at(list);
    for (size_t i = 0; i < a.size() && i < b.size(); ++i) {
      if (a[i].at(tickKey).is_null() || !b[i].at(tickKey).is_null()) continue;
      const uint64_t tick = a[i].at(tickKey).get<uint64_t>();
      countdown.push_back({{"site", a[i].at("site")},
                           {"site_index", a[i].at("site_index")},
                           {"name", a[i].at("name")},
                           {"kind", kind},
                           {"what", a[i].at(whatKey)},
                           {"tick", tick},
                           {"hours_from_now", static_cast<double>(tick - now) * 0.25},
                           {"already", a[i].at(startKey)}});
    }
  };
  collect("plants", "first_down_tick", "down_at_start", "shuts_down", "process_name");
  collect("customers", "first_dry_tick", "dry_at_start", "runs_dry", "material");
  std::stable_sort(countdown.begin(), countdown.end(), [](const json::json& x, const json::json& y) {
    return x.at("tick").get<uint64_t>() < y.at("tick").get<uint64_t>();
  });

  out = json::json{{"tick", now},
                   {"to_tick", now + ticks},
                   {"days", days},
                   {"disruptions", disruptions},
                   {"with", futureWith},
                   {"without", futureWithout},
                   {"delta", delta},
                   {"countdown", countdown}}
            .dump();
  return ForecastStatus::kOk;
}

void SessionRegistry::reapExpired() {
  std::vector<std::shared_ptr<Session>> expired;
  {
    std::lock_guard<std::mutex> lock(globalMutex_);
    const auto now = nowFn_().time_since_epoch().count();
    for (auto it = sessions_.begin(); it != sessions_.end();) {
      if (now - it->second->lastUsed.load() > ttl_.count()) {
        expired.push_back(std::move(it->second));
        it = sessions_.erase(it);
      } else {
        ++it;
      }
    }
  }
  // Free outside the registry lock; requests holding references keep their
  // session alive until they finish with it.
  for (auto& session : expired) session.reset();
}

void registerRoutes(httplib::Server& svr, SessionRegistry& sessions, const std::string& webDir) {
  // Route captures match on std::regex; `([^/]+)` is the session id.
  const std::string id = "([^/]+)";

  // The map builder's check: {"layout": {...}, "world"?: name}. Always 200
  // with {"ok", "errors", ...}; a bad layout is an answer, not a failure.
  svr.Post("/api/worlds/check", [](const httplib::Request& req, httplib::Response& res) {
    const auto problem = [&res](const std::string& text) {
      sendJson(res, 200,
               json::json{{"ok", false},
                          {"errors", json::json::array({{{"site", nullptr}, {"mode", nullptr}, {"text", text}}})},
                          {"warnings", json::json::array()},
                          {"summary", nullptr},
                          {"trial", nullptr}}
                   .dump());
    };
    if (req.body.size() > 1024 * 1024 + 4096) return problem("The layout is too large (over 1 MB)");
    const json::json body = json::json::parse(req.body, nullptr, false);
    if (!body.is_object() || !body.contains("layout") || !body["layout"].is_object())
      return problem("Send the map as {\"layout\": {...}}");
    const std::string world = body.contains("world") && body["world"].is_string()
                                  ? body["world"].get<std::string>() : "erwin-world-v1";
    sendJson(res, 200, crx_check_layout(world.c_str(), body["layout"].dump().c_str()));
  });

  svr.Post("/api/sim", [&sessions](const httplib::Request& req, httplib::Response& res) {
    if (req.body.size() > 1024 * 1024 + 4096) {
      sendJson(res, 400, jsonError("the config is too large (a layout may be at most 1 MB)"));
      return;
    }
    const auto result = sessions.create(req.body);
    switch (result.status) {
      case SessionRegistry::CreateStatus::kCreated:
        sendJson(res, 200, json::json{{"id", result.id}}.dump());
        break;
      case SessionRegistry::CreateStatus::kBadConfig:
        sendJson(res, 400, jsonError("engine rejected the config JSON"));
        break;
      default:
        sendJson(res, 500, jsonError("unexpected create status"));
        break;
    }
  });

  // The client releases a session whenever it replaces one (retry, settings
  // change) and on page unload (fetch keepalive — sendBeacon cannot DELETE).
  svr.Delete("/api/sim/" + id, [&sessions](const httplib::Request& req, httplib::Response& res) {
    if (!sessions.release(req.matches[1].str())) {
      sendJson(res, 404, jsonError("unknown session"));
      return;
    }
    sendJson(res, 200, json::json{{"released", true}}.dump());
  });

  const auto stepHandler = [&sessions](const httplib::Request& req, httplib::Response& res) {
    uint32_t ticks = 0;
    try {
      const json::json body = json::json::parse(req.body);
      ticks = body.at("ticks").get<uint32_t>();
      if (ticks > kMaxTicksPerRequest) {
        sendJson(res, 400, jsonError("ticks exceeds the per-request cap"));
        return;
      }
    } catch (const std::exception&) {
      sendJson(res, 400, jsonError("body must be {\"ticks\":N}"));
      return;
    }

    std::string snapshot;
    const bool found = sessions.withSession(
        req.matches[1].str(), [&](Session& s) {
          crx_step(s.sim, ticks);
          uint32_t bytes = 0;
          const uint8_t* data = crx_snapshot(s.sim, &bytes);
          snapshot.assign(reinterpret_cast<const char*>(data), bytes);
        });
    if (!found) {
      sendJson(res, 404, jsonError("unknown session"));
      return;
    }
    sendBinary(res, std::move(snapshot));
  };
  svr.Post("/api/sim/" + id + "/step", stepHandler);

  svr.Post("/api/sim/" + id + "/command",
           [&sessions](const httplib::Request& req, httplib::Response& res) {
             std::string reply;
             const bool found = sessions.withSession(req.matches[1].str(), [&](Session& s) {
               const uint64_t at = crx_tick(s.sim);
               reply = crx_command(s.sim, req.body.c_str());
               // Remember accepted commands so a rewind can replay them.
               const json::json parsed = json::json::parse(reply, nullptr, false);
               if (parsed.is_object() && parsed.value("ok", false)) s.commands.emplace_back(at, req.body);
             });
             if (!found) {
               sendJson(res, 404, jsonError("unknown session"));
               return;
             }
             sendJson(res, 200, std::move(reply));
           });

  // Back in time: {"tick": N} returns the session to tick N of its own run.
  svr.Post("/api/sim/" + id + "/rewind",
           [&sessions](const httplib::Request& req, httplib::Response& res) {
             uint64_t tick = 0;
             const json::json body = json::json::parse(req.body, nullptr, false);
             if (!body.is_object() || !body.contains("tick") || !body["tick"].is_number_unsigned()) {
               sendJson(res, 400, jsonError("body must be {\"tick\":N} with N a non-negative integer"));
               return;
             }
             tick = body["tick"].get<uint64_t>();
             switch (sessions.rewind(req.matches[1].str(), tick)) {
               case SessionRegistry::RewindStatus::kOk:
                 sendJson(res, 200, json::json{{"ok", true}, {"tick", tick}}.dump());
                 break;
               case SessionRegistry::RewindStatus::kNotFound:
                 sendJson(res, 404, jsonError("unknown session"));
                 break;
               case SessionRegistry::RewindStatus::kAhead:
                 sendJson(res, 400, jsonError("tick is ahead of where this run has reached"));
                 break;
               default:
                 sendJson(res, 500, jsonError("the run could not be rebuilt"));
                 break;
             }
           });

  // Impact forecast: {"days": N} (1 to 120, default 30). Read-only.
  svr.Post("/api/sim/" + id + "/forecast",
           [&sessions](const httplib::Request& req, httplib::Response& res) {
             uint32_t days = 30;
             if (!req.body.empty()) {
               const json::json body = json::json::parse(req.body, nullptr, false);
               if (!body.is_object() ||
                   (body.contains("days") && !body["days"].is_number_unsigned())) {
                 sendJson(res, 400, jsonError("body must be {\"days\":N} with N from 1 to 120"));
                 return;
               }
               if (body.contains("days")) {
                 const uint64_t asked = body["days"].get<uint64_t>();
                 if (asked < 1 || asked > 120) {
                   sendJson(res, 400, jsonError("days must be from 1 to 120"));
                   return;
                 }
                 days = static_cast<uint32_t>(asked);
               }
             }
             std::string doc;
             switch (sessions.forecast(req.matches[1].str(), days, doc)) {
               case SessionRegistry::ForecastStatus::kOk:
                 sendJson(res, 200, std::move(doc));
                 break;
               case SessionRegistry::ForecastStatus::kNotFound:
                 sendJson(res, 404, jsonError("unknown session"));
                 break;
               default:
                 sendJson(res, 500, jsonError("the forecast could not be computed"));
                 break;
             }
           });

  svr.Post("/api/sim/" + id + "/fork",
           [&sessions](const httplib::Request& req, httplib::Response& res) {
             const auto result = sessions.forkFrom(req.matches[1].str());
             switch (result.status) {
               case SessionRegistry::CreateStatus::kCreated:
                 sendJson(res, 200, json::json{{"id", result.id}}.dump());
                 break;
               case SessionRegistry::CreateStatus::kNotFound:
                 sendJson(res, 404, jsonError("unknown session"));
                 break;
               default:
                 sendJson(res, 500, jsonError("fork failed"));
                 break;
             }
           });

  svr.Get("/api/sim/" + id + "/world",
          [&sessions](const httplib::Request& req, httplib::Response& res) {
            std::string world;
            const bool found = sessions.withSession(req.matches[1].str(), [&](Session& s) {
              world = crx_world_json(s.sim);
            });
            if (!found) {
              sendJson(res, 404, jsonError("unknown session"));
              return;
            }
            sendJson(res, 200, std::move(world));
          });

  svr.Get("/api/sim/" + id + "/events",
          [&sessions](const httplib::Request& req, httplib::Response& res) {
            bool ok = false;
            const uint64_t since = parseU64(req.get_param_value("since"), &ok);
            if (!ok) {
              sendJson(res, 400, jsonError("since must be a non-negative integer"));
              return;
            }
            std::string events;
            const bool found = sessions.withSession(req.matches[1].str(), [&](Session& s) {
              events = crx_events(s.sim, since);
            });
            if (!found) {
              sendJson(res, 404, jsonError("unknown session"));
              return;
            }
            sendJson(res, 200, std::move(events));
          });

  svr.Get("/api/sim/" + id + "/series",
          [&sessions](const httplib::Request& req, httplib::Response& res) {
            bool ok = false;
            const uint32_t kind = parseU32(req.get_param_value("kind"), &ok);
            if (!ok) {
              sendJson(res, 400, jsonError("kind must be a non-negative integer"));
              return;
            }
            const uint32_t tankId = parseU32(req.get_param_value("id"), &ok);
            if (!ok) {
              sendJson(res, 400, jsonError("id must be a non-negative integer"));
              return;
            }
            std::string series;
            const bool found = sessions.withSession(req.matches[1].str(), [&](Session& s) {
              uint32_t n = 0;
              const float* data = crx_series(s.sim, kind, tankId, &n);
              series = blobOf(data, n);
            });
            if (!found) {
              sendJson(res, 404, jsonError("unknown session"));
              return;
            }
            sendBinary(res, std::move(series));
          });

  svr.Get("/api/sim/" + id + "/kpis",
          [&sessions](const httplib::Request& req, httplib::Response& res) {
            std::string kpis;
            const bool found = sessions.withSession(req.matches[1].str(), [&](Session& s) {
              uint32_t n = 0;
              const double* data = crx_kpis(s.sim, &n);
              kpis = blobOf(data, n);
            });
            if (!found) {
              sendJson(res, 404, jsonError("unknown session"));
              return;
            }
            sendBinary(res, std::move(kpis));
          });

  // Sourcing: ?site=<key or index>&material=<KEY> for one buying tank, or no
  // query for the list of tanks that buy by vehicle.
  svr.Get("/api/sim/" + id + "/sourcing",
          [&sessions](const httplib::Request& req, httplib::Response& res) {
            const std::string site = req.get_param_value("site");
            const std::string material = req.get_param_value("material");
            std::string doc;
            const bool found = sessions.withSession(req.matches[1].str(), [&](Session& s) {
              doc = crx_sourcing(s.sim, site.c_str(), material.c_str());
            });
            if (!found) {
              sendJson(res, 404, jsonError("unknown session"));
              return;
            }
            // The engine answers a bad query with {"error": ...}.
            const int status = doc.rfind("{\"error\"", 0) == 0 ? 400 : 200;
            sendJson(res, status, std::move(doc));
          });

  // The run so far in time buckets: ?bucket_h=1..168 (default 24).
  svr.Get("/api/sim/" + id + "/economy",
          [&sessions](const httplib::Request& req, httplib::Response& res) {
            uint32_t bucket_h = 24;
            if (req.has_param("bucket_h")) {
              bool ok = false;
              bucket_h = parseU32(req.get_param_value("bucket_h"), &ok);
              if (!ok || bucket_h < 1 || bucket_h > 168) {
                sendJson(res, 400, jsonError("bucket_h must be a whole number of hours, 1 to 168"));
                return;
              }
            }
            std::string doc;
            const bool found = sessions.withSession(req.matches[1].str(), [&](Session& s) {
              const char* text = crx_economy(s.sim, bucket_h);
              if (text != nullptr) doc = text;
            });
            if (!found) {
              sendJson(res, 404, jsonError("unknown session"));
              return;
            }
            sendJson(res, 200, std::move(doc));
          });

  // One vehicle: where it is going, where from, and what it holds.
  svr.Get("/api/sim/" + id + "/vehicle",
          [&sessions](const httplib::Request& req, httplib::Response& res) {
            bool ok = false;
            const uint32_t index = parseU32(req.get_param_value("index"), &ok);
            if (!ok) {
              sendJson(res, 400, jsonError("query must be ?index=N"));
              return;
            }
            std::string doc;
            const bool found = sessions.withSession(req.matches[1].str(), [&](Session& s) {
              const char* text = crx_vehicle(s.sim, index);
              if (text != nullptr) doc = text;
            });
            if (!found) {
              sendJson(res, 404, jsonError("unknown session"));
              return;
            }
            if (doc.empty()) {
              sendJson(res, 400, jsonError("no vehicle with that index"));
              return;
            }
            sendJson(res, 200, std::move(doc));
          });

  // Static front end: serve the built app from the same origin when present.
  std::error_code ec;
  const bool webBuilt = !webDir.empty() &&
                        std::filesystem::exists(std::filesystem::path(webDir) / "index.html", ec);
  if (webBuilt) {
    svr.set_mount_point("/", webDir);
  } else {
    svr.Get("/", [](const httplib::Request&, httplib::Response& res) {
      res.set_content(kPlaceholderHtml, "text/html; charset=utf-8");
    });
  }
}

}  // namespace server
}  // namespace crx
