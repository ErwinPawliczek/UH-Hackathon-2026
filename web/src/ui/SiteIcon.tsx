// React face of the site-preset icon set (siteIcons.ts): the bare icon, and
// the icon in its hexagon badge. Same path data the map labels draw.

import {
  ICON_GRID, ICON_STROKE, badgeGeometry, siteIcon, type SiteIconDef,
} from './siteIcons';

const INK = 'var(--icon-ink, #0a0a0a)';
const ACCENT = 'var(--icon-accent, #1764d6)';

function Strokes({ def }: { def: SiteIconDef }) {
  return (
    <>
      {def.strokes.map((s, i) => {
        const colour = s.accent === true ? ACCENT : INK;
        return s.fill === true
          ? <path key={i} d={s.d} fill={colour} stroke="none" />
          : <path key={i} d={s.d} fill="none" stroke={colour} />;
      })}
    </>
  );
}

/** A preset's icon, `size` pixels square. Decorative: name the plant in text beside it. */
export function SiteIcon({ preset, size = 18 }: { preset: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${ICON_GRID} ${ICON_GRID}`}
      fill="none"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      data-icon={preset}
    >
      <Strokes def={siteIcon(preset)} />
    </svg>
  );
}

/**
 * A preset's icon in a small hexagon badge. `down` paints it alarm red with a
 * white icon — the same "plant down" state the map labels show.
 */
export function SiteBadge({ preset, icon = 16, down = false }: { preset: string; icon?: number; down?: boolean }) {
  const g = badgeGeometry(icon);
  const style = down
    ? ({ '--icon-ink': '#ffffff', '--icon-accent': '#ffffff' } as React.CSSProperties)
    : undefined;
  return (
    <svg
      width={g.width}
      height={g.height}
      viewBox={`0 0 ${g.width} ${g.height}`}
      fill="none"
      strokeWidth={ICON_STROKE}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className="shrink-0"
      style={style}
      data-icon={preset}
    >
      <polygon
        points={g.points}
        fill={down ? 'var(--alarm)' : 'var(--white)'}
        stroke={down ? 'var(--alarm)' : 'var(--ink)'}
        strokeWidth={1.5}
      />
      <g transform={`translate(${g.inset[0]} ${g.inset[1]}) scale(${icon / ICON_GRID})`}>
        <Strokes def={siteIcon(preset)} />
      </g>
    </svg>
  );
}
