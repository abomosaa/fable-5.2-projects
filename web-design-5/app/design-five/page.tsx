import type { Metadata, Viewport } from "next";
import { IBM_Plex_Mono } from "next/font/google";
import localFont from "next/font/local";
import Link from "next/link";
import { CountUp } from "../_shared/CountUp";
import { PageBackground } from "../_shared/PageBackground";
import { RevealRoot } from "../_shared/RevealRoot";
import { Drawing } from "./_components/Drawings";
import { Estimator } from "./_components/Estimator";
import { Exploded } from "./_components/Exploded";
import { ProcessFlow } from "./_components/ProcessFlow";
import { TitleBlock } from "./_components/TitleBlock";
import {
  CONTACT_EMAIL,
  benchmarks,
  capabilities,
  fieldNotes,
  revisions,
  sheets,
  work,
} from "./content";
import "./design-five.css";

// Self-hosted: see ./fonts/README.md.
const display = localFont({
  src: "./fonts/BigShoulders-latin-variable.woff2",
  weight: "100 900",
  variable: "--font-d5-display",
  display: "swap",
  adjustFontFallback: false,
});
const mono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-d5-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Datum — Design engineering studio",
  description:
    "Datum is a design engineering studio in Rotterdam and Toronto. We turn brand and product design into production-grade design systems, web platforms and interfaces, built to tolerance.",
};

export const viewport: Viewport = { themeColor: "#1238e0" };

function SheetHead({
  index,
  title,
  note,
}: {
  index: number;
  title: React.ReactNode;
  note?: string;
}) {
  const sheet = sheets[index];
  return (
    <header className="d5-head" data-reveal>
      <p className="d5-head__ref">
        <span>
          Sheet {sheet.no}/{String(sheets.length).padStart(2, "0")}
        </span>
        <span>{sheet.title}</span>
      </p>
      <h2 className="d5-h2">{title}</h2>
      {note ? <p className="d5-head__note">{note}</p> : null}
    </header>
  );
}

