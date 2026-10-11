// The player's phone screen at /play/?room=CODE (MULTIPLAYER-CONTRACT.md).
//
// Three screens in one frame: give a name; pick a plant in the lobby; then
// run that plant — its price, its rate and its units — and watch what that
// does to its profit and its rank. The frame is a top bar (the mark and one
// menu hexagon that holds everything else), the 3D map, and a bottom sheet
// with two heights: a peek that leaves the map usable, and open.
//
// Mobile first (360 x 740 and up, portrait); every touch target is at least
// 44 px tall. The map is the app's own SceneCanvas, fed by polling.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { SceneCanvas } from '../scene/SceneCanvas';
import { useSim } from '../store/sim';
import { SiteBadge } from '../ui/SiteIcon';
import { ownedName, playerColor } from '../store/roomTypes';
import { Sparkline } from '../ui/charts/Sparkline';
import { fmtMomentWords } from '../ui/format';
import { eventLabel } from '../ui/eventKinds';
import {
  PRICE_MAX, PRICE_MIN, PRICE_STEP, fmtProfit, fmtSold, isHit, makesWords, minRate, myScore, othersWords, pctSigned, plantState,
  priceWords, rankWords, rateWords, roomCode, siteUnits,
} from './playLogic';
import { openRoom, roomSource } from '../store/room';
import { mockRoom, mockRoomWanted } from '../store/roomMock';
import type { RoomInfo, RoomPartner, RoomPartners } from '../store/roomTypes';
import { mePlayer, startScoresLoop, usePlay } from './playStore';

type Menu = 'leaderboard' | 'economy' | 'log' | 'how' | null;

/** A hexagon button tall enough for a thumb. */
const TOUCH = { '--hex-h': '44px', fontSize: 14 } as React.CSSProperties;

function Mark({ size = 22 }: { size?: number }) {
  return (
    <span className="flex items-center gap-2">
      <img src="/logo.svg" alt="" width={size} height={size} />
      <span className="wordmark text-base leading-none">Petro<span className="text-blue">Grid</span></span>
    </span>
  );
}

/** Screen 1: who are you? */
function NameScreen() {
  const join = usePlay((s) => s.join);
  const error = usePlay((s) => s.error);
  const code = usePlay((s) => s.code);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const ok = name.trim().length >= 1 && name.trim().length <= 20;
  const go = () => {
    if (!ok || busy) return;
    setBusy(true);
    void join(name).finally(() => setBusy(false));
  };
  return (
    <main className="flex h-full flex-col items-center justify-center gap-5 bg-white px-6" data-testid="play-name">
      <Mark size={34} />
      <h1 className="wordmark text-2xl text-ink">Join the simulation</h1>
      <p className="text-sm text-muted">Session <span className="data text-ink">{code}</span>. You will run one chemical plant.</p>
      <form className="flex w-full max-w-xs flex-col gap-3" onSubmit={(e) => { e.preventDefault(); go(); }}>
        <label className="flex flex-col gap-1 text-sm text-ink" htmlFor="play-name-input">
          Your name
          <input
            id="play-name-input"
            name="name"
            className="field h-12 px-3 text-base"
            value={name}
            maxLength={20}
            autoComplete="nickname"
            autoFocus
            onChange={(e) => setName(e.target.value)}
            data-testid="play-name-input"
          />
        </label>
        <button type="submit" className="btn btn-primary btn-lg" disabled={!ok || busy} data-testid="play-join">
          {busy ? 'Joining…' : 'Join'}
        </button>
        {error !== null && <p className="text-sm text-alarm" role="alert">{error}</p>}
      </form>
    </main>
  );
}

/** The bottom sheet: a peek that leaves the map usable, or open. */
function Sheet({ open, onToggle, peek, children }: { open: boolean; onToggle: () => void; peek: ReactNode; children: ReactNode }) {
  return (
    <section
      className="relative z-10 flex shrink-0 flex-col border-t border-line bg-panel"
      style={{ maxHeight: open ? '58dvh' : undefined }}
      data-testid="play-sheet"
      data-open={open}
    >
      <button
        type="button"
        className="flex min-h-[44px] w-full cursor-pointer items-center gap-3 px-4 py-2 text-left"
        onClick={onToggle}
        aria-expanded={open}
        data-testid="play-sheet-toggle"
      >
        <span className="min-w-0 flex-1">{peek}</span>
        <span aria-hidden="true" className="text-xs text-muted">{open ? '▼' : '▲'}</span>
      </button>
      {open && <div className="scroll-steady min-h-0 flex-1 overflow-auto px-4 pb-4">{children}</div>}
    </section>
  );
}

