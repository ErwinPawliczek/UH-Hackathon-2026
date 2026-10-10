// M0 web shell: static template layout on canvas, stub data playing at fixed
// time steps, tank inspector wired to the decoded snapshot. The three.js
// scene replaces the canvas at M5 with no state-layer changes.

import { useEffect, useRef, useState } from 'react';
import { decode, type Snapshot } from './engine/snapshot';
import { encodeStub, MAP_H, MAP_W } from './engine/stub';

/** Static M0 layout, shared with the native stub (S7.1 world schema). */
const SITES = [
  { name: 'Oil Field', x: 120, y: 260 },
  { name: 'Refinery', x: 260, y: 210 },
  { name: 'Steam Cracker', x: 340, y: 150 },
  { name: 'Port Terminal', x: 480, y: 90 },
];
const EDGES = [
  [0, 1], [1, 2], [2, 3], [0, 2], [1, 3],
] as const;
const TANKS = Array.from({ length: 8 }, (_, i) => ({
  site: i % 4,
  material: ['CRUDE', 'NAPHTHA', 'GASOLINE', 'DIESEL', 'JET', 'ETHYLENE', 'PE', 'PVC'][i],
}));

const TICKS_PER_DAY = 96;
const SPEEDS = [4, 16, 64];

function fmtTick(tick: number): string {
  const day = Math.floor(tick / TICKS_PER_DAY) + 1;
  const hour = ((tick % TICKS_PER_DAY) / 4).toFixed(2).padStart(5, '0');
  return `Day ${day} ${hour.slice(0, 2)}:${hour.slice(3)} h`;
}

function MapCanvas({ snap }: { snap: Snapshot | null }) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = MAP_W * dpr;
    canvas.height = MAP_H * dpr;
    ctx.scale(dpr, dpr);

    // water + land
    ctx.fillStyle = '#dbeafe';
    ctx.fillRect(0, 0, MAP_W, MAP_H);
    ctx.fillStyle = '#d1e7d8';
    ctx.beginPath();
    ctx.ellipse(MAP_W / 2, MAP_H / 2, MAP_W * 0.44, MAP_H * 0.42, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = '#93c5a8';
    ctx.stroke();

    // edges
    for (const [a, b] of EDGES) {
      ctx.strokeStyle = '#b45309';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(SITES[a].x, SITES[a].y);
      ctx.lineTo(SITES[b].x, SITES[b].y);
      ctx.stroke();
    }

    // sites
    for (const s of SITES) {
      ctx.fillStyle = '#7c2d12';
      ctx.beginPath();
      ctx.arc(s.x, s.y, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#1c1917';
      ctx.font = '12px sans-serif';
      ctx.fillText(s.name, s.x + 10, s.y - 8);
    }

    // vehicles
    if (snap !== null) {
      for (let v = 0; v < snap.nVeh; v++) {
        const x = snap.vehPos[5 * v];
        const y = snap.vehPos[5 * v + 1];
        const fill = snap.vehPos[5 * v + 4];
        ctx.fillStyle = '#0e7490';
        ctx.fillRect(x - 4, y - 3, 8, 6);
        ctx.fillStyle = fill > 0.5 ? '#0891b2' : '#f59e0b';
        ctx.fillRect(x - 4, y - 5, 8 * fill, 2);
      }
    }
  }, [snap]);

  return (
    <canvas
      ref={ref}
      style={{ width: '100%', maxWidth: MAP_W, aspectRatio: '3 / 2', border: '1px solid #ccc' }}
      aria-label="Map"
    />
  );
}

export default function App() {
  const [tick, setTick] = useState(0);
  const [speed, setSpeed] = useState(16);
  const [playing, setPlaying] = useState(true);
  const [selected, setSelected] = useState(0);
  const [snap, setSnap] = useState<Snapshot | null>(null);

  // Fixed-step playback: the frame encodes a stub snapshot at the sim tick —
  // the exact shape of the wasm path (engine step, snapshot, decode).
  useEffect(() => {
    if (!playing) return;
    const id = setInterval(() => {
      setTick((t) => t + speed);
    }, 250);
    return () => clearInterval(id);
  }, [playing, speed]);

  useEffect(() => {
    try {
      setSnap(decode(encodeStub(42, tick)));
    } catch {
      setSnap(null);
    }
  }, [tick]);

  const tank = snap !== null ? Array.from(snap.tanks.slice(4 * selected, 4 * selected + 4)) : null;
  const urgency = snap !== null ? Array.from(snap.siteUrgency) : null;

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', padding: 16, maxWidth: MAP_W }}>
      <h1 style={{ fontSize: 22, margin: '0 0 4px' }}>Chain Reaction — M0 shell</h1>
      <p style={{ color: '#666', margin: '0 0 12px', fontSize: 14 }}>
        Stub data through the real snapshot contract. {snap === null ? 'decoding…' : `tick ${snap.tick}`}
      </p>
      <MapCanvas snap={snap} />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '12px 0' }}>
        <button onClick={() => setPlaying((p) => !p)}>{playing ? 'Pause' : 'Play'}</button>
        {SPEEDS.map((s) => (
          <button
            key={s}
            onClick={() => setSpeed(s)}
            style={{ fontWeight: speed === s ? 'bold' : 'normal' }}
          >
            {s}×
          </button>
        ))}
        <span style={{ fontSize: 14 }}>{fmtTick(tick)}</span>
      </div>
      <div style={{ display: 'flex', gap: 16, fontSize: 14 }}>
        <div>
          <h2 style={{ fontSize: 15, margin: '0 0 6px' }}>Site urgency</h2>
          {SITES.map((s, i) => (
            <div key={s.name}>
              {s.name}: {urgency === null ? '–' : urgency[i].toFixed(2)}
            </div>
          ))}
        </div>
        <div>
          <h2 style={{ fontSize: 15, margin: '0 0 6px' }}>Tank {selected} — {TANKS[selected].material}</h2>
          <select value={selected} onChange={(e) => setSelected(Number(e.target.value))}>
            {TANKS.map((t, i) => (
              <option key={i} value={i}>
                Tank {i} — {t.material}
              </option>
            ))}
          </select>
          {tank !== null && (
            <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
              <li>fill {tank[0].toFixed(2)}</li>
              <li>to-full hours {tank[1].toFixed(2)}</li>
              <li>to-empty hours {tank[2].toFixed(2)}</li>
              <li>hot-hour fraction {tank[3].toFixed(2)}</li>
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}
