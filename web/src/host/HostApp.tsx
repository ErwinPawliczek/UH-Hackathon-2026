// The multiplayer host's big screen, at /host/.
//
// "Host a game" creates a room. Then the lobby: a large QR code and the room
// code for phones to join with, who has joined and which plant each took,
// the 3D map behind with claimed plants labelled, and "Start the game".
// After the start it is the 3D app watching the room, with the host's
// controls (pause, speed, scenario, all sent through the room's host
// action), a leaderboard, and the QR code kept small in a corner for late
// joiners. The host token stays in sessionStorage, so a reload keeps hosting.

import { useEffect, useMemo, useState } from 'react';
import { scenariosFor } from '../engine/scenarios';
import { SceneCanvas } from '../scene/SceneCanvas';
import { createRoom, roomSource, type RoomSource } from '../store/room';
import { ownedName, playerColor, type HostAction, type RoomInfo, type RoomScore } from '../store/roomTypes';
import { useSim } from '../store/sim';
import { useRoom } from '../store/useRoom';
import { DropdownMenu } from '../ui/DropdownMenu';
import { SiteBadge } from '../ui/SiteIcon';
import { SpeedControl } from '../ui/SpeedControl';
import { SiteWindow } from '../ui/SiteWindow';
import { VehicleWindow } from '../ui/VehicleWindow';
import { fmtMoney } from '../ui/economyData';
import { fmtClock } from '../ui/format';
import { Qr } from './Qr';

const HOST_KEY = 'petrogrid-host-v1';

interface Hosting { code: string; hostToken: string }

function loadHosting(): Hosting | null {
  try {
    const raw = JSON.parse(sessionStorage.getItem(HOST_KEY) ?? 'null') as Partial<Hosting> | null;
    return raw !== null && typeof raw.code === 'string' && typeof raw.hostToken === 'string' ? { code: raw.code, hostToken: raw.hostToken } : null;
  } catch {
    return null;
  }
}

/** Where phones go to join: this page's own origin unless it is the public site, so a local network address works too. */
export function joinUrl(code: string, loc: Pick<Location, 'origin' | 'hostname'> = window.location): string {
  const origin = /(^|\.)petrogrid\.xyz$/.test(loc.hostname) ? 'https://multiplayer.petrogrid.xyz' : loc.origin;
  return `${origin}/play/?room=${encodeURIComponent(code)}`;
}

const CARD = { '--chamfer-fill': 'var(--panel)' } as React.CSSProperties;

function Mark() {
  return (
    <span className="flex items-center gap-2">
      <img src="/logo.svg" alt="" width={22} height={22} />
      <span className="wordmark text-lg leading-none">Petro<span className="text-blue">Grid</span></span>
    </span>
  );
}

function Landing({ onHost, busy, error }: { onHost: (password: string) => void; busy: boolean; error: string | null }) {
  const [password, setPassword] = useState('');
  return (
    <div className="flex h-dvh w-full flex-col items-center justify-center gap-6 bg-white text-ink">
      <Mark />
      <h1 className="font-display text-4xl font-bold">Host a collaborative simulation</h1>
      <p className="max-w-[46ch] text-center text-base text-muted">
        Everyone joins on a phone with a QR code, takes a plant, and sets its price, rate and units. You run the
        clock and break things from this screen.
      </p>
      <form className="flex flex-col items-center gap-3" onSubmit={(e) => { e.preventDefault(); onHost(password); }}>
        <input
          type="password"
          className="w-64 border border-line bg-white px-3 py-2 text-center text-base text-ink outline-none focus:border-blue"
          placeholder="Host password"
          aria-label="Host password"
          autoComplete="current-password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          data-testid="host-password"
        />
        <button type="submit" className="btn btn-primary btn-lg" disabled={busy} data-testid="host-create">
          {busy ? 'Opening a room…' : 'Start a session'}
        </button>
      </form>
      {error !== null && <p className="text-sm text-alarm" role="alert">{error}</p>}
      <a className="text-sm text-muted underline" href="/">Back to the main simulation</a>
    </div>
  );
}

/** Who has joined, with the plant each took. */
function Players({ room }: { room: RoomInfo }) {
  const world = useSim((s) => s.world);
  const select = useSim((s) => s.select);
  if (room.players.length === 0) return <p className="text-sm text-muted">Nobody has joined yet. Scan the code to be the first.</p>;
  return (
    <ul className="flex flex-col" data-testid="host-players">
      {room.players.map((p) => {
        const site = p.site === null ? undefined : world?.sites[p.site];
        return (
          <li key={p.id} className="flex items-center gap-2 border-t border-line py-1 first:border-t-0">
            <span aria-hidden="true" className="inline-block h-3 w-3 shrink-0 rounded-full" style={{ background: playerColor(room, p.id) ?? undefined, opacity: p.connected ? 1 : 0.35 }} title={p.connected ? 'Connected' : 'Not connected'} />
            <span className="min-w-0 flex-1 truncate text-sm font-semibold" style={{ color: playerColor(room, p.id) ?? undefined }}>{p.name}</span>
            {site !== undefined && p.site !== null ? (
              <button className="flex cursor-pointer items-center gap-1.5 text-sm text-ink hover:text-blue" onClick={() => select({ kind: 'site', index: p.site as number })} title={`Show ${site.name} on the map`}>
                <SiteBadge preset={site.preset} />
                {site.name}
              </button>
            ) : <span className="text-sm text-muted">choosing a plant…</span>}
          </li>
        );
      })}
    </ul>
  );
}

