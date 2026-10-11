// The vehicle window: click a truck, barge or ship and see its trip — what it
// is carrying, how much, where from and where to, how far it still has to go
// and when it is due. A small draggable window that follows the selection:
// it opens when a vehicle is picked and closing it clears the selection.
//
// The first line always says what it is doing with what and where, in plain
// material names ("Driving to pick up 20 t of propylene at Steam cracker
// (flex)"). While the trip is still being fetched it says so, and if the
// fetch fails it says that too — never a bare ellipsis.
//
// The trip comes from the engine (GET /vehicle), fetched when a vehicle is
// selected, again whenever its order or status changes in the snapshot, and
// every couple of seconds while it is moving so the distance left keeps up.
// It is kept in the store as `selectedVehicleDetail` — the map reads its
// `path` to highlight the route; nothing here draws on the map.

import { useEffect, useState } from 'react';
import type { SiteRef, VehicleDetail } from '../engine/api';
import { VEHICLE_CLASSES, type VehicleClassKey, type WorldSpec } from '../engine/world';
import { useSim } from '../store/sim';
import { DraggableWindow } from './DraggableWindow';
import { SiteBadge } from './SiteIcon';
import { fmtClock, fmtDelta } from './format';
import { materialName } from './materials';
import { standingAt, vehicleLive } from './vehicleLive';

export const VEHICLE_WINDOW_ID = 'vehicle';
/** Real milliseconds between refreshes while the selected vehicle is on the move. */
const REFRESH_MS = 2000;

const MOVING = new Set(['to_pickup', 'to_dropoff']);

/** Engine status names in plain words. */
export const STATUS_WORDS: Record<string, string> = {
  idle: 'Idle',
  to_pickup: 'Driving to pick up',
  queue_load: 'Waiting for a bay to load',
  loading: 'Loading',
  to_dropoff: 'Carrying a load',
  queue_unload: 'Waiting for a bay to unload',
  unloading: 'Unloading',
};

/** Snapshot status numbers (§4.4 VehStatus) as the engine's status names. */
const STATUS_BY_NUMBER = ['idle', 'to_pickup', 'queue_load', 'loading', 'to_dropoff', 'queue_unload', 'unloading'];

const tonnes = (t: number) => `${t >= 100 ? Math.round(t).toLocaleString('en-US') : Math.round(t * 10) / 10} t`;

/**
 * What the vehicle is doing, in one sentence that always names the cargo and
 * the place: "Driving to pick up 20 t of propylene at Steam cracker (flex)."
 */
export function tripSentence(d: VehicleDetail, idleAt: string | null = null): string {
  const o = d.order;
  if (o === null || d.status === 'idle') {
    return idleAt === null ? 'Idle, not shown on the map.' : `Idle at ${idleAt}, not shown on the map.`;
  }
  const what = materialName(o.material);
  const lot = `${tonnes(o.tonnes)} of ${what}`;
  const onBoard = d.cargo !== null ? `${tonnes(d.cargo.tonnes)} of ${materialName(d.cargo.material)}` : lot;
  switch (d.status) {
    case 'to_pickup': return `Driving to pick up ${lot} at ${o.from.name}.`;
    case 'queue_load': return `Waiting for a bay to load ${lot} at ${o.from.name}.`;
    case 'loading': return `Loading ${lot} at ${o.from.name}${d.cargo !== null ? ` — ${tonnes(d.cargo.tonnes)} on board so far` : ''}.`;
    case 'to_dropoff': return `Carrying ${onBoard} to ${o.to.name}.`;
    case 'queue_unload': return `Carrying ${onBoard}, waiting for a bay to unload at ${o.to.name}.`;
    case 'unloading': return `Unloading ${what} at ${o.to.name}${d.cargo !== null ? ` — ${tonnes(d.cargo.tonnes)} still on board` : ''}.`;
    default: return `${STATUS_WORDS[d.status] ?? d.status}: ${lot}.`;
  }
}

/**
 * The first line before the trip is known: the status in words, and that the
 * details are on their way — or that they could not be fetched.
 */
export function pendingSentence(status: string, idleAt: string | null, failure: string | null): string {
  if (status === 'idle') return idleAt === null ? 'Idle, not shown on the map.' : `Idle at ${idleAt}, not shown on the map.`;
  const words = STATUS_WORDS[status] ?? status;
  return failure === null ? `${words} (loading details…)` : `${words} — the trip details could not be loaded (${failure}).`;
}

/** Hours the rest of the drive should take at the class's speed; null when it is not driving. */
export function hoursToGo(d: VehicleDetail, speedKmh: number): number | null {
  if (!MOVING.has(d.status) || !(speedKmh > 0)) return null;
  return d.remainingKm / speedKmh;
}

