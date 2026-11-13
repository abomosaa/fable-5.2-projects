import type { Metadata } from "next";
import Link from "next/link";
import { lalezar } from "../_fonts/lalezar";
import { alexandria, handjet } from "./fonts";
import { Lineup } from "./lineup";
import "./sada.css";

export const metadata: Metadata = {
  title: "صدى — مهرجان الموسيقى المستقلة، العقبة ٢٠٢٧",
  description:
    "صدى: ثلاث ليالٍ من الموسيقى العربية المستقلة على شاطئ العقبة، من ٢٢ إلى ٢٤ أبريل ٢٠٢٧.",
};

const tickerItems = [
  "التذاكر المبكّرة حتى ١ مارس",
  "ثلاث ليالٍ",
  "أكثر من أربعين عرضًا",
  "ثلاثة مسارح",
  "بحر واحد",
];

const names = [
  "ليلى والمدار",
  "كهرباء الجبل",
  "أوتار المدينة",
  "فرقة الملح",
  "سلمى بحر",
  "نجوم الظهيرة",
  "مقام ٤٤٠",
];

const stats = [
  { n: "٣", label: "ليالٍ على الشاطئ" },
  { n: "+٤٠", label: "عرضًا حيًّا" },
  { n: "٣", label: "مسارح" },
  { n: "١٢", label: "بلدًا عربيًا" },
];

const stages = [
  {
    name: "مسرح الموج",
    tag: "المسرح الرئيسي",
    text: "على الرمل مباشرة، وظهره إلى البحر. هنا تُختتم كل ليلة بعرض نجمها.",
    cap: "٨٬٠٠٠ متفرّج",
    shape: "wave",
  },
  {
    name: "مسرح النخيل",
    tag: "عروض الغروب",
    text: "خشبة صغيرة بين النخل للعروض الهادئة والآلات الخشبية، وبجوارها الركن العائلي.",
    cap: "١٬٢٠٠ متفرّج",
    shape: "palm",
  },
  {
    name: "خيمة الصدى",
    tag: "من منتصف الليل",
    text: "إلكترونيات ومنسّقو أغانٍ تحت قماش واحد، حتى يطلع الفجر على الخليج.",
    cap: "٢٬٥٠٠ راقص",
    shape: "tent",
  },
];

const tickets = [
  {
    name: "يوم واحد",
    price: "٢٥",
    note: "اختر ليلتك",
    perks: ["دخول ليوم من اختيارك", "كل المسارح الثلاثة", "حافلات صدى مجانًا"],
  },
  {
    name: "الأيام الثلاثة",
    price: "٦٠",
    note: "الأوفر",
    perks: ["دخول كامل لثلاث ليالٍ", "كل المسارح الثلاثة", "سوار قماشي للذكرى", "حافلات صدى مجانًا"],
    featured: true,
  },
  {
    name: "صدى بلس",
    price: "١٢٠",
    note: "عدد محدود",
    perks: ["كل ما في تذكرة الأيام الثلاثة", "منصّة مرتفعة أمام مسرح الموج", "مدخل سريع بلا طوابير", "جلسة مع الفنانين قبل العروض"],
  },
];

const faqs = [
  {
    q: "كيف أصل إلى موقع المهرجان؟",
    a: "تنطلق حافلات صدى كل نصف ساعة من وسط العقبة إلى الشاطئ ابتداءً من الرابعة عصرًا، وتعود حتى الثالثة فجرًا. الركوب مجاني لحاملي التذاكر.",
  },
  {
    q: "هل يُسمح بدخول الأطفال؟",
    a: "نعم. الدخول مجاني لمن هم دون الثانية عشرة برفقة ذويهم، وبجوار مسرح النخيل ركن عائلي هادئ بعيد عن مكبّرات الصوت.",
  },
  {
    q: "ماذا عن الطعام والشراب؟",
    a: "في سوق المهرجان أكثر من عشرين مطبخًا محليًا، ومحطات ماء مجانية في كل زاوية. أحضر قارورتك معك.",
  },
  {
    q: "هل أستطيع استرداد ثمن التذكرة؟",
    a: "يمكنك استرداد المبلغ كاملًا حتى ثلاثين يومًا قبل المهرجان. بعد ذلك تستطيع تحويل التذكرة إلى اسم آخر مجانًا.",
  },
];

