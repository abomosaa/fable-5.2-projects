import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono, Instrument_Serif } from "next/font/google";
import Link from "next/link";
import { CountUp } from "../_shared/CountUp";
import { PageBackground } from "../_shared/PageBackground";
import { RevealRoot } from "../_shared/RevealRoot";
import { HeroLight } from "./_components/HeroLight";
import { Reel } from "./_components/Reel";
import { Slate } from "./_components/Slate";
import { Timecode } from "./_components/Timecode";
import {
  CONTACT_EMAIL,
  TOTAL_WEEKS,
  acts,
  crafts,
  credits,
  figures,
  films,
  laurels,
  tracks,
} from "./content";
import "./design-two.css";

const serif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-d2-serif",
  display: "swap",
});
const sans = Geist({ subsets: ["latin"], variable: "--font-d2-sans", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-d2-mono", display: "swap" });

export const metadata: Metadata = {
  title: "Umbra — Film & motion studio",
  description:
    "Umbra is a film and motion studio in Lisbon and Copenhagen. We direct, design, animate and score brand films, title sequences and live visuals under one roof.",
};

export const viewport: Viewport = { themeColor: "#070605" };

const manifesto =
  "Light is the first thing we design. Then time. Then silence. Everything after that is just production — and we happen to be very good at production.".split(
    " ",
  );

const pct = (weeks: number) => `${(weeks / TOTAL_WEEKS) * 100}%`;

function Laurel() {
  return (
    <svg className="d2-laurel" viewBox="0 0 48 44" aria-hidden="true">
      <g fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round">
        <path d="M20 41C9 37 3 28 4 15" />
        <path d="M28 41c11-4 17-13 16-26" />
        <path d="M5 21c-3-3-3-7-1-10 3 2 4 6 1 10ZM8 29c-4-1-6-5-6-8 4 0 6 4 6 8ZM14 36c-4 0-7-3-8-6 4-1 7 2 8 6ZM8 14c-1-4 1-7 4-9 2 3 0 7-4 9Z" />
        <path d="M43 21c3-3 3-7 1-10-3 2-4 6-1 10ZM40 29c4-1 6-5 6-8-4 0-6 4-6 8ZM34 36c4 0 7-3 8-6-4-1-7 2-8 6ZM40 14c1-4-1-7-4-9-2 3 0 7 4 9Z" />
      </g>
    </svg>
  );
}

export default function DesignTwo() {
  return (
    <RevealRoot className={`d2 ${serif.variable} ${sans.variable} ${mono.variable}`} id="d2-top">
      <PageBackground color="#070605" />
      <div className="d2-grain" aria-hidden="true" />
      <a className="d2-skip" href="#d2-main">
        Skip to content
      </a>

      <header className="d2-header">
        <a className="d2-brand" href="#d2-top" aria-label="Umbra, back to top">
          <span className="d2-brand__mark" aria-hidden="true" />
          Umbra
        </a>
        <nav className="d2-nav d2-mono" aria-label="Primary">
          <a href="#d2-reel">Reel</a>
          <a href="#d2-craft">Craft</a>
          <a href="#d2-process">Process</a>
          <a href="#d2-laurels">Laurels</a>
        </nav>
        <div className="d2-header__right">
          <p className="d2-rec d2-mono" aria-hidden="true">
            <span className="d2-rec__dot" />
            Rec <Timecode />
          </p>
          <a className="d2-btn" href="#d2-contact">
            Start a film
          </a>
        </div>
      </header>

      <main id="d2-main">
        {/* ── Hero ───────────────────────────────────────────────── */}
        <HeroLight>
          <div className="d2-hero__light" aria-hidden="true" />
          <div className="d2-hero__streak" aria-hidden="true" />
          <div className="d2-hero__moon" aria-hidden="true" />
          <div className="d2-hero__vignette" aria-hidden="true" />

          <div className="d2-hero__content">
            <p className="d2-mono d2-hero__kicker">Film & motion studio — Lisbon / Copenhagen</p>
            <h1 id="d2-hero-title" className="d2-hero__title">
              <span>Pictures</span> <span>
                that <em>move</em>
              </span>{" "}
              <span>people.</span>
            </h1>
            <div className="d2-hero__row">
              <p className="d2-hero__lede">
                We direct, design, animate and score brand films, title sequences and live
                visuals. One studio, one crew, one unbroken line from the first sentence of the
                treatment to the final frame of the master.
              </p>
              <div className="d2-hero__cta">
                <a className="d2-btn d2-btn--solid" href="#d2-reel">
                  <span className="d2-play" aria-hidden="true" />
                  Watch the selects
                </a>
                <a className="d2-btn" href="#d2-contact">
                  Start a production
                </a>
              </div>
            </div>
          </div>

          <p className="d2-hero__slate d2-mono" aria-hidden="true">
            <span>Showreel 2026</span>
            <span>24 fps · 2.39:1 · 35mm + CG</span>
            <span>Scroll ↓</span>
          </p>
        </HeroLight>

        {/* ── Credits marquee ────────────────────────────────────── */}
        <section className="d2-credits" aria-label="Clients">
          <p className="d2-mono d2-credits__label">In the company of</p>
          <div className="d2-credits__window">
            <ul className="d2-credits__track">
              {credits.map((name) => (
                <li key={name}>{name}</li>
              ))}
              {credits.map((name) => (
                <li key={`dup-${name}`} aria-hidden="true">
                  {name}
                </li>
              ))}
            </ul>
          </div>
        </section>

        {/* ── Reel ───────────────────────────────────────────────── */}
        <section className="d2-section" id="d2-reel">
          <header className="d2-head" data-reveal>
            <p className="d2-label d2-mono">
              <span>Sc. 01</span> Selected frames
            </p>
            <h2 className="d2-h2">
              Five films, <em>one frame each.</em>
            </h2>
          </header>
          <Reel films={films} />
        </section>

        {/* ── Manifesto ──────────────────────────────────────────── */}
        <section className="d2-manifesto" aria-label="Manifesto">
          <p className="d2-label d2-mono" data-reveal>
            <span>Sc. 02</span> Point of view
          </p>
          <p className="d2-manifesto__text">
            {manifesto.map((word, i) => (
              <span
                key={i}
                className="d2-manifesto__word"
                style={{ "--p": 8 + (i / manifesto.length) * 26 } as React.CSSProperties}
              >
                {word}{" "}
              </span>
            ))}
          </p>
        </section>

        {/* ── Craft ──────────────────────────────────────────────── */}
        <section className="d2-section" id="d2-craft">
          <header className="d2-head" data-reveal>
            <p className="d2-label d2-mono">
              <span>Sc. 03</span> What we make
            </p>
            <h2 className="d2-h2">
              Four crafts, <em>one roof.</em>
            </h2>
          </header>

          <div className="d2-strip" data-reveal>
            <ol className="d2-strip__frames">
              {crafts.map((craft) => (
                <li key={craft.no} className="d2-frame">
                  <p className="d2-mono d2-frame__no">{craft.no}A</p>
                  <h3>{craft.title}</h3>
                  <p className="d2-frame__text">{craft.text}</p>
                  <ul className="d2-mono d2-frame__tags">
                    {craft.tags.map((tag) => (
                      <li key={tag}>{tag}</li>
                    ))}
                  </ul>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ── Process ────────────────────────────────────────────── */}
        <section className="d2-section d2-process" id="d2-process">
          <header className="d2-head" data-reveal>
            <p className="d2-label d2-mono">
              <span>Sc. 04</span> How a film gets made
            </p>
            <h2 className="d2-h2">
              Eight weeks, <em>cut to picture.</em>
            </h2>
            <p className="d2-head__note">
              A typical sixty-second brand film. Sound starts before the shoot, because the edit
              should be cut to music rather than decorated with it.
            </p>
          </header>

          <div className="d2-nle" data-reveal>
            <div className="d2-nle__bar d2-mono">
              <span className="d2-nle__dots" aria-hidden="true">
                <i />
                <i />
                <i />
              </span>
              <span>umbra_brandfilm_v12 — Timeline</span>
              <span>8 wks</span>
            </div>
            <div
              className="d2-nle__scroll"
              role="group"
              aria-label="Production schedule by discipline. Scrolls horizontally on small screens."
              tabIndex={0}
            >
              <div className="d2-nle__inner">
                <div className="d2-nle__ruler d2-mono" aria-hidden="true">
                  <span />
                  <div>
                    {Array.from({ length: TOTAL_WEEKS }, (_, i) => (
                      <i key={i}>W{i + 1}</i>
                    ))}
                  </div>
                </div>
                <div className="d2-nle__tracks">
                  {tracks.map((track) => (
                    <div key={track.id} className="d2-track" data-tone={track.tone}>
                      <p className="d2-mono d2-track__name">{track.name}</p>
                      <ul className="d2-track__lane">
                        {track.clips.map((clip) => (
                          <li
                            key={clip.label}
                            className="d2-clip"
                            style={{ left: pct(clip.start), width: pct(clip.end - clip.start) }}
                          >
                            <span>{clip.label}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                  <div className="d2-nle__playhead-lane" aria-hidden="true">
                    <span className="d2-nle__playhead" />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <ol className="d2-acts">
            {acts.map((act, i) => (
              <li key={act.act} data-reveal style={{ "--i": i } as React.CSSProperties}>
                <p className="d2-mono d2-acts__act">{act.act}</p>
                <h3>{act.title}</h3>
                <p className="d2-mono d2-acts__weeks">{act.weeks}</p>
                <p className="d2-acts__text">{act.text}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ── Laurels ────────────────────────────────────────────── */}
        <section className="d2-section d2-proof" id="d2-laurels">
          <header className="d2-head" data-reveal>
            <p className="d2-label d2-mono">
              <span>Sc. 05</span> Laurels & numbers
            </p>
            <h2 className="d2-h2">
              Nice things <em>said in dark rooms.</em>
            </h2>
          </header>

          <div className="d2-proof__grid">
            <dl className="d2-figures">
              {figures.map((figure, i) => (
                <div key={figure.label} data-reveal style={{ "--i": i } as React.CSSProperties}>
                  <dd>
                    <CountUp to={figure.value} suffix={figure.suffix} />
                  </dd>
                  <dt className="d2-mono">{figure.label}</dt>
                </div>
              ))}
            </dl>

            <ul className="d2-laurels">
              {laurels.map((item, i) => (
                <li key={`${item.name}-${item.film}`} data-reveal style={{ "--i": i } as React.CSSProperties}>
                  <Laurel />
                  <div>
                    <h3>{item.name}</h3>
                    <p>{item.detail}</p>
                  </div>
                  <p className="d2-mono">
                    {item.film}
                    <br />
                    {item.year}
                  </p>
                </li>
              ))}
            </ul>
          </div>

          <figure className="d2-quote" data-reveal>
            <blockquote>
              <p>
                “Umbra shot our launch film in two nights, with a crew a third the size anyone
                else quoted. It is still the best thing we have ever put our name on.”
              </p>
            </blockquote>
            <figcaption className="d2-mono">
              Ingrid Solheim — Chief Marketing Officer, Kite Mobility
            </figcaption>
          </figure>
        </section>

        {/* ── Contact ────────────────────────────────────────────── */}
        <section className="d2-contact" id="d2-contact">
          <div className="d2-contact__copy">
            <p className="d2-label d2-mono" data-reveal>
              <span>Sc. 06</span> Your film
            </p>
            <h2 className="d2-contact__title" data-reveal>
              Let’s make something worth <em>the dark.</em>
            </h2>
            <p className="d2-contact__lede" data-reveal>
              Fill in the slate and tell us what you are trying to make people feel. We read every
              brief ourselves and come back within one working day with a first thought, a rough
              number and an honest view on whether film is the right answer.
            </p>
            <dl className="d2-contact__details" data-reveal>
              <div>
                <dt className="d2-mono">New work</dt>
                <dd>
                  <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
                </dd>
              </div>
              <div>
                <dt className="d2-mono">Executive producer</dt>
                <dd>
                  Mariana Reis — <a href="tel:+351215550164">+351 21 555 0164</a>
                </dd>
              </div>
              <div>
                <dt className="d2-mono">Typical budgets</dt>
                <dd>€45k – €400k per film</dd>
              </div>
            </dl>
          </div>
          <div data-reveal>
            <Slate />
          </div>
        </section>
      </main>

      <footer className="d2-footer">
        <div className="d2-footer__credits">
          <dl>
            <div>
              <dt className="d2-mono">Directors</dt>
              <dd>Inês Carvalho</dd>
              <dd>Jonas Bak</dd>
            </div>
            <div>
              <dt className="d2-mono">Executive producer</dt>
              <dd>Mariana Reis</dd>
            </div>
            <div>
              <dt className="d2-mono">Head of CG</dt>
              <dd>Tomás Vidal</dd>
            </div>
            <div>
              <dt className="d2-mono">Composer</dt>
              <dd>Aksel Lund</dd>
            </div>
            <div>
              <dt className="d2-mono">Colourist</dt>
              <dd>Bea Monteiro</dd>
            </div>
          </dl>
          <div className="d2-footer__places">
            <address>
              <span className="d2-mono">Lisbon</span>
              Rua do Açúcar 76
              <br />
              1950-009 Lisboa
            </address>
            <address>
              <span className="d2-mono">Copenhagen</span>
              Refshalevej 163A
              <br />
              1432 København K
            </address>
            <ul className="d2-mono">
              <li>
                <a href="https://vimeo.com/" rel="noreferrer">
                  Vimeo
                </a>
              </li>
              <li>
                <a href="https://www.instagram.com/" rel="noreferrer">
                  Instagram
                </a>
              </li>
              <li>
                <Link href="/">← All five concepts</Link>
              </li>
            </ul>
          </div>
        </div>
        <p className="d2-footer__fin" aria-hidden="true">
          Umbra
        </p>
        <p className="d2-footer__legal d2-mono">
          <span>© 2026 Umbra Filmes, Lda.</span>
          <span>Fin.</span>
        </p>
      </footer>
    </RevealRoot>
  );
}
