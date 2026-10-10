// crx-cli — native driver for the engine: run, dump, bench, oracle (§11).

#include "crx/api.h"

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
      "  dump  [--seed N --ticks N --out F]  write the binary snapshot to F\n");
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