function Lobby({ room, url, onStart, onSources, busy }: { room: RoomInfo; url: string; onStart: () => void; onSources: (allow: boolean) => void; busy: boolean }) {
  const free = room.sites.filter((s) => s.playable && s.owner === null).length;
  const taken = room.players.filter((p) => p.site !== null).length;
  return (
    <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-start p-8">
      <section className="chamfer pointer-events-auto flex w-[430px] flex-col gap-4 p-6" style={CARD} data-testid="host-lobby">
        <div className="flex items-center justify-between"><Mark /><span className="label">Collaborative simulation</span></div>
        <div className="flex flex-col items-center gap-2">
          <Qr text={url} size={300} testId="host-qr" />
          <div className="font-display text-6xl font-extrabold leading-none tracking-[0.12em] text-ink" data-testid="host-code">{room.code}</div>
          <p className="data break-all text-center text-xs text-muted" data-testid="host-url">{url}</p>
        </div>
        <div>
          <div className="label mb-1">{room.players.length === 0 ? 'Players' : `${room.players.length} joined · ${taken} with a plant · ${free} plants free`}</div>
          <div className="max-h-[190px] overflow-auto"><Players room={room} /></div>
        </div>
        <button className={`btn self-start ${room.allowSources ? 'btn-active' : ''}`} aria-pressed={room.allowSources === true} onClick={() => onSources(room.allowSources !== true)} disabled={busy} data-testid="host-sources">
          Fields and mines: {room.allowSources ? 'can be picked' : 'not pickable'}
        </button>
        <button className="btn btn-primary btn-lg self-stretch" onClick={onStart} disabled={busy} data-testid="host-start">Start collaborative simulation</button>
        <p className="text-xs text-muted">Plants nobody takes run themselves. Late joiners can still scan and take a free one.</p>
      </section>
    </div>
  );
}

