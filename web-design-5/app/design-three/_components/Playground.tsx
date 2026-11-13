"use client";

import { useEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode } from "react";
import { prefersReducedMotion } from "../../_shared/usePrefersReducedMotion";

/**
 * The hero playground. Two toys live here:
 *  - every `.d3-eye` inside follows the cursor;
 *  - every `[data-sticker]` can be picked up and dropped somewhere else.
 * Both are decorative, so the whole stage is hidden from assistive tech.
 */
export function Playground({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  // Googly eyes.
  useEffect(() => {
    const stage = ref.current;
    if (!stage || prefersReducedMotion()) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;

    const pupils = Array.from(stage.querySelectorAll<HTMLElement>(".d3-eye > i"));
    let frame = 0;
    let x = 0;
    let y = 0;

    const look = () => {
      frame = 0;
      for (const pupil of pupils) {
        const eye = pupil.parentElement!.getBoundingClientRect();
        const dx = x - (eye.left + eye.width / 2);
        const dy = y - (eye.top + eye.height / 2);
        const reach = Math.min(1, Math.hypot(dx, dy) / 140) * eye.width * 0.22;
        const angle = Math.atan2(dy, dx);
        pupil.style.transform = `translate(${Math.cos(angle) * reach}px, ${Math.sin(angle) * reach}px)`;
      }
    };

    const onMove = (event: PointerEvent) => {
      x = event.clientX;
      y = event.clientY;
      if (!frame) frame = requestAnimationFrame(look);
    };

    stage.dataset.tracking = "true";
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => {
      window.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
      delete stage.dataset.tracking;
    };
  }, []);

  // Draggable stickers, via event delegation on the stage.
  const drag = useRef<{ el: HTMLElement; startX: number; startY: number; baseX: number; baseY: number } | null>(null);

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    const el = (event.target as HTMLElement).closest<HTMLElement>("[data-sticker]");
    if (!el) return;
    event.preventDefault();
    el.setPointerCapture(event.pointerId);
    el.dataset.dragging = "true";
    drag.current = {
      el,
      startX: event.clientX,
      startY: event.clientY,
      baseX: Number(el.dataset.x ?? 0),
      baseY: Number(el.dataset.y ?? 0),
    };
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const state = drag.current;
    if (!state) return;
    const nextX = state.baseX + event.clientX - state.startX;
    const nextY = state.baseY + event.clientY - state.startY;
    state.el.dataset.x = String(nextX);
    state.el.dataset.y = String(nextY);
    state.el.style.setProperty("--dx", `${nextX}px`);
    state.el.style.setProperty("--dy", `${nextY}px`);
  };

  const onPointerUp = () => {
    if (!drag.current) return;
    delete drag.current.el.dataset.dragging;
    drag.current = null;
  };

  return (
    <div
      ref={ref}
      className="d3-play"
      aria-hidden="true"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
    >
      {children}
    </div>
  );
}
