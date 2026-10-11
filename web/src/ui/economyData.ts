// Data behind the Economy window: fetching it from the live session, and
// turning the engine's numbers into the sentences and figures the window
// shows. Kept apart from the React components so it can be tested on its own.

import { useEffect, useRef, useState } from 'react';
import type { ForecastReply, SimBackend } from '../engine/api';
import { sessionRequest } from '../store/engineSession';
import { useSim } from '../store/sim';

export const TICKS_PER_DAY = 96;

/** "$5.8 M", "$207 K", "$815", "-$34 K": compact dollars with a thin space before the unit. */
export function fmtMoney(usd: number): string {
  const sign = usd < 0 ? '-' : '';
  const v = Math.abs(usd);
  if (v >= 999_500) return `${sign}$${trim(v / 1e6, v >= 99_950_000 ? 0 : 1)} M`;
  if (v >= 9_995) return `${sign}$${Math.round(v / 1e3)} K`;
  if (v >= 1_000) return `${sign}$${trim(v / 1e3, 1)} K`;
  return `${sign}$${Math.round(v)}`;
}

function trim(v: number, digits: number): string {
  return v.toFixed(digits).replace(/\.0$/, '');
}

/** "12,400 t", "173 t", "8.5 t". */
export function fmtTonnes(t: number): string {
  const v = Math.abs(t);
  return `${v >= 100 ? Math.round(t).toLocaleString('en-US') : Math.round(t * 10) / 10} t`;
}

/** Hours as words: "15 minutes", "3 hours", "6 days 18 hours", "2 days". */
export function fmtDuration(hours: number): string {
  const h = Math.max(0, hours);
  if (h < 1) {
    const m = Math.max(1, Math.round(h * 60));
    return `${m} minute${m === 1 ? '' : 's'}`;
  }
  const whole = Math.round(h);
  const days = Math.floor(whole / 24);
  const rest = whole % 24;
  const d = `${days} day${days === 1 ? '' : 's'}`;
  const r = `${rest} hour${rest === 1 ? '' : 's'}`;
  if (days === 0) return r;
  return rest === 0 ? d : `${d} ${r}`;
}

/** One line of the cost breakdown: what it is, in plain words, and what it adds to the total. */
export interface CostPart {
  key: 'lost_sales' | 'stock' | 'energy' | 'freight';
  label: string;
  note: string;
  /** dollars this adds to the cost (negative = it offsets the cost) */
  usd: number;
}

/**
 * The forecast's cost, itemised. The parts add up to `delta.cost_usd`: sales
 * lost to unmet demand, plus stock that will have been run down (or minus
 * stock built up), plus the change in energy and freight bills.
 */
export function costParts(f: ForecastReply): CostPart[] {
  const d = f.delta;
  const stock = -d.inventory_usd;
  return [
    {
      key: 'lost_sales',
      label: 'Lost sales',
      note: d.unmet_t > 0.5 ? `customers go without ${fmtTonnes(d.unmet_t)} they ordered` : 'every customer still gets what it ordered',
      usd: d.unmet_usd,
    },
    {
      key: 'stock',
      label: stock >= 0 ? 'Stock run down' : 'Stock built up',
      note: stock >= 0 ? 'product that will not be in the tanks at the end' : 'product left sitting in the tanks at the end',
      usd: stock,
    },
    {
      key: 'energy',
      label: d.energy_usd <= 0 ? 'Energy not used' : 'Extra energy',
      note: d.energy_usd <= 0 ? 'stopped plants burn no fuel' : 'plants running harder to catch up',
      usd: d.energy_usd,
    },
    {
      key: 'freight',
      label: d.freight_usd <= 0 ? 'Freight not run' : 'Extra freight',
      note: d.freight_usd <= 0 ? 'fewer loads to carry' : 'longer or more urgent deliveries',
      usd: d.freight_usd,
    },
  ];
}

/** True when the forecast says nothing is wrong: no disruption and no difference worth a dollar. */
export function nothingBroken(f: ForecastReply): boolean {
  return f.disruptions === 0 && Math.abs(f.delta.cost_usd) < 1 && f.countdown.length === 0;
}

/**
 * Material keys in plain words, as they read inside a sentence. (Local until
 * the shared ui/materials map lands; swap to that one then.)
 */
