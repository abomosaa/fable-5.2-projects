import type { Metadata, Viewport } from "next";
import { Cormorant_Garamond, Jost } from "next/font/google";
import Link from "next/link";
import { PageBackground } from "../_shared/PageBackground";
import { RevealRoot } from "../_shared/RevealRoot";
import { Enquiry } from "./_components/Enquiry";
import { Plate } from "./_components/Plates";
import {
  CONTACT_EMAIL,
  commissions,
  figures,
  houses,
  journal,
  materials,
  offer,
  principles,
} from "./content";
import "./design-four.css";

const serif = Cormorant_Garamond({
  subsets: ["latin"],
  weight: ["300", "400", "500"],
  style: ["normal", "italic"],
  variable: "--font-d4-serif",
  display: "swap",
});
const sans = Jost({ subsets: ["latin"], variable: "--font-d4-sans", display: "swap" });

export const metadata: Metadata = {
  title: "Atelier Solenne — Art direction & identity for houses of craft",
  description:
    "Atelier Solenne is an art direction and identity practice in Paris and Copenhagen, working with six hotels, perfumers, vintners and makers each year.",
};

export const viewport: Viewport = { themeColor: "#efe8dc" };

function Ornament() {
  return (
    <svg className="d4-ornament" viewBox="0 0 120 16" aria-hidden="true">
      <path d="M0 8 H46 M74 8 H120" stroke="currentColor" strokeWidth="0.75" />
      <path d="M60 1.5 L66.5 8 L60 14.5 L53.5 8 Z" fill="none" stroke="currentColor" strokeWidth="0.75" />
      <circle cx="60" cy="8" r="1.4" fill="currentColor" />
    </svg>
  );
}

function Monogram() {
  return (
    <svg className="d4-monogram" viewBox="0 0 64 64" aria-hidden="true">
      <circle cx="32" cy="32" r="30.5" fill="none" stroke="currentColor" strokeWidth="0.75" />
      <circle cx="32" cy="32" r="26.5" fill="none" stroke="currentColor" strokeWidth="0.4" />
      <text x="32" y="43" textAnchor="middle" fontSize="33" fontStyle="italic" fill="currentColor">
        S
      </text>
    </svg>
  );
}

