// Chain Reaction — plain words: implementation.
#include "sim/words.h"

#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstring>

namespace crx {
namespace sim {

namespace {

struct Word {
  const char* key;
  const char* word;
};

// Mid-sentence names. Abbreviations people actually say stay as they are.
const Word kMaterials[] = {
    {"CRUDE", "crude oil"},   {"RAW_GAS", "raw gas"},        {"SALT", "salt"},
    {"METHANE", "methane"},   {"ETHANE", "ethane"},          {"LPG", "LPG"},
    {"NAPHTHA", "naphtha"},   {"HEAVY_NAPHTHA", "heavy naphtha"},
    {"GASOIL", "gasoil"},     {"VGO", "vacuum gasoil"},      {"GASOLINE", "gasoline"},
    {"JET", "jet fuel"},      {"DIESEL", "diesel"},          {"FUEL_OIL", "fuel oil"},
    {"SOLVENT", "solvent"},   {"BENZENE", "benzene"},        {"ETHYLENE", "ethylene"},
    {"PROPYLENE", "propylene"}, {"CHLORINE", "chlorine"},    {"CAUSTIC", "caustic soda"},
    {"VCM", "vinyl chloride"}, {"STYRENE", "styrene"},       {"PE", "polyethylene"},
    {"PP", "polypropylene"},  {"PVC", "PVC"},                {"PS", "polystyrene"},
    {"FUEL_GAS", "fuel gas"}, {"WATER", "water"},            {"AIR_O2", "air"},
    {"LOSS", "losses"},
};

// Streams that only exist inside a process.
const Word kStreams[] = {
    {"brine", "purified brine"},        {"catholyte", "cell liquor"},
    {"compressed", "compressed cracked gas"}, {"cracked", "cracked gas"},
    {"crude", "crude product"},         {"eb", "ethylbenzene"},
    {"edc", "ethylene dichloride"},     {"hcl", "hydrogen chloride"},
    {"powder", "polymer powder"},       {"pure", "purified feed"},
    {"pygas", "pyrolysis gasoline"},    {"quenched", "quenched gas"},
    {"reformate", "reformate"},         {"resid", "atmospheric residue"},
    {"slurry", "PVC slurry"},           {"treated", "treated feed"},
    {"vapour", "cracked vapour"},       {"wet_cl2", "wet chlorine gas"},
    {"ygrade", "mixed gas liquids"},
};

const Word kVehicles[] = {
    {"TRUCK_TANK", "a tank truck"},   {"TRUCK_PRESS", "a pressurised truck"},
    {"TRUCK_BULK", "a bulk truck"},   {"BARGE_TANK", "a tank barge"},
    {"BARGE_DRY", "a dry barge"},     {"SHIP_TANK", "a tanker"},
    {"SHIP_GAS", "a gas carrier"},    {"SHIP_DRY", "a bulk carrier"},
};

template <size_t N>
const char* find(const Word (&table)[N], const std::string& key) {
  for (const Word& w : table)
    if (key == w.key) return w.word;
  return nullptr;
}

// A key no table knows, tidied rather than shown raw: FOO_BAR -> "foo bar".
std::string tidy(const std::string& key) {
  std::string out;
  for (const char c : key)
    out += c == '_' ? ' ' : static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  return out;
}

}  // namespace

std::string materialWord(const std::string& key) {
  if (const char* w = find(kMaterials, key)) return w;
  return tidy(key);
}

std::string materialWord(const Catalog& catalog, uint16_t material) {
  return material < catalog.materials.size() ? materialWord(catalog.materials[material].key)
                                             : std::string("material");
}

std::string vehicleWord(const std::string& class_key) {
  if (const char* w = find(kVehicles, class_key)) return w;
  return "a " + tidy(class_key);
}

std::string streamTitle(const std::string& key) {
  const char* known = find(kStreams, key);
  std::string out = known != nullptr ? std::string(known) : materialWord(key);
  if (!out.empty()) out[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(out[0])));
  return out;
}

std::string tonnesText(double tonnes) {
  char buf[48];
  if (tonnes < 100.0 && std::fabs(tonnes - std::round(tonnes)) > 0.05) {
    std::snprintf(buf, sizeof buf, "%.1f t", tonnes);
    return buf;
  }
  // Whole tonnes with thousands separators.
  const long long whole = std::llround(tonnes);
  std::string digits = std::to_string(whole < 0 ? -whole : whole), out;
  for (size_t i = 0; i < digits.size(); ++i) {
    if (i > 0 && (digits.size() - i) % 3 == 0) out += ',';
    out += digits[i];
  }
  return (whole < 0 ? "-" : "") + out + " t";
}

std::string trainsDownText(uint32_t trains) {
  return std::to_string(trains) + (trains == 1 ? " train down" : " trains down");
}

std::string processWithin(const std::string& site_name, const std::string& process_name) {
  // Compare ignoring case; cut only on a word boundary and keep something.
  if (process_name.size() > site_name.size() + 1 && !site_name.empty()) {
    bool same = true;
    for (size_t i = 0; i < site_name.size() && same; ++i)
      same = std::tolower(static_cast<unsigned char>(process_name[i])) ==
             std::tolower(static_cast<unsigned char>(site_name[i]));
    if (same && process_name[site_name.size()] == ' ') return process_name.substr(site_name.size() + 1);
  }
  return process_name;
}

}  // namespace sim
}  // namespace crx