const MATERIAL_WORDS: Record<string, string> = {
  CRUDE: 'crude oil', RAW_GAS: 'raw gas', SALT: 'salt', METHANE: 'methane', ETHANE: 'ethane', LPG: 'LPG',
  NAPHTHA: 'naphtha', GASOLINE: 'gasoline', JET: 'jet fuel', DIESEL: 'diesel', FUEL_OIL: 'fuel oil',
  SOLVENT: 'solvent', BENZENE: 'benzene', ETHYLENE: 'ethylene', PROPYLENE: 'propylene', CHLORINE: 'chlorine',
  CAUSTIC: 'caustic soda', STYRENE: 'styrene', PE: 'polyethylene', PP: 'polypropylene', PVC: 'PVC', PS: 'polystyrene',
  VCM: 'vinyl chloride', HEAVY_NAPHTHA: 'heavy naphtha', GASOIL: 'gas oil', VGO: 'vacuum gas oil',
};

/** A material key as words: "FUEL_OIL" → "fuel oil"; an unknown key in lower case with spaces. */
export function materialWords(key: string): string {
  return MATERIAL_WORDS[key] ?? key.toLowerCase().replace(/_/g, ' ');
}

/** The same, to start a label: "Fuel oil", "LPG". */
export function materialTitle(key: string): string {
  const words = materialWords(key);
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** "Polyethylene shuts down in 6 days 18 hours" / "Gas grid runs dry of methane in 3 hours" / "… is already shut down". */
export function countdownSentence(row: ForecastReply['countdown'][number]): string {
  const dry = row.kind === 'runs_dry';
  const what = materialWords(row.what);
  if (row.already) return dry ? `${row.name} is already out of ${what}` : `${row.name} is already shut down`;
  const when = fmtDuration(row.hours_from_now);
  return dry ? `${row.name} runs dry of ${what} in ${when}` : `${row.name} shuts down in ${when}`;
}

export interface Polled<T> {
  data: T | null;
  /** why the last fetch failed, when it did */
  error: string | null;
  /** a fetch is in flight (the previous data stays on screen meanwhile) */
  loading: boolean;
}

/**
 * Data fetched from the live session while a panel is open. It is fetched
 * when the panel opens and again whenever `key` changes (callers fold into
 * it whatever should trigger a refresh: the sim day, a scenario count). It
 * goes through the session's own request queue, one fetch at a time, and is
 * dropped whenever the run is replaced or taken back in time.
 */
export function useSessionData<T>(
  open: boolean,
  key: string,
  fetcher: (backend: SimBackend, id: string) => Promise<T>,
): Polled<T> {
  const epoch = useSim((s) => s.runEpoch);
  const [state, setState] = useState<Polled<T> & { epoch: number }>({ data: null, error: null, loading: false, epoch });
  const inFlight = useRef(false);
  const wanted = useRef('');
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  useEffect(() => {
    if (!open) return;
    const want = `${epoch}|${key}`;
    wanted.current = want;
    let cancelled = false;
    const run = () => {
      if (inFlight.current) return; // the fetch in flight re-checks when it lands
      const asked = wanted.current;
      const askedEpoch = epoch;
      const request = sessionRequest((backend, id) => fetcherRef.current(backend, id));
      if (request === null) return;
      inFlight.current = true;
      setState((s) => ({ ...s, loading: true, ...(s.epoch !== askedEpoch ? { data: null, error: null, epoch: askedEpoch } : {}) }));
      request
        .then(
          (data) => {
            if (useSim.getState().runEpoch === askedEpoch) setState({ data, error: null, loading: false, epoch: askedEpoch });
          },
          (err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            setState((s) => ({ ...s, error: message, loading: false }));
          },
        )
        .finally(() => {
          inFlight.current = false;
          if (!cancelled && wanted.current !== asked) run(); // something changed while it was in flight
        });
    };
    run();
    return () => {
      cancelled = true;
    };
  }, [open, key, epoch]);

  // data from a run that is gone is never shown
  return state.epoch === epoch ? state : { data: null, error: null, loading: state.loading };
}

/** Trains online across every unit: changes whenever a unit fails or is repaired. */
function trainsOnline(): number {
  const snap = useSim.getState().snap;
  if (snap === null) return 0;
  let n = 0;
  for (let i = 0; i < snap.unitTrains.length; i++) n += snap.unitTrains[i];
  return n;
}

/**
 * The forecast for the Disruption impact tab: fetched when the tab opens,
 * when a scenario is triggered or a unit fails or comes back, after a step
 * back in time, and otherwise once per simulated day.
 */
export function useForecast(open: boolean, days: number): Polled<ForecastReply> {
  const day = useSim((s) => Math.floor(Number(s.snap?.tick ?? 0) / TICKS_PER_DAY));
  const triggered = useSim((s) => s.triggered.length);
  const trains = useSim(() => trainsOnline());
  return useSessionData(open, `${day}|${triggered}|${trains}|${days}`, (backend, id) => {
    if (backend.forecast === undefined) return Promise.reject(new Error('This view needs the hosted engine.'));
    return backend.forecast(id, days);
  });
}