export default function DesignFour() {
  return (
    <RevealRoot className={`d4 ${serif.variable} ${sans.variable}`} id="d4-top">
      <PageBackground color="#efe8dc" />
      <div className="d4-progress" aria-hidden="true" />
      <a className="d4-skip" href="#d4-main">
        Skip to content
      </a>

      <header className="d4-header">
        <nav className="d4-header__nav" aria-label="Primary">
          <a href="#d4-commissions">Commissions</a>
          <a href="#d4-atelier">The Atelier</a>
        </nav>
        <a className="d4-wordmark" href="#d4-top" aria-label="Atelier Solenne, back to top">
          <small>Atelier</small>
          Solenne
        </a>
        <nav className="d4-header__nav d4-header__nav--end" aria-label="Secondary">
          <a href="#d4-library">Library</a>
          <a href="#d4-enquire">Enquire</a>
        </nav>
      </header>

      <main id="d4-main">
        {/* ── Hero ───────────────────────────────────────────────── */}
        <section className="d4-hero" aria-labelledby="d4-hero-title">
          <p className="d4-caps d4-hero__kicker">Art direction & identity · Paris — Copenhagen</p>
          <h1 id="d4-hero-title" className="d4-hero__title">
            <span>Identities of</span> <span>
              <em>quiet</em> consequence
            </span>
          </h1>

          <div className="d4-hero__stage">
            <p className="d4-hero__aside d4-hero__aside--left">
              <span className="d4-caps">N° 01 — The practice</span>
              We work with hotels, perfumers, vintners and makers who intend to be here in a
              hundred years, and design accordingly.
            </p>

            <figure className="d4-plate d4-plate--arch d4-hero__plate">
              <Plate id="nature-morte" label="Still life: a dark vase with a single stem, a brass sphere and a terracotta disc on a warm wall" />
            </figure>

            <div className="d4-hero__aside d4-hero__aside--right">
              <p>
                <span className="d4-caps">Commissions, 2027</span>
                Six houses each year. Two places remain.
              </p>
              <a className="d4-link" href="#d4-enquire">
                Begin an enquiry
              </a>
            </div>
          </div>

          <p className="d4-caps d4-hero__foot">
            <span>Est. MMIX</span>
            <span>Nature morte, atelier wall — 2026</span>
            <span>Scroll</span>
          </p>
        </section>

        {/* ── Manifesto ──────────────────────────────────────────── */}
        <section className="d4-manifesto" aria-label="Manifesto">
          <Ornament />
          <p className="d4-manifesto__text" data-reveal>
            We believe the most persuasive thing a house can do is lower its voice. So we make
            identities that are <em>felt before they are noticed</em>, and remembered long after
            the wrapping has been folded and kept.
          </p>
          <p className="d4-manifesto__sign" data-reveal>
            <em>Solène Marchetti & Aksel Thorne</em>
            <span className="d4-caps">Founders</span>
          </p>
        </section>

        {/* ── Commissions ────────────────────────────────────────── */}
        <section className="d4-section" id="d4-commissions">
          <header className="d4-head" data-reveal>
            <p className="d4-caps">Chapter one</p>
            <h2 className="d4-h2">
              Selected <em>commissions</em>
            </h2>
          </header>

          <div className="d4-spreads">
            {commissions.map((item) => (
              <article key={item.house} className="d4-spread" data-shape={item.shape}>
                <figure className={`d4-plate d4-plate--${item.shape}`} data-reveal>
                  <Plate id={item.plate} label={`${item.house}, ${item.scope}`} />
                  <figcaption className="d4-caps">
                    Pl. {item.numeral} — {item.place}
                  </figcaption>
                </figure>
                <div className="d4-spread__text" data-reveal>
                  <p className="d4-spread__numeral" aria-hidden="true">
                    {item.numeral}
                  </p>
                  <h3>{item.house}</h3>
                  <p className="d4-spread__body">{item.text}</p>
                  <dl>
                    <div>
                      <dt className="d4-caps">Scope</dt>
                      <dd>{item.scope}</dd>
                    </div>
                    <div>
                      <dt className="d4-caps">Place</dt>
                      <dd>{item.place}</dd>
                    </div>
                    <div>
                      <dt className="d4-caps">Year</dt>
                      <dd>{item.year}</dd>
                    </div>
                  </dl>
                  <p className="d4-spread__note">
                    <em>{item.note}</em>
                  </p>
                </div>
              </article>
            ))}
          </div>
        </section>

        {/* ── The atelier offers ─────────────────────────────────── */}
        <section className="d4-dark" id="d4-atelier">
          <header className="d4-head" data-reveal>
            <p className="d4-caps">Chapter two</p>
            <h2 className="d4-h2">
              What the atelier <em>offers</em>
            </h2>
            <p className="d4-head__lede">
              Four disciplines, practised by eleven people in two cities. We prefer to do all four
              for one house than one for four.
            </p>
          </header>

          <ol className="d4-offer">
            {offer.map((item, i) => (
              <li key={item.title} data-reveal style={{ "--i": i } as React.CSSProperties}>
                <p className="d4-offer__numeral">{item.numeral}</p>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
                <ul className="d4-caps">
                  {item.items.map((entry) => (
                    <li key={entry}>{entry}</li>
                  ))}
                </ul>
              </li>
            ))}
          </ol>

          <dl className="d4-figures">
            {figures.map((figure, i) => (
              <div key={figure.label} data-reveal style={{ "--i": i } as React.CSSProperties}>
                <dd>{figure.value}</dd>
                <dt className="d4-caps">{figure.label}</dt>
              </div>
            ))}
          </dl>
        </section>

        {/* ── Method ─────────────────────────────────────────────── */}
        <section className="d4-section d4-method">
          <header className="d4-head" data-reveal>
            <p className="d4-caps">Chapter three</p>
            <h2 className="d4-h2">
              A <em>slower</em> method
            </h2>
          </header>
          <ol className="d4-principles">
            {principles.map((item) => (
              <li key={item.no} data-reveal>
                <p className="d4-caps">{item.no}</p>
                <h3>{item.title}</h3>
                <p>{item.text}</p>
              </li>
            ))}
          </ol>
        </section>

        {/* ── Materials library ──────────────────────────────────── */}
        <section className="d4-section d4-library" id="d4-library">
          <header className="d4-head" data-reveal>
            <p className="d4-caps">Chapter four</p>
            <h2 className="d4-h2">
              The <em>library</em>
            </h2>
            <p className="d4-head__lede">
              Four hundred and twelve papers, cloths, foils and stones live in the drawers of the
              Paris atelier. A few we return to more often than is strictly reasonable.
            </p>
          </header>
          <ul className="d4-swatches">
            {materials.map((item, i) => (
              <li key={item.id} data-reveal style={{ "--i": i % 4 } as React.CSSProperties}>
                <span className="d4-swatch" data-material={item.id} aria-hidden="true">
                  <i>S</i>
                </span>
                <span className="d4-swatch__no d4-caps">{String(i + 1).padStart(2, "0")}</span>
                <strong>{item.name}</strong>
                <span className="d4-swatch__spec">{item.spec}</span>
              </li>
            ))}
          </ul>
        </section>

        {/* ── Words & houses ─────────────────────────────────────── */}
        <section className="d4-words" aria-label="In their words">
          <Ornament />
          <figure data-reveal>
            <blockquote>
              <p>
                “They spent a week in the hotel before they drew anything. By the end the night
                porter knew them by name, and the identity they gave us felt as though it had
                always been ours.”
              </p>
            </blockquote>
            <figcaption>
              <em>Élodie Vauquelin</em>
              <span className="d4-caps">Proprietor, Hôtel Vauquelin</span>
            </figcaption>
          </figure>

          <div className="d4-houses" data-reveal>
            <p className="d4-caps">Houses we have served</p>
            <p className="d4-houses__list">
              {houses.map((house, i) => (
                <span key={house}>
                  {house}
                  {i < houses.length - 1 ? <i aria-hidden="true"> · </i> : null}
                </span>
              ))}
            </p>
          </div>
        </section>

        {/* ── Journal ────────────────────────────────────────────── */}
        <section className="d4-section d4-journal" aria-labelledby="d4-journal-title">
          <header className="d4-head" data-reveal>
            <p className="d4-caps">Chapter five</p>
            <h2 className="d4-h2" id="d4-journal-title">
              Notes from the <em>atelier</em>
            </h2>
          </header>
          <ul className="d4-notes">
            {journal.map((entry, i) => (
              <li key={entry.title} data-reveal style={{ "--i": i } as React.CSSProperties}>
                <p className="d4-caps">{entry.date}</p>
                <h3>{entry.title}</h3>
                <p>{entry.text}</p>
              </li>
            ))}
          </ul>
        </section>

        {/* ── Enquire ────────────────────────────────────────────── */}
        <section className="d4-enquire" id="d4-enquire">
          <div className="d4-enquire__card" data-reveal>
            <Monogram />
            <p className="d4-caps">Commissions for 2027</p>
            <h2 className="d4-h2">
              Write to <em>the atelier</em>
            </h2>
            <p className="d4-enquire__lede">
              Tell us about your house — what it makes, whom it serves, and what you would like it
              to be known for in twenty years. We read every letter ourselves.
            </p>
            <Enquiry />
            <p className="d4-enquire__alt">
              Or write directly: <a className="d4-link" href={`mailto:${CONTACT_EMAIL}`}>{CONTACT_EMAIL}</a>
            </p>
          </div>
        </section>
      </main>

      <footer className="d4-footer">
        <Monogram />
        <div className="d4-footer__grid">
          <address>
            <span className="d4-caps">Paris</span>
            14 rue de Thorigny
            <br />
            75003 Paris
            <br />
            <a href="tel:+33155500137">+33 1 55 50 01 37</a>
          </address>
          <address>
            <span className="d4-caps">Copenhagen</span>
            Bredgade 38, 2. sal
            <br />
            1260 København K
            <br />
            <a href="tel:+4533550142">+45 33 55 01 42</a>
          </address>
          <ul>
            <li className="d4-caps">Elsewhere</li>
            <li>
              <a href="https://www.instagram.com/" rel="noreferrer">
                Instagram
              </a>
            </li>
            <li>
              <a href={`mailto:${CONTACT_EMAIL}`}>Correspondence</a>
            </li>
            <li>
              <Link href="/">All five concepts</Link>
            </li>
          </ul>
        </div>
        <p className="d4-footer__colophon d4-caps">
          <span>© MMXXVI Atelier Solenne SARL</span>
          <span>Set in Cormorant Garamond & Jost</span>
          <a href="#d4-top">Return to top</a>
        </p>
      </footer>
    </RevealRoot>
  );
}
