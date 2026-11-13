import Link from "next/link";
import { kufi } from "./_fonts/kufi";
import { lalezar } from "./_fonts/lalezar";
import { readex } from "./_fonts/readex";
import { ruqaa } from "./_fonts/ruqaa";
import "./home.css";

export default function Home() {
  return (
    <main
      className={`home-root ${readex.variable} ${ruqaa.variable} ${kufi.variable} ${lalezar.variable}`}
    >
      <header className="home-header">
        <p className="home-eyebrow">معرض صغير</p>
        <h1 className="home-title">ثلاثة تصاميم عربية</h1>
        <p className="home-lede">
          ثلاثة مواقع، لكلٍّ منها موضوعه ولغته البصرية وخطوطه. اختر واحدًا
          للدخول.
        </p>
      </header>

      <ul className="home-grid">
        <li>
          <Link href="/al-hamish" className={`home-card home-hamish`}>
            <span className="home-meta">
              <span>٠١</span>
              <span>مجلة أدبية فصلية</span>
            </span>
            <span className="home-art" aria-hidden="true">
              <span className="home-hamishRule" />
              <span className="home-hamishName">الهامش</span>
              <span className="home-hamishRule" />
              <span className="home-hamishLines">
                <i />
                <i />
                <i />
              </span>
            </span>
            <span className="home-info">
              <strong>الهامش</strong>
              <span>
                تحريريّ بروح الورق: خط نسخيّ، حواشٍ جانبية، وحبر أحمر.
              </span>
              <em>
                افتح التصميم <b>←</b>
              </em>
            </span>
          </Link>
        </li>

        <li>
          <Link href="/suhail" className={`home-card home-suhail`}>
            <span className="home-meta">
              <span>٠٢</span>
              <span>مرصد فلكي صحراوي</span>
            </span>
            <span className="home-art" aria-hidden="true">
              <span className="home-suhailRing">
                <span className="home-suhailRingInner" />
                <span className="home-suhailStar" />
              </span>
              <span className="home-suhailName">سُهيل</span>
            </span>
            <span className="home-info">
              <strong>مرصد سُهيل</strong>
              <span>
                ليلٌ عميق وخطوط كوفية وخريطة نجوم تفاعلية بأسمائها العربية.
              </span>
              <em>
                افتح التصميم <b>←</b>
              </em>
            </span>
          </Link>
        </li>

        <li>
          <Link href="/sada" className={`home-card home-sada`}>
            <span className="home-meta">
              <span>٠٣</span>
              <span>مهرجان موسيقى مستقلة</span>
            </span>
            <span className="home-art" aria-hidden="true">
              <span className="home-sadaEcho">
                <span>صدى</span>
                <span>صدى</span>
                <span>صدى</span>
              </span>
            </span>
            <span className="home-info">
              <strong>صدى</strong>
              <span>ملصق صاخب: ألوان جريئة وحروف عريضة وحواف سميكة.</span>
              <em>
                افتح التصميم <b>←</b>
              </em>
            </span>
          </Link>
        </li>
      </ul>

      <footer className="home-footer">
        <span>ثلاثة مسارات · صفحة واحدة لكل تصميم</span>
        <span dir="ltr">/al-hamish · /suhail · /sada</span>
      </footer>
    </main>
  );
}
