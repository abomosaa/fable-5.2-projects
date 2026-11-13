"use client";

import { useEffect, useRef, type ComponentPropsWithoutRef } from "react";

/**
 * Wraps a subtree and flags every descendant carrying `data-reveal` with
 * `data-revealed` the first time it scrolls into view.
 *
 * The component is intentionally style-agnostic: each design choreographs its
 * own entrance in CSS (`[data-reveal]` → `[data-revealed]`), so server-rendered
 * sections stay server components and only need a data attribute.
 */
export function RevealRoot({
  children,
  ...rest
}: ComponentPropsWithoutRef<"div">) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) return;

    const targets = root.querySelectorAll<HTMLElement>(
      "[data-reveal]:not([data-revealed])",
    );

    if (!("IntersectionObserver" in window)) {
      targets.forEach((el) => el.setAttribute("data-revealed", ""));
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          entry.target.setAttribute("data-revealed", "");
          observer.unobserve(entry.target);
        }
      },
      { rootMargin: "0px 0px -6% 0px", threshold: 0.05 },
    );

    targets.forEach((el) => observer.observe(el));
    return () => observer.disconnect();
  }, []);

  return (
    <div ref={ref} {...rest}>
      {children}
    </div>
  );
}