/** Plants, owners and profit, best first; falls back to who owns what while the server has no scores. */
function Leaderboard({ source, room }: { source: RoomSource; room: RoomInfo }) {
  const world = useSim((s) => s.world);
  const select = useSim((s) => s.select);
  const [scores, setScores] = useState<RoomScore[] | null>(null);
  useEffect(() => {
    let stop = false;
    const load = () => source.scores().then((r) => { if (!stop) setScores(r.scores); }).catch(() => { if (!stop) setScores(null); });
    load();
    const t = setInterval(load, 2000);
    return () => { stop = true; clearInterval(t); };
  }, [source]);
  const [board, setBoard] = useState<'profit' | 'damage'>('profit');
  const ownerOf = new Map(room.sites.map((s) => [s.index, s.owner]));
  const names = new Map(room.players.map((p) => [p.id, p.name]));
  const all = scores !== null
    ? scores.map((r) => ({ site: r.site, name: r.name, owner: ownerOf.get(r.site) ?? r.owner, ownerName: r.ownerName, value: board === 'profit' ? r.profitUsd : r.damageUsd ?? 0 }))
    // no scores yet: who has what
    : room.sites.filter((s) => s.playable).map((s) => ({ site: s.index, name: s.name, owner: s.owner, ownerName: s.owner === null ? null : names.get(s.owner) ?? null, value: NaN }));
  // players first on the profit board; the damage board lists players only
  const rows = (board === 'damage' ? all.filter((r) => r.owner !== null) : all)
    .sort((a, b) => (scores !== null ? b.value - a.value : Number(b.owner !== null) - Number(a.owner !== null) || a.site - b.site));
  return (
    <section className="chamfer pointer-events-auto absolute right-4 top-16 z-30 w-[360px] p-3" style={CARD} data-testid="host-leaderboard">
      <div className="mb-2 flex items-center gap-2">
        {([['profit', 'Profit'], ['damage', 'Damage to economy']] as const).map(([key, label]) => (
          <button key={key} className={`btn ${board === key ? 'btn-active' : ''}`} onClick={() => setBoard(key)} data-testid={`host-board-${key}`}>{label}</button>
        ))}
      </div>
      {board === 'damage' && <p className="mb-1 text-xs text-muted">Customer sales lost because of each player, against the same run without them.</p>}
      {rows.length === 0 && <p className="text-sm text-muted">Nobody has taken a plant yet.</p>}
      <ol className="max-h-[60vh] overflow-auto">
        {rows.map((r, i) => {
          const color = playerColor(room, r.owner);
          return (
            <li key={r.site} className="border-t border-line first:border-t-0">
              <button className="flex w-full cursor-pointer items-center gap-2 py-1 text-left hover:bg-panel-2" onClick={() => select({ kind: 'site', index: r.site })}>
                <span className="data w-5 shrink-0 text-right text-muted">{scores !== null ? i + 1 : ''}</span>
                <SiteBadge preset={world?.sites[r.site]?.preset ?? ''} />
                <span className="min-w-0 flex-1 truncate text-sm font-semibold" style={{ color: color ?? undefined }}>
                  {r.owner !== null ? ownedName(r.ownerName ?? names.get(r.owner) ?? 'Player', r.name) : <span className="font-normal text-muted">{r.name}</span>}
                </span>
                <span className={`data shrink-0 text-sm ${board === 'damage' ? 'text-alarm' : 'text-ink'}`}>{Number.isFinite(r.value) ? fmtMoney(r.value) : '—'}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

/** What the players and the host have done to the network, newest first. */
const MOVE_TYPES = new Set(['price_set', 'rate_set', 'trade_block', 'trade_blocked', 'trade_unblocked']);
const HOST_TYPES = new Set(['supply_shock', 'demand_shock', 'route_break', 'site_shutdown', 'hurricane', 'water_restriction']);
function Moves({ room }: { room: RoomInfo }) {
  const events = useSim((s) => s.events);
  const select = useSim((s) => s.select);
  const ownerOf = new Map(room.sites.map((s) => [s.index, s.owner]));
  const moves = events
    .filter((e) => e.player !== undefined || MOVE_TYPES.has(e.type) || HOST_TYPES.has(e.type) || ((e.type === 'unit_failed' || e.type === 'unit_repaired') && (/by the operator/.test(e.text) || !ownerOf.get(e.site ?? -1))))
    .slice(-40)
    .reverse();
  return (
    <section className="chamfer pointer-events-auto absolute left-4 top-16 z-[5] w-[340px] p-3" style={CARD} data-testid="host-moves">
      <div className="label mb-1">Moves</div>
      {moves.length === 0 && <p className="text-sm text-muted">Nothing yet. Every price change, cut, shutdown and blocked trade shows up here.</p>}
      <ol className="scroll-steady max-h-[60vh] overflow-auto">
        {moves.map((e) => {
          const owner = e.player ?? (e.site === undefined ? null : ownerOf.get(e.site) ?? null);
          const isPlayer = e.player !== undefined || MOVE_TYPES.has(e.type) || /by the operator/.test(e.text);
          const color = isPlayer ? playerColor(room, owner) : null;
          return (
            <li key={e.seq} className="border-t border-line first:border-t-0">
              <button className="flex w-full cursor-pointer items-baseline gap-2 py-1 text-left hover:bg-panel-2" onClick={() => e.site !== undefined && select({ kind: 'site', index: e.site })}>
                <span className="data w-16 shrink-0 text-[11px] text-muted">{fmtClock(e.tick)}</span>
                <span className="min-w-0 flex-1 text-sm" style={{ color: color ?? undefined, fontWeight: color !== null ? 600 : 400 }}>{e.text}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}

function HostBar({ room, send, busy }: { room: RoomInfo; send: (a: HostAction) => void; busy: boolean }) {
  const world = useSim((s) => s.world);
  const tick = useSim((s) => s.snap?.tick);
  const scenarios = useMemo(() => scenariosFor(world), [world]);
  const [fired, setFired] = useState<string[]>([]);
  const [playersOnly, setPlayersOnly] = useState(false);
  useEffect(() => {
    document.documentElement.dataset.playersOnly = playersOnly ? '1' : '';
    return () => { document.documentElement.dataset.playersOnly = ''; };
  }, [playersOnly]);
  const running = room.phase === 'running';
  return (
    <header className="absolute inset-x-0 top-0 z-[60] flex h-12 items-center gap-2 bg-panel px-4" data-testid="host-bar">
      <Mark />
      <span className="data ml-2 min-w-28 rounded-sm bg-panel-2 px-2 py-1" data-testid="host-clock">{tick === undefined ? '—' : fmtClock(Number(tick))}</span>
      {room.phase === 'ended' ? <span className="text-sm text-muted">The simulation has ended.</span> : (
        <>
          <button className={`btn ${running ? 'btn-active' : 'btn-primary'}`} onClick={() => send({ action: running ? 'pause' : 'resume' })} disabled={busy} data-testid="host-pause">{running ? '⏸ Pause' : '▶ Resume'}</button>
          <SpeedControl value={room.speed} onSet={(v) => send({ action: 'speed', speed: v })} />
          <DropdownMenu
            label="Scenario"
            items={scenarios.map((s) => ({ key: s.key, label: s.label, checked: fired.includes(s.key), disabled: fired.includes(s.key) }))}
            onPick={(key) => { const s = scenarios.find((x) => x.key === key); if (s !== undefined) { send({ action: 'scenario', command: s.command }); setFired((f) => [...f, key]); } }}
            testId="host-scenario"
          />
        </>
      )}
      {room.phase !== 'ended' && <button className="btn" onClick={() => { send({ action: 'scenario', command: { type: 'end_events' } }); setFired([]); }} disabled={busy} title="End every running scenario now" data-testid="host-end-events">End events</button>}
      <button className={`btn ${playersOnly ? 'btn-active' : ''}`} aria-pressed={playersOnly} onClick={() => setPlayersOnly(!playersOnly)} data-testid="host-players-only">Players only: {playersOnly ? 'on' : 'off'}</button>
      <span className="ml-auto text-xs text-muted">Code <span className="data text-ink">{room.code}</span> · {room.players.length} player{room.players.length === 1 ? '' : 's'}</span>
      {room.phase !== 'ended' && <button className="btn" onClick={() => { if (window.confirm('End the simulation for everyone?')) send({ action: 'end' }); }} data-testid="host-end">End simulation</button>}
    </header>
  );
}

function Game({ hosting, onLeave }: { hosting: Hosting; onLeave: () => void }) {
  useRoom(hosting.code);
  const room = useSim((s) => s.room);
  const world = useSim((s) => s.world);
  const snap = useSim((s) => s.snap);
  const error = useSim((s) => s.error);
  const source = useMemo(() => roomSource(hosting.code), [hosting.code]);
  const [busy, setBusy] = useState(false);
  const [refused, setRefused] = useState<string | null>(null);
  const url = joinUrl(hosting.code);
  // the plant window's Fail unit button works for the host: its command goes out as a host scenario
  useEffect(() => {
    useSim.setState({ sendCommand: (cmd) => source.host(hosting.hostToken, { action: 'scenario', command: cmd }) });
    return () => { useSim.setState({ sendCommand: null }); };
  }, [source, hosting.hostToken]);

  const send = (action: HostAction) => {
    setBusy(true);
    setRefused(null);
    source.host(hosting.hostToken, action)
      .then((r) => { if (r.ok === false) setRefused(r.error ?? 'The server refused that.'); })
      .catch((err: unknown) => setRefused(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="relative h-dvh w-full overflow-hidden bg-white text-ink" data-testid="host-game">
      {world !== null && <SceneCanvas />}
      {/* click a plant or a vehicle on the map: the same windows as the main app */}
      {world !== null && room !== null && room.phase !== 'lobby' && <><VehicleWindow /><SiteWindow /></>}
      {room !== null && room.phase !== 'lobby' && <HostBar room={room} send={send} busy={busy} />}
      {room !== null && room.phase === 'lobby' && <Lobby room={room} url={url} onSources={(allow) => send({ action: 'sources', allow })} onStart={() => { send({ action: 'start' }); window.setTimeout(() => send({ action: 'speed', speed: 8 }), 400); }} busy={busy} />}
      {room !== null && room.phase !== 'lobby' && <Leaderboard source={source} room={room} />}
      {room !== null && room.phase !== 'lobby' && <Moves room={room} />}
      {(refused !== null || (error !== null && snap !== null)) && (
        <div className="absolute inset-x-0 top-14 z-[65] flex justify-center">
          <span className="rounded-sm border border-alarm/50 bg-white px-4 py-2 text-xs font-medium text-alarm" role="alert">{refused ?? error}</span>
        </div>
      )}
      {(world === null || room === null) && (
        <div className="absolute inset-0 z-20 flex flex-col items-center justify-center gap-3 text-sm text-muted">
          {error !== null ? (
            <>
              <p className="text-alarm" role="alert">{error}</p>
              <button className="btn btn-primary" onClick={onLeave}>Host a new session</button>
            </>
          ) : 'Opening the room…'}
        </div>
      )}
    </div>
  );
}

export function HostApp() {
  const [hosting, setHosting] = useState<Hosting | null>(() => loadHosting());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const host = (password: string) => {
    setBusy(true);
    setError(null);
    createRoom(password)
      .then((h) => { sessionStorage.setItem(HOST_KEY, JSON.stringify(h)); setHosting(h); })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setBusy(false));
  };
  const leave = () => { sessionStorage.removeItem(HOST_KEY); useSim.getState().setError(null); setHosting(null); };

  if (hosting === null) return <Landing onHost={host} busy={busy} error={error} />;
  return <Game hosting={hosting} onLeave={leave} />;
}
