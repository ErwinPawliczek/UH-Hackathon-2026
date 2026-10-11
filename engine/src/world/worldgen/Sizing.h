// The sizing walk (§6.5–6.6): from end demands back through net recipes to
// plant counts and design rates, co-products credited, residuals to ports.
// Deterministic: same catalog+params+placement+routes → same numbers.
//
// The local demand table below (t/d per million people at demand_scale = 1)
// is generator data, clearly marked, calibrated so the reference world lands
// near the §6 composition: fuel burn ≈ 500 L/y per capita for gasoline,
// polymers ≈ 100/25/80/10 kg/y per capita for PE/PP/PVC/PS.
#ifndef CRX_WORLDGEN_SIZING_H
#define CRX_WORLDGEN_SIZING_H

#include "world/worldgen/CatalogView.h"
#include "world/worldgen/Layout.h"
#include "world/worldgen/Routes.h"
#include "world/worldgen/WorldGenTypes.h"

#include <map>
#include <string>
#include <vector>

namespace crx {
namespace worldgen {

struct SizingResult {
  struct ProcDesign {
    int site = -1;            // SiteSlot index
    std::string type;         // process type key
    std::string mode;         // operating mode key ("DEFAULT" when single)
    double rate_t_h = 0.0;    // design rate, t/h of the process basis
    bool demand_curved = false;  // city demand sinks ride the demand sinusoid
  };

  // One directed material movement. Piped=true → straight pipeline between the
  // two sites (§6.4); otherwise a contracted vehicle flow.
  struct FlowLine {
    std::string material;
    int from_site = -1, to_site = -1;
    double t_d = 0.0;
    bool piped = false;
  };

  // Tank design flows at a site (t/h), summed over the site's processes.
  struct TankDesign {
    int site = -1;
    std::string material;
    TankRole role = TankRole::Feed;
    double in_t_h = 0.0, out_t_h = 0.0;
    double capacity_t = 0.0;  // cover days × design flow, from the site preset
  };

  // One vehicle assignment for a flow: class, home site, and how many.
  // from/to site == kOverseasSite means the flow touches the overseas node.
  struct VehicleLine {
    std::string cls;
    int home_site = -1;
    int count = 1;
  };

  std::vector<ProcDesign> processes;
  std::vector<FlowLine> flows;
  std::vector<TankDesign> tanks;
  std::vector<VehicleLine> fleet;
  std::map<std::string, double> net_t_d;    // + = shortfall, − = net export
  std::map<std::string, double> unmet_t_d;  // demand no domestic supplier covers
};

// Local demand/sizing constants — clearly marked generator data (see above).
struct DemandConstants {
  // Fuel sinks, t/d per million people (≈ 500 L/y per capita gasoline).
  double gasoline = 1000.0, diesel = 1375.0, jet = 475.0, lpg = 275.0;
  // Polymer and chemical sinks, t/d per million people (kg/y per capita).
  double pe = 274.0;          // 100 kg/y
  double pp = 68.5;           // 25 kg/y, split between two consumer sinks
  double pvc = 219.2;         // 80 kg/y
  double ps = 27.4;           // 10 kg/y
  double solvent = 54.8;      // 20 kg/y
  double styrene_monomer = 13.7;  // 5 kg/y
  double caustic = 68.5;      // 25 kg/y
  // Steam-cracker feed policy: the flex cracker's mode shares (the gas cracker
  // runs 100% ethane). Fixed policy, not search.
  double flex_ethane = 0.30, flex_lpg = 0.50, flex_naphtha = 0.20;
};

// True when the preset only hosts city demand sinks (curved schedules, and
// never a pipeline endpoint — §6.4).
bool is_city_sink_preset(const std::string& preset);

SizingResult sizeWorld(const CatalogView& catalog, const GenParams& params,
                       const DemandConstants& demands, const Features& features,
                       const std::vector<SiteSlot>& slots, const Routes& routes);

// Sentinel site index for the OVERSEAS node in flow lines (import/export leg).
constexpr int kOverseasSite = -1;

}  // namespace worldgen
}  // namespace crx

#endif  // CRX_WORLDGEN_SIZING_H
