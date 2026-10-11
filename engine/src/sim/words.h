// Chain Reaction — plain words for the event log and host views.
//
// Catalog keys and names are written for the model ("NaOH, dry basis",
// TRUCK_BULK, "wet_cl2"); a person reading the log wants "caustic soda",
// "a bulk truck", "wet chlorine gas". One table, used by every log line.
#ifndef CRX_SIM_WORDS_H
#define CRX_SIM_WORDS_H

#include "sim/world.h"

#include <string>

namespace crx {
namespace sim {

// A material as it reads inside a sentence: "polyethylene", "fuel oil", "LPG".
std::string materialWord(const Catalog& catalog, uint16_t material);
std::string materialWord(const std::string& key);

// A vehicle class with its article: "a bulk truck", "a tanker".
std::string vehicleWord(const std::string& class_key);

// A process-internal or material stream key in plain words, starting with a
// capital: "Ethylene dichloride", "Wet chlorine gas", "Polyethylene".
std::string streamTitle(const std::string& key);

// "25 t", "7.5 t", "1,610 t".
std::string tonnesText(double tonnes);

// "1 train down", "2 trains down".
std::string trainsDownText(uint32_t trains);

// A process named within its site, without saying the site twice:
// "Process industries" + "Process industries caustic demand" -> "caustic demand".
std::string processWithin(const std::string& site_name, const std::string& process_name);

}  // namespace sim
}  // namespace crx

#endif  // CRX_SIM_WORDS_H
