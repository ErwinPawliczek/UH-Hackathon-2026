// crx-cli — native driver for the engine: run, dump, bench, oracle (§11).

#include "crx/api.h"
#include "world/worldgen/WorldGen.h"
#include "world/worldgen/WorldJson.h"

#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

namespace {

void printHelp() {
  std::printf(
      "crx-cli — Chain Reaction engine driver\n"
      "  version                     print engine version\n"
      "  run   [--seed N --ticks N]  step the sim, print tick, hash and KPIs\n"
      "  dump  [--seed N --ticks N --out F]  write the binary snapshot to F\n"
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
  const char* out = "snapshot.bin";
  for (int i = 2; i + 1 < argc; i += 2) {
    if (std::strcmp(argv[i], "--seed") == 0) {
      seed = std::strtoull(argv[i + 1], nullptr, 10);
    } else if (std::strcmp(argv[i], "--ticks") == 0) {
      ticks = std::strtoul(argv[i + 1], nullptr, 10);
    } else if (std::strcmp(argv[i], "--out") == 0) {
      out = argv[i + 1];
    }
  }

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

  char cfg[64];
  std::snprintf(cfg, sizeof cfg, "{\"seed\":%llu}",
                static_cast<unsigned long long>(seed));
  crx_sim* sim = crx_create(cfg);
  if (sim == nullptr) {
    std::fprintf(stderr, "crx_create failed\n");
    return 1;
  }

  int rc = 0;
  if (cmd == "run") {
    crx_step(sim, ticks);
    uint32_t n = 0;
    const double* k = crx_kpis(sim, &n);
    std::printf("tick %llu hash %016llx kpis",
                static_cast<unsigned long long>(crx_tick(sim)),
                static_cast<unsigned long long>(crx_state_hash(sim)));
    for (uint32_t i = 0; i < n; ++i) std::printf(" %.6f", k[i]);
    std::printf("\n");
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
