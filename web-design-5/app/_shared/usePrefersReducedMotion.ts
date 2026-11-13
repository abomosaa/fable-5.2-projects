"use client";

import { useSyncExternalStore } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

function subscribe(onChange: () => void) {
  const media = window.matchMedia(QUERY);
  media.addEventListener("change", onChange);
  return () => media.removeEventListener("change", onChange);
}

/** `true` when the visitor asked the OS for reduced motion. `false` on the server. */
export function usePrefersReducedMotion() {
  return useSyncExternalStore(
    subscribe,
    () => window.matchMedia(QUERY).matches,
    () => false,
  );
}

/** Imperative check for use inside effects and event handlers. */
export function prefersReducedMotion() {
  return (
    typeof window !== "undefined" && window.matchMedia(QUERY).matches
  );
}
