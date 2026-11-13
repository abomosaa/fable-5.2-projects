import { useId } from "react";
import type { StillId } from "../content";

/**
 * "Film stills" drawn entirely in SVG. Every still shares a 2.39:1 artboard
 * and slices to fill whatever frame it is placed in.
 */

type SceneProps = { uid: string };

function Aurea({ uid }: SceneProps) {
  return (
    <>
      <defs>
        <radialGradient id={`${uid}-bg`} cx="38%" cy="52%" r="75%">
          <stop offset="0" stopColor="#7a3306" />
          <stop offset="0.45" stopColor="#2a1004" />
          <stop offset="1" stopColor="#050302" />
        </radialGradient>
        <radialGradient id={`${uid}-drop`} cx="36%" cy="30%" r="80%">
          <stop offset="0" stopColor="#fff3cf" />
          <stop offset="0.18" stopColor="#ffc35a" />
          <stop offset="0.6" stopColor="#d9650a" />
          <stop offset="1" stopColor="#4a1602" />
        </radialGradient>
        <radialGradient id={`${uid}-glow`}>
          <stop offset="0" stopColor="#ffb347" stopOpacity="0.9" />
          <stop offset="1" stopColor="#ffb347" stopOpacity="0" />
        </radialGradient>
        <filter id={`${uid}-soft`} x="-50%" y="-50%" width="200%" height="200%">
          <feGaussianBlur stdDeviation="14" />
        </filter>
      </defs>
      <rect width="1200" height="502" fill={`url(#${uid}-bg)`} />
      <ellipse cx="470" cy="270" rx="430" ry="230" fill={`url(#${uid}-glow)`} opacity="0.55" />
      <g filter={`url(#${uid}-soft)`} opacity="0.5">
        <circle cx="930" cy="130" r="58" fill="#ff9d3c" />
        <circle cx="1050" cy="300" r="82" fill="#c2500a" />
        <circle cx="160" cy="110" r="44" fill="#ffcf8a" />
        <circle cx="90" cy="390" r="70" fill="#8a3505" />
      </g>
      <g fill="none" stroke="#ffcf8a">
        <ellipse cx="470" cy="392" rx="210" ry="26" strokeOpacity="0.5" strokeWidth="1.5" />
        <ellipse cx="470" cy="392" rx="320" ry="42" strokeOpacity="0.28" strokeWidth="1" />
        <ellipse cx="470" cy="392" rx="450" ry="60" strokeOpacity="0.14" strokeWidth="1" />
      </g>
      <path
        d="M470 92 C 520 190 566 232 566 290 A 96 96 0 0 1 374 290 C 374 232 420 190 470 92 Z"
        fill={`url(#${uid}-drop)`}
      />
      <ellipse cx="438" cy="262" rx="16" ry="34" fill="#fff8e1" opacity="0.7" transform="rotate(18 438 262)" />
    </>
  );
}

