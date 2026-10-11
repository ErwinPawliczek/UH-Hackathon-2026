// crx-server entry point: parse config, install routes, listen, reap.
//
// Options (flag beats env beats default):
//   --port N      or CRX_PORT      — listen port (default 8080; Fly internal port)
//   --web-dir P   or CRX_WEB_DIR   — built front end to serve at / (default web/dist)

#include "crx_server.h"

#include <httplib.h>

#include <atomic>
#include <chrono>
#include <cstdlib>
#include <iostream>
#include <string>
#include <thread>

namespace {

int parsePort(const std::string& text, int fallback) {
  if (text.empty()) return fallback;
  try {
    const int value = std::stoi(text);
    if (value <= 0 || value > 65535) return fallback;
    return value;
  } catch (const std::exception&) {
    return fallback;
  }
}

}  // namespace

int main(int argc, char** argv) {
  std::string portArg;
  std::string webDir = "web/dist";
  if (const char* env = std::getenv("CRX_WEB_DIR")) webDir = env;
  if (const char* env = std::getenv("CRX_PORT")) portArg = env;
  for (int i = 1; i < argc; ++i) {
    const std::string arg = argv[i];
    if (arg == "--port" && i + 1 < argc) {
      portArg = argv[++i];
    } else if (arg == "--web-dir" && i + 1 < argc) {
      webDir = argv[++i];
    }
  }
  const int port = parsePort(portArg, 8080);

  crx::server::SessionRegistry sessions;
  httplib::Server svr;
  crx::server::registerRoutes(svr, sessions, webDir);

  svr.set_logger([](const httplib::Request& req, const httplib::Response& res) {
    std::cout << req.method << " " << req.path << " -> " << res.status << std::endl;
  });

  // Inactivity expiry (§7.4): a light sweep every 30 s alongside the per-request
  // reap in create(); sessions idle past the 2-minute TTL are freed (bounded
  // work, no cancellation ceremony at shutdown).
  std::atomic<bool> stop{false};
  std::thread reaper([&sessions, &stop] {
    while (!stop.load(std::memory_order_relaxed)) {
      std::this_thread::sleep_for(std::chrono::seconds(30));
      sessions.reapExpired();
    }
  });

  std::cout << "crx-server listening on 0.0.0.0:" << port << std::endl;
  if (!svr.listen("0.0.0.0", port)) {
    std::cerr << "failed to bind 0.0.0.0:" << port << std::endl;
    stop.store(true);
    reaper.join();
    return 1;
  }
  stop.store(true);
  reaper.join();
  return 0;
}
