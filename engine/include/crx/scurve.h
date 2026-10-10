#pragma once

#include <algorithm>

namespace crx {

// The one signal shape used everywhere (§5.2): 0 at or below `lo`, 1 at or
// above `hi`, smooth in between. Closed form, two plain parameters.
inline double scurve(double x, double lo, double hi) {
  double t = (x - lo) / (hi - lo);
  t = std::clamp(t, 0.0, 1.0);
  return t * t * (3.0 - 2.0 * t);
}

}  // namespace crx
