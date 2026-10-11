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
import type { HostAction, RoomInfo, RoomScore } from '../store/roomTypes';
import { useSim } from '../store/sim';
import { useRoom } from '../store/useRoom';
import { DropdownMenu } from '../ui/DropdownMenu';
import { SiteBadge } from '../ui/SiteIcon';
import { fmtMoney } from '../ui/economyData';
import { fmtClock } from '../ui/format';
import { Qr } from './Qr';

const HOST_KEY = 'petrogrid-host-v1';
const SPEEDS = [1, 2, 4, 8, 16, 32];

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
            <span aria-hidden="true" className={`inline-block h-2 w-2 shrink-0 rounded-full ${p.connected ? 'bg-blue' : 'bg-line-2'}`} title={p.connected ? 'Connected' : 'Not connected'} />
            <span className="min-w-0 flex-1 truncate text-sm font-medium text-ink">{p.name}</span>
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

function Lobby({ room, url, onStart, busy }: { room: RoomInfo; url: string; onStart: () => void; busy: boolean }) {
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
  const names = new Map(room.players.map((p) => [p.id, p.name]));
  const rows = scores !== null
    ? [...scores].sort((a, b) => a.rank - b.rank)
    // no scores yet: who has what, taken plants first
    : room.sites.filter((s) => s.playable).map((s) => ({ site: s.index, name: s.name, ownerName: s.owner === null ? null : names.get(s.owner) ?? null, profitUsd: NaN, rank: 0 }))
      .sort((a, b) => Number(b.ownerName !== null) - Number(a.ownerName !== null) || a.site - b.site);
  return (
    <section className="chamfer pointer-events-auto absolute right-4 top-16 z-30 w-[340px] p-3" style={CARD} data-testid="host-leaderboard">
      <div className="mb-1 flex items-baseline justify-between"><span className="label">Leaderboard</span><span className="text-xs text-muted">{scores !== null ? 'profit so far' : 'scores are not in yet'}</span></div>
      <ol className="max-h-[60vh] overflow-auto">
        {rows.map((r, i) => (
          <li key={r.site} className="border-t border-line first:border-t-0">
            <button className="flex w-full cursor-pointer items-center gap-2 py-1 text-left hover:bg-panel-2" onClick={() => select({ kind: 'site', index: r.site })}>
              <span className="data w-5 shrink-0 text-right text-muted">{scores !== null ? r.rank || i + 1 : ''}</span>
              <SiteBadge preset={world?.sites[r.site]?.preset ?? ''} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm font-medium text-ink">{r.ownerName ?? 'Nobody'}</span>
                <span className="block truncate text-xs text-muted">{r.name}</span>
              </span>
              <span className="data shrink-0 text-sm text-ink">{Number.isFinite(r.profitUsd) ? fmtMoney(r.profitUsd) : '—'}</span>
            </button>
          </li>
        ))}
      </ol>
    </section>
  );
}

function HostBar({ room, send, busy }: { room: RoomInfo; send: (a: HostAction) => void; busy: boolean }) {
  const world = useSim((s) => s.world);
  const tick = useSim((s) => s.snap?.tick);
  const scenarios = useMemo(() => scenariosFor(world), [world]);
  const [fired, setFired] = useState<string[]>([]);
  const running = room.phase === 'running';
  return (
    <header className="absolute inset-x-0 top-0 z-[60] flex h-12 items-center gap-2 bg-panel px-4" data-testid="host-bar">
      <Mark />
      <span className="data ml-2 min-w-28 rounded-sm bg-panel-2 px-2 py-1" data-testid="host-clock">{tick === undefined ? '—' : fmtClock(Number(tick))}</span>
      {room.phase === 'ended' ? <span className="text-sm text-muted">The simulation has ended.</span> : (
        <>
          <button className={`btn ${running ? 'btn-active' : 'btn-primary'}`} onClick={() => send({ action: running ? 'pause' : 'resume' })} disabled={busy} data-testid="host-pause">{running ? '⏸ Pause' : '▶ Resume'}</button>
          <span className="ml-1 text-xs text-muted">Speed</span>
          {SPEEDS.map((v) => (
            <button key={v} className={`btn ${Math.abs(room.speed - v) < 1e-6 ? 'btn-active' : ''}`} aria-pressed={Math.abs(room.speed - v) < 1e-6} onClick={() => send({ action: 'speed', speed: v })} data-testid={`host-speed-${v}`}>{v}</button>
          ))}
          <DropdownMenu
            label="Scenario"
            items={scenarios.map((s) => ({ key: s.key, label: s.label, checked: fired.includes(s.key), disabled: fired.includes(s.key) }))}
            onPick={(key) => { const s = scenarios.find((x) => x.key === key); if (s !== undefined) { send({ action: 'scenario', command: s.command }); setFired((f) => [...f, key]); } }}
            testId="host-scenario"
          />
        </>
      )}
      <span className="ml-auto text-xs text-muted">{room.players.length} player{room.players.length === 1 ? '' : 's'}</span>
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
      {room !== null && room.phase !== 'lobby' && <HostBar room={room} send={send} busy={busy} />}
      {room !== null && room.phase === 'lobby' && <Lobby room={room} url={url} onStart={() => send({ action: 'start' })} busy={busy} />}
      {room !== null && room.phase !== 'lobby' && <Leaderboard source={source} room={room} />}
      {room !== null && room.phase !== 'lobby' && (
        <section className="chamfer chamfer-sm absolute bottom-4 left-4 z-30 flex items-center gap-3 p-2.5" style={CARD} data-testid="host-corner">
          <Qr text={url} size={104} />
          <div>
            <div className="label">Join</div>
            <div className="font-display text-3xl font-extrabold leading-none tracking-[0.1em]">{room.code}</div>
            <div className="mt-1 max-w-[150px] break-all text-[10px] leading-tight text-muted">{url.replace(/^https?:\/\//, '')}</div>
          </div>
        </section>
      )}
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
