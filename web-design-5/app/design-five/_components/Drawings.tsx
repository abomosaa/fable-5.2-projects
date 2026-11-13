import type { DrawingId } from "../content";

/** Line drawings for the work cards: one stroke weight, no fills, like a plot. */

function Matrix() {
  const cells = [];
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 6; col++) {
      const x = 24 + col * 46;
      const y = 22 + row * 40;
      const variant = (row + col) % 4;
      cells.push(
        <g key={`${row}-${col}`}>
          <rect x={x} y={y} width="38" height="30" rx={variant === 1 ? 15 : 3} />
          {variant === 0 ? <path d={`M${x + 8} ${y + 15} h22`} /> : null}
          {variant === 2 ? <circle cx={x + 19} cy={y + 15} r="6" /> : null}
          {variant === 3 ? <path d={`M${x + 8} ${y + 11} h22 M${x + 8} ${y + 19} h14`} /> : null}
        </g>,
      );
    }
  }
  return (
    <>
      {cells}
      <path d="M24 12 h268 M24 8 v8 M292 8 v8" className="d5-dwg__dim" />
    </>
  );
}

function Page() {
  return (
    <>
      <rect x="40" y="16" width="240" height="168" rx="4" />
      <path d="M40 38 h240 M52 27 h30 M210 27 h14 M232 27 h14 M254 27 h14" />
      <rect x="56" y="54" width="118" height="70" />
      <path d="M56 54 l118 70 M174 54 l-118 70" className="d5-dwg__dim" />
      <path d="M190 60 h74 M190 74 h74 M190 88 h52" />
      <rect x="190" y="104" width="46" height="18" rx="9" />
      <rect x="56" y="138" width="62" height="34" />
      <rect x="129" y="138" width="62" height="34" />
      <rect x="202" y="138" width="62" height="34" />
      <path d="M292 16 v168 M288 16 h8 M288 184 h8" className="d5-dwg__dim" />
    </>
  );
}

function Dashboard() {
  return (
    <>
      <rect x="24" y="16" width="272" height="168" rx="4" />
      <path d="M84 16 v168 M84 48 h212" />
      <path d="M38 34 h32 M38 60 h32 M38 76 h24 M38 92 h32 M38 108 h20" />
      <path d="M100 150 l28 -34 l26 16 l30 -52 l28 30 l26 -44 l34 22" />
      <path d="M100 166 h180 M100 70 v96" className="d5-dwg__dim" />
      <circle cx="184" cy="80" r="4" />
      <circle cx="238" cy="66" r="4" />
      <rect x="100" y="26" width="46" height="14" rx="7" />
      <rect x="154" y="26" width="46" height="14" rx="7" />
      <circle cx="270" cy="33" r="7" />
    </>
  );
}

function Mobile() {
  const phone = (x: number, y: number) => (
    <g key={x}>
      <rect x={x} y={y} width="76" height="150" rx="12" />
      <path d={`M${x + 28} ${y + 10} h20`} />
      <rect x={x + 12} y={y + 28} width="52" height="38" rx="3" />
      <path d={`M${x + 12} ${y + 80} h52 M${x + 12} ${y + 92} h36`} />
      <rect x={x + 12} y={y + 112} width="52" height="18" rx="9" />
    </g>
  );
  return (
    <>
      {phone(34, 34)}
      {phone(122, 18)}
      {phone(210, 34)}
      <path d="M110 108 h12 M198 108 h12" className="d5-dwg__dim" />
      <path d="M116 104 l6 4 l-6 4 M204 104 l6 4 l-6 4" className="d5-dwg__dim" />
    </>
  );
}

const drawings: Record<DrawingId, () => React.ReactNode> = {
  matrix: Matrix,
  page: Page,
  dashboard: Dashboard,
  mobile: Mobile,
};

export function Drawing({ id }: { id: DrawingId }) {
  const Art = drawings[id];
  return (
    <svg className="d5-dwg" viewBox="0 0 320 200" aria-hidden="true">
      <Art />
    </svg>
  );
}
