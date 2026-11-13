import { useId } from "react";
import type { PlateId } from "../content";

/**
 * Still-life "photographs" composed in SVG: flat shapes, soft shadows and a
 * layer of paper grain. Portrait plates use a 400 × 500 artboard, wide plates
 * 600 × 400.
 */

type SceneProps = { uid: string };

function Defs({ uid }: SceneProps) {
  return (
    <defs>
      <filter id={`${uid}-soft`} x="-40%" y="-80%" width="180%" height="260%">
        <feGaussianBlur stdDeviation="7" />
      </filter>
      <filter id={`${uid}-grain`} x="0" y="0" width="100%" height="100%">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="7" result="noise" />
        <feColorMatrix in="noise" values="0 0 0 0 0.14  0 0 0 0 0.11  0 0 0 0 0.09  0 0 0 0.55 -0.12" />
      </filter>
    </defs>
  );
}

function Grain({ uid, width, height }: SceneProps & { width: number; height: number }) {
  return (
    <rect
      width={width}
      height={height}
      filter={`url(#${uid}-grain)`}
      opacity="0.5"
      style={{ mixBlendMode: "multiply" }}
    />
  );
}

function NatureMorte({ uid }: SceneProps) {
  return (
    <>
      <defs>
        <linearGradient id={`${uid}-wall`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#dfccb1" />
          <stop offset="1" stopColor="#c9ae8c" />
        </linearGradient>
        <linearGradient id={`${uid}-table`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#b3936f" />
          <stop offset="1" stopColor="#97775a" />
        </linearGradient>
        <linearGradient id={`${uid}-vase`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#344338" />
          <stop offset="0.55" stopColor="#232e27" />
          <stop offset="1" stopColor="#161d19" />
        </linearGradient>
        <radialGradient id={`${uid}-orb`} cx="36%" cy="30%" r="80%">
          <stop offset="0" stopColor="#efd9a8" />
          <stop offset="0.6" stopColor="#b38f58" />
          <stop offset="1" stopColor="#7a5c33" />
        </radialGradient>
      </defs>
      <rect width="400" height="500" fill={`url(#${uid}-wall)`} />
      <polygon points="0,0 210,0 400,300 400,500 120,500 0,330" fill="#f3e6cf" opacity="0.38" />
      <circle cx="278" cy="150" r="78" fill="#bf7350" />
      <rect y="372" width="400" height="128" fill={`url(#${uid}-table)`} />
      <rect y="372" width="400" height="1.5" fill="#7d6247" opacity="0.6" />
      <ellipse cx="196" cy="384" rx="120" ry="10" fill="#2b1f15" opacity="0.4" filter={`url(#${uid}-soft)`} />
      <ellipse cx="296" cy="384" rx="46" ry="7" fill="#2b1f15" opacity="0.4" filter={`url(#${uid}-soft)`} />
      <path d="M150 196 C 142 146 166 104 198 66" fill="none" stroke="#3e4d3f" strokeWidth="2.5" strokeLinecap="round" />
      <ellipse cx="190" cy="88" rx="20" ry="7" transform="rotate(-50 190 88)" fill="#56684f" />
      <ellipse cx="160" cy="122" rx="18" ry="6.5" transform="rotate(-128 160 122)" fill="#56684f" />
      <ellipse cx="172" cy="150" rx="16" ry="6" transform="rotate(-36 172 150)" fill="#647659" />
      <path d="M150 380 C 108 380 92 334 100 290 C 106 256 130 238 132 208 L 132 192 L 172 192 L 172 208 C 174 238 198 256 204 290 C 212 334 196 380 154 380 Z" fill={`url(#${uid}-vase)`} />
      <rect x="128" y="186" width="48" height="9" rx="4" fill="#1d2620" />
      <circle cx="296" cy="346" r="34" fill={`url(#${uid}-orb)`} />
      <rect x="236" y="362" width="46" height="18" fill="#efe6d6" />
    </>
  );
}

function Vauquelin({ uid }: SceneProps) {
  return (
    <>
      <defs>
        <linearGradient id={`${uid}-wall`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#35443a" />
          <stop offset="1" stopColor="#252f29" />
        </linearGradient>
        <linearGradient id={`${uid}-door`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#f0e2c6" />
          <stop offset="1" stopColor="#cdb38a" />
        </linearGradient>
        <radialGradient id={`${uid}-lamp`}>
          <stop offset="0" stopColor="#fff3d6" stopOpacity="0.9" />
          <stop offset="1" stopColor="#fff3d6" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect width="400" height="500" fill={`url(#${uid}-wall)`} />
      <g fill="none" stroke="#46574b" strokeWidth="1">
        <path d="M0 120 H400 M0 250 H400 M0 380 H400" />
      </g>
      <path d="M118 430 V224 a82 82 0 0 1 164 0 V430 Z" fill="#1b231e" />
      <path d="M130 430 V226 a70 70 0 0 1 140 0 V430 Z" fill={`url(#${uid}-door)`} />
      <path d="M200 156 V430" stroke="#b79b72" strokeWidth="1.5" />
      <path d="M130 226 a70 70 0 0 1 140 0 Z" fill="#e3d0ab" />
      <g stroke="#b79b72" strokeWidth="1.5">
        <path d="M200 226 V156 M200 226 L151 177 M200 226 L249 177 M130 226 H270" />
      </g>
      <circle cx="188" cy="330" r="4" fill="#8a6c3f" />
      <circle cx="212" cy="330" r="4" fill="#8a6c3f" />
      <circle cx="200" cy="96" r="60" fill={`url(#${uid}-lamp)`} />
      <rect x="194" y="70" width="12" height="30" rx="5" fill="#f6ecd4" />
      <rect x="198" y="52" width="4" height="20" fill="#9a7a4c" />
      <rect x="100" y="430" width="200" height="16" fill="#d7c19b" />
      <rect x="84" y="446" width="232" height="16" fill="#c5ad85" />
      <rect x="66" y="462" width="268" height="38" fill="#b39a72" />
      <rect x="302" y="276" width="42" height="56" rx="2" fill="#a88753" />
      <text x="323" y="312" textAnchor="middle" fontSize="26" fill="#2a352e" fontStyle="italic">
        V
      </text>
      <rect x="42" y="392" width="38" height="38" fill="#b0603f" />
      <path d="M61 392 V318" stroke="#2a221a" strokeWidth="3" />
      <g fill="#6f8266">
        <circle cx="61" cy="296" r="30" />
        <circle cx="42" cy="322" r="18" />
        <circle cx="82" cy="320" r="20" />
      </g>
    </>
  );
}

function Ormeau({ uid }: SceneProps) {
  return (
    <>
      <defs>
        <linearGradient id={`${uid}-wall`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ead6c6" />
          <stop offset="1" stopColor="#d2b29c" />
        </linearGradient>
        <linearGradient id={`${uid}-amber`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#e7b96f" />
          <stop offset="1" stopColor="#a2602b" />
        </linearGradient>
        <radialGradient id={`${uid}-stone`} cx="34%" cy="30%" r="85%">
          <stop offset="0" stopColor="#f1c98a" />
          <stop offset="0.7" stopColor="#b9743a" />
          <stop offset="1" stopColor="#8a4f22" />
        </radialGradient>
      </defs>
      <rect width="600" height="400" fill={`url(#${uid}-wall)`} />
      <circle cx="452" cy="150" r="150" fill="#c58c70" opacity="0.5" />
      <rect y="300" width="600" height="100" fill="#c4a088" />
      <ellipse cx="216" cy="306" rx="130" ry="9" fill="#3a251a" opacity="0.35" filter={`url(#${uid}-soft)`} />
      <ellipse cx="430" cy="306" rx="120" ry="9" fill="#3a251a" opacity="0.35" filter={`url(#${uid}-soft)`} />
      <rect x="130" y="236" width="150" height="66" fill="#f3e9db" />
      <rect x="130" y="236" width="150" height="4" fill="#fbf5ea" />
      <rect x="346" y="196" width="160" height="106" fill="#e9dac7" />
      <rect x="346" y="196" width="160" height="4" fill="#f6ecdc" />
      <rect x="176" y="128" width="58" height="108" rx="5" fill={`url(#${uid}-amber)`} />
      <rect x="182" y="134" width="8" height="96" rx="4" fill="#fff" opacity="0.3" />
      <rect x="192" y="104" width="26" height="24" fill="#241d17" />
      <rect x="186" y="170" width="38" height="36" fill="#f6f1e7" />
      <path d="M192 182 H218 M192 189 H218 M197 196 H213" stroke="#241d17" strokeWidth="1" />
      <ellipse cx="426" cy="146" rx="56" ry="50" fill={`url(#${uid}-stone)`} />
      <rect x="416" y="82" width="20" height="18" fill="#c9a15f" />
      <circle cx="426" cy="72" r="15" fill="#241d17" />
      <circle cx="426" cy="150" r="17" fill="#f6f1e7" />
      <path d="M418 150 H434 M421 155 H431" stroke="#241d17" strokeWidth="1" />
      <path d="M548 300 C 540 240 556 190 580 150" fill="none" stroke="#5b6b52" strokeWidth="2" />
      <ellipse cx="566" cy="178" rx="16" ry="5" transform="rotate(-52 566 178)" fill="#6f8266" />
      <ellipse cx="546" cy="226" rx="15" ry="5" transform="rotate(-124 546 226)" fill="#6f8266" />
      <circle cx="78" cy="286" r="16" fill="#efe3d3" />
    </>
  );
}

function Lys({ uid }: SceneProps) {
  const bottle = (x: number, fill: string, label: string) => (
    <g key={x}>
      <path
        d={`M${x} 400 V266 C ${x} 238 ${x + 19} 228 ${x + 19} 200 V146 H${x + 37} V200 C ${x + 37} 228 ${x + 56} 238 ${x + 56} 266 V400 Z`}
        fill={fill}
      />
      <rect x={x + 17} y="140" width="22" height="34" fill="#c2a878" />
      <rect x={x + 6} y="292" width="44" height="74" fill={label} />
      <path
        d={`M${x + 28} 306 c -7 6 -7 14 0 20 c 7 -6 7 -14 0 -20 Z M${x + 20} 318 c -4 4 -2 9 4 10 M${x + 36} 318 c 4 4 2 9 -4 10 M${x + 19} 332 H${x + 37}`}
        fill="none"
        stroke="#241d17"
        strokeWidth="1"
      />
      <path d={`M${x + 14} 346 H${x + 42} M${x + 18} 353 H${x + 38}`} stroke="#241d17" strokeWidth="0.8" />
      <rect x={x + 5} y="270" width="5" height="124" rx="2.5" fill="#fff" opacity="0.14" />
    </g>
  );
  return (
    <>
      <defs>
        <linearGradient id={`${uid}-wall`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#d3d6c5" />
          <stop offset="1" stopColor="#b8bda5" />
        </linearGradient>
      </defs>
      <rect width="400" height="500" fill={`url(#${uid}-wall)`} />
      <path d="M62 400 V190 a138 138 0 0 1 276 0 V400 Z" fill="#e4e6d8" />
      <polygon points="62,190 200,52 338,400 62,400" fill="#f4f3e8" opacity="0.4" />
      <rect y="400" width="400" height="100" fill="#a3a88e" />
      <rect y="400" width="400" height="1.5" fill="#868b72" />
      <ellipse cx="204" cy="408" rx="150" ry="9" fill="#232b22" opacity="0.4" filter={`url(#${uid}-soft)`} />
      {bottle(96, "#27332a", "#f6f1e7")}
      {bottle(172, "#2b1f1a", "#ece5d6")}
      {bottle(248, "#27332a", "#e2dac8")}
      <circle cx="336" cy="386" r="14" fill="#c9b27c" />
      <circle cx="60" cy="390" r="10" fill="#8f9a78" />
    </>
  );
}

function Maren({ uid }: SceneProps) {
  const bowl = (cx: number, y: number, half: number, depth: number, fill: string) => (
    <path
      d={`M${cx - half} ${y} H${cx + half} C ${cx + half * 0.9} ${y + depth * 0.8} ${cx + half * 0.45} ${y + depth} ${cx} ${y + depth} C ${cx - half * 0.45} ${y + depth} ${cx - half * 0.9} ${y + depth * 0.8} ${cx - half} ${y} Z`}
      fill={fill}
    />
  );
  return (
    <>
      <defs>
        <linearGradient id={`${uid}-wall`} x1="0" y1="0" x2="1" y2="1">
          <stop offset="0" stopColor="#ebe1d0" />
          <stop offset="1" stopColor="#d6c6ac" />
        </linearGradient>
        <linearGradient id={`${uid}-clay`} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0" stopColor="#f6f0e4" />
          <stop offset="1" stopColor="#d8ccb8" />
        </linearGradient>
      </defs>
      <rect width="600" height="400" fill={`url(#${uid}-wall)`} />
      <circle cx="176" cy="176" r="128" fill="#b8684a" opacity="0.85" />
      <rect y="304" width="600" height="96" fill="#c6b292" />
      <rect y="304" width="600" height="1.5" fill="#a48f6f" />
      <ellipse cx="300" cy="312" rx="230" ry="9" fill="#33261a" opacity="0.32" filter={`url(#${uid}-soft)`} />
      {bowl(210, 246, 84, 58, "#2a352e")}
      {bowl(210, 206, 62, 42, `url(#${uid}-clay)`)}
      {bowl(210, 176, 44, 32, "#c98d6d")}
      <path d="M372 304 C 344 250 352 176 380 132 L 380 96 H 420 V 132 C 448 176 456 250 428 304 Z" fill={`url(#${uid}-clay)`} />
      <ellipse cx="400" cy="96" rx="20" ry="5" fill="#bcae98" />
      <ellipse cx="506" cy="254" rx="42" ry="50" fill="#d6ae66" />
      <ellipse cx="506" cy="254" rx="30" ry="37" fill="none" stroke="#b98f48" strokeWidth="1.5" />
      <g fill="#8d7a5e" opacity="0.7">
        <circle cx="388" cy="180" r="1.6" />
        <circle cx="410" cy="220" r="1.3" />
        <circle cx="396" cy="258" r="1.8" />
        <circle cx="418" cy="158" r="1.2" />
        <circle cx="190" cy="222" r="1.5" />
        <circle cx="230" cy="230" r="1.2" />
      </g>
    </>
  );
}

const scenes: Record<PlateId, { wide: boolean; Scene: (props: SceneProps) => React.ReactNode }> = {
  "nature-morte": { wide: false, Scene: NatureMorte },
  vauquelin: { wide: false, Scene: Vauquelin },
  ormeau: { wide: true, Scene: Ormeau },
  lys: { wide: false, Scene: Lys },
  maren: { wide: true, Scene: Maren },
};

export function Plate({ id, label }: { id: PlateId; label: string }) {
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const { wide, Scene } = scenes[id];
  const [width, height] = wide ? [600, 400] : [400, 500];
  return (
    <span className="d4-plate__frame">
      <svg
        className="d4-plate__art"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="xMidYMid slice"
        role="img"
        aria-label={label}
      >
        <Defs uid={uid} />
        <Scene uid={uid} />
        <Grain uid={uid} width={width} height={height} />
      </svg>
    </span>
  );
}