/** Screen 2: pick a plant. One tap on the map or the list asks, in that row, to confirm. */
function LobbySheet({ room }: { room: RoomInfo }) {
  const world = useSim((s) => s.world);
  const selected = useSim((s) => s.selected);
  const select = useSim((s) => s.select);
  const seat = usePlay((s) => s.seat);
  const claim = usePlay((s) => s.claim);
  const error = usePlay((s) => s.error);
  const me = room.players.find((p) => p.id === seat?.playerId) ?? null;
  const [open, setOpen] = useState(true);
  const [busy, setBusy] = useState(false);
  const nameOf = (id: string | null) => room.players.find((p) => p.id === id)?.name ?? 'someone';
  const asked = selected !== null && selected.kind === 'site' ? selected.index : null;
  const mine = me?.site ?? null;
  const mySite = room.sites.find((s) => s.index === mine);
  const plants = room.sites.filter((s) => s.playable);
  const free = plants.filter((s) => s.owner === null).length;
  const askedRow = useRef<HTMLLIElement | null>(null);
  // a tap on the map opens the sheet at that plant's row
  useEffect(() => {
    if (asked === null || mine !== null) return;
    setOpen(true);
    askedRow.current?.scrollIntoView({ block: 'nearest' });
  }, [asked, mine]);

  const take = (site: number | null) => {
    setBusy(true);
    void claim(site).finally(() => { setBusy(false); select(null); });
  };

  if (mySite !== undefined && world !== null) {
    return (
      <section className="relative z-10 shrink-0 border-t-2 border-blue bg-panel px-4 py-4" data-testid="play-chosen">
        <div className="label text-blue-strong">Your plant</div>
        <div className="mt-2 flex items-center gap-3">
          <SiteBadge preset={mySite.preset} icon={28} />
          <div className="min-w-0 flex-1">
            <div className="text-xl font-semibold leading-tight" style={{ color: playerColor(room, me?.id ?? null) ?? undefined }}>{ownedName(me?.name, mySite.name)}</div>
            <div className="text-xs text-muted">{makesWords(world, mySite.index)}</div>
          </div>
        </div>
        <p className="mt-3 text-sm text-ink" role="status">
          <span className="font-semibold">You are in.</span> {room.phase === 'lobby' ? 'Waiting for the host to start.' : 'Starting…'} {othersWords(room, me?.id ?? null)}
        </p>
        {room.phase === 'lobby' && (
          <button type="button" className="btn mt-3" style={TOUCH} onClick={() => take(null)} disabled={busy} data-testid="play-release">
            {busy ? 'One moment…' : 'Change plant'}
          </button>
        )}
        {error !== null && <p className="mt-2 text-sm text-alarm" role="alert">{error}</p>}
      </section>
    );
  }

  return (
    <Sheet
      open={open}
      onToggle={() => setOpen(!open)}
      peek={<span className="text-sm font-semibold text-ink">Pick a plant <span className="font-normal text-muted">· {free} free · tap one</span></span>}
    >
      {error !== null && <p className="mb-2 text-sm text-alarm" role="alert">{error}</p>}
      <ul className="divide-y divide-line" data-testid="play-free">
        {plants.map((s) => {
          const taken = s.owner !== null;
          const asking = asked === s.index && !taken;
          return (
            <li key={s.index} ref={asked === s.index ? askedRow : undefined}>
              {asking ? (
                <div className="flex min-h-[56px] items-center gap-2 bg-blue-soft px-2 py-2" data-testid="play-confirm">
                  <SiteBadge preset={s.preset} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm font-semibold text-ink">Run {s.name}?</span>
                    {world !== null && <span className="block truncate text-xs text-muted">{makesWords(world, s.index)}</span>}
                  </span>
                  <button type="button" className="btn" style={TOUCH} onClick={() => select(null)} disabled={busy}>No</button>
                  <button type="button" className="btn btn-primary" style={TOUCH} onClick={() => take(s.index)} disabled={busy} data-testid="play-take">{busy ? 'Taking…' : 'Confirm'}</button>
                </div>
              ) : (
                <button
                  type="button"
                  className={`flex min-h-[44px] w-full items-center gap-2 px-2 text-left text-sm ${taken ? 'text-muted' : 'cursor-pointer text-ink'}`}
                  onClick={() => select({ kind: 'site', index: s.index })}
                  disabled={taken}
                >
                  <SiteBadge preset={s.preset} />
                  <span className="min-w-0 flex-1 truncate" style={taken ? { color: playerColor(room, s.owner) ?? undefined, fontWeight: 600 } : undefined} data-testid={taken ? 'play-taken' : undefined}>{taken ? ownedName(nameOf(s.owner), s.name) : s.name}</span>
                </button>
              )}
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

/** Who my plant sells to and buys from, each with a switch to cut them off. */
function Trading({ site }: { site: number }) {
  const source = usePlay((s) => s.source);
  const setBlock = usePlay((s) => s.setBlock);
  const [partners, setPartners] = useState<RoomPartners | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  useEffect(() => {
    if (source === null) return undefined;
    let stop = false;
    const load = () => source.partners(site).then((p) => { if (!stop) setPartners(p); }).catch(() => undefined);
    load();
    const t = setInterval(load, 5000);
    return () => { stop = true; clearInterval(t); };
  }, [source, site]);
  if (partners === null || partners.buyers.length + partners.suppliers.length === 0) return null;
  const flip = (direction: 'sell' | 'buy', p: RoomPartner) => {
    setBusy(`${direction}${p.site}`);
    void setBlock(p.site, direction, !p.blocked)
      .then(() => source?.partners(site)).then((next) => { if (next) setPartners(next); })
      .finally(() => setBusy(null));
  };
  const rows = (title: string, direction: 'sell' | 'buy', list: RoomPartner[]) => list.length === 0 ? null : (
    <>
      <div className="label mb-1 mt-3">{title}</div>
      <ul className="divide-y divide-line">
        {list.map((p) => (
          <li key={p.site} className="flex min-h-[52px] items-center gap-2 py-1">
            <span className="min-w-0 flex-1">
              <span className={`block truncate text-sm ${p.blocked ? 'text-alarm line-through' : 'text-ink'}`}>{p.name}</span>
              <span className="block truncate text-xs text-muted">{p.blocked ? 'cut off' : p.materials.join(', ')}</span>
            </span>
            <button type="button" className={`btn ${p.blocked ? '' : 'btn-danger'}`} style={TOUCH} disabled={busy !== null} onClick={() => flip(direction, p)} data-testid={`play-block-${direction}-${p.site}`}>
              {busy === `${direction}${p.site}` ? '…' : p.blocked ? 'Resume' : direction === 'sell' ? 'Stop selling' : 'Stop buying'}
            </button>
          </li>
        ))}
      </ul>
    </>
  );
  return (
    <div data-testid="play-trading">
      {rows('You sell to', 'sell', partners.buyers)}
      {rows('You buy from', 'buy', partners.suppliers)}
    </div>
  );
}

function Slider({ id, label, value, min, max, step, shown, words, onChange }: {
  id: string; label: string; value: number; min: number; max: number; step: number; shown: string; words: string; onChange: (v: number) => void;
}) {
  return (
    <div className="py-2">
      <label className="flex items-baseline justify-between text-sm text-ink" htmlFor={id}>
        <span className="font-semibold">{label}</span>
        <span className="data text-base" data-testid={`${id}-value`}>{shown}</span>
      </label>
      <input
        id={id}
        name={id}
        type="range"
        className="h-11 w-full accent-[var(--blue)]"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        data-testid={id}
      />
      <p className="text-xs text-muted" data-testid={`${id}-words`}>{words}</p>
    </div>
  );
}

/** Screen 3: your plant. */
function PlantSheet({ room, site }: { room: RoomInfo; site: number }) {
  const world = useSim((s) => s.world);
  const snap = useSim((s) => s.snap);
  const scores = usePlay((s) => s.scores);
  const trend = usePlay((s) => s.profitTrend);
  const pending = usePlay((s) => s.pending);
  const sending = usePlay((s) => s.sending);
  const confirmedAt = usePlay((s) => s.confirmedAt);
  const error = usePlay((s) => s.error);
  const { setPrice, setRate, setUnit } = usePlay.getState();
  const [open, setOpen] = useState(true);
  const { score, of } = myScore(scores, site);
  // what the slider shows: the player's own last setting until the server's figure catches up
  const [markup, setMarkup] = useState<number | null>(null);
  const [share, setShare] = useState<number | null>(null);
  const units = useMemo(() => (world === null ? [] : siteUnits(world, site)), [world, site]);
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 500); // keeps "saved" fresh
    return () => clearInterval(t);
  }, []);
  if (world === null) return null;
  const spec = room.sites.find((s) => s.index === site);
  const state = plantState(snap, site);
  const low = minRate(world, site);
  const m = markup ?? score?.markup ?? 0;
  const r = share ?? score?.rateShare ?? 1;
  const waiting = sending || Object.keys(pending).length > 0;
  const saved = confirmedAt !== null && performance.now() - confirmedAt < 4000;

  return (
    <Sheet
      open={open}
      onToggle={() => setOpen(!open)}
      peek={(
        <span className="flex items-center gap-3">
          <SiteBadge preset={spec?.preset ?? ''} icon={22} down={state.alarm} />
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm font-semibold leading-tight text-ink" data-testid="play-plant-name">{spec?.name ?? 'Your plant'}</span>
            <span className="block text-xs leading-tight" style={{ color: state.alarm ? 'var(--alarm)' : 'var(--muted)' }}>{state.text}</span>
          </span>
          <span className="text-right">
            <span className="data block text-lg font-semibold leading-tight text-ink" data-testid="play-profit">{score === null ? '—' : fmtProfit(score.profitUsd)}</span>
            <span className="block text-xs leading-tight text-muted" data-testid="play-rank">{score === null ? 'no rank yet' : rankWords(score.rank, of)}</span>
          </span>
        </span>
      )}
    >
      <div className="mb-2 flex items-end justify-between gap-3">
        <div>
          <div className="label">Profit so far</div>
          <div className="text-4xl font-semibold leading-none text-ink">{score === null ? '—' : fmtProfit(score.profitUsd)}</div>
          <div className="mt-1 text-xs text-muted">{score === null ? '' : `${fmtSold(score.soldT)} sold · ${rankWords(score.rank, of)}`}</div>
        </div>
        <Sparkline values={trend} width={120} height={36} color="#1764d6" />
      </div>

      <p className="min-h-[18px] text-xs" role="status" data-testid="play-saved" style={{ color: error !== null ? 'var(--alarm)' : 'var(--muted)' }}>
        {error !== null ? error : waiting ? 'Sending…' : saved ? 'Saved: your settings are in.' : room.phase === 'lobby' ? 'Settings take effect when the host starts.' : ''}
      </p>

      <Slider
        id="play-price"
        label="Price"
        value={m}
        min={PRICE_MIN}
        max={PRICE_MAX}
        step={PRICE_STEP}
        shown={pctSigned(m)}
        words={priceWords(m)}
        onChange={(v) => { setMarkup(v); setPrice(Math.round(v * 100) / 100); }}
      />
      <Slider
        id="play-rate"
        label="Rate"
        value={r}
        min={low}
        max={1}
        step={0.05}
        shown={`${Math.round(r * 100)}%`}
        words={rateWords(r, low)}
        onChange={(v) => { setShare(v); setRate(Math.round(v * 100) / 100); }}
      />

      <Trading site={site} />

      <div className="label mb-1 mt-2">Units</div>
      <ul className="divide-y divide-line" data-testid="play-units">
        {units.map((u) => {
          const online = snap?.unitTrains[u.index] ?? u.trains;
          const down = online <= 0;
          return (
            <li key={u.index} className="flex min-h-[52px] items-center gap-2 py-1">
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{u.name}</span>
                <span className="block text-xs" style={{ color: down ? 'var(--alarm)' : 'var(--muted)' }}>{down ? 'down' : `running · ${u.process}`}</span>
              </span>
              <button
                type="button"
                className={`btn ${down ? 'btn-primary' : 'btn-danger'}`}
                style={TOUCH}
                onClick={() => void setUnit(u.index, !down)}
                data-testid={`play-unit-${u.index}`}
              >
                {down ? 'Bring back' : 'Take down'}
              </button>
            </li>
          );
        })}
      </ul>
    </Sheet>
  );
}

function Panel({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  return (
    <div className="absolute inset-0 z-40 flex flex-col bg-panel" role="dialog" aria-label={title} data-testid="play-panel">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-line px-4">
        <h2 className="label">{title}</h2>
        <button type="button" className="btn" style={TOUCH} onClick={onClose} data-testid="play-panel-close">Close</button>
      </header>
      <div className="scroll-steady min-h-0 flex-1 overflow-auto p-4">{children}</div>
    </div>
  );
}

function Leaderboard({ mySite }: { mySite: number | null }) {
  const scores = usePlay((s) => s.scores);
  const room = useSim((s) => s.room);
  const [board, setBoard] = useState<'profit' | 'damage'>('profit');
  if (scores.length === 0) return <p className="text-sm text-muted">No scores yet: they start when the host starts the clock.</p>;
  const rows = board === 'profit'
    ? [...scores].sort((a, b) => b.profitUsd - a.profitUsd)
    : scores.filter((s) => s.owner !== null).sort((a, b) => (b.damageUsd ?? 0) - (a.damageUsd ?? 0));
  return (
    <div>
      <div className="mb-3 flex gap-2" role="tablist">
        {([['profit', 'Profit'], ['damage', 'Damage to economy']] as const).map(([key, label]) => (
          <button key={key} type="button" role="tab" aria-selected={board === key} className={`btn ${board === key ? 'btn-active' : ''}`} style={TOUCH} onClick={() => setBoard(key)} data-testid={`play-board-${key}`}>{label}</button>
        ))}
      </div>
      {board === 'damage' && <p className="mb-2 text-xs text-muted">Sales customers lost because of what each player did, compared with the same run without them.</p>}
      {rows.length === 0 && <p className="text-sm text-muted">Nobody has taken a plant yet.</p>}
      <ol className="divide-y divide-line" data-testid="play-leaderboard">
        {rows.map((s, i) => (
          <li key={s.site} className={`flex min-h-[44px] items-center gap-3 px-1 text-sm ${s.site === mySite ? 'bg-blue-soft' : ''}`}>
            <span className="data w-7 text-muted">{i + 1}</span>
            <span className="min-w-0 flex-1 truncate font-semibold" style={{ color: playerColor(room, s.owner) ?? undefined }}>
              {s.owner !== null ? ownedName(s.ownerName, s.name) : <span className="font-normal text-muted">{s.name}</span>}
            </span>
            <span className={`data font-semibold ${board === 'damage' ? 'text-alarm' : 'text-ink'}`}>{fmtProfit(board === 'damage' ? s.damageUsd ?? 0 : s.profitUsd)}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/** The economy on a phone, from what a room reports: read-only. */
function EconomyOverview({ room }: { room: RoomInfo }) {
  const scores = usePlay((s) => s.scores);
  const snap = useSim((s) => s.snap);
  const total = (f: (s: (typeof scores)[number]) => number) => scores.reduce((a, s) => a + f(s), 0);
  const running = room.sites.filter((s) => s.playable && ![3, 4].includes(snap?.siteStatus[s.index] ?? 0)).length;
  const playable = room.sites.filter((s) => s.playable).length;
  const top = [...scores].sort((a, b) => b.markup - a.markup).filter((s) => Math.abs(s.markup) > 0.001).slice(0, 4);
  const Tile = ({ label, value, note }: { label: string; value: string; note: string }) => (
    <div className="chamfer chamfer-sm p-3" style={{ '--chamfer-fill': 'var(--white)' } as React.CSSProperties}>
      <div className="label">{label}</div>
      <div className="text-2xl font-semibold leading-tight text-ink">{value}</div>
      <div className="text-xs text-muted">{note}</div>
    </div>
  );
  return (
    <div className="flex flex-col gap-3" data-testid="play-economy">
      <Tile label="Plants running" value={`${running} of ${playable}`} note="not shut down or restarting" />
      <Tile label="Sold so far" value={fmtSold(total((s) => s.soldT))} note={`worth ${fmtProfit(total((s) => s.revenueUsd))} across every plant`} />
      <Tile label="Profit so far" value={fmtProfit(total((s) => s.profitUsd))} note="every plant together" />
      <Tile label="Spent" value={fmtProfit(total((s) => s.feedUsd + s.freightUsd + s.energyUsd))} note={`feed ${fmtProfit(total((s) => s.feedUsd))} · freight ${fmtProfit(total((s) => s.freightUsd))} · energy ${fmtProfit(total((s) => s.energyUsd))}`} />
      <div className="chamfer chamfer-sm p-3" style={{ '--chamfer-fill': 'var(--white)' } as React.CSSProperties}>
        <div className="label mb-1">Prices set by players</div>
        {top.length === 0
          ? <p className="text-sm text-muted">Everyone is selling at the going rate.</p>
          : top.map((s) => (
            <div key={s.site} className="flex justify-between text-sm text-ink"><span className="truncate">{s.name}</span><span className="data">{pctSigned(s.markup)}</span></div>
          ))}
      </div>
    </div>
  );
}

function LogList() {
  const events = useSim((s) => s.events);
  const notable = events.filter((e) => e.type !== 'dispatch' && e.type !== 'delivered').slice(-60).reverse();
  if (notable.length === 0) return <p className="text-sm text-muted">Nothing has happened yet.</p>;
  return (
    <ul className="divide-y divide-line" data-testid="play-log">
      {notable.map((e) => (
        <li key={e.seq} className="py-2 text-sm">
          <div className="flex justify-between text-xs text-muted"><span className="label">{eventLabel(e)}</span><span>{fmtMomentWords(e.tick)}</span></div>
          <div className="text-ink">{e.text}</div>
        </li>
      ))}
    </ul>
  );
}

const HOW = [
  'You run one plant. Everyone else runs theirs; the rest run themselves.',
  'Price: ask more and you earn more per tonne but sell less. Ask less and you sell more.',
  'Rate: make less and you buy less feed. Units can be taken down and brought back.',
  'Trading: stop selling to one buyer, or stop buying from one supplier, and watch what it does to them.',
  'The host runs the clock and sets off trouble. There are two boards: most profit, and most damage to the economy.',
];

export function PlayApp() {
  const code = useMemo(() => roomCode(window.location), []);
  const open = usePlay((s) => s.open);
  const seat = usePlay((s) => s.seat);
  const room = useSim((s) => s.room);
  const roomError = useSim((s) => s.error);
  const events = useSim((s) => s.events);
  const leave = usePlay((s) => s.leave);
  const ownDown = usePlay((s) => s.ownDown);
  const [menuOpen, setMenuOpen] = useState(false);
  const [menu, setMenu] = useState<Menu>(null);
  const [seenHit, setSeenHit] = useState(-1);

  useEffect(() => {
    if (code === null) return undefined;
    // the room mode of the app does the watching; `?mockroom` swaps in its stand-in room
    const source = mockRoomWanted() ? mockRoom(code) : roomSource(code);
    open(code, source);
    const stopRoom = openRoom(code, source);
    const stopScores = startScoresLoop();
    return () => { stopScores(); stopRoom(); };
  }, [code, open]);

  const me = mePlayer(room, seat);
  // tell the scene which plant is mine: its label says "yours"
  const mySiteNow = me?.site ?? null;
  useEffect(() => { useSim.getState().setMySite(mySiteNow); }, [mySiteNow]);
  // a seat the room no longer knows (the game was restarted): ask the name again
  useEffect(() => {
    if (room !== null && seat !== null && me === null) leave();
  }, [room, seat, me, leave]);

  if (code === null) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-4 bg-white px-6 text-center" data-testid="play-no-room">
        <Mark size={34} />
        <p className="text-sm text-ink">Scan the code on the big screen to join the simulation.</p>
      </main>
    );
  }
  const gone = room === null && roomError !== null && /no game|has ended/i.test(roomError);
  if (gone) {
    return (
      <main className="flex h-full flex-col items-center justify-center gap-4 bg-white px-6 text-center" data-testid="play-gone">
        <Mark size={34} />
        <h1 className="wordmark text-xl text-ink">This simulation has ended</h1>
        <p className="text-sm text-muted">Scan the code on the big screen to join the next one.</p>
      </main>
    );
  }
  if (seat === null) return <NameScreen />;

  const mySite = me?.site ?? null;
  const playing = room !== null && room.phase !== 'lobby' && mySite !== null;
  // trouble at my plant that I did not cause myself
  const hit = mySite === null ? undefined : [...events].reverse().find((e) => e.site === mySite && isHit(e.type) && !(ownDown.length > 0 && (e.type === 'unit_failed' || e.type === 'process_shutdown')));
  const banner = room?.phase === 'paused'
    ? 'Paused by the host'
    : room?.phase === 'ended'
      ? 'The simulation is over'
      : hit !== undefined && hit.seq > seenHit
        ? `Your plant: ${hit.text}`
        : null;

  return (
    <div className="relative flex h-full flex-col overflow-hidden bg-white" data-testid="play-app" data-phase={room?.phase ?? 'loading'}>
      <header className="relative z-30 flex h-12 shrink-0 items-center justify-between border-b border-line bg-panel px-3">
        <Mark />
        <div className="relative">
          <button type="button" className={`btn ${menuOpen ? 'btn-active' : ''}`} style={TOUCH} onClick={() => setMenuOpen(!menuOpen)} aria-haspopup="menu" aria-expanded={menuOpen} data-testid="play-menu">
            Menu <span aria-hidden="true" className="ml-2 text-[9px]">{menuOpen ? '▲' : '▼'}</span>
          </button>
          {menuOpen && (
            <ul className="chamfer chamfer-sm absolute right-0 top-12 z-50 w-56 py-1" role="menu" data-testid="play-menu-list">
              {([['leaderboard', 'Leaderboard'], ['economy', 'Economy overview'], ['log', 'Log'], ['how', 'How to play']] as const).map(([key, label]) => (
                <li key={key} role="none">
                  <button type="button" role="menuitem" className="menu-item flex min-h-[44px] w-full items-center px-3 text-left text-sm" onClick={() => { setMenu(key); setMenuOpen(false); }} data-testid={`play-menu-${key}`}>{label}</button>
                </li>
              ))}
              <li role="none">
                <button type="button" role="menuitem" className="menu-item flex min-h-[44px] w-full items-center px-3 text-left text-sm text-alarm" onClick={() => { setMenuOpen(false); leave(); }} data-testid="play-menu-leave">Leave</button>
              </li>
            </ul>
          )}
        </div>
      </header>

      {banner !== null && (
        <button
          type="button"
          className={`relative z-20 min-h-[36px] w-full px-4 py-2 text-left text-sm font-medium ${room?.phase === 'paused' || room?.phase === 'ended' ? 'bg-blue-soft text-blue-strong' : 'bg-alarm text-white'}`}
          onClick={() => hit !== undefined && setSeenHit(hit.seq)}
          role="status"
          data-testid="play-banner"
        >
          {banner}
        </button>
      )}

      {/* the map: the upper part of the screen, usable above the sheet */}
      <div className="relative min-h-0 flex-1" data-testid="play-map">
        <SceneCanvas />
      </div>

      {room === null
        ? <div className="shrink-0 border-t border-line bg-panel px-4 py-4 text-sm text-muted" role="status">{roomError ?? 'Finding the simulation…'}</div>
        : playing && mySite !== null
          ? <PlantSheet room={room} site={mySite} />
          : room.phase !== 'lobby' && mySite === null
            ? <LobbySheet room={room} />
            : <LobbySheet room={room} />}

      {menu === 'leaderboard' && <Panel title="Leaderboard" onClose={() => setMenu(null)}><Leaderboard mySite={mySite} /></Panel>}
      {menu === 'economy' && room !== null && <Panel title="Economy overview" onClose={() => setMenu(null)}><EconomyOverview room={room} /></Panel>}
      {menu === 'log' && <Panel title="Log" onClose={() => setMenu(null)}><LogList /></Panel>}
      {menu === 'how' && (
        <Panel title="How to play" onClose={() => setMenu(null)}>
          <ol className="flex list-decimal flex-col gap-3 pl-5 text-sm text-ink" data-testid="play-how">{HOW.map((line) => <li key={line}>{line}</li>)}</ol>
        </Panel>
      )}
    </div>
  );
}
