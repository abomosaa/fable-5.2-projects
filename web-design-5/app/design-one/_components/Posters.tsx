/**
 * Poster artwork for the work index, drawn as inline SVG so the page ships
 * without a single bitmap. Every poster shares one 3:4 artboard and the
 * three-colour palette of the site.
 */

const INK = "#0d0d0c";
const PAPER = "#ecebe6";
const SIGNAL = "#ff4a1c";
const GREY = "#b9b7ae";

type ArtboardProps = {
  title: string;
  background: string;
  children: React.ReactNode;
};

function Artboard({ title, background, children }: ArtboardProps) {
  return (
    <svg
      className="d1-poster"
      viewBox="0 0 300 400"
      role="img"
      aria-label={title}
      preserveAspectRatio="xMidYMid slice"
    >
      <rect width="300" height="400" fill={background} />
      {children}
    </svg>
  );
}

function KunsthalleNord() {
  return (
    <Artboard title="Poster for Kunsthalle Nord" background={INK}>
      <circle cx="212" cy="150" r="136" fill={PAPER} />
      <circle cx="128" cy="214" r="46" fill={SIGNAL} />
      <rect x="24" y="24" width="5" height="52" fill={PAPER} />
      <text x="24" y="338" fontSize="38" fontWeight="600" letterSpacing="-1.8" fill={PAPER}>
        Kunsthalle
      </text>
      <text x="24" y="374" fontSize="38" fontWeight="600" letterSpacing="-1.8" fill={PAPER}>
        Nord
      </text>
      <text x="276" y="374" fontSize="9" fontWeight="500" textAnchor="end" fill={PAPER}>
        Programm 01—04 / 26
      </text>
    </Artboard>
  );
}

function FerroCycles() {
  return (
    <Artboard title="Poster for Ferro Cycles" background={SIGNAL}>
      <circle cx="58" cy="262" r="96" fill="none" stroke={INK} strokeWidth="24" />
      <circle cx="262" cy="262" r="96" fill="none" stroke={INK} strokeWidth="24" />
      <path d="M58 262 L150 132 L262 262 M150 132 L186 132" fill="none" stroke={INK} strokeWidth="9" />
      <text x="22" y="82" fontSize="72" fontWeight="700" letterSpacing="-4.5" fill={INK}>
        Ferro
      </text>
      <text x="24" y="104" fontSize="10" fontWeight="500" fill={INK}>
        Cargo, in steel. Rotterdam.
      </text>
    </Artboard>
  );
}

function LumenBank() {
  const dots = [];
  for (let row = 0; row < 9; row++) {
    for (let col = 0; col < 7; col++) {
      const light = (col / 6 + (8 - row) / 8) / 2;
      dots.push(
        <circle
          key={`${row}-${col}`}
          cx={30 + col * 40}
          cy={30 + row * 34}
          r={2 + light * light * 15}
          fill={row === 2 && col === 5 ? SIGNAL : INK}
        />,
      );
    }
  }
  return (
    <Artboard title="Poster for Lumen Bank" background={PAPER}>
      {dots}
      <text x="24" y="376" fontSize="44" fontWeight="600" letterSpacing="-2.4" fill={INK}>
        Lumen
      </text>
      <text x="276" y="376" fontSize="9" fontWeight="500" textAnchor="end" fill={INK}>
        One language, 14 markets
      </text>
    </Artboard>
  );
}

function AtlasEditions() {
  const spines = [
    [24, 18, 190, INK],
    [46, 30, 236, SIGNAL],
    [80, 12, 172, INK],
    [96, 24, 214, GREY],
    [124, 38, 252, INK],
    [166, 14, 180, SIGNAL],
    [184, 26, 226, INK],
    [214, 10, 160, GREY],
    [228, 22, 206, INK],
    [254, 22, 244, SIGNAL],
  ] as const;
  return (
    <Artboard title="Poster for Atlas Editions" background={PAPER}>
      {spines.map(([x, width, height, fill]) => (
        <rect key={x} x={x} y={306 - height} width={width} height={height} fill={fill} />
      ))}
      <rect x="24" y="306" width="252" height="3" fill={INK} />
      <text x="24" y="346" fontSize="30" fontWeight="600" letterSpacing="-1.5" fill={INK}>
        Atlas Editions
      </text>
      <text x="24" y="372" fontSize="10" fontWeight="500" fill={INK}>
        Spring list — forty titles in translation
      </text>
    </Artboard>
  );
}