/** How far along its current drive the vehicle is, 0..1; null when it is not driving. */
export function tripProgress(d: VehicleDetail): number | null {
  if (!MOVING.has(d.status) || !(d.tripKm > 0)) return null;
  return Math.min(1, Math.max(0, 1 - d.remainingKm / d.tripKm));
}

const km = (v: number) => `${Math.round(v).toLocaleString('en-US')} km`;

/** A line icon per transport mode, on the same 24 px grid and stroke as the site icons. */
function ModeIcon({ cls, size = 22 }: { cls: string; size?: number }) {
  const mode = cls.startsWith('BARGE') ? 'barge' : cls.startsWith('SHIP') ? 'ship' : 'truck';
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="var(--ink)" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {mode === 'truck' && (
        <>
          <path d="M2.5 7h11v9.5h-11z" />
          <path d="M13.5 10h4l3.5 3.5v3h-7.5" />
          <path d="M5.2 17.2a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0-3.8 0M15.2 17.2a1.9 1.9 0 1 0 3.8 0a1.9 1.9 0 1 0-3.8 0" stroke="var(--blue)" />
        </>
      )}
      {mode === 'barge' && (
        <>
          <path d="M2.5 13.5h19l-2 4.5h-15z" />
          <path d="M6 13.5v-4h9v4" />
          <path d="M17 13.5V8h2.5v5.5" />
          <path d="M2.5 21c1.6-1.3 3.2-1.3 4.8 0s3.2 1.3 4.7 0 3.2-1.3 4.8 0 3.1 1.3 4.7 0" stroke="var(--blue)" />
        </>
      )}
      {mode === 'ship' && (
        <>
          <path d="M2.5 13h16.5l2.5-3-1.5 7.5h-15z" />
          <path d="M5 13V8.5h5V13" />
          <path d="M7.5 8.5V5.5" />
          <path d="M12.5 13v-2.5h4V13" />
          <path d="M2.5 21c1.6-1.3 3.2-1.3 4.8 0s3.2 1.3 4.7 0 3.2-1.3 4.8 0 3.1 1.3 4.7 0" stroke="var(--blue)" />
        </>
      )}
    </svg>
  );
}

/** One end of the trip: the site's badge and name; clicking it selects the site. */
function TripEnd({ label, end, world }: { label: string; end: SiteRef; world: WorldSpec }) {
  const site = world.sites[end.site];
  const select = useSim((s) => s.select);
  return (
    <button
      className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-sm border border-line bg-white px-2 py-1.5 text-left hover:bg-panel-2"
      onClick={() => site !== undefined && select({ kind: 'site', index: end.site })}
      title={site !== undefined ? `Show ${end.name}` : end.name}
    >
      <SiteBadge preset={site?.preset ?? end.key} />
      <span className="min-w-0">
        <span className="label block">{label}</span>
        <span className="block truncate text-ink">{end.name}</span>
      </span>
    </button>
  );
}

/**
 * Keep the store's selectedVehicleDetail fresh for the selected vehicle:
 * fetch on select, when its order or status changes, on a rewind, and every
 * two seconds while it is driving and the run is playing.
 */
function useSelectedVehicleDetail(vehIdx: number | null): string | null {
  const fetchVehicle = useSim((s) => s.fetchVehicle);
  const orderId = useSim((s) => (vehIdx === null ? null : s.snap?.vehOrder[vehIdx] ?? null));
  const status = useSim((s) => (vehIdx === null ? null : s.snap?.vehStatus[2 * vehIdx] ?? null));
  const runEpoch = useSim((s) => s.runEpoch);
  const playing = useSim((s) => s.playing);
  const moving = status === 1 || status === 4;
  /** why the last fetch failed, for the vehicle it failed for */
  const [failure, setFailure] = useState<{ veh: number; reason: string } | null>(null);

  useEffect(() => {
    if (vehIdx === null || fetchVehicle === null) return;
    let stale = false;
    const load = () => {
      fetchVehicle(vehIdx)
        .then((detail) => {
          const sel = useSim.getState().selected;
          if (!stale && sel !== null && sel.kind === 'vehicle' && sel.index === vehIdx) {
            useSim.setState({ selectedVehicleDetail: detail });
            setFailure(null);
          }
        })
        .catch((err: unknown) => {
          // an engine without the endpoint, or a session just replaced: the
          // window says so and shows what the snapshot alone knows
          if (!stale) setFailure({ veh: vehIdx, reason: err instanceof Error ? err.message : String(err) });
        });
    };
    load();
    const timer = moving && playing ? setInterval(load, REFRESH_MS) : null;
    return () => {
      stale = true;
      if (timer !== null) clearInterval(timer);
    };
  }, [vehIdx, fetchVehicle, orderId, status, runEpoch, moving, playing]);
  return failure !== null && failure.veh === vehIdx ? failure.reason : null;
}

