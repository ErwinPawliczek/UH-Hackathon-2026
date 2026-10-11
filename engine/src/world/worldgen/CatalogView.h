// CatalogView — the read-only slice of the catalog the layout generator needs.
//
// The generator codes against this schema (outline §4.2), not against the
// catalog JSON files. The view is built from the loaded production catalog
// (crx/catalog.h) by makeCatalogView() below — one table, no transcription:
// the generator's keys and recipes are the engine's keys and recipes.
//
// Process recipes here are the per-mode aggregates over the process's units,
// per tonne of basis, INCLUDING site-internal streams and pseudos — the raw
// material the §4.2 loader derives `ProcessType::net` (external-only) from.
// The generator collapses site-internal streams itself when it composes a
// multi-process site (refinery, vinyls, styrenics).
#ifndef CRX_WORLDGEN_CATALOG_VIEW_H
#define CRX_WORLDGEN_CATALOG_VIEW_H

#include "world/worldgen/WorldGenTypes.h"

#include <cstdint>
#include <map>
#include <string>
#include <vector>

namespace crx {

class Catalog;

namespace worldgen {

// Local copies of the catalog's Phase / MatKind enums (§4.2).
enum class Phase : uint8_t { Liquid = 0, LiquefiedGas = 1, Gas = 2, Solid = 3 };
enum class MatKind : uint8_t { Traded = 0, SiteInternal = 1, Pseudo = 2 };

// Boundary role of a process (§3: sources supply, sinks demand, plants
// convert). Mirrors crx::Boundary so the generator never parses JSON.
enum class Boundary : uint8_t { None = 0, Source = 1, Sink = 2 };

struct MaterialInfo {
  std::string key;
  Phase phase = Phase::Liquid;
  MatKind kind = MatKind::Traded;
  uint8_t modes_mask = 0;  // bitmask: bit0 Road, bit1 River, bit2 Sea, bit3 Pipeline
  double base_price = 0.0;
};

struct NetStream {
  std::string material;  // material key
  double t_per_t = 0.0;  // per tonne of process basis
};

struct NetRecipe {
  std::vector<NetStream> in, out;
};

struct ProcessInfo {
  std::string key;
  std::string basis;               // material key of the process basis
  std::vector<std::string> modes;  // {"DEFAULT"} or {"ETHANE","LPG","NAPHTHA"}
  std::vector<NetRecipe> by_mode;  // parallel to `modes`; unit aggregates
  double nameplate_t_d = 0.0;      // reference nameplate, t/d of basis
  Boundary boundary = Boundary::None;
  // Units in flow order (§3.2): key and train count. Sizing needs trains;
  // per-unit balances stay in the catalog loader's territory.
  struct UnitInfo { std::string key; uint8_t trains; };
  std::vector<UnitInfo> units;
};

struct PresetInfo {
  std::string key, name;
  std::vector<std::string> process_keys;  // instanced at such a site, in flow order
  double ref_nameplate_t_d = 0.0;         // site's reference plant size (t/d of basis)
  // Tank covers by role (§4.2 TankRule): max over the preset's tank rules for
  // that role, plus the per-material overrides the rules actually carry.
  double cover_feed_d = 7.0;
  double cover_product_d = 7.0;
  double cover_internal_d = 7.0;
  std::map<std::string, double> cover_by_material;  // exact per-material cover
  uint8_t bays_road = 2, bays_river = 0, bays_sea = 0;
};

struct VehicleClassInfo {
  std::string key;
  Mode mode = Mode::Road;
  Phase carries = Phase::Liquid;
  double capacity_t = 0.0, speed_kmh = 0.0, load_t_h = 0.0, freight_per_t_km = 0.0;
};

struct CatalogView {
  std::vector<MaterialInfo> materials;
  std::vector<ProcessInfo> processes;
  std::vector<PresetInfo> presets;
  std::vector<VehicleClassInfo> vehicles;

  const MaterialInfo* material(const std::string& key) const;
  const ProcessInfo* process(const std::string& key) const;
  const PresetInfo* preset(const std::string& key) const;
  const VehicleClassInfo* vehicle(const std::string& key) const;
};

// Builds the generator's view from the loaded production catalog. Process
// recipes come from the catalog's aggregated net flows (including
// site-internal materials); pseudo and process-local streams stay in the
// by_mode aggregates the same way the §3 outline transcribed them. The
// catalog is validated by its loader, so the mapping is total.
CatalogView makeCatalogView(const crx::Catalog& catalog);

}  // namespace worldgen
}  // namespace crx

#endif  // CRX_WORLDGEN_CATALOG_VIEW_H
