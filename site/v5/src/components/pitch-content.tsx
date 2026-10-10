const problems = [
  { n: "01", title: "Concentrated", text: "Over 95% of US ethylene capacity sits in Texas and Louisiana. A regional storm is a national supply event." },
  { n: "02", title: "Coupled", text: "Plants feed each other through shared pipelines, storage and waterways. They fail together and recover slowly." },
  { n: "03", title: "Blind", text: "Every planning tool stops at the plant's own fence. None models the links between companies." },
  { n: "04", title: "Late", text: "Without knowing how long it has, a plant can't choose between cutting early and running on. Customers find out by letter." },
  { n: "05", title: "Dirty", text: "Emergency shutdowns and restarts pollute. Earlier, orderly rate cuts could avoid much of it." },
];

const stats = [
  { value: "95%+", label: "of US ethylene capacity in Texas or Louisiana", source: "PolitiFact, citing the US Energy Department, 2018" },
  { value: "75%", label: "of US ethylene capacity still offline days after the 2021 freeze", source: "Chemistry World, Feb 2021" },
  { value: "$100M", label: "one company's hit from 61 days of unplanned downtime at one site", source: "Industrial Info, Jul 2014" },
];

const answers = [
  { title: "How long it has", text: "The days until it must cut rates or shut down." },
  { title: "What it costs", text: "Lost production in dollars, and the emissions of each shutdown and restart." },
  { title: "Its best move", text: "The same event run under different choices: run on, cut early, buy elsewhere." },
];

const steps = [
  { title: "Model every plant", text: "Down to its units, with real yields, minimum rates and restart times, from public data." },
  { title: "Move the product", text: "Through pipelines, barges, ships and trucks with real capacities and transit times, hour by hour." },
  { title: "Add your own numbers privately", text: "A company registers its plants and gets a precise forecast only it can see.", tag: "In development" },
];

const nodes = [
  { x: 60, y: 70, label: "Cracker" }, { x: 190, y: 40, label: "Pipeline" }, { x: 190, y: 120, label: "Storage" },
  { x: 320, y: 70, label: "PE plant" }, { x: 450, y: 40, label: "PP plant" }, { x: 450, y: 120, label: "Port" },
  { x: 580, y: 80, label: "Resin buyer" },
];
const links: [number, number][] = [[0, 1], [0, 2], [1, 3], [2, 3], [3, 4], [3, 5], [4, 6], [5, 6]];

function hexPath(cx: number, cy: number, r: number) {
  return Array.from({ length: 6 }, (_, i) => {
    const a = (Math.PI / 3) * i - Math.PI / 2;
    return `${cx + r * Math.cos(a)},${cy + r * Math.sin(a)}`;
  }).join(" ");
}

function Section({ id, eyebrow, title, children }: { id: string; eyebrow: string; title: string; children: React.ReactNode }) {
  return (
    <section id={id} className="pitch-section">
      <p className="pitch-eyebrow"><span className="hex-dot" />{eyebrow}</p>
      <h2 className="pitch-h2">{title}</h2>
      {children}
    </section>
  );
}