function HafenQuartier() {
  return (
    <Artboard title="Poster for Hafen Quartier" background={INK}>
      <path d="M52 286 L226 112" stroke={PAPER} strokeWidth="46" />
      <path d="M92 89 H249 V246" fill="none" stroke={PAPER} strokeWidth="46" />
      <rect x="24" y="318" width="22" height="22" fill={SIGNAL} />
      <text x="58" y="337" fontSize="24" fontWeight="600" letterSpacing="-1" fill={PAPER}>
        Hafen Quartier
      </text>
      <text x="24" y="374" fontSize="10" fontWeight="500" fill={PAPER}>
        Kai 4—11 · 650 m
      </text>
      <text x="276" y="374" fontSize="10" fontWeight="500" textAnchor="end" fill={PAPER}>
        ↗ Nordhafen
      </text>
    </Artboard>
  );
}

function SoraAudio() {
  return (
    <Artboard title="Poster for Sora Audio" background={INK}>
      {[148, 124, 100, 76, 52].map((r, i) => (
        <circle
          key={r}
          cx="150"
          cy="176"
          r={r}
          fill="none"
          stroke={SIGNAL}
          strokeWidth={3 + i * 2}
        />
      ))}
      <circle cx="150" cy="176" r="24" fill={SIGNAL} />
      <text x="24" y="374" fontSize="44" fontWeight="600" letterSpacing="-2.4" fill={PAPER}>
        Sora
      </text>
      <text x="276" y="374" fontSize="9" fontWeight="500" textAnchor="end" fill={PAPER}>
        S—3 Reference
      </text>
    </Artboard>
  );
}

function Tessel() {
  return (
    <Artboard title="Type specimen for Tessel" background={PAPER}>
      <text x="14" y="212" fontSize="232" fontWeight="600" letterSpacing="-14" fill={INK}>
        Aa
      </text>
      <rect x="24" y="246" width="252" height="2" fill={INK} />
      <g fontSize="22" fontWeight="600" fill={INK}>
        <text x="24" y="282" transform="translate(24 0) scale(0.78 1) translate(-24 0)">
          Tessel Narrow
        </text>
        <text x="24" y="312">Tessel Normal</text>
        <text x="24" y="342" transform="translate(24 0) scale(1.26 1) translate(-24 0)">
          Tessel Wide
        </text>
      </g>
      <circle cx="262" cy="34" r="14" fill={SIGNAL} />
      <text x="24" y="376" fontSize="9" fontWeight="500" fill={INK}>
        27 styles · 480 glyphs · 92 languages
      </text>
    </Artboard>
  );
}

function NordlysFestival() {
  const bars = Array.from({ length: 21 }, (_, i) => {
    const wave = Math.sin(i * 0.62) * 0.5 + Math.sin(i * 0.23 + 1.4) * 0.5;
    return Math.round(120 + wave * 92);
  });
  return (
    <Artboard title="Poster for Nordlys Festival" background={INK}>
      {bars.map((height, i) => (
        <rect
          key={i}
          x={24 + i * 12}
          y={92}
          width="7"
          height={height}
          fill={i % 5 === 3 ? PAPER : SIGNAL}
        />
      ))}
      <text x="24" y="60" fontSize="40" fontWeight="600" letterSpacing="-2" fill={PAPER}>
        Nordlys
      </text>
      <text x="276" y="60" fontSize="40" fontWeight="600" letterSpacing="-2" textAnchor="end" fill={SIGNAL}>
        23
      </text>
      <text x="24" y="374" fontSize="10" fontWeight="500" fill={PAPER}>
        Ten nights above the Arctic Circle
      </text>
    </Artboard>
  );
}

const posters = [
  KunsthalleNord,
  FerroCycles,
  LumenBank,
  AtlasEditions,
  HafenQuartier,
  SoraAudio,
  Tessel,
  NordlysFestival,
];

/** Renders the poster that belongs to the project at `index`. */
export function Poster({ index }: { index: number }) {
  const Art = posters[index % posters.length];
  return <Art />;
}
