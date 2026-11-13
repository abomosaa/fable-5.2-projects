"use client";

import { useState } from "react";

type Star = {
  id: string;
  name: string;
  latin: string;
  ra: number; // بالساعات
  dec: number; // بالدرجات
  mag: string;
  magValue: number;
  distance: string;
  kind: string;
  color: string;
  note: string;
  label: "left" | "right" | "above";
};

const stars: Star[] = [
  {
    id: "betelgeuse",
    name: "مَنكِب الجوزاء",
    latin: "Betelgeuse",
    ra: 5.919,
    dec: 7.41,
    mag: "0.5",
    magValue: 0.5,
    distance: "550",
    kind: "عملاق أحمر فائق",
    color: "#ffb08a",
    note: "دخل اللاتينيةَ محرَّفًا عن «يد الجوزاء» فصار Betelgeuse. عملاق أحمر يكبر الشمس مئات المرّات، ويتغيّر لمعانه من شهر إلى شهر.",
    label: "left",
  },
  {
    id: "bellatrix",
    name: "النّاجِذ",
    latin: "Bellatrix",
    ra: 5.419,
    dec: 6.35,
    mag: "1.64",
    magValue: 1.64,
    distance: "250",
    kind: "عملاق أزرق",
    color: "#cfe0ff",
    note: "يُعرف أيضًا بالمِرزَم، وهو المنكب الآخر للجوزاء؛ ثالث نجوم الكوكبة لمعانًا.",
    label: "right",
  },
  {
    id: "mintaka",
    name: "المِنطَقة",
    latin: "Mintaka",
    ra: 5.533,
    dec: -0.3,
    mag: "2.23",
    magValue: 2.23,
    distance: "1,200",
    kind: "نجم متعدّد أزرق",
    color: "#d6e4ff",
    note: "المِنطَقة هي الحزام. أول نجوم الحزام الثلاثة من جهة الغرب، ويكاد يقع على خط الاستواء السماوي تمامًا.",
    label: "right",
  },
  {
    id: "alnilam",
    name: "النِّظام",
    latin: "Alnilam",
    ra: 5.604,
    dec: -1.2,
    mag: "1.69",
    magValue: 1.69,
    distance: "2,000",
    kind: "عملاق أزرق فائق",
    color: "#d6e4ff",
    note: "النِّظام هو سِلك اللؤلؤ. أوسط نجوم الحزام وألمعها، وأبعدها عنّا كذلك.",
    label: "above",
  },
  {
    id: "alnitak",
    name: "النِّطاق",
    latin: "Alnitak",
    ra: 5.679,
    dec: -1.94,
    mag: "1.77",
    magValue: 1.77,
    distance: "1,200",
    kind: "نجم ثلاثي أزرق",
    color: "#d6e4ff",
    note: "النِّطاق ما يُشدّ على الوسط. آخر نجوم الحزام شرقًا، وبجواره يختبئ سديم رأس الحصان.",
    label: "left",
  },
  {
    id: "saiph",
    name: "سيف الجبّار",
    latin: "Saiph",
    ra: 5.796,
    dec: -9.67,
    mag: "2.09",
    magValue: 2.09,
    distance: "650",
    kind: "عملاق أزرق فائق",
    color: "#cfe0ff",
    note: "حمل اسم السيف وإن كان يقع اليوم عند ركبة الجبّار؛ انتقل إليه الاسم من نجوم السيف المجاورة.",
    label: "left",
  },
  {
    id: "rigel",
    name: "رِجل الجوزاء",
    latin: "Rigel",
    ra: 5.242,
    dec: -8.2,
    mag: "0.13",
    magValue: 0.13,
    distance: "860",
    kind: "عملاق أزرق فائق",
    color: "#c4d8ff",
    note: "قدم الجوزاء اليسرى، وألمع نجوم الكوكبة. يشعّ بضوء عشرات الآلاف من الشموس.",
    label: "right",
  },
  {
    id: "aldebaran",
    name: "الدَّبَران",
    latin: "Aldebaran",
    ra: 4.599,
    dec: 16.51,
    mag: "0.86",
    magValue: 0.86,
    distance: "65",
    kind: "عملاق برتقالي",
    color: "#ffc48a",
    note: "الدَّبَران هو التابع، لأنه يطلع بعد الثريّا ويتبعها في مسيرها. وهو عين الثور الحمراء.",
    label: "left",
  },
  {
    id: "sirius",
    name: "الشِّعرى اليمانية",
    latin: "Sirius",
    ra: 6.752,
    dec: -16.72,
    mag: "−1.46",
    magValue: -1.46,
    distance: "8.6",
    kind: "نجم أبيض مزدوج",
    color: "#f2f6ff",
    note: "ألمع نجوم السماء قاطبة ومن أقربها إلى الشمس. عرفها العرب قديمًا وسمّوها العَبور.",
    label: "right",
  },
];

