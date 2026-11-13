import type { Metadata } from "next";
import Link from "next/link";
import { kufi } from "../_fonts/kufi";
import { plexArabic, plexMono } from "./fonts";
import { SkyChart } from "./sky-chart";
import "./suhail.css";

export const metadata: Metadata = {
  title: "مرصد سُهيل — ليالي رصد في قلب الصحراء",
  description:
    "مرصد سُهيل الفلكي على حافّة الربع الخالي: ليالي رصد ومبيت تحت المجرّة، وخريطة نجوم بأسمائها العربية.",
};

function seeded(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const rand = seeded(2019);
const tints = ["#ffffff", "#ffffff", "#dfe6ff", "#cdd8ff", "#ffe8c4"];
const heroStars = Array.from({ length: 340 }, () => {
  const y = Math.pow(rand(), 1.35) * 900;
  return {
    x: Math.round(rand() * 16000) / 10,
    y: Math.round(y * 10) / 10,
    r: Math.round((0.35 + Math.pow(rand(), 3) * 1.5) * 100) / 100,
    o: Math.round((0.35 + rand() * 0.65) * (1 - y / 1500) * 100) / 100,
    c: tints[Math.floor(rand() * tints.length)],
    t: Math.floor(rand() * 9),
  };
});

const zodiac = [
  "الحَمَل",
  "الثَّور",
  "الجوزاء",
  "السَّرَطان",
  "الأسد",
  "السُّنبُلة",
  "الميزان",
  "العقرب",
  "القَوس",
  "الجَدي",
  "الدَّلو",
  "الحوت",
];

function StarField() {
  return (
    <svg
      className="sh-stars"
      viewBox="0 0 1600 900"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
    >
      {heroStars.map((s, i) => (
        <circle
          key={i}
          cx={s.x}
          cy={s.y}
          r={s.r}
          fill={s.c}
          opacity={s.o}
          className={s.t < 3 ? `sh-tw sh-tw${s.t}` : undefined}
        />
      ))}
    </svg>
  );
}

function Astrolabe() {
  const c = 400;
  const ticks = Array.from({ length: 360 }, (_, i) => {
    const len = i % 30 === 0 ? 26 : i % 10 === 0 ? 16 : i % 5 === 0 ? 10 : 5;
    return <line key={i} x1={c} y1={22} x2={c} y2={22 + len} transform={`rotate(${i} ${c} ${c})`} />;
  });
  return (
    <svg className="sh-astrolabe" viewBox="0 0 800 800" direction="rtl" aria-hidden="true">
      <g className="sh-astro-outer">
        <circle cx={c} cy={c} r="378" />
        <circle cx={c} cy={c} r="330" />
        <circle cx={c} cy={c} r="286" />
        <g className="sh-astro-ticks">{ticks}</g>
        {zodiac.map((name, i) => (
          <g key={name} transform={`rotate(${i * 30} ${c} ${c})`}>
            <line x1={c} y1={70} x2={c} y2={114} />
            <text x={c} y={96} transform={`rotate(15 ${c} ${c})`} textAnchor="middle">
              {name}
            </text>
          </g>
        ))}
      </g>
      <g className="sh-astro-rete">
        <circle cx={c} cy={c + 62} r="224" />
        <circle cx={c} cy={c + 62} r="212" strokeDasharray="2 7" />
        <circle cx={c} cy={c} r="150" />
        <path d={`M${c - 286} ${c}H${c + 286}M${c} ${c - 286}V${c + 286}`} />
        <path d={`M${c - 150} ${c}a150 150 0 0 1 300 0`} strokeDasharray="1 5" />
        {[
          [520, 250],
          [300, 300],
          [585, 470],
          [250, 520],
          [430, 610],
          [360, 190],
        ].map(([x, y]) => (
          <g key={`${x}-${y}`}>
            <circle cx={x} cy={y} r="3.2" className="sh-astro-dot" />
            <circle cx={x} cy={y} r="9" />
          </g>
        ))}
      </g>
      <circle cx={c} cy={c} r="5" className="sh-astro-dot" />
    </svg>
  );
}

function Mark() {
  return (
    <svg className="sh-mark" viewBox="0 0 32 32" aria-hidden="true">
      <circle cx="16" cy="16" r="14.5" fill="none" stroke="currentColor" strokeWidth="1" />
      <path
        d="M16 5c.6 6.6 4.4 10.400 11 11-6.600.6-10.400 4.400-11 11-.6-6.600-4.400-10.400-11-11 6.600-.6 10.400-4.400 11-11z"
        fill="currentColor"
      />
    </svg>
  );
}

const facts = [
  { value: "20.47° N", unit: "45.91° E", label: "الموقع" },
  { value: "612", unit: "م", label: "الارتفاع عن سطح البحر" },
  { value: "2", unit: "بورتل", label: "ظلمة السماء" },
  { value: "310", unit: "ليلة", label: "صافية في السنة" },
];

const nights = [
  {
    no: "01",
    title: "ليلة الراصد",
    text: "أربع ساعات تبدأ عند الغروب: نقرأ السماء بالعين المجرّدة كما قرأها أهل البادية، ثم ننتقل إلى التلسكوب الرئيسي لرصد الكواكب والسُّدُم.",
    meta: ["كل خميس وجمعة", "حتى 16 ضيفًا", "من الغروب إلى منتصف الليل"],
    price: "180",
  },
  {
    no: "02",
    title: "مبيت تحت المجرّة",
    text: "ليلة كاملة في مخيّم المرصد: عشاء على النار، رصد حتى الفجر، خيام مفتوحة السقف، ثم شروق من فوق الكثبان.",
    meta: ["ليالي المحاق", "حتى 24 ضيفًا", "من العصر إلى الضحى"],
    price: "640",
    featured: true,
  },
  {
    no: "03",
    title: "ورشة التصوير الفلكي",
    text: "يومان مع مصوّري المرصد: من ضبط الكاميرا والحامل، إلى معالجة أول صورة تلتقطها لدرب التبّانة.",
    meta: ["مرّة في الشهر", "8 مشاركين فقط", "يومان وليلة"],
    price: "1,250",
  },
];

const calendar = [
  {
    day: "14",
    month: "ديسمبر",
    title: "ذروة شهب التوأميات",
    text: "أغزر زخّات السنة: حتى مئة وعشرين شهابًا في الساعة تحت سماء مظلمة.",
    tag: "رؤية ممتازة",
  },
  {
    day: "21",
    month: "ديسمبر",
    title: "الانقلاب الشتوي",
    text: "أطول ليالي السنة، والجبّار في كبد السماء عند منتصف الليل.",
    tag: "ليلة طويلة",
  },
  {
    day: "03",
    month: "يناير",
    title: "ذروة شهب الرباعيات",
    text: "زخّة قصيرة وحادّة قبيل الفجر، والقمر هلال نحيل لا يزاحمها.",
    tag: "رؤية جيدة",
  },
  {
    day: "07",
    month: "يناير",
    title: "المحاق",
    text: "أظلم ليالي الشهر، وموعد «مبيت تحت المجرّة» الأول في العام الجديد.",
    tag: "أظلم سماء",
  },
  {
    day: "11",
    month: "فبراير",
    title: "المشتري في التقابل",
    text: "أقرب ما يكون وألمع ما يكون، وأقماره الأربعة في متناول أي تلسكوب.",
    tag: "طوال الليل",
  },
];

export default function Suhail() {
  return (
    <div className={`sh-root ${kufi.variable} ${plexArabic.variable} ${plexMono.variable}`}>
      <header className="sh-nav">
        <a href="#sh-top" className="sh-logo">
          <Mark />
          <span>مرصد سُهيل</span>
        </a>
        <nav aria-label="أقسام الموقع">
          <a href="#about">المرصد</a>
          <a href="#sky">خريطة النجوم</a>
          <a href="#nights">الليالي</a>
          <a href="#calendar">التقويم</a>
        </nav>
        <a href="#book" className="sh-btn sh-btn-small">
          احجز ليلتك
        </a>
      </header>

      <main id="sh-top">
        {/* ——— الواجهة ——— */}
        <section className="sh-hero">
          <StarField />
          <div className="sh-milky" aria-hidden="true" />
          <Astrolabe />

          <div className="sh-hero-copy">
            <p className="sh-eyebrow">
              <span dir="ltr">N 20.47°</span> مرصد فلكي على حافّة الربع الخالي
            </p>
            <h1>
              السماء كما رآها
              <br />
              <em>الأوّلون</em>
            </h1>
            <p className="sh-hero-lede">
              ليالي رصد في قلب الصحراء، بعيدًا عن أضواء المدن، حيث ما زالت النجوم
              تحمل أسماءها العربية.
            </p>
            <div className="sh-hero-actions">
              <a href="#book" className="sh-btn">
                احجز ليلتك
              </a>
              <a href="#sky" className="sh-link">
                استكشف خريطة النجوم <span aria-hidden="true">←</span>
              </a>
            </div>
          </div>

          <div className="sh-canopus" aria-hidden="true">
            <i />
            <span>
              سُهيل
              <small dir="ltr">Canopus · −0.74</small>
            </span>
          </div>

          <svg className="sh-dunes" viewBox="0 0 1600 260" preserveAspectRatio="none" aria-hidden="true">
            <path
              d="M0 150C180 120 320 70 520 92s330 82 560 60 330-78 520-52v160H0z"
              fill="#0d1230"
            />
            <path
              d="M0 196c220-44 420-58 640-22s380 62 560 30 260-52 400-40v96H0z"
              fill="#090d24"
            />
            <path
              d="M0 236c260-34 520-30 800-10s520 6 800-22v56H0z"
              fill="#060914"
            />
          </svg>

          <dl className="sh-facts">
            {facts.map((f) => (
              <div key={f.label}>
                <dt>{f.label}</dt>
                <dd>
                  <span dir="ltr">{f.value}</span>
                  <small dir="auto">{f.unit}</small>
                </dd>
              </div>
            ))}
          </dl>
        </section>

        {/* ——— عن المرصد ——— */}
        <section id="about" className="sh-about sh-wrap">
          <p className="sh-index">
            <span dir="ltr">01</span> المرصد
          </p>
          <h2 className="sh-statement">
            على بُعد ثلاث ساعات من أقرب مدينة، تنطفئ الأضواء كلّها…
            <span> وتبقى السماء.</span>
          </h2>
          <div className="sh-about-grid">
            <div className="sh-about-text">
              <p>
                أُقيم مرصد سُهيل عام 2019 على حافّة الربع الخالي، حيث لا يحجب
                النجومَ ضوءٌ ولا غبارُ مدينة. نفتح أبوابنا للهواة والعائلات
                والباحثين، ونرصد بتلسكوب عاكس قطره ستّون سنتيمترًا.
              </p>
              <p>
                ونحكي السماء كما حكاها أهل الصحراء: بالأنواء والمنازل، وبأسماء
                النجوم التي ما زال العالم كلّه ينطقها بالعربية.
              </p>
            </div>
            <figure className="sh-saying">
              <blockquote>
                إذا طلع سُهيل،
                <br />
                برد الليل،
                <br />
                وخيف السَّيل.
              </blockquote>
              <figcaption>
                <strong>من أسجاع العرب في الأنواء</strong>
                يطلع سُهيل على جزيرة العرب في أواخر أغسطس، فيعدّه أهل البادية
                بشيرًا بانكسار القيظ.
              </figcaption>
            </figure>
          </div>
        </section>

        {/* ——— خريطة النجوم ——— */}
        <section id="sky" className="sh-sky">
          <div className="sh-wrap">
            <header className="sh-head">
              <p className="sh-index">
                <span dir="ltr">02</span> خريطة النجوم
              </p>
              <h2>نجومٌ بأسمائها الأولى</h2>
              <p>
                أكثر من مئتي نجم لامع يحمل اليوم اسمًا عربيّ الأصل. هذه تسعة
                منها تتوسّط سماء الشتاء؛ مرّ على أيّ نجم لتعرف حكاية اسمه.
              </p>
            </header>
            <SkyChart />
          </div>
        </section>

        {/* ——— الليالي ——— */}
        <section id="nights" className="sh-nights sh-wrap">
          <header className="sh-head">
            <p className="sh-index">
              <span dir="ltr">03</span> الليالي
            </p>
            <h2>ثلاث طرق لقضاء الليل</h2>
            <p>
              كل التجارب يقودها فلكيّو المرصد، وتشمل النقل من نقطة التجمّع،
              والقهوة والتمر، ومقعدًا دافئًا تحت السماء.
            </p>
          </header>
          <ul className="sh-cards">
            {nights.map((n) => (
              <li key={n.no} className={n.featured ? "sh-card sh-card-featured" : "sh-card"}>
                <p className="sh-card-no" dir="ltr">
                  {n.no}
                </p>
                {n.featured && <p className="sh-card-flag">الأكثر طلبًا</p>}
                <h3>{n.title}</h3>
                <p className="sh-card-text">{n.text}</p>
                <ul className="sh-card-meta">
                  {n.meta.map((m) => (
                    <li key={m}>{m}</li>
                  ))}
                </ul>
                <div className="sh-card-foot">
                  <p>
                    <span dir="ltr">{n.price}</span>
                    <small>ريالًا للشخص</small>
                  </p>
                  <a href="#book" aria-label={`احجز: ${n.title}`}>
                    احجز <span aria-hidden="true">←</span>
                  </a>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* ——— التقويم ——— */}
        <section id="calendar" className="sh-calendar sh-wrap">
          <header className="sh-head">
            <p className="sh-index">
              <span dir="ltr">04</span> تقويم السماء
            </p>
            <h2>
              شتاء <span className="sh-num">2026</span> –{" "}
              <span className="sh-num">2027</span>
            </h2>
          </header>
          <ol className="sh-events">
            {calendar.map((e) => (
              <li key={e.title}>
                <p className="sh-event-date">
                  <span dir="ltr">{e.day}</span>
                  {e.month}
                </p>
                <h3>{e.title}</h3>
                <p className="sh-event-text">{e.text}</p>
                <p className="sh-event-tag">{e.tag}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ——— الحجز ——— */}
        <section id="book" className="sh-book">
          <div className="sh-book-ring" aria-hidden="true" />
          <div className="sh-wrap">
            <p className="sh-index">
              <span dir="ltr">05</span> الحجز
            </p>
            <h2>
              مكانك تحت السماء
              <br />
              محفوظ إلى أن يكتمل العدد
            </h2>
            <p>
              تُفتح الحجوزات قبل كل محاق بثلاثين يومًا. اترك بريدك لنخبرك عند فتح
              الموعد القادم.
            </p>
            <form className="sh-form" action="#book">
              <label htmlFor="sh-email">البريد الإلكتروني</label>
              <input
                id="sh-email"
                type="email"
                name="email"
                dir="ltr"
                placeholder="you@example.com"
                autoComplete="email"
              />
              <button type="submit" className="sh-btn">
                أخبروني
              </button>
            </form>
          </div>
        </section>
      </main>

      <footer className="sh-footer sh-wrap">
        <div className="sh-footer-brand">
          <a href="#sh-top" className="sh-logo">
            <Mark />
            <span>مرصد سُهيل</span>
          </a>
          <p>مرصد فلكي أهلي مفتوح للجميع، على حافّة الربع الخالي.</p>
        </div>
        <dl>
          <div>
            <dt>الوصول</dt>
            <dd>
              نقطة التجمّع: السُّلَيِّل
              <br />
              ثم 40 كم بسيارات المرصد
            </dd>
          </div>
          <div>
            <dt>التواصل</dt>
            <dd>
              <span dir="ltr">salam@suhail.example</span>
              <br />
              <span dir="ltr">+966 11 000 0000</span>
            </dd>
          </div>
          <div>
            <dt>الإحداثيات</dt>
            <dd dir="ltr" className="sh-footer-coords">
              20.47° N, 45.91° E
            </dd>
          </div>
        </dl>
        <div className="sh-footer-base">
          <span>
            © <span dir="ltr">2026</span> مرصد سُهيل. أطفئ الضوء حين تغادر.
          </span>
          <Link href="/">
            <span aria-hidden="true">→</span> العودة إلى التصاميم الثلاثة
          </Link>
        </div>
      </footer>
    </div>
  );
}