export function PitchContent() {
  return (
    <div className="pitch">
      <header className="pitch-hero">
        <p className="pitch-eyebrow"><span className="hex-dot" />Gulf Coast petrochemical network</p>
        <h1 className="pitch-h1">
          One coast makes almost all of America's plastics feedstock. Its plants fail together.{" "}
          <span className="text-primary">No tool sees it coming.</span>
        </h1>
        <p className="pitch-lead">
          In February 2021, three-quarters of US ethylene capacity went offline within days. A month later it still wasn't back.
          PetroGrid simulates the whole coast as one network, so every plant learns how a disruption will reach it.
        </p>
      </header>

      <Section id="issue" eyebrow="The issue" title="Three numbers">
        <div className="stat-grid">
          {stats.map((s) => (
            <div key={s.value} className="hex-card">
              <div className="stat-value">{s.value}</div>
              <p className="stat-label">{s.label}</p>
              <p className="stat-source">{s.source}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section id="problem" eyebrow="The problem" title="Five ways a failure spreads">
        <div className="problem-list">
          {problems.map((p) => (
            <div key={p.n} className="problem-row">
              <span className="hex-badge">{p.n}</span>
              <div>
                <h3 className="pitch-h3">{p.title}</h3>
                <p className="pitch-body">{p.text}</p>
              </div>
            </div>
          ))}
        </div>
      </Section>

      <Section id="solution" eyebrow="What we do" title="A weather forecast for the supply chain">
        <p className="pitch-lead">Break anything on the coast, and every plant gets three answers.</p>
        <div className="cascade hex-card">
          <svg viewBox="0 0 640 160" role="img" aria-label="A cracker trip cascading through pipeline, storage, plants, port and resin buyer">
            {links.map(([a, b], i) => { const na = nodes[a]!, nb = nodes[b]!; return (
              <line key={i} x1={na.x} y1={na.y} x2={nb.x} y2={nb.y} className="cascade-link" />
            ); })}
            {nodes.map((n, i) => (
              <g key={n.label} className="cascade-node">
                <polygon points={hexPath(n.x, n.y, 18)} style={{ animationDelay: `${i * 0.35}s` }} />
                <text x={n.x} y={n.y + 34} textAnchor="middle">{n.label}</text>
              </g>
            ))}
          </svg>
          <p className="stat-source">Illustrative: a cracker trip reaching plants downstream, in order.</p>
        </div>
        <div className="three-grid">
          {answers.map((a, i) => (
            <div key={a.title} className="hex-card">
              <span className="hex-badge">{i + 1}</span>
              <h3 className="pitch-h3">{a.title}</h3>
              <p className="pitch-body">{a.text}</p>
            </div>
          ))}
        </div>
      </Section>

      <Section id="how" eyebrow="How it works" title="Three steps">
        <ol className="steps">
          {steps.map((s, i) => (
            <li key={s.title} className="step">
              <span className="hex-badge">{i + 1}</span>
              <div>
                <h3 className="pitch-h3">{s.title} {s.tag && <span className="pitch-tag">{s.tag}</span>}</h3>
                <p className="pitch-body">{s.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="demo" eyebrow="The demo" title="Trip a cracker. Run it twice.">
        <p className="pitch-lead">Pick a plant, break it and watch the coast respond. Then compare two choices side by side.</p>
        <div className="two-grid">
          <div className="hex-card">
            <h3 className="pitch-h3">Run on</h3>
            <p className="pitch-body">Keep rates up and hope supply returns. Risk an emergency shutdown when tanks run dry, with its restart cost and emissions.</p>
          </div>
          <div className="hex-card hex-card-primary">
            <h3 className="pitch-h3">Cut early</h3>
            <p className="pitch-body">An orderly rate cut before impact. Customers are warned before the letter, and the emergency shutdown can be avoided.</p>
          </div>
        </div>
        <p className="stat-source">Outputs are estimates from public capacities, not live plant data.</p>
      </Section>

      <Section id="business" eyebrow="Business" title="Who buys it and why">
        <div className="three-grid">
          <div className="hex-card">
            <h3 className="pitch-h3">Users</h3>
            <p className="pitch-body">Supply and operations planners at Gulf Coast producers first. Resin buyers, insurers and ports next.</p>
          </div>
          <div className="hex-card">
            <h3 className="pitch-h3">Today's alternatives</h3>
            <p className="pitch-body">Site models cover one plant in steady operation. Market reports arrive after the fact. Neither shows a disruption moving between companies.</p>
          </div>
          <div className="hex-card">
            <h3 className="pitch-h3">Price anchor</h3>
            <p className="pitch-body">One avoided day of downtime: about <strong>$1.6M a day</strong> in the Dow case (our arithmetic).</p>
          </div>
        </div>
        <p className="pitch-body growth">Grows from a public model, to private forecasts per company, to better estimates for all as plants register.</p>
      </Section>

      <section className="pitch-close">
        <h2 className="pitch-h1">The Gulf Coast already runs as one plant. <span className="text-primary">We gave it one model.</span></h2>
        <p className="pitch-body">PetroGrid · petrogrid.xyz</p>
      </section>

      <footer className="pitch-sources">
        <p className="pitch-eyebrow"><span className="hex-dot" />Sources, checked 10 October 2026</p>
        <ul>
          <li>PolitiFact, "Fact-checking ethylene production in the US", 2019</li>
          <li>Chemistry World, "Polar storm paralyses US Gulf Coast petrochemical sector", 2021</li>
          <li>Wood Mackenzie, "Texas deep freeze: lingering impacts on US petrochemicals industry", 2021</li>
          <li>Industrial Info, "US ethylene producers see costly outages in second quarter 2014", 2014</li>
          <li>Texas Observer, "Early shut-downs, upgrades could have avoided millions of pounds of pollutants released during Harvey", 2017</li>
        </ul>
      </footer>
    </div>
  );
}