export default function DesignFive() {
  return (
    <RevealRoot className={`d5 ${display.variable} ${mono.variable}`} id="d5-top">
      <PageBackground color="#1238e0" />
      <div className="d5-frame" aria-hidden="true" />
      <a className="d5-skip" href="#d5-main">
        Skip to content
      </a>

      <header className="d5-header">
        <a className="d5-brand" href="#d5-top" aria-label="Datum, back to top">
          <svg viewBox="0 0 40 40" aria-hidden="true">
            <rect x="1" y="1" width="38" height="38" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M8 28 L20 9 L32 28 Z" fill="currentColor" />
            <path d="M4 32 H36" stroke="currentColor" strokeWidth="2" />
          </svg>
          Datum
        </a>
        <nav className="d5-nav" aria-label="Primary">
          <a href="#d5-capabilities">
            <span>02</span> Capabilities
          </a>
          <a href="#d5-work">
            <span>03</span> Work
          </a>
          <a href="#d5-process">
            <span>04</span> Process
          </a>
          <a href="#d5-estimate">
            <span>06</span> Estimate
          </a>
        </nav>
        <p className="d5-status">
          <i aria-hidden="true" /> Booking Q1 2027
        </p>
        <a className="d5-btn d5-btn--solid d5-header__cta" href="#d5-estimate">
          Get an estimate
        </a>
      </header>

      <main id="d5-main">
        {/* ── Sheet 01 · Cover ───────────────────────────────────── */}
        <section className="d5-hero" id="d5-cover" aria-labelledby="d5-hero-title">
          <div className="d5-hero__copy">
            <p className="d5-ref">DWG No. DTM-000 · Design engineering studio · Rotterdam / Toronto</p>
            <h1 id="d5-hero-title" className="d5-hero__title">
              <span>We build</span> <span>what</span> <span>designers</span> <span>draw</span>
              <span className="d5-hero__dim" aria-hidden="true">
                <i>± 0 px</i>
              </span>
            </h1>
            <p className="d5-hero__lede">
              Datum turns brand and product design into production-grade design systems, web
              platforms and interfaces. Measured, documented and built to tolerance.
            </p>
            <div className="d5-hero__cta">
              <a className="d5-btn d5-btn--solid" href="#d5-estimate">
                Estimate a project <span aria-hidden="true">→</span>
              </a>
              <a className="d5-btn" href="#d5-work">
                View the drawings
              </a>
            </div>
            <dl className="d5-hero__spec">
              <div>
                <dt>Team</dt>
                <dd>14 design engineers</dd>
              </div>
              <div>
                <dt>Stack</dt>
                <dd>React · TypeScript · CSS</dd>
              </div>
              <div>
                <dt>Standard</dt>
                <dd>WCAG 2.2 AA</dd>
              </div>
              <div>
                <dt>Since</dt>
                <dd>2019</dd>
              </div>
            </dl>
          </div>
          <Exploded />
        </section>

        {/* ── Sheet 02 · Capabilities ────────────────────────────── */}
        <section className="d5-sheet" id="d5-capabilities">
          <SheetHead
            index={1}
            title={
              <>
                Schedule of <em>capabilities</em>
              </>
            }
            note="Five things we do, with typical duration and crew. Mix as required."
          />
          <div className="d5-table" role="table" aria-label="Capabilities">
            <div className="d5-table__row d5-table__row--head" role="row">
              <span role="columnheader">Code</span>
              <span role="columnheader">Capability</span>
              <span role="columnheader">Description</span>
              <span role="columnheader">Duration</span>
              <span role="columnheader">Crew</span>
              <span role="columnheader">Output</span>
            </div>
            {capabilities.map((item) => (
              <div key={item.code} className="d5-table__row" role="row" data-reveal>
                <span role="cell" className="d5-table__code">
                  {item.code}
                </span>
                <h3 role="cell">{item.name}</h3>
                <p role="cell">{item.text}</p>
                <span role="cell" data-label="Duration">
                  {item.duration}
                </span>
                <span role="cell" data-label="Crew">
                  {item.team}
                </span>
                <span role="cell" data-label="Output">
                  {item.output}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* ── Sheet 03 · Selected work ───────────────────────────── */}
        <section className="d5-sheet" id="d5-work">
          <SheetHead
            index={2}
            title={
              <>
                Selected <em>drawings</em>
              </>
            }
            note="Four of 120-odd builds. Numbers are measured in production, not in the pitch."
          />
          <ul className="d5-work">
            {work.map((item, i) => (
              <li key={item.dwg} className="d5-card" data-reveal style={{ "--i": i % 2 } as React.CSSProperties}>
                <div className="d5-card__plot">
                  <Drawing id={item.drawing} />
                  <span className="d5-card__dwg">{item.dwg}</span>
                </div>
                <div className="d5-card__body">
                  <p className="d5-ref">{item.client}</p>
                  <h3>{item.title}</h3>
                  <p className="d5-card__text">{item.text}</p>
                  <dl className="d5-card__metrics">
                    {item.metrics.map((metric) => (
                      <div key={metric.label}>
                        <dd>{metric.value}</dd>
                        <dt>{metric.label}</dt>
                      </div>
                    ))}
                  </dl>
                  <p className="d5-card__stack">{item.stack}</p>
                </div>
              </li>
            ))}
          </ul>
        </section>

        {/* ── Sheet 04 · Process ─────────────────────────────────── */}
        <section className="d5-sheet" id="d5-process">
          <SheetHead
            index={3}
            title={
              <>
                Sequence of <em>works</em>
              </>
            }
            note="Twelve weeks for a typical system. Select a stage for the detail."
          />
          <div data-reveal>
            <ProcessFlow />
          </div>
        </section>

        {/* ── Sheet 05 · Benchmarks ──────────────────────────────── */}
        <section className="d5-sheet d5-paper" id="d5-benchmarks">
          <SheetHead
            index={4}
            title={
              <>
                Measured, <em>not claimed</em>
              </>
            }
            note="Taken from live builds and client analytics, rolling twelve months."
          />
          <dl className="d5-bench">
            {benchmarks.map((item, i) => (
              <div key={item.label} data-reveal style={{ "--i": i } as React.CSSProperties}>
                <dt>
                  <span>{item.ref}</span>
                  {item.label}
                </dt>
                <dd>
                  <CountUp to={item.value} decimals={item.decimals} suffix={item.suffix} />
                </dd>
              </div>
            ))}
          </dl>

          <ul className="d5-notes">
            {fieldNotes.map((note, i) => (
              <li key={note.name} data-reveal style={{ "--i": i } as React.CSSProperties}>
                <figure>
                  <p className="d5-ref">Field note {String(i + 1).padStart(2, "0")}</p>
                  <blockquote>
                    <p>“{note.quote}”</p>
                  </blockquote>
                  <figcaption>
                    <strong>{note.name}</strong>
                    {note.role}
                  </figcaption>
                </figure>
              </li>
            ))}
          </ul>
        </section>

        {/* ── Sheet 06 · Estimate ────────────────────────────────── */}
        <section className="d5-sheet" id="d5-estimate">
          <SheetHead
            index={5}
            title={
              <>
                Estimate <em>your build</em>
              </>
            }
            note="Three inputs, one honest range. No email required to see the number."
          />
          <div data-reveal>
            <Estimator />
          </div>
        </section>

        {/* ── Sheet 07 · Issue ───────────────────────────────────── */}
        <section className="d5-sheet d5-issue" id="d5-contact">
          <div className="d5-issue__main" data-reveal>
            <p className="d5-ref">Sheet 07/07 · Issued for construction</p>
            <h2 className="d5-issue__title">
              Send us <em>the drawings.</em>
            </h2>
            <p className="d5-issue__lede">
              Figma file, napkin sketch or a legacy codebase nobody wants to open. We reply within
              one working day with questions, not a sales deck.
            </p>
            <div className="d5-hero__cta">
              <a className="d5-btn d5-btn--solid" href={`mailto:${CONTACT_EMAIL}?subject=New%20build`}>
                {CONTACT_EMAIL} <span aria-hidden="true">→</span>
              </a>
              <a className="d5-btn" href="tel:+31105550163">
                +31 10 555 0163
              </a>
            </div>
          </div>

          <div className="d5-rev" data-reveal>
            <table>
              <caption>Revisions</caption>
              <thead>
                <tr>
                  <th scope="col">Rev</th>
                  <th scope="col">Date</th>
                  <th scope="col">Description</th>
                  <th scope="col">By</th>
                </tr>
              </thead>
              <tbody>
                {revisions.map((row) => (
                  <tr key={row.rev}>
                    <td>{row.rev}</td>
                    <td>{row.date}</td>
                    <td>{row.note}</td>
                    <td>{row.by}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>

      <footer className="d5-footer">
        <address>
          <strong>Rotterdam</strong>
          Van Nelleweg 1, Unit 2406
          <br />
          3044 BC Rotterdam, NL
        </address>
        <address>
          <strong>Toronto</strong>
          401 Richmond St W, Studio 368
          <br />
          Toronto, ON M5V 3A8
        </address>
        <ul>
          <li>
            <a href="https://github.com/" rel="noreferrer">
              GitHub
            </a>
          </li>
          <li>
            <a href="https://www.linkedin.com/" rel="noreferrer">
              LinkedIn
            </a>
          </li>
          <li>
            <Link href="/">← All five concepts</Link>
          </li>
        </ul>
        <p>
          © 2026 Datum Design Engineering B.V.
          <br />
          KvK 74 20 18 63 · Do not scale from this drawing.
        </p>
      </footer>

      <TitleBlock />
    </RevealRoot>
  );
}
