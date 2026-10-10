// Live per-vehicle view model for the vehicle inspector. Works from snapshot
// arrays for both backends; the stub additionally knows each vehicle's route
// schedule, so heading is derived from the snapshot direction either way and
// ETA is exact only when the stub maths is available.

import { stubVehicleState } from '../engine/stub';
import { routeLength } from '../engine/world';
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
  from: string;
  to: string;
  /** absolute tick of leg end; null when not derivable */
  etaTick: number | null;
}

export function vehicleLive(world: WorldSpec, snap: Snapshot, v: number, backendKind: 'stub' | 'http'): VehicleLive {
  const veh = world.vehicles[v];
  const route = world.routes[veh.route];
  const x = snap.vehPos[5 * v];
  const y = snap.vehPos[5 * v + 1];
  const dirX = snap.vehPos[5 * v + 2];
  const dirY = snap.vehPos[5 * v + 3];
  const fill = snap.vehPos[5 * v + 4];
  const status = snap.vehStatus[2 * v];
  const orderId = snap.vehOrder[v];

  if (backendKind === 'stub') {
    const st = stubVehicleState(world, Number(snap.tick), v);
    return { x, y, dirX, dirY, fill, status, orderId, from: st.from, to: st.to, etaTick: st.etaTick };
  }

  // HTTP snapshot: derive heading by comparing the snapshot direction with the
  // route direction at the nearest polyline point; ETA is not derivable yet.
  const heading = headingToEnd(route.points, x, y, dirX, dirY);
  return {
    x, y, dirX, dirY, fill, status, orderId,
    from: route.ends[heading ? 0 : 1],
    to: route.ends[heading ? 1 : 0],
    etaTick: null,
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
    const t = clamp01(((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / (routeLength([[ax, ay], [bx, by]]) || 1e-9));
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
  const len = routeLength([[ax, ay], [bx, by]]) || 1e-9;
  const segDirX = (bx - ax) / len;
  const segDirY = (by - ay) / len;
  return dirX * segDirX + dirY * segDirY >= 0;
}

const clamp01 = (t: number) => Math.min(1, Math.max(0, t));