function Spark({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 0c1 7 4 10 12 12-8 2-11 5-12 12-1-7-4-10-12-12 8-2 11-5 12-12z" />
    </svg>
  );
}

function StageShape({ shape }: { shape: string }) {
  if (shape === "wave") {
    return (
      <svg viewBox="0 0 120 80" aria-hidden="true">
        <path d="M4 24q14-16 28 0t28 0 28 0 28 0M4 44q14-16 28 0t28 0 28 0 28 0M4 64q14-16 28 0t28 0 28 0 28 0" />
      </svg>
    );
  }
  if (shape === "palm") {
    return (
      <svg viewBox="0 0 120 80" aria-hidden="true">
        <path d="M60 78V34M60 34C52 16 34 10 18 16M60 34C68 16 86 10 102 16M60 34C46 26 28 30 18 44M60 34c14-8 32-4 42 10M60 34C58 20 60 10 60 4" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 120 80" aria-hidden="true">
      <path d="M6 74L60 8l54 66zM60 8v66M60 40L38 74M60 40l22 34" />
    </svg>
  );
}

export default function Sada() {
  return (
    <div className={`sd-root ${lalezar.variable} ${alexandria.variable} ${handjet.variable}`}>
      <div className="sd-ticker" aria-label={tickerItems.join(" · ")}>
        <div className="sd-ticker-track" aria-hidden="true">
          {[0, 1, 2, 3].map((copy) => (
            <p key={copy}>
              {tickerItems.map((item) => (
                <span key={item}>
                  {item}
                  <Spark />
                </span>
              ))}
            </p>
          ))}
        </div>
      </div>

      <header className="sd-nav">
        <a href="#sd-top" className="sd-logo" aria-label="صدى — الصفحة الرئيسية">
          صدى
        </a>
        <nav aria-label="أقسام الموقع">
          <a href="#lineup">البرنامج</a>
          <a href="#stages">المسارح</a>
          <a href="#tickets">التذاكر</a>
          <a href="#faq">أسئلة</a>
        </nav>
        <a href="#tickets" className="sd-btn sd-btn-small">
          احجز تذكرتك
        </a>
      </header>

      <main id="sd-top">
        {/* ——— الواجهة ——— */}
        <section className="sd-hero">
          <div className="sd-sun" aria-hidden="true" />

          <div className="sd-hero-word">
            <h1 className="sd-echo">
              <span aria-hidden="true">صدى</span>
              <span aria-hidden="true">صدى</span>
              <span aria-hidden="true">صدى</span>
              <span aria-hidden="true">صدى</span>
              <span>صدى</span>
            </h1>
            <p className="sd-badge">
              النسخة
              <br />
              السادسة
            </p>
          </div>

          <div className="sd-hero-info">
            <p className="sd-hero-kicker">مهرجان الموسيقى المستقلة</p>
            <p className="sd-hero-date">
              ٢٢ — ٢٤
              <br />
              أبريل ٢٠٢٧
            </p>
            <p className="sd-hero-place">
              <Spark /> العقبة، على شاطئ البحر الأحمر
            </p>
            <p className="sd-hero-text">
              ثلاث ليالٍ يلتقي فيها أجمل ما في الموسيقى العربية الجديدة، من الروك
              إلى الطرب الإلكتروني، والقدمان في الرمل.
            </p>
            <div className="sd-hero-actions">
              <a href="#tickets" className="sd-btn">
                احجز تذكرتك
              </a>
              <a href="#lineup" className="sd-btn sd-btn-ghost">
                شاهد البرنامج
              </a>
            </div>
            <div className="sd-eq" aria-hidden="true">
              {Array.from({ length: 14 }, (_, i) => (
                <i key={i} />
              ))}
            </div>
          </div>
        </section>

        <div className="sd-sea">
          <dl className="sd-stats">
            {stats.map((s) => (
              <div key={s.label}>
                <dt>{s.label}</dt>
                <dd>{s.n}</dd>
              </div>
            ))}
          </dl>
        </div>

        <div className="sd-names" aria-hidden="true">
          <div className="sd-names-track">
            {[0, 1, 2].map((copy) => (
              <p key={copy}>
                {names.map((n) => (
                  <span key={n}>
                    {n}
                    <Spark />
                  </span>
                ))}
              </p>
            ))}
          </div>
        </div>

        {/* ——— البرنامج ——— */}
        <section id="lineup" className="sd-section sd-wrap">
          <header className="sd-head">
            <h2>البرنامج</h2>
            <p>
              أبرز عروض كل ليلة. تُفتح الأبواب في الرابعة عصرًا، ويُعلن البرنامج
              الكامل بمواعيده الدقيقة في مارس.
            </p>
          </header>
          <Lineup />
        </section>

        {/* ——— المسارح ——— */}
        <section id="stages" className="sd-stages">
          <div className="sd-wrap">
            <header className="sd-head">
              <h2>ثلاثة مسارح</h2>
              <p>
                خمس دقائق مشيًا على الرمل تفصل بين أبعد مسرحين، وبينها سوق
                المهرجان ومطابخه.
              </p>
            </header>
            <ul className="sd-stage-list">
              {stages.map((st) => (
                <li key={st.name} className={`sd-stage sd-stage-${st.shape}`}>
                  <div className="sd-stage-art">
                    <StageShape shape={st.shape} />
                  </div>
                  <p className="sd-chip">{st.tag}</p>
                  <h3>{st.name}</h3>
                  <p>{st.text}</p>
                  <p className="sd-stage-cap">{st.cap}</p>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ——— التذاكر ——— */}
        <section id="tickets" className="sd-tickets">
          <div className="sd-wrap">
            <header className="sd-head">
              <h2>التذاكر</h2>
              <p>
                أسعار الحجز المبكّر سارية حتى ١ مارس ٢٠٢٧. الأسعار بالدينار
                الأردني وتشمل الضريبة.
              </p>
            </header>
            <ul className="sd-ticket-list">
              {tickets.map((t) => (
                <li key={t.name} className={t.featured ? "sd-ticket sd-ticket-featured" : "sd-ticket"}>
                  <div className="sd-ticket-top">
                    <p className="sd-chip">{t.note}</p>
                    <h3>{t.name}</h3>
                    <p className="sd-ticket-price">
                      <strong>{t.price}</strong>
                      <span>دينارًا</span>
                    </p>
                  </div>
                  <div className="sd-ticket-bottom">
                    <ul>
                      {t.perks.map((p) => (
                        <li key={p}>
                          <Spark />
                          {p}
                        </li>
                      ))}
                    </ul>
                    <a href="#tickets" className="sd-btn" aria-label={`احجز تذكرة ${t.name}`}>
                      احجز الآن
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ——— أسئلة ——— */}
        <section id="faq" className="sd-section sd-wrap sd-faq">
          <header className="sd-head">
            <h2>قبل أن تسأل</h2>
            <p>
              لم تجد جوابك؟ راسلنا على{" "}
              <span dir="ltr" className="sd-mail">
                ahlan@sada.example
              </span>
            </p>
          </header>
          <div className="sd-faq-list">
            {faqs.map((f, i) => (
              <details key={f.q} open={i === 0}>
                <summary>
                  <span>{f.q}</span>
                  <i aria-hidden="true" />
                </summary>
                <p>{f.a}</p>
              </details>
            ))}
          </div>
        </section>
      </main>

      <footer className="sd-footer">
        <div className="sd-wrap">
          <p className="sd-footer-big">نلتقي عند البحر</p>
          <div className="sd-footer-grid">
            <form className="sd-form" action="#sd-top">
              <label htmlFor="sd-email">اشترك لتصلك أسماء الفنانين أولًا بأول</label>
              <div>
                <input
                  id="sd-email"
                  type="email"
                  name="email"
                  dir="ltr"
                  placeholder="you@example.com"
                  autoComplete="email"
                />
                <button type="submit">اشترك</button>
              </div>
            </form>
            <ul className="sd-footer-links">
              <li>
                <a href="#lineup">البرنامج</a>
              </li>
              <li>
                <a href="#stages">المسارح</a>
              </li>
              <li>
                <a href="#tickets">التذاكر</a>
              </li>
              <li>
                <a href="#faq">أسئلة شائعة</a>
              </li>
            </ul>
          </div>
          <div className="sd-footer-base">
            <span>© ٢٠٢٧ مهرجان صدى · العقبة، الأردن</span>
            <Link href="/">
              <span aria-hidden="true">→</span> العودة إلى التصاميم الثلاثة
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
