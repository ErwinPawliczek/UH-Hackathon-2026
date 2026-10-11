// Vehicle inspector: class, cargo, fill, order state, route and ETA for the
// selected vehicle.

import { VEHICLE_CLASSES } from '../engine/world';
import { VEH_STATUS } from '../engine/stub';
import { materialColor } from '../scene/palette';
import { liveCargo } from '../scene/instances';
import { useSim } from '../store/sim';
import { fmtClock, fmtDelta, fmtPct } from './format';
import { VEH_IDLE, standingAt, vehicleLive } from './vehicleLive';

export function VehicleInspector({ vehIdx }: { vehIdx: number }) {
  const world = useSim((s) => s.world);
  const snap = useSim((s) => s.snap);
  if (world === null || snap === null) return null;
  const veh = world.vehicles[vehIdx];
  if (veh === undefined) return null;

  const live = vehicleLive(world, snap, vehIdx);
  const clsLabel = VEHICLE_CLASSES[veh.cls]?.label ?? veh.cls;
  // What is on board right now; an empty vehicle carries nothing.
  const cargo = liveCargo(world, snap, vehIdx);
  const cargoColor = cargo === null ? '5f656c' : materialColor(cargo).getHexString();

  return (
    <section className="panel pointer-events-auto w-80 p-4 text-xs" data-testid="vehicle-inspector">
      <header className="mb-2 flex items-center justify-between">
        <h2 className="font-body text-base font-semibold text-ink">
          {clsLabel} {vehIdx + 1}
        </h2>
        <span
          className="rounded-sm px-2 py-0.5 font-medium"
          style={{ backgroundColor: `#${cargoColor}33`, color: `#${cargoColor}` }}
        >
          {cargo ?? 'Empty'}
        </span>
      </header>

      {/* An idle vehicle is parked and not drawn: say where it is instead of pointing at nothing. */}
      {live.status === VEH_IDLE && (
        <p className="mb-3 rounded-sm bg-panel-2 px-2 py-1.5 text-muted" data-testid="vehicle-idle-note">
          {(() => {
            const at = standingAt(world, live);
            return at === null ? 'Idle, not shown on the map.' : `Idle at ${at}, not shown on the map.`;
          })()}
        </p>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-ink">
        <dt className="label">Status</dt>
        <dd data-testid="vehicle-status">{VEH_STATUS[live.status] ?? `status ${live.status}`}</dd>

        <dt className="label">Load</dt>
        <dd>{fmtPct(live.fill)}</dd>

        <dt className="label">Order</dt>
        <dd className="data">#{live.orderId}</dd>

        <dt className="label">Route</dt>
        <dd data-testid="vehicle-route">
          {live.from} → {live.to}
        </dd>

        <dt className="label">ETA</dt>
        <dd data-testid="vehicle-eta">
          {live.etaTick === null ? '—' : `${fmtClock(live.etaTick)} (${fmtDelta(Number(snap.tick), live.etaTick)})`}
        </dd>

        <dt className="label">Position</dt>
        <dd className="data">
          {live.x.toFixed(0)}, {live.y.toFixed(0)} km
        </dd>
      </dl>
    </section>
  );
}
