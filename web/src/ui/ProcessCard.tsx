// Process card: pure presentational view of one process's recipe flows, unit
// fleet state and fail controls. Props in, markup out — no store access and no
// fetching, so tests render it to static markup. Styling uses the v3 tokens
// (design/v3/simulation-style.md): light chrome, mono numerals, alarm red only
// for down units.

import { useState, type CSSProperties, useId } from 'react';
import type { FlowMaterial } from '../catalog/processes';
import { PROC_STATUS_LABELS } from '../scene/palette';
import { fmtPct } from './format';
import type { ProcessCardData, ProcessCardUnit } from './processCardModel';

const panel: CSSProperties = {
  border: '1px solid var(--line)',
  borderRadius: 'var(--r-md)',
  background: 'var(--panel)',
  padding: 8,
};

const label: CSSProperties = {
  fontFamily: 'var(--f-mono)',
  fontSize: 10,
  letterSpacing: '0.14em',
  textTransform: 'uppercase',
  color: 'var(--muted)',
};

const num: CSSProperties = {
  fontFamily: 'var(--f-mono)',
  fontVariantNumeric: 'tabular-nums',
  fontSize: 12,
  color: 'var(--ink)',
};

const chip: CSSProperties = {
  ...num,
  display: 'inline-block',
  border: '1px solid var(--line-2)',
  borderRadius: 'var(--r-sm)',
  padding: '0 4px',
  background: 'var(--white)',
};

const fadedChip: CSSProperties = {
  ...chip,
  color: 'var(--dim)',
  borderColor: 'var(--line)',
  background: 'transparent',
};

/** v3 state colours: alarm only when the unit is down or restarting. */
export function statusColor(status: number): string {
  if (status === 2 || status === 3) return 'var(--alarm)';
  if (status === 1) return 'var(--blue-light)';
  if (status === 4) return 'var(--dim)';
  return 'var(--blue)';
}

function MaterialChip({ m }: { m: FlowMaterial }) {
  return <span style={m.faded ? fadedChip : chip}>{m.key}</span>;
}

function FlowRow({ label: text, mats }: { label: string; mats: FlowMaterial[] }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, minHeight: 18 }}>
      <span style={label}>{text}</span>
      {mats.length === 0 ? (
        <span style={{ ...num, color: 'var(--dim)' }}>—</span>
      ) : (
        <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {mats.map((m) => (
            <MaterialChip key={m.key} m={m} />
          ))}
        </span>
      )}
    </div>
  );
}

/** Share of the material in its recipe side, as a mono percentage. */
function sharePct(m: FlowMaterial): string {
  return fmtPct(m.share);
}

function RecipeRow({ matsIn, matsOut }: { matsIn: FlowMaterial[]; matsOut: FlowMaterial[] }) {
  const render = (mats: FlowMaterial[]) =>
    mats.map((m, i) => (
      <span key={m.key} style={{ display: 'inline-flex', gap: 4, alignItems: 'baseline' }}>
        {i > 0 ? <span style={{ color: 'var(--dim)' }}>·</span> : null}
        <MaterialChip m={m} />
        <span style={{ ...label, letterSpacing: 0 }}>{sharePct(m)}</span>
      </span>
    ));
  return (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'baseline',
        gap: 6,
        rowGap: 2,
        ...num,
        fontSize: 11,
        minWidth: 0,
      }}
      data-testid="recipe-row"
    >
      {render(matsIn)}
      <span style={{ color: 'var(--muted)' }}>→</span>
      {render(matsOut)}
    </div>
  );
}

/**
 * Fail-this-unit control: trains-down and duration inputs issuing the
 * §7.2 unit_outage command through the parent's callback.
 */
