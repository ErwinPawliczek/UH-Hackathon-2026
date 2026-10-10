#pragma once

#include <cstdint>
#include <limits>

namespace crx {

template <class Tag>
struct Id {
  uint32_t v = std::numeric_limits<uint32_t>::max();

  bool valid() const { return v != std::numeric_limits<uint32_t>::max(); }
  bool operator==(const Id&) const = default;
  auto operator<=>(const Id&) const = default;
};

struct MaterialTag; struct SiteTag;     struct TankTag;     struct ProcessTag;
struct UnitTag;     struct NodeTag;     struct EdgeTag;     struct PipelineTag;
struct VehicleTag;  struct OrderTag;

using MaterialId  = Id<MaterialTag>;  using SiteId     = Id<SiteTag>;
using TankId      = Id<TankTag>;      using ProcessId  = Id<ProcessTag>;
using UnitId      = Id<UnitTag>;      using NodeId     = Id<NodeTag>;
using EdgeId      = Id<EdgeTag>;      using PipelineId = Id<PipelineTag>;
using VehicleId   = Id<VehicleTag>;   using OrderId    = Id<OrderTag>;

template <class I>
struct Range {
  uint32_t begin = 0;
  uint32_t count = 0;
};

}  // namespace crx
