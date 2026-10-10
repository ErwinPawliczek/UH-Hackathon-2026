// crx-server — implementation (§7.4).

#include "crx_server.h"

#include <nlohmann/json.hpp>

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
    : capacity_(capacity), ttl_(ttl), idEntropy_(std::random_device{}()) {}

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

SessionRegistry::CreateResult SessionRegistry::insertNew(crx_sim* sim) {
  std::lock_guard<std::mutex> lock(globalMutex_);
  if (sessions_.size() >= capacity_) {
    crx_destroy(sim);
    return {CreateStatus::kAtCapacity, {}};
  }
  Session* session = new Session(sim);
  const std::string id = nextIdLocked();
  sessions_.emplace(id, std::unique_ptr<Session>(session));
  return {CreateStatus::kCreated, id};
}

SessionRegistry::CreateResult SessionRegistry::create(const std::string& configJson) {
  reapExpired();  // free capped-out slots that have gone idle
  crx_sim* sim = crx_create(configJson.empty() ? nullptr : configJson.c_str());
  if (sim == nullptr) return {CreateStatus::kBadConfig, {}};
  return insertNew(sim);
}

SessionRegistry::CreateResult SessionRegistry::forkFrom(const std::string& parentId) {
  reapExpired();
  crx_sim* child = nullptr;
  {
    std::lock_guard<std::mutex> lock(globalMutex_);
    const auto it = sessions_.find(parentId);
    if (it == sessions_.end()) return {CreateStatus::kNotFound, {}};
    std::lock_guard<std::mutex> sessionLock(it->second->mutex);
    child = crx_fork(it->second->sim);
  }
  if (child == nullptr) return {CreateStatus::kBadConfig, {}};
  return insertNew(child);
}

void SessionRegistry::reapExpired() {
  std::vector<std::unique_ptr<Session>> expired;
  {
    std::lock_guard<std::mutex> lock(globalMutex_);
    const auto now = Clock::now();
    for (auto it = sessions_.begin(); it != sessions_.end();) {
      if (now - it->second->lastUsed > ttl_) {
        expired.push_back(std::move(it->second));
        it = sessions_.erase(it);
      } else {
        ++it;
      }
    }
  }
  // Destroy only after waiting out any in-flight engine call on the session.
  for (auto& session : expired) {
    std::lock_guard<std::mutex> sessionLock(session->mutex);
    session.reset();
  }
}

void registerRoutes(httplib::Server& svr, SessionRegistry& sessions, const std::string& webDir) {
  // Route captures match on std::regex; `([^/]+)` is the session id.
  const std::string id = "([^/]+)";

  svr.Post("/api/sim", [&sessions](const httplib::Request& req, httplib::Response& res) {
    const auto result = sessions.create(req.body);
    switch (result.status) {
      case SessionRegistry::CreateStatus::kCreated:
        sendJson(res, 200, json::json{{"id", result.id}}.dump());
        break;
      case SessionRegistry::CreateStatus::kBadConfig:
        sendJson(res, 400, jsonError("engine rejected the config JSON"));
        break;
      case SessionRegistry::CreateStatus::kAtCapacity:
        sendJson(res, 503, jsonError("session limit reached; retry after sessions expire"));
        break;
      default:
        sendJson(res, 500, jsonError("unexpected create status"));
        break;
    }
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
               reply = crx_command(s.sim, req.body.c_str());
             });
             if (!found) {
               sendJson(res, 404, jsonError("unknown session"));
               return;
             }
             sendJson(res, 200, std::move(reply));
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
               case SessionRegistry::CreateStatus::kAtCapacity:
                 sendJson(res, 503, jsonError("session limit reached; retry after sessions expire"));
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