function FailControl({
  unit,
  onFail,
}: {
  unit: ProcessCardUnit;
  onFail: (trainsDown: number, durationHours: number) => void;
}) {
  const [trainsDown, setTrainsDown] = useState(1);
  const [hours, setHours] = useState(24);
  const fieldId = useId(); // unit keys repeat across processes; ids must not
  const max = Math.max(1, unit.trains);
  return (
    <span
      style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
      data-testid={`fail-control-${unit.key}`}
    >
      <input
        id={`${fieldId}-trains`}
        name={`fail-trains-${unit.key}`}
        aria-label={`Trains down for ${unit.key}`}
        type="number"
        min={1}
        max={max}
        value={trainsDown}
        onChange={(e) => setTrainsDown(Math.min(max, Math.max(1, Number(e.target.value) || 1)))}
        style={{ ...num, width: 44, border: '1px solid var(--line-2)', borderRadius: 'var(--r-sm)', padding: '1px 4px', background: 'var(--panel-2)' }}
      />
      <span style={label}>trains</span>
      <input
        id={`${fieldId}-hours`}
        name={`fail-hours-${unit.key}`}
        aria-label={`Hours for ${unit.key}`}
        type="number"
        min={1}
        value={hours}
        onChange={(e) => setHours(Math.max(1, Math.floor(Number(e.target.value) || 1)))}
        style={{ ...num, width: 52, border: '1px solid var(--line-2)', borderRadius: 'var(--r-sm)', padding: '1px 4px', background: 'var(--panel-2)' }}
      />
      <span style={label}>h</span>
      <button type="button" className="btn btn-primary btn-sm" onClick={() => onFail(trainsDown, hours)}>
        Fail unit
      </button>
    </span>
  );
}

function UnitRow({ unit, onFailUnit }: { unit: ProcessCardUnit; onFailUnit?: ProcessCardProps['onFailUnit'] }) {
  const down = unit.trainsOnline < unit.trains;
  return (
    <li style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 6 }}>
      <span style={{ ...num, fontWeight: 500 }}>{unit.key}</span>
      <span style={label}>{unit.name}</span>
      {unit.singleTrain ? (
        <span
          title="Single train — losing it stops the whole process"
          style={{
            ...label,
            border: '1px solid var(--line-2)',
            borderRadius: 'var(--r-sm)',
            padding: '0 4px',
            background: 'var(--white)',
          }}
          data-testid={`single-train-${unit.key}`}
        >
          single train
        </span>
      ) : null}
      <span style={{ ...num, color: down ? 'var(--alarm)' : 'var(--ink)' }} data-testid={`unit-trains-${unit.key}`}>
        {unit.trainsOnline}/{unit.trains} trains
      </span>
      {unit.recipes.map((r, i) => (
        <RecipeRow key={i} matsIn={r.in} matsOut={r.out} />
      ))}
      {onFailUnit ? <FailControl unit={unit} onFail={(t, h) => onFailUnit(unit, t, h)} /> : null}
    </li>
  );
}

export interface ProcessCardProps {
  card: ProcessCardData;
  /** When provided, every unit row gets a fail-this-unit control. */
  onFailUnit?: (unit: ProcessCardUnit, trainsDown: number, durationHours: number) => void;
}

/** One process's card: live rate, external flows, per-unit fleet and recipes. */
export function ProcessCard({ card, onFailUnit }: ProcessCardProps) {
  const down = card.status === 2 || card.status === 3;
  return (
    <article style={panel} data-testid={`process-card-${card.key}`} data-known={card.known ? 'true' : 'false'}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 8 }}>
        <span style={{ ...num, fontWeight: 600 }}>{card.name}</span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <span style={{ width: 8, height: 8, borderRadius: 'var(--r-full)', background: statusColor(card.status), display: 'inline-block' }} />
          <span style={label}>{PROC_STATUS_LABELS[card.status] ?? `status ${card.status}`}</span>
        </span>
      </div>
      <div style={label}>{card.key}</div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, margin: '6px 0' }}>
        <div style={{ flex: 1, height: 4, borderRadius: 'var(--r-full)', background: 'var(--panel-2)', overflow: 'hidden' }}>
          <div
            style={{
              height: '100%',
              width: `${Math.min(100, Math.max(0, card.rate * 100))}%`,
              background: down ? 'var(--alarm)' : 'var(--blue)',
            }}
          />
        </div>
        <span style={{ ...num, color: down ? 'var(--alarm)' : 'var(--ink)' }} data-testid={`process-rate-${card.key}`}>
          {fmtPct(card.rate)}
        </span>
      </div>

      {card.known ? (
        <div style={{ display: 'grid', gap: 2, marginBottom: 6 }}>
          <FlowRow label="needs" mats={card.needs.map((key) => ({ key, share: 1, faded: false }))} />
          <FlowRow label="makes" mats={card.makes.map((key) => ({ key, share: 1, faded: false }))} />
        </div>
      ) : (
        <div style={{ ...label, color: 'var(--dim)', marginBottom: 6 }} data-testid={`unknown-process-${card.key}`}>
          no catalog data
        </div>
      )}

      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
        {card.units.map((unit) => (
          <UnitRow key={unit.key} unit={unit} onFailUnit={onFailUnit} />
        ))}
      </ul>
    </article>
  );
}