function FirstLight({ uid }: SceneProps) {
  const stars = [
    [80, 60], [190, 140], [260, 40], [340, 110], [470, 70], [560, 30], [690, 120],
    [760, 54], [880, 96], [960, 38], [1040, 150], [1130, 72], [150, 210], [1010, 220],
  ];
  return (
    <>
      <defs>
        <linearGradient id={`${uid}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#02040a" />
          <stop offset="0.62" stopColor="#0d1a33" />
          <stop offset="0.63" stopColor="#05070c" />
          <stop offset="1" stopColor="#010204" />
        </linearGradient>
        <radialGradient id={`${uid}-lamp`}>
          <stop offset="0" stopColor="#ffffff" />
          <stop offset="0.25" stopColor="#bfe0ff" stopOpacity="0.8" />
          <stop offset="1" stopColor="#4d8dff" stopOpacity="0" />
        </radialGradient>
        <linearGradient id={`${uid}-road`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#9cc7ff" stopOpacity="0.5" />
          <stop offset="1" stopColor="#9cc7ff" stopOpacity="0" />
        </linearGradient>
        <filter id={`${uid}-blur`} x="-50%" y="-200%" width="200%" height="500%">
          <feGaussianBlur stdDeviation="5" />
        </filter>
      </defs>
      <rect width="1200" height="502" fill={`url(#${uid}-sky)`} />
      {stars.map(([x, y], i) => (
        <circle key={i} cx={x} cy={y} r={i % 3 === 0 ? 1.6 : 1} fill="#dbe9ff" opacity={0.35 + (i % 4) * 0.15} />
      ))}
      <rect y="313" width="1200" height="1.5" fill="#7fb2ff" opacity="0.55" />
      <path d="M520 316 L680 316 L980 502 L220 502 Z" fill={`url(#${uid}-road)`} opacity="0.5" />
      <g filter={`url(#${uid}-blur)`}>
        <ellipse cx="548" cy="306" rx="330" ry="5" fill="#8fc1ff" opacity="0.9" />
        <ellipse cx="652" cy="306" rx="330" ry="5" fill="#8fc1ff" opacity="0.9" />
      </g>
      <circle cx="548" cy="306" r="62" fill={`url(#${uid}-lamp)`} />
      <circle cx="652" cy="306" r="62" fill={`url(#${uid}-lamp)`} />
      <circle cx="548" cy="306" r="7" fill="#fff" />
      <circle cx="652" cy="306" r="7" fill="#fff" />
    </>
  );
}

function Meridian({ uid }: SceneProps) {
  return (
    <>
      <defs>
        <radialGradient id={`${uid}-corona`}>
          <stop offset="0.3" stopColor="#fff6e0" />
          <stop offset="0.42" stopColor="#ffc277" stopOpacity="0.85" />
          <stop offset="0.7" stopColor="#c2410c" stopOpacity="0.22" />
          <stop offset="1" stopColor="#c2410c" stopOpacity="0" />
        </radialGradient>
        <radialGradient id={`${uid}-flare`}>
          <stop offset="0" stopColor="#fff" />
          <stop offset="0.3" stopColor="#ffe2b0" stopOpacity="0.8" />
          <stop offset="1" stopColor="#ffe2b0" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="1200" height="502" fill="#050403" />
      <circle cx="600" cy="251" r="420" fill={`url(#${uid}-corona)`} />
      <g fill="none" stroke="#e7b872" strokeOpacity="0.2">
        <circle cx="600" cy="251" r="236" />
        <circle cx="600" cy="251" r="318" strokeDasharray="2 10" />
        <circle cx="600" cy="251" r="410" />
      </g>
      <circle cx="600" cy="251" r="150" fill="#030202" />
      <circle cx="704" cy="144" r="46" fill={`url(#${uid}-flare)`} />
      <rect x="430" y="143.5" width="548" height="1" fill="#ffe2b0" opacity="0.6" />
    </>
  );
}

function Treeline({ uid }: SceneProps) {
  return (
    <>
      <defs>
        <linearGradient id={`${uid}-sky`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#8fa6a3" />
          <stop offset="0.55" stopColor="#c9c7b4" />
          <stop offset="1" stopColor="#57706f" />
        </linearGradient>
        <linearGradient id={`${uid}-fog`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d9d8c8" stopOpacity="0" />
          <stop offset="1" stopColor="#d9d8c8" stopOpacity="0.75" />
        </linearGradient>
      </defs>
      <rect width="1200" height="502" fill={`url(#${uid}-sky)`} />
      <circle cx="820" cy="150" r="54" fill="#f4eed7" opacity="0.85" />
      <path d="M0 290 L140 222 L250 262 L390 170 L520 250 L650 196 L800 268 L930 204 L1070 256 L1200 214 V502 H0 Z" fill="#7d9391" />
      <rect y="220" width="1200" height="120" fill={`url(#${uid}-fog)`} />
      <path d="M0 348 L120 300 L270 336 L420 262 L560 330 L720 280 L860 340 L1010 290 L1200 336 V502 H0 Z" fill="#4f6968" />
      <rect y="290" width="1200" height="110" fill={`url(#${uid}-fog)`} opacity="0.7" />
      <path d="M0 408 L160 356 L330 400 L500 338 L680 402 L850 360 L1030 410 L1200 372 V502 H0 Z" fill="#263a3b" />
      <rect y="360" width="1200" height="90" fill={`url(#${uid}-fog)`} opacity="0.35" />
      <path d="M0 462 L210 420 L420 458 L640 414 L860 462 L1060 430 L1200 452 V502 H0 Z" fill="#0b1415" />
      <path d="M612 414 l-5 -30 l5 -8 l5 8 z" fill="#0b1415" />
    </>
  );
}

function Nocturne({ uid }: SceneProps) {
  const beams = [
    [120, "#ff3d8b"], [300, "#8d5bff"], [470, "#ff3d8b"], [600, "#c9b6ff"],
    [730, "#ff3d8b"], [900, "#8d5bff"], [1080, "#ff3d8b"],
  ] as const;
  const crowd = Array.from({ length: 34 }, (_, i) => ({
    x: i * 37 - 6,
    y: 458 + ((i * 7) % 5) * 5,
    r: 17 + ((i * 3) % 4) * 2,
  }));
  return (
    <>
      <defs>
        <linearGradient id={`${uid}-bg`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#12051f" />
          <stop offset="1" stopColor="#040208" />
        </linearGradient>
        <filter id={`${uid}-haze`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="9" />
        </filter>
        <radialGradient id={`${uid}-stage`}>
          <stop offset="0" stopColor="#ff7ab0" stopOpacity="0.75" />
          <stop offset="1" stopColor="#ff7ab0" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="1200" height="502" fill={`url(#${uid}-bg)`} />
      <g filter={`url(#${uid}-haze)`} style={{ mixBlendMode: "screen" }}>
        {beams.map(([x, color], i) => (
          <polygon
            key={x}
            points={`600,-30 ${x - 50},470 ${x + 50},470`}
            fill={color}
            opacity={0.2 + (i % 3) * 0.08}
          />
        ))}
      </g>
      <ellipse cx="600" cy="420" rx="520" ry="110" fill={`url(#${uid}-stage)`} />
      <circle cx="600" cy="-8" r="26" fill="#fff" opacity="0.9" />
      {crowd.map((head) => (
        <circle key={head.x} cx={head.x} cy={head.y} r={head.r} fill="#030106" />
      ))}
      <rect y="470" width="1200" height="40" fill="#030106" />
    </>
  );
}

const scenes: Record<StillId, (props: SceneProps) => React.ReactNode> = {
  aurea: Aurea,
  "first-light": FirstLight,
  meridian: Meridian,
  treeline: Treeline,
  nocturne: Nocturne,
};

export function Still({ id, title }: { id: StillId; title?: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const Scene = scenes[id];
  return (
    <svg
      className="d2-still"
      viewBox="0 0 1200 502"
      preserveAspectRatio="xMidYMid slice"
      role={title ? "img" : undefined}
      aria-label={title}
      aria-hidden={title ? undefined : true}
    >
      <Scene uid={uid} />
    </svg>
  );
}
