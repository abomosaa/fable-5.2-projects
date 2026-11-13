import type { Metadata, Viewport } from "next";
import { Inter_Tight } from "next/font/google";
import Link from "next/link";
import { CountUp } from "../_shared/CountUp";
import { PageBackground } from "../_shared/PageBackground";
import { RevealRoot } from "../_shared/RevealRoot";
import { Header } from "./_components/Header";
import { WorkIndex } from "./_components/WorkIndex";
import {
  CONTACT_EMAIL,
  clients,
  disciplines,
  method,
  projects,
  recognition,
  stats,
} from "./content";
import "./design-one.css";

const grotesk = Inter_Tight({
  subsets: ["latin"],
  variable: "--font-d1",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Oberfeld — Bureau for brand identity & typographic systems",
  description:
    "Oberfeld is an independent design bureau in Zürich and Rotterdam. We build identity systems, custom typefaces and digital design languages for companies that mean it.",
};

export const viewport: Viewport = { themeColor: "#ecebe6" };

const totalWeeks = method.reduce((sum, step) => sum + step.weeks, 0);

export default function DesignOne() {
  return (
    <RevealRoot className={`d1 ${grotesk.variable}`} id="d1-top">
      <PageBackground color="#ecebe6" />
      <a className="d1-skip" href="#d1-main">
        Skip to content
      </a>
      <Header />

      <main id="d1-main">
        {/* ── 01 Hero ─────────────────────────────────────────────── */}
        <section className="d1-hero" aria-labelledby="d1-hero-title">
          <div className="d1-hero__disc" aria-hidden="true">
            <span />
          </div>

          <div className="d1-hero__meta">
            <p className="d1-tag">
              <span>(01)</span> Introduction
            </p>
            <p className="d1-hero__lede">
              Oberfeld is an independent bureau of designers, type engineers
              and strategists. We build identities that work on a Tuesday
              afternoon, not just on launch day.
            </p>
          </div>

          <h1 id="d1-hero-title" className="d1-hero__title">
            <span className="d1-line">
              <span>Identity systems</span>
            </span>{" "}
            <span className="d1-line">
              <span>for companies</span>
            </span>{" "}
            <span className="d1-line">
              <span>
                that mean it<em>.</em>
              </span>
            </span>
          </h1>

          <dl className="d1-hero__facts">
            <div>
              <dt>Founded</dt>
              <dd>2011, Zürich</dd>
            </div>
            <div>
              <dt>Team</dt>
              <dd>26 people, two studios</dd>
            </div>
            <div>
              <dt>Focus</dt>
              <dd>Identity, type, digital design language</dd>
            </div>
            <div>
              <dt>Availability</dt>
              <dd>
                <span className="d1-pulse" aria-hidden="true" />
                Booking from March 2027
              </dd>
            </div>
          </dl>
        </section>

        {/* ── 02 Bureau statement ─────────────────────────────────── */}
        <section className="d1-section d1-statement" id="d1-bureau">
          <header className="d1-sechead" data-reveal>
            <p className="d1-tag">
              <span>(02)</span> Bureau
            </p>
          </header>
          <div className="d1-statement__body">
            <p className="d1-statement__text" data-reveal>
              A brand is not what you launch. It is what four thousand people
              do with it afterwards. We design <mark>the rules</mark>, the{" "}
              <mark>typefaces</mark> and the <mark>tools</mark> that make doing
              the right thing the easiest thing.
            </p>
            <div className="d1-statement__cols">
              <article data-reveal style={{ "--i": 0 } as React.CSSProperties}>
                <h3>Systems, not logos</h3>
                <p>
                  A mark is one decision. An identity is ten thousand. We spend
                  our time on the nine thousand nine hundred and ninety-nine
                  that nobody presents on a slide.
                </p>
              </article>
              <article data-reveal style={{ "--i": 1 } as React.CSSProperties}>
                <h3>Type is infrastructure</h3>
                <p>
                  Typography is the only brand asset that turns up on every
                  surface you own. We draw it, engineer it and license it so it
                  works everywhere and you own it.
                </p>
              </article>
              <article data-reveal style={{ "--i": 2 } as React.CSSProperties}>
                <h3>Built to be used</h3>
                <p>
                  If the in-house team cannot make a decent poster without
                  calling us, we have failed. Every system ships with
                  templates, tokens and a phone number.
                </p>
              </article>
            </div>
          </div>
        </section>

        {/* ── 03 Work index ───────────────────────────────────────── */}
        <section className="d1-section" id="d1-work">
          <header className="d1-sechead" data-reveal>
            <p className="d1-tag">
              <span>(03)</span> Selected work
            </p>
            <h2 className="d1-title">Index 2023—26</h2>
            <p className="d1-sechead__note">
              Eight of 214. Select a row for the short version; ask us for the
              long one.
            </p>
          </header>
          <WorkIndex projects={projects} />
        </section>

        {/* ── 04 Disciplines ──────────────────────────────────────── */}
        <section className="d1-section d1-dark" id="d1-disciplines">
          <header className="d1-sechead" data-reveal>
            <p className="d1-tag">
              <span>(04)</span> Disciplines
            </p>
            <h2 className="d1-title">
              Four disciplines,
              <br />
              one system.
            </h2>
          </header>
          <ol className="d1-disc">
            {disciplines.map((item) => (
              <li key={item.no} className="d1-disc__item" data-reveal>
                <span className="d1-disc__no">{item.no}</span>
                <h3 className="d1-disc__title">{item.title}</h3>
                <p className="d1-disc__text">{item.text}</p>
                <ul className="d1-disc__list">
                  {item.items.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>
        </section>

        {/* ── 05 Numbers ──────────────────────────────────────────── */}
        <section className="d1-section d1-numbers" aria-label="Oberfeld in numbers">
          <header className="d1-sechead" data-reveal>
            <p className="d1-tag">
              <span>(05)</span> In numbers
            </p>
          </header>
          <dl className="d1-stats">
            {stats.map((stat, i) => (
              <div
                key={stat.label}
                data-reveal
                style={{ "--i": i } as React.CSSProperties}
              >
                <dd>
                  <CountUp to={stat.value} suffix={stat.suffix} />
                </dd>
                <dt>{stat.label}</dt>
              </div>
            ))}
          </dl>
        </section>

        {/* ── 06 Method ───────────────────────────────────────────── */}
        <section className="d1-section" id="d1-method">
          <header className="d1-sechead" data-reveal>
            <p className="d1-tag">
              <span>(06)</span> Method
            </p>
            <h2 className="d1-title">
              Eighteen weeks,
              <br />
              drawn to scale.
            </h2>
            <p className="d1-sechead__note">
              A typical identity programme. The bar below is proportional — most
              of the time goes where most of the work is.
            </p>
          </header>

          <div className="d1-scale" data-reveal aria-hidden="true">
            {method.map((step) => (
              <span
                key={step.no}
                style={{ flexGrow: step.weeks }}
                data-step={step.no}
              >
                <b>{step.title}</b>
                <i>{Math.round((step.weeks / totalWeeks) * 100)}%</i>
              </span>
            ))}
          </div>

          <ol className="d1-method">
            {method.map((step, i) => (
              <li
                key={step.no}
                data-reveal
                style={{ "--i": i } as React.CSSProperties}
              >
                <p className="d1-method__no">{step.no}</p>
                <h3>{step.title}</h3>
                <p className="d1-method__time">{step.duration}</p>
                <p>{step.text}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ── 07 Clients & recognition ────────────────────────────── */}
        <section className="d1-section" aria-labelledby="d1-clients-title">
          <header className="d1-sechead" data-reveal>
            <p className="d1-tag">
              <span>(07)</span> Clients & recognition
            </p>
            <h2 className="d1-title" id="d1-clients-title">
              Good company.
            </h2>
          </header>

          <ul className="d1-clients" data-reveal>
            {clients.map((client) => (
              <li key={client}>{client}</li>
            ))}
          </ul>

          <div className="d1-proof">
            <figure className="d1-quote" data-reveal>
              <blockquote>
                <p>
                  “We briefed a logo. Oberfeld delivered an operating system for
                  the brand, and the patience to teach nine product teams how to
                  use it. Two years on, nobody remembers the old way.”
                </p>
              </blockquote>
              <figcaption>
                <strong>Marta Ilves</strong>
                Chief Brand Officer, Lumen Bank
              </figcaption>
            </figure>

            <table className="d1-awards" data-reveal>
              <caption>Recognition</caption>
              <tbody>
                {recognition.map((row) => (
                  <tr key={`${row.year}-${row.award}`}>
                    <td>{row.year}</td>
                    <th scope="row">{row.award}</th>
                    <td>{row.detail}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* ── 08 Contact ──────────────────────────────────────────── */}
        <section className="d1-contact" id="d1-contact">
          <p className="d1-tag" data-reveal>
            <span>(08)</span> New business
          </p>
          <a
            className="d1-contact__cta"
            href={`mailto:${CONTACT_EMAIL}?subject=New%20project`}
            data-reveal
          >
            <span>Start a</span>
            <span>
              project <i aria-hidden="true">↗</i>
            </span>
          </a>

          <div className="d1-contact__grid">
            <div data-reveal style={{ "--i": 0 } as React.CSSProperties}>
              <h3>Write to</h3>
              <p>
                Jonas Oberfeld, Partner
                <br />
                <a href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
                <br />
                <a href="tel:+41445550142">+41 44 555 01 42</a>
              </p>
            </div>
            <div data-reveal style={{ "--i": 1 } as React.CSSProperties}>
              <h3>Tell us</h3>
              <ol>
                <li>What you are making, in two sentences</li>
                <li>When it needs to exist</li>
                <li>A budget range, however rough</li>
              </ol>
            </div>
            <div data-reveal style={{ "--i": 2 } as React.CSSProperties}>
              <h3>Good to know</h3>
              <p>
                Identity programmes start at CHF 60,000 and run twelve to
                twenty weeks. We reply to every enquiry within two working
                days, including the ones we have to decline.
              </p>
            </div>
          </div>
        </section>
      </main>

      <footer className="d1-footer">
        <div className="d1-footer__grid">
          <address>
            <strong>Zürich</strong>
            Hardturmstrasse 161
            <br />
            8005 Zürich, Switzerland
          </address>
          <address>
            <strong>Rotterdam</strong>
            Schiehavenkade 208
            <br />
            3024 EZ Rotterdam, Netherlands
          </address>
          <ul>
            <li>
              <a href="https://www.instagram.com/" rel="noreferrer">
                Instagram
              </a>
            </li>
            <li>
              <a href="https://www.linkedin.com/" rel="noreferrer">
                LinkedIn
              </a>
            </li>
            <li>
              <a href="https://www.are.na/" rel="noreferrer">
                Are.na
              </a>
            </li>
          </ul>
          <ul>
            <li>
              <a href="#d1-top">Back to top ↑</a>
            </li>
            <li>
              <Link href="/">All five concepts ←</Link>
            </li>
          </ul>
        </div>

        <svg
          className="d1-footer__wordmark"
          viewBox="0 0 1000 205"
          role="img"
          aria-label="Oberfeld"
        >
          <text
            x="0"
            y="188"
            textLength="1000"
            lengthAdjust="spacingAndGlyphs"
            fontSize="262"
            fontWeight="600"
          >
            Oberfeld
          </text>
        </svg>

        <p className="d1-footer__legal">
          <span>© 2026 Oberfeld GmbH</span>
          <span>CHE-114.203.771</span>
          <span>Set in Inter Tight</span>
        </p>
      </footer>
    </RevealRoot>
  );
}
