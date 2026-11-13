import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Caveat } from "next/font/google";
import Link from "next/link";
import { PageBackground } from "../_shared/PageBackground";
import { RevealRoot } from "../_shared/RevealRoot";
import { MadLibs } from "./_components/MadLibs";
import { Nav } from "./_components/Nav";
import { Playground } from "./_components/Playground";
import { WorkGrid } from "./_components/WorkGrid";
import { CONTACT_EMAIL, faqs, plans, praise, services, steps, work } from "./content";
import "./design-three.css";

const display = Bricolage_Grotesque({
  subsets: ["latin"],
  axes: ["wdth", "opsz"],
  variable: "--font-d3",
  display: "swap",
});
const hand = Caveat({ subsets: ["latin"], variable: "--font-d3-hand", display: "swap" });

export const metadata: Metadata = {
  title: "Wiggle Room — Brand, packaging & illustration studio",
  description:
    "Wiggle Room is a small, loud studio in Melbourne and Lisbon making identities, packaging and illustration for companies that would rather be loved than be beige.",
};

export const viewport: Viewport = { themeColor: "#fff5e1" };

const marquee = ["Branding", "Packaging", "Illustration", "Naming", "Websites", "Merch", "Good times"];
const wordmark = "Wiggle Room".split("");

/** A scalloped burst: `points` bumps between an inner and outer radius. */
function burstPath(points: number, outer: number, inner: number, c = 100) {
  const step = Math.PI / points;
  let d = "";
  for (let i = 0; i < points * 2; i++) {
    const r = i % 2 === 0 ? outer : inner;
    const x = (c + Math.cos(i * step - Math.PI / 2) * r).toFixed(1);
    const y = (c + Math.sin(i * step - Math.PI / 2) * r).toFixed(1);
    d += `${i === 0 ? "M" : "L"}${x} ${y}`;
  }
  return `${d}Z`;
}

function Eyes() {
  return (
    <span className="d3-eyes">
      <span className="d3-eye">
        <i />
      </span>
      <span className="d3-eye">
        <i />
      </span>
    </span>
  );
}

function Squiggle({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 300 24" preserveAspectRatio="none" aria-hidden="true">
      <path
        d="M4 14 Q 22 -4 40 12 T 76 12 T 112 12 T 148 12 T 184 12 T 220 12 T 256 12 T 296 10"
        fill="none"
        stroke="currentColor"
        strokeWidth="6"
        strokeLinecap="round"
      />
    </svg>
  );
}

