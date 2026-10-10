// Chain Reaction — catalog types, loader and validator (§3, §4.2).
//
// The catalog is the static layer of the three-layer model: what kinds of
// things exist. It is data (engine/data/catalog/*.json), parsed into the
// structs below and validated at load. Two rules from §3.2 are enforced by
// the validator:
//
//   1. every unit balances in every mode to 1e-9 (t in == t out per tonne of
//      basis), except boundary processes (§3.3: sources have no input, sinks
//      no output — their recipe is one-sided by design);
//   2. every internal stream is produced and consumed in equal amounts
//      within its process, per mode.
//
// The net recipe of a process (external streams per mode) is derived from
// its units at load — never read from, or written to, the JSON.
#ifndef CRX_CATALOG_H
#define CRX_CATALOG_H

#include "crx/ids.h"

#include <cstdint>
#include <string>
#include <utility>
#include <vector>

namespace crx {

enum class Phase : uint8_t { Liquid, LiquefiedGas, Gas, Solid };
enum class Mode : uint8_t { Road, River, Sea, Pipeline };
enum class MatKind : uint8_t { Traded, SiteInternal, Pseudo };

// Process-local stream slots start here; slots below index the materials.
inline constexpr uint16_t kInternalStreamBase = 1000;

constexpr double kBalanceTol = 1e-9;  // §12 test 1 tolerance

struct Material {
  std::string key, name;
  Phase phase = Phase::Liquid;
  MatKind kind = MatKind::Traded;
  uint8_t modes = 0;  // bitmask of Mode; letters in §3.1: T road, B river, S sea, P pipeline
  double base_price = 0.0;  // $/t; non-traded materials are not priced
  double lhv_gj_t = 0.0;    // FUEL_GAS: 48 GJ/t (§3.1 note)
};

// One leg of a unit recipe, per tonne of process basis. `key` names a
// catalog material or a process-internal stream; `slot` is the resolved
// index used by the sim (material index, or kInternalStreamBase + i).
struct Stream {
  std::string key;
  uint16_t slot = 0;
  double t_per_t = 0.0;
};

struct UnitRecipe {
  std::vector<Stream> in, out;
  double heat_gj = 0.0;    // GJ per tonne of basis
  double power_mwh = 0.0;  // MWh per tonne of basis
};

struct UnitSlot {
  std::string key, name, glyph;
  uint8_t trains = 1;
  double overdesign = 1.10;  // trains sized at 110% of process nameplate (§3.2)
  std::vector<UnitRecipe> by_mode;  // parallel to ProcessType::modes
  double mtbf_h = 0.0, mttr_h = 0.0;  // 0 = random failures off (§5.9)
};

// Boundary processes close the model boundary (§3.3): a source has no
// inputs, a sink no outputs; their unit recipes are one-sided.
enum class Boundary : uint8_t { None, Source, Sink };

struct ProcessType {
  std::string key, name;
  MaterialId basis;         // resolved; per tonne of basis
  std::string basis_key;    // material key as written (diagnostics)
  std::vector<std::string> modes;     // {"DEFAULT"} or {"ETHANE","LPG","NAPHTHA"}
  std::vector<std::string> internal;  // process-local stream names (no tank)
  std::vector<UnitSlot> units;        // in flow order
  int swing_unit = -1;                // unit whose trains choose the mode
  double turndown = 0.0, ramp_per_h = 0.0, restart_h = 0.0, switch_h = 0.0;
  bool rations = true;                // false for sinks (§4.2)
  Boundary boundary = Boundary::None;
  std::vector<std::vector<Stream>> net;  // derived at load, per mode:
                                         // external in (negative) and out (positive)
};

enum class TankRole : uint8_t { Feed, Product, Internal, Both };

struct TankRule {
  MaterialId m;
  TankRole role = TankRole::Feed;
  double cover_days = 0.0, target_frac = 0.0;
};

struct SitePreset {
  std::string key, name;
  std::vector<uint16_t> processes;  // indices into Catalog::process_types
  std::vector<TankRule> tanks;
  uint8_t bays[3] = {0, 0, 0};  // road, river, sea
  double ref_nameplate_t_d = 0.0;  // 0 for sources, sinks and the port
};

struct VehicleClass {
  std::string key;
  Mode mode = Mode::Road;
  Phase carries = Phase::Liquid;
  double capacity_t = 0.0, speed_kmh = 0.0, load_t_h = 0.0, freight = 0.0;
};

struct Catalog {
  std::vector<Material> materials;
  std::vector<ProcessType> process_types;
  std::vector<SitePreset> site_presets;
  std::vector<VehicleClass> vehicle_classes;

  // Lookups by key; return the index or -1.
  int findMaterial(const std::string& key) const;
  int findProcess(const std::string& key) const;
  int findPreset(const std::string& key) const;
  int findVehicle(const std::string& key) const;
};

// Validates cross-checks only (shapes are already checked at parse time):
// unit balances per mode, internal-stream netting per mode, site preset and
// vehicle references, and §12 test 1's "every traded material has a producer
// and a consumer". Returns false with `error` listing all violations.
bool validateCatalog(const Catalog& catalog, std::string& error);

// Parses and validates a whole catalog from JSON texts. `process_files`
// holds every processes/*.json document as (name, text) pairs; each must be
// an array of process objects in the §3.7 format. Returns false with
// `error` set on any parse or validation failure.
bool buildCatalog(const std::string& materials_json,
                  const std::string& vehicles_json,
                  const std::string& presets_json,
                  const std::vector<std::pair<std::string, std::string>>& process_files,
                  Catalog& out, std::string& error);

// Directory convenience for the engine/data/catalog layout:
// materials.json, vehicles.json, presets.json, processes/*.json (sorted).
bool loadCatalogFromDir(const std::string& dir, Catalog& out, std::string& error);

const char* toString(Phase phase);
const char* toString(MatKind kind);

}  // namespace crx

#endif  // CRX_CATALOG_H
