import type { WorkItem } from "../content";

/**
 * Chunky, outlined product illustrations for the work cards.
 * One shared artboard (400 × 300) and one stroke weight keep them a family.
 */

const INK = "#15120f";
const stroke = {
  stroke: INK,
  strokeWidth: 5,
  strokeLinejoin: "round",
  strokeLinecap: "round",
} as const;

function Fizzy() {
  const can = (x: number, fill: string, tilt: number) => (
    <g transform={`rotate(${tilt} ${x + 40} 160)`}>
      <rect x={x} y="70" width="80" height="170" rx="16" fill={fill} {...stroke} />
      <ellipse cx={x + 40} cy="72" rx="34" ry="9" fill="#fff" {...stroke} />
      <path d={`M${x} 140 q20 -18 40 0 t40 0 v40 q-20 18 -40 0 t-40 0 z`} fill="#fff" {...stroke} />
      <circle cx={x + 26} cy="208" r="5" fill={INK} />
      <circle cx={x + 52} cy="218" r="3.5" fill={INK} />
    </g>
  );
  return (
    <>
      {can(60, "#ffd23e", -8)}
      {can(258, "#37d39a", 9)}
      {can(160, "#2f4cff", 0)}
    </>
  );
}

function Dough() {
  return (
    <>
      <path d="M200 262 L92 76 Q200 26 308 76 Z" fill="#ffb347" {...stroke} />
      <path d="M92 76 Q200 26 308 76 L296 98 Q200 54 104 98 Z" fill="#e2783a" {...stroke} />
      <circle cx="168" cy="120" r="17" fill="#ff5533" {...stroke} />
      <circle cx="236" cy="128" r="14" fill="#ff5533" {...stroke} />
      <circle cx="200" cy="216" r="11" fill="#ff5533" {...stroke} />
      <circle cx="184" cy="164" r="7" fill={INK} />
      <circle cx="218" cy="164" r="7" fill={INK} />
      <path d="M186 184 q15 14 30 0" fill="none" {...stroke} />
      <path d="M52 232 l14 -22 M40 196 l24 4 M348 232 l-14 -22 M360 196 l-24 4" fill="none" {...stroke} />
    </>
  );
}

function Nap() {
  return (
    <>
      <rect x="132" y="34" width="136" height="236" rx="24" fill="#fff5e1" {...stroke} />
      <rect x="146" y="58" width="108" height="170" rx="10" fill="#2f4cff" {...stroke} />
      <path d="M214 104 a38 38 0 1 0 22 62 a30 30 0 0 1 -22 -62 z" fill="#ffd23e" {...stroke} />
      <circle cx="200" cy="250" r="7" fill={INK} />
      <path d="M290 96 h26 l-26 30 h26" fill="none" {...stroke} />
      <path d="M318 44 h18 l-18 22 h18" fill="none" {...stroke} strokeWidth="4" />
      <path d="M70 150 l10 -18 l10 18 l18 4 l-14 12 l4 18 l-18 -10 l-18 10 l4 -18 l-14 -12 z" fill="#fff" {...stroke} />
      <circle cx="94" cy="230" r="8" fill="#fff" {...stroke} />
    </>
  );
}

function GoodBoy() {
  return (
    <>
      <path d="M112 52 h176 l18 206 q-106 22 -212 0 z" fill="#ff6bb0" {...stroke} />
      <path d="M112 52 h176 l-8 28 h-160 z" fill="#fff" {...stroke} />
      <path d="M150 128 q-34 -4 -30 44 q22 6 34 -18 z" fill={INK} {...stroke} />
      <path d="M250 128 q34 -4 30 44 q-22 6 -34 -18 z" fill={INK} {...stroke} />
      <ellipse cx="200" cy="168" rx="56" ry="52" fill="#fff5e1" {...stroke} />
      <circle cx="180" cy="154" r="7" fill={INK} />
      <circle cx="220" cy="154" r="7" fill={INK} />
      <ellipse cx="200" cy="176" rx="12" ry="8" fill={INK} />
      <path d="M200 184 v10 M184 196 q16 14 32 0" fill="none" {...stroke} />
      <path d="M192 200 q8 22 16 0 z" fill="#ff5533" {...stroke} strokeWidth="4" />
    </>
  );
}

function Sunday() {
  return (
    <>
      <g transform="rotate(-9 150 160)">
        <rect x="70" y="60" width="150" height="196" rx="10" fill="#2f4cff" {...stroke} />
        <path d="M96 60 v196" fill="none" {...stroke} />
        <rect x="116" y="92" width="80" height="36" rx="6" fill="#fff5e1" {...stroke} />
      </g>
      <g transform="rotate(7 250 160)">
        <rect x="186" y="74" width="140" height="182" rx="10" fill="#ffd23e" {...stroke} />
        <path d="M210 118 h92 M210 148 h92 M210 178 h60" fill="none" {...stroke} />
        <path d="M206 208 l10 10 l18 -22" fill="none" {...stroke} />
      </g>
      <g transform="rotate(38 320 80)">
        <rect x="306" y="16" width="26" height="150" fill="#37d39a" {...stroke} />
        <path d="M306 166 h26 l-13 30 z" fill="#fff5e1" {...stroke} />
        <rect x="306" y="16" width="26" height="22" fill="#ff6bb0" {...stroke} />
      </g>
    </>
  );
}

function Pedal() {
  return (
    <>
      <circle cx="110" cy="196" r="62" fill="#fff5e1" {...stroke} />
      <circle cx="298" cy="196" r="62" fill="#fff5e1" {...stroke} />
      <path d="M110 196 l64 -96 h86 l38 96 M174 100 l44 96 h-108 M260 100 l-42 96 M158 78 h34 M250 72 l10 28 M238 70 h34" fill="none" {...stroke} strokeWidth="7" />
      <circle cx="218" cy="196" r="13" fill="#ffd23e" {...stroke} />
      <circle cx="96" cy="188" r="6" fill={INK} />
      <circle cx="124" cy="188" r="6" fill={INK} />
      <path d="M96 208 q14 12 28 0" fill="none" {...stroke} />
      <circle cx="284" cy="188" r="6" fill={INK} />
      <circle cx="312" cy="188" r="6" fill={INK} />
      <path d="M284 208 q14 12 28 0" fill="none" {...stroke} />
    </>
  );
}

const art: Record<WorkItem["id"], () => React.ReactNode> = {
  fizzy: Fizzy,
  dough: Dough,
  nap: Nap,
  goodboy: GoodBoy,
  sunday: Sunday,
  pedal: Pedal,
};

export function WorkArt({ id }: { id: WorkItem["id"] }) {
  const Art = art[id];
  return (
    <svg className="d3-art" viewBox="0 0 400 300" aria-hidden="true">
      <Art />
    </svg>
  );
}