function Arrow({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 90 60" aria-hidden="true">
      <path
        d="M6 8 C 30 4 62 14 70 46 M52 36 L71 48 L80 28"
        fill="none"
        stroke="currentColor"
        strokeWidth="4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function MarqueeBand({ tone, reverse }: { tone: "ink" | "pink"; reverse?: boolean }) {
  return (
    <div className="d3-band" data-tone={tone} data-reverse={reverse} aria-hidden="true">
      <div className="d3-band__track">
        {[0, 1, 2, 3].map((copy) => (
          <span key={copy}>
            {marquee.map((word) => (
              <b key={word}>
                {word} <i>✺</i>
              </b>
            ))}
          </span>
        ))}
      </div>
    </div>
  );
}

export default function DesignThree() {
  return (
    <RevealRoot className={`d3 ${display.variable} ${hand.variable}`} id="d3-top">
      <PageBackground color="#fff5e1" />
      <a className="d3-skip" href="#d3-main">
        Skip to content
      </a>
      <Nav />

      <main id="d3-main">
        {/* ── Hero ───────────────────────────────────────────────── */}
        <section className="d3-hero" aria-labelledby="d3-hero-title">
          <div className="d3-hero__copy">
            <p className="d3-pill">
              <span aria-hidden="true">✺</span> Brand, packaging & illustration studio · Est. 2017
            </p>
            <h1 id="d3-hero-title" className="d3-hero__title">
              <span>Brands with</span> <span>a bit of</span>{" "}
              <span className="d3-hero__wiggle">
                <span>wiggle.</span>
                <Squiggle className="d3-hero__squiggle" />
              </span>
            </h1>
            <p className="d3-hero__lede">
              We’re a small, loud studio making identities, packaging and illustration for
              companies that would rather be <strong>loved</strong> than be beige.
            </p>
            <div className="d3-hero__cta">
              <a className="d3-btn d3-btn--yellow d3-btn--big" href="#d3-work">
                See the good stuff <span aria-hidden="true">↓</span>
              </a>
              <a className="d3-btn d3-btn--white d3-btn--big" href="#d3-hi">
                Say hi
              </a>
            </div>
            <p className="d3-hero__proof">
              Trusted by 140+ founders, three supermarkets and one very good dog.
            </p>
          </div>

          <Playground>
            <div className="d3-play__panel">
              <div className="d3-char d3-char--blob">
                <svg viewBox="0 0 200 200">
                  <path d="M104 10c42 0 80 26 86 68s-12 84-52 100-90 12-114-24S2 78 26 44s40-34 78-34z" />
                </svg>
                <Eyes />
                <span className="d3-smile" />
              </div>
              <div className="d3-char d3-char--burst">
                <svg viewBox="0 0 200 200">
                  <path d={burstPath(12, 96, 76)} />
                </svg>
                <Eyes />
                <span className="d3-smile d3-smile--o" />
              </div>
              <div className="d3-char d3-char--bean">
                <svg viewBox="0 0 200 200">
                  <path d="M70 196v-22M130 196v-22" />
                  <rect x="44" y="8" width="112" height="170" rx="56" />
                </svg>
                <Eyes />
                <span className="d3-smile" />
              </div>
              <span className="d3-play__sun" />
            </div>

            <div className="d3-sticker d3-sticker--badge" data-sticker>
              <svg viewBox="0 0 200 200">
                <path d={burstPath(18, 98, 88)} className="d3-sticker__burst" />
                <defs>
                  <path id="d3-badge-arc" d="M100 100 m-64 0 a64 64 0 1 1 128 0 a64 64 0 1 1 -128 0" />
                </defs>
                <text className="d3-sticker__ring">
                  <textPath href="#d3-badge-arc" textLength="396">
                    100% NOT BEIGE ✺ 100% NOT BORING ✺
                  </textPath>
                </text>
                <text x="100" y="118" textAnchor="middle" className="d3-sticker__yes">
                  YES!
                </text>
              </svg>
            </div>
            <div className="d3-sticker d3-sticker--tag" data-sticker>
              <b>HELLO</b>
              <small>my name is</small>
              <em>Your Brand</em>
            </div>
            <div className="d3-sticker d3-sticker--stars" data-sticker>
              ★★★★★ <span>4.9 from nice people</span>
            </div>
            <p className="d3-play__hint">
              psst, drag the stickers
              <Arrow />
            </p>
          </Playground>
        </section>

        {/* ── Crossing marquees ──────────────────────────────────── */}
        <div className="d3-bands">
          <MarqueeBand tone="pink" reverse />
          <MarqueeBand tone="ink" />
        </div>

        {/* ── Work ───────────────────────────────────────────────── */}
        <section className="d3-section" id="d3-work">
          <header className="d3-head" data-reveal>
            <h2 className="d3-h2">
              Stuff we made <span className="d3-mark d3-mark--yellow">(and still like)</span>
            </h2>
            <p className="d3-note d3-note--right">
              tap a filter!
              <Arrow />
            </p>
          </header>
          <WorkGrid items={work} />
        </section>

        {/* ── Services ───────────────────────────────────────────── */}
        <section className="d3-section d3-services" id="d3-services">
          <header className="d3-head" data-reveal>
            <h2 className="d3-h2">
              Four things we’re <span className="d3-mark d3-mark--mint">weirdly</span> good at
            </h2>
          </header>
          <ul className="d3-bento">
            {services.map((service, i) => (
              <li
                key={service.title}
                className="d3-tile"
                data-reveal
                style={{ "--i": i, "--tile": service.color } as React.CSSProperties}
              >
                <span className="d3-tile__no">0{i + 1}</span>
                <h3>{service.title}</h3>
                <p>{service.blurb}</p>
                <ul>
                  {service.items.map((item) => (
                    <li key={item}>{item}</li>
                  ))}
                </ul>
              </li>
            ))}
            <li className="d3-tile d3-tile--ask" data-reveal style={{ "--i": 4 } as React.CSSProperties}>
              <p className="d3-tile__hand">Not sure which one you need?</p>
              <h3>Most people aren’t. Ask us and we’ll tell you straight.</h3>
              <a className="d3-btn d3-btn--yellow" href="#d3-hi">
                Ask away <span aria-hidden="true">→</span>
              </a>
            </li>
          </ul>
        </section>

        {/* ── Process ────────────────────────────────────────────── */}
        <section className="d3-section d3-how" id="d3-how">
          <header className="d3-head" data-reveal>
            <h2 className="d3-h2">
              How it goes <span className="d3-mark d3-mark--pink">(no surprises)</span>
            </h2>
            <p className="d3-head__lede">
              Eight weeks, four steps, one shared board you can peek at whenever you like.
            </p>
          </header>
          <ol className="d3-steps">
            {steps.map((step, i) => (
              <li key={step.no} data-reveal style={{ "--i": i } as React.CSSProperties}>
                <span className="d3-steps__no">{step.no}</span>
                <p className="d3-steps__when">{step.when}</p>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ── Pricing ────────────────────────────────────────────── */}
        <section className="d3-section d3-pricing" id="d3-pricing">
          <header className="d3-head" data-reveal>
            <h2 className="d3-h2">
              Pick your <span className="d3-mark d3-mark--lilac">flavour</span>
            </h2>
            <p className="d3-head__lede">
              Real prices, on the website, like it’s a normal thing to do. Everything is quoted
              fixed before we start.
            </p>
          </header>
          <ul className="d3-plans">
            {plans.map((plan, i) => (
              <li
                key={plan.name}
                className="d3-plan"
                data-featured={plan.featured}
                data-reveal
                style={{ "--i": i, "--tile": plan.color } as React.CSSProperties}
              >
                {plan.featured ? <span className="d3-plan__flag">Most loved</span> : null}
                <h3>{plan.name}</h3>
                <p className="d3-plan__price">
                  <small>{plan.unit}</small>
                  {plan.price}
                </p>
                <p className="d3-plan__time">{plan.time}</p>
                <p className="d3-plan__pitch">{plan.pitch}</p>
                <ul>
                  {plan.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
                <a className="d3-btn d3-btn--ink" href="#d3-hi">
                  {plan.cta} <span aria-hidden="true">→</span>
                </a>
              </li>
            ))}
          </ul>
        </section>

        {/* ── Praise ─────────────────────────────────────────────── */}
        <section className="d3-section d3-praise" aria-labelledby="d3-praise-title">
          <header className="d3-head" data-reveal>
            <h2 className="d3-h2" id="d3-praise-title">
              People say <span className="d3-mark d3-mark--yellow">nice things</span>
            </h2>
          </header>
          <ul className="d3-bubbles">
            {praise.map((item, i) => (
              <li key={item.name} data-reveal style={{ "--i": i } as React.CSSProperties}>
                <figure>
                  <blockquote style={{ "--tile": item.color } as React.CSSProperties}>
                    <p>“{item.quote}”</p>
                  </blockquote>
                  <figcaption>
                    <span className="d3-avatar" style={{ background: item.color }} aria-hidden="true">
                      {item.name
                        .split(" ")
                        .map((part) => part[0])
                        .join("")}
                    </span>
                    <span>
                      <strong>{item.name}</strong>
                      {item.role}
                    </span>
                  </figcaption>
                </figure>
              </li>
            ))}
          </ul>
        </section>

        {/* ── FAQ ────────────────────────────────────────────────── */}
        <section className="d3-section d3-faq" id="d3-faq">
          <header className="d3-head" data-reveal>
            <h2 className="d3-h2">
              Things people <span className="d3-mark d3-mark--mint">always ask</span>
            </h2>
          </header>
          <div className="d3-faq__list">
            {faqs.map((faq, i) => (
              <details key={faq.q} className="d3-qa" data-reveal style={{ "--i": i } as React.CSSProperties}>
                <summary>
                  <span>{faq.q}</span>
                  <i aria-hidden="true" />
                </summary>
                <p>{faq.a}</p>
              </details>
            ))}
          </div>
        </section>

        {/* ── Contact ────────────────────────────────────────────── */}
        <section className="d3-hi" id="d3-hi">
          <p className="d3-note d3-note--light" data-reveal>
            fill in the blanks
            <Arrow />
          </p>
          <h2 className="sr-only">Say hi</h2>
          <div data-reveal>
            <MadLibs />
          </div>
          <p className="d3-hi__alt" data-reveal>
            Not a form person? Email <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a> or call{" "}
            <a href="tel:+61355500148">+61 3 5550 0148</a>.
          </p>
        </section>
      </main>

      <footer className="d3-footer">
        <p className="d3-footer__word" aria-label="Wiggle Room">
          {wordmark.map((letter, i) => (
            <span key={i} aria-hidden="true" style={{ "--i": i } as React.CSSProperties}>
              {letter === " " ? " " : letter}
            </span>
          ))}
        </p>
        <div className="d3-footer__grid">
          <p>
            <strong>Melbourne</strong>
            14 Easey Street, Collingwood
            <br />
            VIC 3066, Australia
          </p>
          <p>
            <strong>Lisbon</strong>
            Rua da Boavista 54
            <br />
            1200-066 Lisboa, Portugal
          </p>
          <ul>
            <li>
              <a href="https://www.instagram.com/" rel="noreferrer">
                Instagram
              </a>
            </li>
            <li>
              <a href="https://dribbble.com/" rel="noreferrer">
                Dribbble
              </a>
            </li>
            <li>
              <a href="https://www.linkedin.com/" rel="noreferrer">
                LinkedIn
              </a>
            </li>
          </ul>
          <ul>
            <li>
              <a href="#d3-top">Back to the top ↑</a>
            </li>
            <li>
              <Link href="/">← All five concepts</Link>
            </li>
          </ul>
        </div>
        <p className="d3-footer__legal">
          © 2026 Wiggle Room Pty Ltd. Made with too much coffee and exactly enough glitter.
        </p>
      </footer>
    </RevealRoot>
  );
}
