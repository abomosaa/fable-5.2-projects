"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { nav } from "../content";

export function Nav() {
  const [open, setOpen] = useState(false);

  // Transient UI: do not restore an open menu when the route is revisited.
  useLayoutEffect(() => () => setOpen(false), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <header className="d3-header">
      <div className="d3-header__bar">
        <a className="d3-logo" href="#d3-top" onClick={() => setOpen(false)}>
          <span className="d3-logo__face" aria-hidden="true">
            <i />
            <i />
          </span>
          Wiggle Room
        </a>

        <nav className="d3-header__links" aria-label="Primary">
          {nav.map((item) => (
            <a key={item.href} href={item.href}>
              {item.label}
            </a>
          ))}
        </nav>

        <a className="d3-btn d3-btn--pink d3-header__cta" href="#d3-hi">
          Say hi
        </a>

        <button
          type="button"
          className="d3-burger"
          aria-expanded={open}
          aria-controls="d3-menu"
          aria-label={open ? "Close menu" : "Open menu"}
          onClick={() => setOpen((value) => !value)}
        >
          <span />
          <span />
        </button>
      </div>

      <nav id="d3-menu" className="d3-menu" aria-label="Mobile" hidden={!open}>
        {nav.map((item, i) => (
          <a
            key={item.href}
            href={item.href}
            style={{ "--i": i } as React.CSSProperties}
            onClick={() => setOpen(false)}
          >
            {item.label}
          </a>
        ))}
        <a
          href="#d3-hi"
          className="d3-menu__cta"
          style={{ "--i": nav.length } as React.CSSProperties}
          onClick={() => setOpen(false)}
        >
          Say hi →
        </a>
      </nav>
    </header>
  );
}
