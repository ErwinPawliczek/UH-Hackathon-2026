export function PetroChainMark() {
  return (
    <g transform="translate(-77.6 -96) scale(4)" className="petrochain-mark">
      <polygon points="19.4,10 31.52,17 31.52,31 19.4,38 7.28,31 7.28,17" fill="none" stroke="var(--foreground)" strokeWidth="2.6" strokeLinejoin="round" />
      {/* Blue tail runs along the shared edge of the two hexagons beside the logo
          and stops on the next grid intersection, one hexagon out: from the
          upper-right vertex (31.52, 17) one hexagon radius (14 units) along
          (0.866, -0.5). */}
      <path d="M31.52 17 43.64 10" stroke="var(--primary)" strokeWidth="2.6" strokeLinecap="round" />
      {[[19.4, 10], [31.52, 31], [19.4, 38], [7.28, 31], [7.28, 17]].map(([x, y]) => (
        <circle key={`${x}-${y}`} cx={x} cy={y} r="2.8" fill="var(--background)" stroke="var(--foreground)" strokeWidth="2.2" />
      ))}
      <circle cx="31.52" cy="17" r="2.8" fill="var(--background)" stroke="var(--primary)" strokeWidth="2.2" />
      <circle cx="43.64" cy="10" r="3.6" fill="var(--primary)" />
    </g>
  );
}