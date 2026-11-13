"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { LocalTime } from "../../_shared/LocalTime";
import { nav } from "../content";

export function Header() {
  const [menuOpen, setMenuOpen] = useState(false);

  // The menu is transient UI: never restore it open when the route is revisited.
  useLayoutEffect(() => () => setMenuOpen(false), []);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      root.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const close = () => setMenuOpen(false);

  return (
    <header className="d1-header" data-menu-open={menuOpen}>
      <div className="d1-header__bar">
        <a className="d1-header__brand" href="#d1-top" onClick={close}>
          Oberfeld<sup>®</sup>
        </a>
        <p className="d1-header__desc">
          Bureau for brand identity
          <br />& typographic systems
        </p>
        <p className="d1-header__place">
          Zürich, CH
          <br />
          <LocalTime timeZone="Europe/Zurich" />
        </p>
        <nav className="d1-header__nav" aria-label="Primary">
          {nav.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
        </nav>
        <a className="d1-btn d1-header__cta" href="#d1-contact">
          <span>Start a project</span>
          <span className="d1-btn__arrow" aria-hidden="true">
            ↗
          </span>
        </a>
        <button
          type="button"
          className="d1-header__toggle"
          aria-expanded={menuOpen}
          aria-controls="d1-menu"
          onClick={() => setMenuOpen((value) => !value)}
        >
          {menuOpen ? "Close" : "Menu"}
        </button>
      </div>

      <div id="d1-menu" className="d1-menu" hidden={!menuOpen}>
        <nav aria-label="Mobile">
          {nav.map((item, i) => (
            <a key={item.href} href={item.href} onClick={close}>
              <span>0{i + 1}</span>
              {item.label}
            </a>
          ))}
          <a href="#d1-contact" onClick={close}>
            <span>05</span>
            Contact
          </a>
        </nav>
        <p>
          Zürich <LocalTime timeZone="Europe/Zurich" seconds={false} /> ·
          Rotterdam <LocalTime timeZone="Europe/Amsterdam" seconds={false} />
        </p>
      </div>
    </header>
  );
}
