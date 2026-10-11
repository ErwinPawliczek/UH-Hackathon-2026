// crx-cli — native driver for the engine: run, dump (§11).
//
// `run` steps the sim and prints a report every --report ticks: per site,
// process rate as a share of design with the operating status, and tank
// levels with their f/u/h signals — the M1 acceptance surface (§13): run
// it during a cracker outage and watch downstream starve while upstream
// backs up.

#include "crx/api.h"
#include "world/worldgen/WorldGen.h"
#include "world/worldgen/WorldJson.h"

#include <nlohmann/json.hpp>

#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

using json = nlohmann::json;

namespace {

struct Snapshot {
  uint64_t tick = 0;
  std::vector<float> tank;  // 4 per tank: fill, f, u, h
  std::vector<float> proc;  // rate/design per process
  std::vector<uint8_t> procStatus;
  std::vector<float> vehPose;   // 5 per vehicle: x, y, dirx, diry, fill
  std::vector<uint8_t> vehB;    // 2 per vehicle: status, cargo material
  std::vector<uint32_t> vehOrder;
  std::vector<uint8_t> edgeOpen;
  std::vector<float> price;  // per material
};

// Reads the self-describing snapshot: magic4 + version4 + tick8 + count4,
// then count × {scalars4, offset4} entries.
bool readSnapshot(const uint8_t* data, uint32_t bytes, Snapshot& out) {
  if (bytes < 20 || std::memcmp(data, "CRXS", 4) != 0) return false;
  uint32_t version = 0, nArrays = 0;
  std::memcpy(&version, data + 4, 4);
  std::memcpy(&out.tick, data + 8, 8);
  std::memcpy(&nArrays, data + 16, 4);
  if (version < 1 || nArrays < 12) return false;

  struct Entry {
    uint32_t scalars, offset;
  };
  std::vector<Entry> table(nArrays);
  for (uint32_t a = 0; a < nArrays; ++a) {
    std::memcpy(&table[a].scalars, data + 20 + 8 * a, 4);
    std::memcpy(&table[a].offset, data + 20 + 8 * a + 4, 4);
  }
  auto floats = [&](uint32_t a) {
    std::vector<float> v(table[a].scalars);
    std::memcpy(v.data(), data + table[a].offset, 4 * table[a].scalars);
    return v;
  };
  auto bytes8 = [&](uint32_t a) {
    return std::vector<uint8_t>(data + table[a].offset,
                                data + table[a].offset + table[a].scalars);
  };
  out.tank = floats(0);
  out.proc = floats(1);
  out.procStatus = bytes8(2);
  out.vehPose = floats(6);
  out.vehB = bytes8(7);
  out.edgeOpen = bytes8(10);
  out.price = floats(11);
  out.vehOrder.resize(table[8].scalars);
  std::memcpy(out.vehOrder.data(), data + table[8].offset, 4 * table[8].scalars);
  return true;
}

const char* statusName(uint8_t status) {
  switch (status) {
    case 0: return "Running";
    case 1: return "HoldMin";
    case 2: return "Shutdown";
    case 3: return "Restarting";
    default: return "?";
  }
}

void printReport(const json& world, const Snapshot& snap) {
  const double hours = static_cast<double>(snap.tick) * 0.25;
  std::printf("== tick %llu  (%.1f h) ==\n", static_cast<unsigned long long>(snap.tick), hours);

  const json& sites = world.at("sites");
  const json& tanks = world.at("tanks");
  // Processes are site-grouped in site order (§4.3 construction), so the
  // running position across sites is the global process id the snapshot uses.
  uint32_t p = 0;
  for (uint32_t sid = 0; sid < sites.size(); ++sid) {
    const auto& site = sites[sid];
    std::printf("  %s:\n", site.at("name").get<std::string>().c_str());
    for (const auto& proc : site.at("processes")) {
      if (p >= snap.proc.size() || p >= snap.procStatus.size()) continue;
      std::printf("    %-18s %6.1f%%  %s\n",
                  proc.at("key").get<std::string>().c_str(), 100.0 * snap.proc[p],
                  statusName(snap.procStatus[p]));
      ++p;
    }
    for (uint32_t t = 0; t < tanks.size(); ++t) {
      const auto& tank = tanks[t];
      if (tank.at("site") != sid) continue;
      if (4 * t + 3 >= snap.tank.size()) continue;
      std::printf("    %-18s %6.1f%%  f=%.2f u=%.2f h=%.2f\n",
                  (tank.at("material").get<std::string>() + " " +
                   tank.at("role").get<std::string>())
                      .c_str(),
                  100.0 * snap.tank[4 * t + 0], snap.tank[4 * t + 1],
                  snap.tank[4 * t + 2], snap.tank[4 * t + 3]);
    }
  }
  // M2 fleet and route availability.
  const uint32_t nVeh = static_cast<uint32_t>(snap.vehPose.size() / 5);
  for (uint32_t v = 0; v < nVeh && 2 * v + 1 < snap.vehB.size(); ++v) {
    static const char* vehStatus[] = {"Idle", "ToPickup", "QueueLoad", "Loading",
                                      "ToDropoff", "QueueUnload", "Unloading"};
    const uint8_t st = snap.vehB[2 * v];
    std::printf("    vehicle %u  %-11s x=%6.1f y=%6.1f fill=%.2f%s\n", v,
                st < 7 ? vehStatus[st] : "?", snap.vehPose[5 * v],
                snap.vehPose[5 * v + 1], snap.vehPose[5 * v + 4],
                snap.vehOrder[v] != UINT32_MAX ? "" : "  (no order)");
  }
  uint32_t open = 0;
  for (uint8_t e : snap.edgeOpen) open += e != 0;
  std::printf("    routes open %u/%zu, price idx[0]=%.3f\n", open,
              snap.edgeOpen.size(), snap.price.empty() ? 0.f : snap.price[0]);
}

void printHelp() {
  std::printf(
      "crx-cli — Chain Reaction engine driver\n"
      "  version                     print engine version\n"
      "  run   [--seed N --ticks N --report N] [--event '<json>' ...]\n"
      "                              step the sim, report sites, tanks and rates\n"
      "                              every N ticks (default 96); inject §5.9 events\n"
      "                              via --event (repeatable, applied before tick 0)\n"
      "  dump  [--seed N --ticks N --out F] [--event '<json>' ...]\n"
      "                              write the binary snapshot to F\n"
      "  worldgen [--seed N --out F] generate the template world, write JSON\n");
}

}  // namespace

