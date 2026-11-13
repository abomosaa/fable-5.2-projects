import type { Metadata } from "next";
import Link from "next/link";
import { ruqaa } from "../_fonts/ruqaa";
import { amiri, naskh } from "./fonts";
import "./hamish.css";

export const metadata: Metadata = {
  title: "الهامش — مجلة فصلية للأدب والفكر والفنون",
  description:
    "الهامش مجلة عربية فصلية تُعنى بالأدب والفكر والفنون. العدد السابع والأربعون: في مديح البطء.",
};

const sections = ["مقالات", "قصص", "شعر", "حوارات", "ترجمات", "فنون", "الأرشيف"];

const stories = [
  {
    kind: "مقالة",
    title: "المدينة التي تسكن اللغة",
    excerpt:
      "كيف تحفظ اللهجات خرائط مدنٍ لم تعد قائمة، وكيف يصير الكلام اليومي أرشيفًا لما محته الجرّافات.",
    author: "هالة منصور",
    time: "١٢ دقيقة",
  },
  {
    kind: "قصة قصيرة",
    title: "ساعي البريد الأخير",
    excerpt:
      "في قرية نسيتها الخرائط، يواصل رجل واحد توزيع رسائل لم يعد يكتبها أحد، ويقرؤها على أصحابها بصوتٍ عالٍ.",
    author: "يوسف الدبّاغ",
    time: "٩ دقائق",
  },
  {
    kind: "ترجمة",
    title: "سبع قصائد عن المطر",
    excerpt:
      "مختارات من الهايكو الياباني في ترجمة جديدة تحاول أن تُبقي على الصمت القائم بين الكلمات.",
    author: "ترجمة: ريم العلي",
    time: "٥ دقائق",
  },
  {
    kind: "فنون",
    title: "الخط خارج اللوحة",
    excerpt:
      "جيل جديد من الخطّاطين يحمل الحرف العربي إلى الجدران والشاشات والأقمشة، ويسأل: أين ينتهي الخط ويبدأ الرسم؟",
    author: "كريم بن يوسف",
    time: "١٤ دقيقة",
  },
];

const contents = [
  { title: "افتتاحية: لماذا الهامش؟", by: "هيئة التحرير", page: "٥" },
  { title: "في مديح البطء", by: "نور الهدى سليمان", page: "١٢", feature: true },
  { title: "المدينة التي تسكن اللغة", by: "هالة منصور", page: "٣٤" },
  { title: "ساعي البريد الأخير", by: "يوسف الدبّاغ", page: "٥٢" },
  { title: "سبع قصائد عن المطر", by: "ترجمة: ريم العلي", page: "٦٨" },
  { title: "الخط خارج اللوحة", by: "كريم بن يوسف", page: "٨١" },
  { title: "حوار العدد: سعاد الناصري", by: "أجراه: طارق حدّاد", page: "٩٦" },
  { title: "مراجعات الكتب", by: "مجموعة من الكتّاب", page: "١١٤" },
];

const verses = [
  ["على قَدْرِ أهلِ العَزْمِ تأتي العَزائِمُ", "وتأتي على قَدْرِ الكِرامِ المَكارِمُ"],
  ["وتَعْظُمُ في عَينِ الصَّغيرِ صِغارُها", "وتَصْغُرُ في عَينِ العَظيمِ العَظائِمُ"],
];

function Star({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" aria-hidden="true">
      <path d="M12 0l3.5 3.5h5v5L24 12l-3.5 3.5v5h-5L12 24l-3.5-3.5h-5v-5L0 12l3.5-3.5v-5h5z" />
    </svg>
  );
}