export function VehicleWindow() {
  const selected = useSim((s) => s.selected);
  const world = useSim((s) => s.world);
  const snap = useSim((s) => s.snap);
  const detail = useSim((s) => s.selectedVehicleDetail);
  const select = useSim((s) => s.select);
  const vehIdx = selected !== null && selected.kind === 'vehicle' ? selected.index : null;
  const failure = useSelectedVehicleDetail(vehIdx);

  const veh = vehIdx === null || world === null ? undefined : world.vehicles[vehIdx];
  const open = vehIdx !== null && world !== null && snap !== null && veh !== undefined;
  if (!open || vehIdx === null || world === null || snap === null || veh === undefined) return null;

  const live = vehicleLive(world, snap, vehIdx);
  const spec = VEHICLE_CLASSES[veh.cls as VehicleClassKey];
  const clsLabel = spec?.label ?? veh.cls;
  const d = detail !== null && detail.index === vehIdx ? detail : null;
  const status = d?.status ?? STATUS_BY_NUMBER[live.status] ?? 'idle';
  const idleAt = standingAt(world, live);
  const capacityT = d?.capacityT ?? spec?.capacityT ?? 0;
  const progress = d === null ? null : tripProgress(d);
  const now = Number(snap.tick);
  const order = d?.order ?? null;
  const toGoH = d === null ? null : hoursToGo(d, spec?.speedKmh ?? 0);

  return (
    <DraggableWindow
      id={VEHICLE_WINDOW_ID}
      title={`${clsLabel} ${vehIdx + 1}`}
      width={340}
      maxHeight="70vh"
      open
      onClose={() => select(null)}
      at={{ x: Math.max(16, (typeof window === 'undefined' ? 1366 : window.innerWidth) - 356), y: 72 }}
    >
      <div className="flex flex-col gap-3 p-3 text-xs" data-testid="vehicle-window">
        {/* the status line: always what, how much and where */}
        <div className="flex items-start gap-2">
          <ModeIcon cls={veh.cls} />
          <p className="min-w-0 flex-1 text-sm leading-snug text-ink" data-testid="vehicle-status">
            {d !== null ? tripSentence(d, idleAt) : pendingSentence(status, idleAt, failure)}
          </p>
        </div>

        {order !== null && (
          <div className="flex items-stretch gap-2" data-testid="vehicle-trip">
            <TripEnd label="From" end={order.from} world={world} />
            <span className="self-center text-muted" aria-hidden="true">→</span>
            <TripEnd label="To" end={order.to} world={world} />
          </div>
        )}

        {d !== null && progress !== null && (
          <div data-testid="vehicle-progress">
            <div className="mb-1 flex justify-between">
              <span className="text-ink">
                {km(d.remainingKm)} to go{d.legDestination !== null ? ` to ${d.legDestination.name}` : ''}
              </span>
              <span className="text-muted">
                of {km(d.tripKm)}
                {toGoH !== null && ` · about ${toGoH < 1 ? `${Math.max(1, Math.round(toGoH * 60))} min` : `${Math.round(toGoH * 10) / 10} h`}`}
              </span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-sm bg-line-2">
              <div className="h-full rounded-sm bg-blue" style={{ width: `${progress * 100}%` }} />
            </div>
          </div>
        )}

        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-ink">
          <dt className="label">On board</dt>
          <dd data-testid="vehicle-load">
            {d !== null
              ? d.cargo !== null
                ? `${tonnes(d.cargo.tonnes)} of ${materialName(d.cargo.material)}${capacityT > 0 ? ` (${Math.round((d.cargo.tonnes / capacityT) * 100)}% of ${tonnes(capacityT)})` : ''}`
                : `Empty${capacityT > 0 ? ` (carries up to ${tonnes(capacityT)})` : ''}`
              : `${Math.round(live.fill * 100)}%${capacityT > 0 ? ` of ${tonnes(capacityT)}` : ''}`}
          </dd>

          {order !== null && (
            <>
              <dt className="label">Order</dt>
              <dd className="data">
                #{order.id} · {tonnes(order.tonnes)} of {materialName(order.material)}
                <span className="block text-muted">placed {fmtClock(order.createdTick)}</span>
              </dd>

              <dt className="label">Booked for</dt>
              <dd className="data" data-testid="vehicle-eta">
                {fmtClock(order.etaTick)} ({order.etaTick >= now ? fmtDelta(now, order.etaTick) : 'running late'})
              </dd>

              {(order.priceUsdT > 0 || order.freightUsd > 0) && (
                <>
                  <dt className="label">Value</dt>
                  <dd className="data">
                    ${Math.round(order.priceUsdT).toLocaleString('en-US')}/t · freight ${Math.round(order.freightUsd).toLocaleString('en-US')}
                  </dd>
                </>
              )}
            </>
          )}

          <dt className="label">Position</dt>
          <dd className="data">
            {live.x.toFixed(0)}, {live.y.toFixed(0)} km
          </dd>
        </dl>
      </div>
    </DraggableWindow>
  );
}
