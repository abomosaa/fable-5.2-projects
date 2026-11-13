"use client";

import { useEffect, useRef, useState } from "react";
import { sheets } from "../content";

/**
 * The drawing's title block. It tracks which "sheet" (section) is on screen
 * and, with a mouse, reads out the cursor position like a drafting table.
 */
export function TitleBlock() {
  const [current, setCurrent] = useState(0);
  const coords = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const sections = sheets
      .map((sheet) => document.getElementById(sheet.id))
      .filter((el): el is HTMLElement => el !== null);

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const index = sheets.findIndex((sheet) => sheet.id === entry.target.id);
          if (index >= 0) setCurrent(index);
        }
      },
      // A thin band across the middle of the viewport decides the active sheet.
      { rootMargin: "-45% 0px -50% 0px" },
    );
    sections.forEach((section) => observer.observe(section));
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const el = coords.current;
    if (!el) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

    let frame = 0;
    let x = 0;
    let y = 0;
    const write = () => {
      frame = 0;
      el.textContent = `X ${String(x).padStart(4, "0")}  Y ${String(y).padStart(5, "0")}`;
    };
    const onMove = (event: PointerEvent) => {
      x = Math.round(event.clientX);
      y = Math.round(event.clientY + window.scrollY);
      if (!frame) frame = requestAnimationFrame(write);
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, []);

  const sheet = sheets[current];

  return (
    <aside className="d5-titleblock" aria-label="Drawing title block">
      <div className="d5-titleblock__brand">
        <strong>Datum</strong>
        <span>Design engineering</span>
      </div>
      <dl>
        <div className="d5-titleblock__wide">
          <dt>Title</dt>
          <dd aria-live="polite">{sheet.title}</dd>
        </div>
        <div>
          <dt>Sheet</dt>
          <dd>
            {sheet.no}/{String(sheets.length).padStart(2, "0")}
          </dd>
        </div>
        <div>
          <dt>Rev</dt>
          <dd>D</dd>
        </div>
        <div>
          <dt>Scale</dt>
          <dd>1:1</dd>
        </div>
        <div>
          <dt>Units</dt>
          <dd>px</dd>
        </div>
        <div className="d5-titleblock__wide d5-titleblock__coords">
          <dt>Cursor</dt>
          <dd>
            <span ref={coords}>X 0000  Y 00000</span>
          </dd>
        </div>
      </dl>
      <ol className="d5-titleblock__ticks" aria-hidden="true">
        {sheets.map((item, i) => (
          <li key={item.id} data-active={i === current} data-done={i < current} />
        ))}
      </ol>
    </aside>
  );
}
