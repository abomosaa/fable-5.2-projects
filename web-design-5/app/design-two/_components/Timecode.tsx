"use client";

import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "../../_shared/usePrefersReducedMotion";

const FPS = 24;
const pad = (value: number) => String(value).padStart(2, "0");

function toTimecode(ms: number) {
  const frames = Math.floor((ms / 1000) * FPS);
  const ff = frames % FPS;
  const seconds = Math.floor(frames / FPS);
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}:${pad(ff)}`;
}

/** A running 24 fps timecode. Stays frozen for visitors who prefer reduced motion. */
export function Timecode({ className }: { className?: string }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || prefersReducedMotion()) return;

    const start = performance.now();
    let frame = 0;
    let last = "";
    const tick = (now: number) => {
      const next = toTimecode(now - start);
      if (next !== last) {
        el.textContent = next;
        last = next;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, []);

  return (
    <span ref={ref} className={className} aria-hidden="true">
      00:00:00:00
    </span>
  );
}
