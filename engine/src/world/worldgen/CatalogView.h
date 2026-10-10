// CatalogView — the read-only slice of the catalog the layout generator needs.
//
// The generator codes against this schema (outline §4.2), not against the
// catalog JSON files: those are authored in a parallel workstream and are
// embedded by its loader. Until that lands, `referenceCatalog()` below serves
// a clearly-marked LOCAL TABLE transcribed from outline §3 (materials §3.1,
// plant presets §3.2, site presets §3.3, vehicle classes §3.4). When the real
// loader exists, build a CatalogView from it and the generator is unchanged.
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
#include <string>
#include <vector>

namespace crx {
namespace worldgen {

// Local copies of the catalog's Phase / MatKind enums (§4.2).
enum class Phase : uint8_t { Liquid = 0, LiquefiedGas = 1, Gas = 2, Solid = 3 };
enum class MatKind : uint8_t { Traded = 0, SiteInternal = 1, Pseudo = 2 };

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
  // Units in flow order (§3.2): key and train count. Sizing needs trains;
  // per-unit balances stay in the catalog loader's territory.
  struct UnitInfo { std::string key; uint8_t trains; };
  std::vector<UnitInfo> units;
};

struct PresetInfo {
  std::string key, name;
  std::vector<std::string> process_keys;  // instanced at such a site, in flow order
  double cover_feed_d = 15.0;             // tank cover days by role (§4.2 TankRule)
  double cover_product_d = 10.0;
  double cover_internal_d = 2.0;
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

// LOCAL TABLE (clearly marked): outline §3 values transcribed by hand. Replace
// with the catalog loader's view once engine/data/catalog/ merges.
CatalogView referenceCatalog();

}  // namespace worldgen
}  // namespace crx

#endif  // CRX_WORLDGEN_CATALOG_VIEW_H
