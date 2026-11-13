"use client";

import { useEffect, useRef, type ReactNode } from "react";
import { prefersReducedMotion } from "../../_shared/usePrefersReducedMotion";

/**
 * The hero is a lens pointed at a single light. With a mouse, the light
 * follows the cursor; otherwise it drifts on its own (see `d2-drift` in CSS).
 */
export function HeroLight({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (!window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
    if (prefersReducedMotion()) return;

    let x = 68;
    let y = 40;
    let targetX = x;
    let targetY = y;
    let frame = 0;

    const render = () => {
      x += (targetX - x) * 0.07;
      y += (targetY - y) * 0.07;
      el.style.setProperty("--mx", `${x.toFixed(2)}%`);
      el.style.setProperty("--my", `${y.toFixed(2)}%`);
      const settled = Math.abs(targetX - x) < 0.05 && Math.abs(targetY - y) < 0.05;
      frame = settled ? 0 : requestAnimationFrame(render);
    };

    const onMove = (event: PointerEvent) => {
      const rect = el.getBoundingClientRect();
      targetX = ((event.clientX - rect.left) / rect.width) * 100;
      targetY = ((event.clientY - rect.top) / rect.height) * 100;
      el.dataset.live = "true";
      if (!frame) frame = requestAnimationFrame(render);
    };

    el.addEventListener("pointermove", onMove);
    return () => {
      el.removeEventListener("pointermove", onMove);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <section ref={ref} className="d2-hero" aria-labelledby="d2-hero-title">
      {children}
    </section>
  );
}