int main(int argc, char** argv) {
  const std::string cmd = argc > 1 ? argv[1] : "help";
  if (cmd == "help" || cmd == "--help" || cmd == "-h") {
    printHelp();
    return 0;
  }
  if (cmd == "version") {
    std::printf("crx-cli %s\n", crx_version());
    return 0;
  }

  uint64_t seed = 42;
  uint32_t ticks = 96 * 10;
  uint32_t report = 96;
  const char* out = "snapshot.bin";
  std::vector<std::string> events;  // --event JSON, repeatable, applied in order
  for (int i = 2; i + 1 < argc; i += 2) {
    if (std::strcmp(argv[i], "--seed") == 0) {
      seed = std::strtoull(argv[i + 1], nullptr, 10);
    } else if (std::strcmp(argv[i], "--ticks") == 0) {
      ticks = std::strtoul(argv[i + 1], nullptr, 10);
    } else if (std::strcmp(argv[i], "--report") == 0) {
      report = std::strtoul(argv[i + 1], nullptr, 10);
    } else if (std::strcmp(argv[i], "--out") == 0) {
      out = argv[i + 1];
    } else if (std::strcmp(argv[i], "--event") == 0) {
      events.push_back(argv[i + 1]);
    }
  }
  if (report == 0) report = ticks;  // single report at the end

  if (cmd == "worldgen") {
    const crx::worldgen::GenResult r =
        crx::worldgen::generateWorld(seed, crx::worldgen::GenParams{},
                                     crx::worldgen::referenceCatalog());
    if (!r.ok) {
      std::fprintf(stderr, "worldgen: feasibility gate rejected seed %llu after all attempts\n",
                   static_cast<unsigned long long>(seed));
      for (const auto& e : r.gate_errors) std::fprintf(stderr, "  - %s\n", e.c_str());
      return 1;
    }
    const std::string json = crx::worldgen::toWorldJson(r.world).dump(2);
    std::FILE* f = std::fopen(out, "wb");
    if (f == nullptr) {
      std::fprintf(stderr, "cannot open %s for writing\n", out);
      return 1;
    }
    std::fwrite(json.data(), 1, json.size(), f);
    std::fclose(f);
    std::printf("world seed %llu: sites %zu, tanks %zu, processes %zu, units %zu, "
                "edges %zu, pipelines %zu, vehicles %zu, contracts %zu -> %s\n",
                static_cast<unsigned long long>(r.world.seed), r.world.nSites(),
                r.world.nTanks(), r.world.nProcesses(), r.world.units.size(),
                r.world.edges.size(), r.world.nPipelines(), r.world.nVehicles(),
                r.world.contracts.size(), out);
    return 0;
  }

  const std::string cfg = "{\"seed\":" + std::to_string(seed) + "}";
  crx_sim* sim = crx_create(cfg.c_str());
  if (sim == nullptr) {
    std::fprintf(stderr, "crx_create failed\n");
    return 1;
  }
  for (const std::string& ev : events) {
    const char* reply = crx_command(sim, ev.c_str());
    if (std::strstr(reply, "\"ok\":true") == nullptr) {
      std::fprintf(stderr, "event rejected: %s\n", reply);
      return 1;
    }
    std::printf("event: %s\n", ev.c_str());
  }

  const json world = json::parse(crx_world_json(sim));
  int rc = 0;
  if (cmd == "run") {
    uint32_t done = 0;
    while (done < ticks) {
      const uint32_t chunk = std::min(report, ticks - done);
      crx_step(sim, chunk);
      done += chunk;
      uint32_t bytes = 0;
      Snapshot snap;
      const uint8_t* raw = crx_snapshot(sim, &bytes);  // sequenced: bytes out first
      if (!readSnapshot(raw, bytes, snap)) {
        std::fprintf(stderr, "snapshot read failed\n");
        rc = 1;
        break;
      }
      printReport(world, snap);
      uint32_t nk = 0;
      const double* k = crx_kpis(sim, &nk);
      std::printf("    KPIs: service=%.4f unmet=%.1ft unmet$=%.0f prod_idx=%.4f "
                  "shutdown_h=%.1f stockouts=%.0f freight$=%.0f energy$=%.0f\n\n",
                  k[0], k[1], k[2], k[3], k[4], k[5], k[6], k[7]);
    }
    std::printf("final: tick %llu hash %016llx\n", static_cast<unsigned long long>(crx_tick(sim)),
                static_cast<unsigned long long>(crx_state_hash(sim)));
  } else if (cmd == "dump") {
    crx_step(sim, ticks);
    uint32_t bytes = 0;
    const uint8_t* snap = crx_snapshot(sim, &bytes);
    std::FILE* f = std::fopen(out, "wb");
    if (f == nullptr) {
      std::fprintf(stderr, "cannot open %s for writing\n", out);
      rc = 1;
    } else {
      std::fwrite(snap, 1, bytes, f);
      std::fclose(f);
      std::printf("wrote %u bytes at tick %llu to %s\n", bytes,
                  static_cast<unsigned long long>(crx_tick(sim)), out);
    }
  } else {
    std::fprintf(stderr, "unknown command: %s\n", cmd.c_str());
    printHelp();
    rc = 1;
  }

  crx_destroy(sim);
  return rc;
}