const SIZE = 640;
const SCALE = 12;
const CENTER_RA = 5.6;

function project(ra: number, dec: number) {
  return {
    x: SIZE / 2 - (ra - CENTER_RA) * 15 * SCALE,
    y: SIZE / 2 - dec * SCALE,
  };
}

const meissa = project(5.585, 9.93);
const points = Object.fromEntries(stars.map((s) => [s.id, project(s.ra, s.dec)]));

const figure: [string, string][] = [
  ["betelgeuse", "bellatrix"],
  ["betelgeuse", "alnitak"],
  ["bellatrix", "mintaka"],
  ["mintaka", "alnilam"],
  ["alnilam", "alnitak"],
  ["alnitak", "saiph"],
  ["mintaka", "rigel"],
  ["saiph", "rigel"],
];

// نجوم خلفية ثابتة (مولّد عشوائي ببذرة ثابتة حتى يتطابق الخادم والمتصفح)
function seeded(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = seeded(1448);
const dust = Array.from({ length: 150 }, () => {
  const a = rand() * Math.PI * 2;
  const r = Math.sqrt(rand()) * 300;
  return {
    x: Math.round((SIZE / 2 + Math.cos(a) * r) * 10) / 10,
    y: Math.round((SIZE / 2 + Math.sin(a) * r) * 10) / 10,
    r: Math.round((0.35 + rand() * 0.9) * 100) / 100,
    o: Math.round((0.2 + rand() * 0.5) * 100) / 100,
  };
});

function radius(mag: number) {
  return Math.max(2.6, 7.2 - (mag + 1.5) * 1.25);
}

export function SkyChart() {
  const [activeId, setActiveId] = useState("aldebaran");
  const active = stars.find((s) => s.id === activeId) ?? stars[0];

  return (
    <div className="sh-chart">
      <div className="sh-chart-map">
        <svg viewBox={`0 0 ${SIZE} ${SIZE}`} direction="rtl" aria-hidden="true">
          <defs>
            <radialGradient id="sh-chart-bg" cx="50%" cy="50%" r="50%">
              <stop offset="0" stopColor="#141c48" />
              <stop offset="0.65" stopColor="#0b1130" />
              <stop offset="1" stopColor="#080c22" />
            </radialGradient>
            <radialGradient id="sh-glow" cx="50%" cy="50%" r="50%">
              <stop offset="0" stopColor="#fff" stopOpacity="0.55" />
              <stop offset="1" stopColor="#fff" stopOpacity="0" />
            </radialGradient>
            <clipPath id="sh-chart-clip">
              <circle cx={SIZE / 2} cy={SIZE / 2} r="304" />
            </clipPath>
          </defs>

          <circle cx={SIZE / 2} cy={SIZE / 2} r="304" fill="url(#sh-chart-bg)" />

          <g clipPath="url(#sh-chart-clip)">
            {/* شبكة الإحداثيات */}
            <g className="sh-chart-grid">
              {[-20, -10, 0, 10, 20].map((dec) => (
                <line
                  key={dec}
                  x1="0"
                  x2={SIZE}
                  y1={SIZE / 2 - dec * SCALE}
                  y2={SIZE / 2 - dec * SCALE}
                  className={dec === 0 ? "sh-chart-equator" : undefined}
                />
              ))}
              {[4.5, 5, 5.5, 6, 6.5, 7].map((ra) => (
                <line
                  key={ra}
                  y1="0"
                  y2={SIZE}
                  x1={project(ra, 0).x}
                  x2={project(ra, 0).x}
                />
              ))}
            </g>

            {dust.map((d, i) => (
              <circle key={i} cx={d.x} cy={d.y} r={d.r} fill="#dfe6ff" opacity={d.o} />
            ))}

            {/* خط الحزام الدالّ على الشعرى والدبران */}
            <line
              className="sh-chart-pointer"
              x1={points.sirius.x}
              y1={points.sirius.y}
              x2={points.alnilam.x}
              y2={points.alnilam.y}
            />
            <line
              className="sh-chart-pointer"
              x1={points.alnilam.x}
              y1={points.alnilam.y}
              x2={points.aldebaran.x}
              y2={points.aldebaran.y}
            />

            {/* شكل الكوكبة */}
            <g className="sh-chart-figure">
              {figure.map(([a, b]) => (
                <line
                  key={a + b}
                  x1={points[a].x}
                  y1={points[a].y}
                  x2={points[b].x}
                  y2={points[b].y}
                />
              ))}
              <line x1={meissa.x} y1={meissa.y} x2={points.betelgeuse.x} y2={points.betelgeuse.y} />
              <line x1={meissa.x} y1={meissa.y} x2={points.bellatrix.x} y2={points.bellatrix.y} />
            </g>
            <circle cx={meissa.x} cy={meissa.y} r="2.4" fill="#d6e4ff" />
          </g>

          <circle cx={SIZE / 2} cy={SIZE / 2} r="304" className="sh-chart-rim" />
          <circle cx={SIZE / 2} cy={SIZE / 2} r="314" className="sh-chart-rim sh-chart-rim-outer" />

          <text x={SIZE / 2} y="34" className="sh-chart-compass">
            شمال
          </text>
          <text x="36" y={SIZE / 2 + 4} className="sh-chart-compass">
            شرق
          </text>
          <text x={SIZE - 36} y={SIZE / 2 + 4} className="sh-chart-compass">
            غرب
          </text>

          {stars.map((s) => {
            const p = points[s.id];
            const r = radius(s.magValue);
            const on = s.id === activeId;
            const labelX =
              s.label === "left" ? p.x - r - 10 : s.label === "right" ? p.x + r + 10 : p.x;
            const labelY = s.label === "above" ? p.y - r - 12 : p.y + 5;
            const anchor =
              s.label === "left" ? "start" : s.label === "right" ? "end" : "middle";
            return (
              <g
                key={s.id}
                className={on ? "sh-star sh-star-on" : "sh-star"}
                onClick={() => setActiveId(s.id)}
                onMouseEnter={() => setActiveId(s.id)}
              >
                <circle cx={p.x} cy={p.y} r="22" fill="transparent" />
                <circle cx={p.x} cy={p.y} r={r * 3.4} fill="url(#sh-glow)" opacity={on ? 0.9 : 0.4} />
                {on && <circle cx={p.x} cy={p.y} r={r + 8} className="sh-star-ring" />}
                <circle cx={p.x} cy={p.y} r={r} fill={s.color} />
                <text x={labelX} y={labelY} textAnchor={anchor}>
                  {s.name}
                </text>
              </g>
            );
          })}
        </svg>
        <p className="sh-chart-caption">
          كوكبة الجبّار وما حولها، كما تُرى من المرصد في ليالي الشتاء. خط الحزام
          المنقّط يدلّ على الشِّعرى شرقًا وعلى الدَّبَران غربًا.
        </p>
      </div>

      <div className="sh-chart-side">
        <ul className="sh-chart-list">
          {stars.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                aria-pressed={s.id === activeId}
                onClick={() => setActiveId(s.id)}
                onFocus={() => setActiveId(s.id)}
                onMouseEnter={() => setActiveId(s.id)}
              >
                <i style={{ background: s.color }} aria-hidden="true" />
                <span>{s.name}</span>
                <span dir="ltr" lang="en">
                  {s.latin}
                </span>
              </button>
            </li>
          ))}
        </ul>

        <article className="sh-chart-card" aria-live="polite">
          <header>
            <h3>{active.name}</h3>
            <p dir="ltr" lang="en">
              {active.latin}
            </p>
          </header>
          <p className="sh-chart-note">{active.note}</p>
          <dl>
            <div>
              <dt>القدر الظاهري</dt>
              <dd dir="ltr">{active.mag}</dd>
            </div>
            <div>
              <dt>البُعد بالسنين الضوئية</dt>
              <dd dir="ltr">{active.distance}</dd>
            </div>
            <div>
              <dt>النوع</dt>
              <dd className="sh-chart-kind">{active.kind}</dd>
            </div>
          </dl>
        </article>
      </div>
    </div>
  );
}
