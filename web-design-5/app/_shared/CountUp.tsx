"use client";

import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "./usePrefersReducedMotion";

type CountUpProps = {
  to: number;
  /** Digits after the decimal point. */
  decimals?: number;
  prefix?: string;
  suffix?: string;
  /** Animation length in milliseconds. */
  duration?: number;
  className?: string;
};

function format(value: number, decimals: number) {
  return value.toLocaleString("en-US", {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

/**
 * Counts from zero to `to` the first time it enters the viewport.
 * The final value is server-rendered, so it is correct without JavaScript and
 * for visitors who prefer reduced motion.
 */
export function CountUp({
  to,
  decimals = 0,
  prefix = "",
  suffix = "",
  duration = 1600,
  className,
}: CountUpProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const done = useRef(false);

  useEffect(() => {
    const el = ref.current;
    if (!el || done.current || prefersReducedMotion()) return;

    let frame = 0;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry.isIntersecting) return;
        observer.disconnect();
        done.current = true;

        const start = performance.now();
        const tick = (now: number) => {
          const progress = Math.min((now - start) / duration, 1);
          const eased = 1 - Math.pow(1 - progress, 4);
          el.textContent = `${prefix}${format(to * eased, decimals)}${suffix}`;
          if (progress < 1) frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );

    observer.observe(el);
    return () => {
      observer.disconnect();
      cancelAnimationFrame(frame);
      el.textContent = `${prefix}${format(to, decimals)}${suffix}`;
    };
  }, [to, decimals, prefix, suffix, duration]);

  return (
    <span ref={ref} className={className}>
      {prefix}
      {format(to, decimals)}
      {suffix}
    </span>
  );
}
