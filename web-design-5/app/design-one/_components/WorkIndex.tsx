"use client";

import { useEffect, useRef, useState } from "react";
import { prefersReducedMotion } from "../../_shared/usePrefersReducedMotion";
import type { Project } from "../content";
import { Poster } from "./Posters";

/**
 * The work index: a ruled table where each row expands into a short case
 * summary. On devices with a fine pointer a poster preview trails the cursor.
 */
export function WorkIndex({ projects }: { projects: Project[] }) {
  const [open, setOpen] = useState<number | null>(0);
  const [hovered, setHovered] = useState<number | null>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const list = listRef.current;
    const preview = previewRef.current;
    if (!list || !preview) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

    const ease = prefersReducedMotion() ? 1 : 0.16;
    let x = 0;
    let y = 0;
    let targetX = 0;
    let targetY = 0;
    let frame = 0;
    let primed = false;

    const render = () => {
      x += (targetX - x) * ease;
      y += (targetY - y) * ease;
      preview.style.transform = `translate3d(${x}px, ${y}px, 0)`;
      const settled =
        Math.abs(targetX - x) < 0.2 && Math.abs(targetY - y) < 0.2;
      frame = settled ? 0 : requestAnimationFrame(render);
    };

    const onMove = (event: PointerEvent) => {
      targetX = event.clientX;
      targetY = event.clientY;
      if (!primed) {
        // Start at the cursor instead of flying in from the corner.
        primed = true;
        x = targetX;
        y = targetY;
      }
      if (!frame) frame = requestAnimationFrame(render);
    };

    list.addEventListener("pointermove", onMove);
    return () => {
      list.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, []);

  const previewVisible = hovered !== null && hovered !== open;

  return (
    <div className="d1-index">
      <div className="d1-index__legend" aria-hidden="true">
        <span>No.</span>
        <span>Client</span>
        <span>Project</span>
        <span>Sector</span>
        <span>Year</span>
        <span />
      </div>

      <ol className="d1-index__list" ref={listRef}>
        {projects.map((project, i) => {
          const isOpen = open === i;
          const panelId = `d1-case-${project.no}`;
          return (
            <li key={project.no} className="d1-row" data-open={isOpen}>
              <button
                type="button"
                className="d1-row__head"
                aria-expanded={isOpen}
                aria-controls={panelId}
                onClick={() => setOpen(isOpen ? null : i)}
                onPointerEnter={() => setHovered(i)}
                onPointerLeave={() => setHovered(null)}
              >
                <span className="d1-row__no">{project.no}</span>
                <span className="d1-row__client">{project.client}</span>
                <span className="d1-row__project">{project.project}</span>
                <span className="d1-row__sector">{project.sector}</span>
                <span className="d1-row__year">{project.year}</span>
                <span className="d1-row__toggle" aria-hidden="true" />
              </button>

              <div id={panelId} className="d1-row__panel" inert={!isOpen}>
                <div className="d1-row__panel-inner">
                  <div className="d1-case">
                    <div className="d1-case__poster">
                      <Poster index={i} />
                    </div>
                    <div className="d1-case__body">
                      <p className="d1-case__summary">{project.summary}</p>
                      <ul className="d1-case__scope" aria-label="Scope">
                        {project.scope.map((item) => (
                          <li key={item}>{item}</li>
                        ))}
                      </ul>
                    </div>
                    <div className="d1-case__results">
                      <h4>Outcome</h4>
                      <ul>
                        {project.results.map((result) => (
                          <li key={result}>{result}</li>
                        ))}
                      </ul>
                    </div>
                  </div>
                </div>
              </div>
            </li>
          );
        })}
      </ol>

      <div
        ref={previewRef}
        className="d1-preview"
        data-visible={previewVisible}
        aria-hidden="true"
      >
        <div className="d1-preview__frame">
          {projects.map((project, i) => (
            <div
              key={project.no}
              className="d1-preview__item"
              data-active={hovered === i}
            >
              <Poster index={i} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
