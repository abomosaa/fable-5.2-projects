"use client";

import { useEffect, useState } from "react";
import { usePrefersReducedMotion } from "../../_shared/usePrefersReducedMotion";
import type { Film } from "../content";
import { Still } from "./Stills";

const DWELL_MS = 6500;

/**
 * The showreel viewer: one widescreen frame and a list of selects. It advances
 * on its own until the visitor picks a film, hovers the viewer or prefers
 * reduced motion.
 */
export function Reel({ films }: { films: Film[] }) {
  const [active, setActive] = useState(0);
  const [held, setHeld] = useState(false);
  const [hovering, setHovering] = useState(false);
  const reduced = usePrefersReducedMotion();
  const autoplay = !reduced && !held && !hovering;

  useEffect(() => {
    if (!autoplay) return;
    const id = window.setTimeout(
      () => setActive((index) => (index + 1) % films.length),
      DWELL_MS,
    );
    return () => window.clearTimeout(id);
  }, [autoplay, active, films.length]);

  const film = films[active];
  const select = (index: number) => {
    setActive(index);
    setHeld(true);
  };

  return (
    <div
      className="d2-reel"
      data-autoplay={autoplay}
      onPointerEnter={() => setHovering(true)}
      onPointerLeave={() => setHovering(false)}
    >
      <div className="d2-reel__viewer">
        <div className="d2-reel__frame">
          {films.map((item, i) => (
            <div key={item.still} className="d2-reel__still" data-active={i === active}>
              <Still id={item.still} />
            </div>
          ))}
          <span className="d2-reel__mark d2-reel__mark--tl" aria-hidden="true" />
          <span className="d2-reel__mark d2-reel__mark--tr" aria-hidden="true" />
          <span className="d2-reel__mark d2-reel__mark--bl" aria-hidden="true" />
          <span className="d2-reel__mark d2-reel__mark--br" aria-hidden="true" />
          <p className="d2-reel__slate d2-mono" aria-hidden="true">
            <span>Reel 26</span>
            <span>
              Select {String(active + 1).padStart(2, "0")}/{String(films.length).padStart(2, "0")}
            </span>
            <span>2.39:1</span>
          </p>
        </div>

        <div className="d2-reel__caption" aria-live="polite">
          <div key={film.still} className="d2-reel__caption-inner">
            <h3>{film.title}</h3>
            <p className="d2-mono">
              {film.client} · {film.kind} · {film.runtime} · {film.year}
            </p>
            <p className="d2-reel__note">{film.note}</p>
            {film.laurels ? <p className="d2-reel__laurel d2-mono">❋ {film.laurels}</p> : null}
          </div>
        </div>
      </div>

      <ol className="d2-reel__list">
        {films.map((item, i) => (
          <li key={item.still}>
            <button
              type="button"
              className="d2-reel__item"
              aria-current={i === active ? "true" : undefined}
              onClick={() => select(i)}
            >
              <span className="d2-reel__thumb" aria-hidden="true">
                <Still id={item.still} />
              </span>
              <span className="d2-reel__item-text">
                <span className="d2-mono">
                  {String(i + 1).padStart(2, "0")} — {item.kind}
                </span>
                <span className="d2-reel__item-title">{item.title}</span>
              </span>
              <span className="d2-mono d2-reel__item-time">{item.runtime}</span>
              <span
                key={i === active ? `run-${active}` : "idle"}
                className="d2-reel__progress"
                style={{ animationDuration: `${DWELL_MS}ms` }}
                aria-hidden="true"
              />
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}