function CoverArt() {
  const lines = [262, 228, 250, 176, 240, 206, 118];
  return (
    <svg
      className="hm-art"
      viewBox="0 0 480 620"
      role="img"
      aria-label="رسم العدد: شمس حمراء تغرب خلف قوس، وتحتها سطور صفحة مكتوبة"
    >
      <defs>
        <clipPath id="hm-arch">
          <path d="M70 620V250a170 170 0 0 1 340 0v370z" />
        </clipPath>
        <filter id="hm-grain" x="0" y="0" width="100%" height="100%">
          <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" seed="11" />
          <feColorMatrix values="0 0 0 0 0.1  0 0 0 0 0.09  0 0 0 0 0.08  0 0 0 0.55 -0.12" />
        </filter>
      </defs>
      <rect width="480" height="620" fill="#e4d9c2" />
      <path
        d="M52 620V250a188 188 0 0 1 376 0v370"
        fill="none"
        stroke="#1a1714"
        strokeWidth="1.5"
      />
      <path d="M70 620V250a170 170 0 0 1 340 0v370z" fill="#1a1714" />
      <g clipPath="url(#hm-arch)">
        <circle cx="240" cy="276" r="108" fill="#c2371f" />
        <rect x="70" y="384" width="340" height="236" fill="#1a1714" />
        {lines.map((w, i) => (
          <rect
            key={i}
            x={382 - w}
            y={424 + i * 25}
            width={w}
            height="5"
            rx="2.5"
            fill="#f4eee1"
            opacity={i === lines.length - 1 ? 0.55 : 0.92}
          />
        ))}
        <rect x="98" y="399" width="284" height="1" fill="#f4eee1" opacity="0.4" />
      </g>
      <g fill="#c2371f">
        <path transform="translate(40 40) scale(1.15)" d="M12 0l3.5 3.5h5v5L24 12l-3.5 3.5v5h-5L12 24l-3.5-3.5h-5v-5L0 12l3.5-3.5v-5h5z" />
        <path transform="translate(412 40) scale(1.15)" d="M12 0l3.5 3.5h5v5L24 12l-3.5 3.5v5h-5L12 24l-3.5-3.5h-5v-5L0 12l3.5-3.5v-5h5z" />
      </g>
      <rect width="480" height="620" filter="url(#hm-grain)" style={{ mixBlendMode: "multiply" }} />
    </svg>
  );
}

