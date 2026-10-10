// Vehicle inspector: class, cargo, fill, order state, route and ETA for the
// selected vehicle.

import { VEHICLE_CLASSES } from '../engine/world';
import { VEH_STATUS } from '../engine/stub';
import { materialColor } from '../scene/palette';
import { useSim } from '../store/sim';
import { fmtClock, fmtDelta, fmtPct } from './format';
import { vehicleLive } from './vehicleLive';

export function VehicleInspector({ vehIdx }: { vehIdx: number }) {
  const world = useSim((s) => s.world);
  const snap = useSim((s) => s.snap);
  const backendKind = useSim((s) => s.backendKind);
  if (world === null || snap === null) return null;
  const veh = world.vehicles[vehIdx];
  if (veh === undefined) return null;

  const live = vehicleLive(world, snap, vehIdx, backendKind);
  const clsLabel = VEHICLE_CLASSES[veh.cls].label;
  const cargoColor = materialColor(veh.cargo).getHexString();

  return (
    <section className="panel pointer-events-auto w-80 p-3 text-xs" data-testid="vehicle-inspector">
      <header className="mb-2 flex items-center justify-between">
        <h2 className="text-sm font-semibold text-slate-100">
          {clsLabel} {vehIdx + 1}
        </h2>
        <span
          className="rounded px-1.5 py-0.5 font-medium"
          style={{ backgroundColor: `#${cargoColor}33`, color: `#${cargoColor}` }}
        >
          {veh.cargo}
        </span>
      </header>

      <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1.5 text-slate-300">
        <dt className="text-slate-500">Status</dt>
        <dd data-testid="vehicle-status">{VEH_STATUS[live.status] ?? `status ${live.status}`}</dd>

        <dt className="text-slate-500">Load</dt>
        <dd>{fmtPct(live.fill)}</dd>

        <dt className="text-slate-500">Order</dt>
        <dd className="font-mono">#{live.orderId}</dd>

        <dt className="text-slate-500">Route</dt>
        <dd data-testid="vehicle-route">
          {live.from} → {live.to}
        </dd>

        <dt className="text-slate-500">ETA</dt>
        <dd data-testid="vehicle-eta">
          {live.etaTick === null ? '—' : `${fmtClock(live.etaTick)} (${fmtDelta(Number(snap.tick), live.etaTick)})`}
        </dd>

        <dt className="text-slate-500">Position</dt>
        <dd className="font-mono">
          {live.x.toFixed(0)}, {live.y.toFixed(0)} km
        </dd>
      </dl>
    </section>
  );
}
