// Live per-vehicle view model for the vehicle inspector. Everything comes from
// the snapshot: pose/status/order from arrays 6-8, movement (assigned route,
// progress, activity ETA) from the v2 arrays 12-14. There is no stub-specific
// path — both producers encode the same contract. On v1 payloads (no movement
// arrays) the route and ETA fields degrade to unknown instead of being
// fabricated.

import { NO_ETA, NO_ROUTE } from '../engine/snapshot';
import type { Snapshot } from '../engine/snapshot';
import type { WorldSpec } from '../engine/world';

export interface VehicleLive {
  x: number;
  y: number;
  dirX: number;
  dirY: number;
  fill: number;
  status: number;
  orderId: number;
  /** display names of the route ends the vehicle is travelling between */
  from: string;
  to: string;
  /** absolute tick the current activity ends; null when not derivable */
  etaTick: number | null;
}

export function vehicleLive(world: WorldSpec, snap: Snapshot, v: number): VehicleLive {
  const x = snap.vehPos[5 * v];
  const y = snap.vehPos[5 * v + 1];
  const dirX = snap.vehPos[5 * v + 2];
  const dirY = snap.vehPos[5 * v + 3];
  const fill = snap.vehPos[5 * v + 4];
  const status = snap.vehStatus[2 * v];
  const orderId = snap.vehOrder[v];

  const routeId = snap.vehRoute?.[v];
  const eta = snap.vehEta?.[v];
  const etaTick = eta !== undefined && eta !== NO_ETA ? eta : null;

  // Assigned route from the snapshot; heading from the engine's direction
  // vector against the polyline direction at the nearest segment.
  if (routeId === undefined || routeId === NO_ROUTE || routeId >= world.routes.length) {
    return { x, y, dirX, dirY, fill, status, orderId, from: '—', to: '—', etaTick };
  }
  const route = world.routes[routeId];
  const heading = headingToEnd(route.points, x, y, dirX, dirY);
  return {
    x, y, dirX, dirY, fill, status, orderId,
    from: route.ends[heading ? 0 : 1],
    to: route.ends[heading ? 1 : 0],
    etaTick,
  };
}

/** True when the vehicle is travelling in polyline direction (towards ends[1]). */
function headingToEnd(points: [number, number][], x: number, y: number, dirX: number, dirY: number): boolean {
  // nearest segment by endpoint distance is good enough at stub fidelity
  let bestSeg = 0;
  let bestDist = Infinity;
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, ay] = points[i];
    const [bx, by] = points[i + 1];
    const segLen = Math.hypot(bx - ax, by - ay) || 1e-9;
    const t = clamp01(((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / segLen);
    const px = ax + (bx - ax) * t;
    const py = ay + (by - ay) * t;
    const d = Math.hypot(x - px, y - py);
    if (d < bestDist) {
      bestDist = d;
      bestSeg = i;
    }
  }
  const [ax, ay] = points[bestSeg];
  const [bx, by] = points[bestSeg + 1];
  const len = Math.hypot(bx - ax, by - ay) || 1e-9;
  const segDirX = (bx - ax) / len;
  const segDirY = (by - ay) / len;
  return dirX * segDirX + dirY * segDirY >= 0;
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