export default function AlHamish() {
  return (
    <div className={`hm-root ${amiri.variable} ${naskh.variable} ${ruqaa.variable}`}>
      <div className="hm-wrap">
        <header className="hm-header">
          <div className="hm-topline">
            <span>العدد السابع والأربعون</span>
            <span>خريف ٢٠٢٦ · جمادى الأولى ١٤٤٨ هـ</span>
            <Link href="/" className="hm-back">
              <span aria-hidden="true">→</span> التصاميم الثلاثة
            </Link>
          </div>

          <div className="hm-masthead">
            <p className="hm-ear">
              مجلة فصلية
              <br />
              تُعنى بالأدب والفكر والفنون
              <br />
              <span>تصدر منذ ربيع ٢٠١٥</span>
            </p>
            <h1 className="hm-logo">الهامش</h1>
            <p className="hm-ear hm-ear-end">
              في هذا العدد
              <br />
              ملف القراءة البطيئة
              <br />
              <span>وحوار مع سعاد الناصري</span>
            </p>
          </div>

          <nav className="hm-nav" aria-label="أبواب المجلة">
            <ul>
              {sections.map((item) => (
                <li key={item}>
                  <a href="#contents">{item}</a>
                </li>
              ))}
            </ul>
            <a href="#subscribe" className="hm-nav-cta">
              اشترك
            </a>
          </nav>
        </header>

        <main>
          {/* ——— ملف العدد ——— */}
          <section className="hm-hero" aria-labelledby="hm-feature-title">
            <div className="hm-hero-text">
              <p className="hm-kicker">
                <Star /> ملف العدد
              </p>
              <h2 id="hm-feature-title" className="hm-headline">
                في مديح البطء: كيف نقرأ في زمن العجلة؟
              </h2>
              <p className="hm-standfirst">
                نقرأ اليوم أكثر من أي جيل مضى، ونتذكّر أقل. ستّ كاتبات وكتّاب
                يعودون إلى الكتاب الواحد، والجملة الواحدة، وإلى القلم الرصاص في
                الهامش.
              </p>
              <div className="hm-byline">
                <span>
                  بقلم <strong>نور الهدى سليمان</strong>
                </span>
                <span>قراءة في ١٨ دقيقة</span>
                <a href="#excerpt" className="hm-readmore">
                  اقرأ المقتطف <span aria-hidden="true">←</span>
                </a>
              </div>
            </div>
            <figure className="hm-hero-art">
              <CoverArt />
              <figcaption>
                <span>غلاف العدد ٤٧</span>
                <span>رسم: سُرى الخطيب</span>
              </figcaption>
            </figure>
          </section>

          {/* ——— مختارات ——— */}
          <section className="hm-stories" aria-label="مختارات من العدد">
            {stories.map((story, i) => (
              <article key={story.title} className="hm-story">
                <p className="hm-story-kind">
                  <span>{["١", "٢", "٣", "٤"][i]}</span>
                  {story.kind}
                </p>
                <h3>
                  <a href="#contents">{story.title}</a>
                </h3>
                <p className="hm-story-excerpt">{story.excerpt}</p>
                <p className="hm-story-meta">
                  {story.author} <i aria-hidden="true">·</i> {story.time}
                </p>
              </article>
            ))}
          </section>

          {/* ——— مقتطف ——— */}
          <section id="excerpt" className="hm-excerpt" aria-labelledby="hm-excerpt-title">
            <header className="hm-excerpt-head">
              <p className="hm-kicker">
                <Star /> مقتطف
              </p>
              <h2 id="hm-excerpt-title">في مديح البطء</h2>
              <p>
                نور الهدى سليمان
                <br />
                <span>من ملف العدد، ص ١٢</span>
              </p>
            </header>

            <div className="hm-prose">
              <div className="hm-para">
                <p>
                  <span className="hm-dropword">كان جدّي</span> يقرأ الكتاب
                  الواحد شتاءً كاملًا. يضعه على حافة النافذة، ويعود إليه كل مساء
                  كمن يعود إلى صديق قديم، لا يستعجله ولا يسأله أن يختصر. لم يكن
                  يعرف شيئًا عن «تحدّيات القراءة» ولا عن قوائم المئة كتاب في
                  السنة؛ كان يعرف فقط أن الجملة الجيدة تحتاج إلى وقت كي تستقرّ
                  في صاحبها، كما يحتاج الشاي إلى وقت كي يختمر.
                </p>
              </div>

              <div className="hm-para">
                <p>
                  نحن اليوم نمرّ على النصوص مرور العابر على واجهات المحالّ: نظرة
                  خاطفة، ثم الواجهة التالية
                  <sup>١</sup>. والقراءة البطيئة ليست حنينًا إلى زمن مضى، بل
                  مقاومة هادئة؛ أن تمنح الصفحة حقّها من الانتباه، وأن تقبل بأن
                  بعض المعاني لا يُدرَك إلا على مهل.
                </p>
                <aside className="hm-note">
                  <span>١</span>
                  تشير دراسات في القراءة إلى أن التصفّح السريع على الشاشات يُضعف
                  تذكّر التفاصيل، قياسًا بالقراءة الورقية المتأنّية.
                </aside>
              </div>

              <div className="hm-para">
                <p>
                  وفي الهوامش تحديدًا يسكن هذا البطء
                  <sup>٢</sup>. الهامش هو المكان الذي يتوقّف فيه القارئ ليكتب:
                  «ليس هكذا»، أو «تذكّرتُ أمّي»، أو يرسم علامة استفهام صغيرة.
                  هناك لا يعود الكتاب شيئًا نستهلكه، بل يصير شيئًا نحاوره.
                </p>
                <aside className="hm-note">
                  <span>٢</span>
                  عرف النسّاخ العرب الحاشية منذ القرون الأولى، واشتهرت بعض
                  الحواشي حتى صارت تُنسخ كتبًا مستقلة.
                </aside>
              </div>
            </div>
          </section>

          <blockquote className="hm-pullquote">
            <p>
              الهامش هو المكان الذي لا يعود فيه الكتاب شيئًا نستهلكه، بل يصير
              شيئًا نحاوره.
            </p>
          </blockquote>
        </main>
      </div>

      {/* ——— ديوان العدد ——— */}
      <section className="hm-poem" aria-labelledby="hm-poem-title">
        <div className="hm-wrap">
          <p className="hm-poem-label">
            <Star /> من عيون الشعر <Star />
          </p>
          <h2 id="hm-poem-title">على قدر أهل العزم</h2>
          <div className="hm-verses">
            {verses.map(([a, b]) => (
              <p key={a} className="hm-bayt">
                <span>{a}</span>
                <Star />
                <span>{b}</span>
              </p>
            ))}
          </div>
          <p className="hm-poet">أبو الطيّب المتنبّي · القرن الرابع الهجري</p>
        </div>
      </section>

      <div className="hm-wrap">
        {/* ——— الفهرس والحوار ——— */}
        <section id="contents" className="hm-contents">
          <div className="hm-toc">
            <header className="hm-section-head">
              <h2>فهرس العدد</h2>
              <p>١٢٨ صفحة</p>
            </header>
            <ol>
              {contents.map((item) => (
                <li key={item.title} className={item.feature ? "hm-toc-feature" : undefined}>
                  <a href="#excerpt">
                    <span className="hm-toc-title">
                      {item.title}
                      {item.feature && <em>ملف العدد</em>}
                    </span>
                    <span className="hm-toc-by">{item.by}</span>
                    <span className="hm-toc-dots" aria-hidden="true" />
                    <span className="hm-toc-page">{item.page}</span>
                  </a>
                </li>
              ))}
            </ol>
          </div>

          <article className="hm-interview">
            <p className="hm-interview-label">حوار العدد</p>
            <blockquote>
              «الرواية بيتٌ أبنيه لأُسكِن فيه سؤالًا واحدًا، ثم أتركه مفتوح
              الباب.»
            </blockquote>
            <div className="hm-interview-foot">
              <p>
                <strong>سعاد الناصري</strong>
                روائية، صاحبة «بيت في آخر النهر»
              </p>
              <a href="#contents">
                اقرأ الحوار <span aria-hidden="true">←</span>
              </a>
            </div>
          </article>
        </section>

        {/* ——— الاشتراك ——— */}
        <section id="subscribe" className="hm-subscribe">
          <div className="hm-subscribe-text">
            <h2>
              أربعة أعداد في السنة.
              <br />
              بلا إعلانات، وبلا استعجال.
            </h2>
            <p>
              تصلك «الهامش» مطبوعةً على ورق غير مصقول إلى باب بيتك، ومعها رسالة
              شهرية من هيئة التحرير عمّا نقرؤه بين عددٍ وآخر.
            </p>
          </div>
          <div className="hm-subscribe-side">
            <ul className="hm-plans">
              <li>
                <span>الاشتراك الورقي</span>
                <strong>٦٠ دولارًا</strong>
                <small>في السنة، شاملًا البريد</small>
              </li>
              <li>
                <span>الاشتراك الرقمي</span>
                <strong>٢٤ دولارًا</strong>
                <small>في السنة، مع الأرشيف كاملًا</small>
              </li>
            </ul>
            <form className="hm-form" action="#subscribe">
              <label htmlFor="hm-email">بريدك الإلكتروني</label>
              <div>
                <input
                  id="hm-email"
                  type="email"
                  name="email"
                  dir="ltr"
                  placeholder="name@example.com"
                  autoComplete="email"
                />
                <button type="submit">اشترك الآن</button>
              </div>
            </form>
          </div>
        </section>

        <footer className="hm-footer">
          <p className="hm-footer-logo">الهامش</p>
          <div className="hm-footer-cols">
            <p>
              <strong>هيئة التحرير</strong>
              رئيسة التحرير: ليلى عبد الرحمن
              <br />
              مدير التحرير: طارق حدّاد
              <br />
              الإخراج الفني: سُرى الخطيب
            </p>
            <p>
              <strong>للمراسلة</strong>
              ص. ب. ١١٤٧، بيروت
              <br />
              <span dir="ltr">tahrir@alhamish.example</span>
              <br />
              نرحّب بالنصوص غير المنشورة
            </p>
            <p>
              <strong>عن هذه الصفحة</strong>
              صُفّت بحروف «أميري» و«نوتو نسخ»، وكُتب الترويس بخط «عارف رقعة».
            </p>
          </div>
          <div className="hm-footer-base">
            <span>© ٢٠٢٦ مجلة الهامش. جميع الحقوق محفوظة لأصحاب النصوص.</span>
            <Link href="/">
              <span aria-hidden="true">→</span> العودة إلى التصاميم الثلاثة
            </Link>
          </div>
        </footer>
      </div>
    </div>
  );
}
