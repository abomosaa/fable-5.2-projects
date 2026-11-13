"use client";

import { useEffect } from "react";

/**
 * Paints the document canvas while a design is on screen so overscroll and
 * short pages never flash white behind a dark layout. The colour is removed
 * again when the route is hidden or unmounted.
 */
export function PageBackground({ color }: { color: string }) {
  useEffect(() => {
    const root = document.documentElement;
    const previous = root.style.backgroundColor;
    root.style.backgroundColor = color;
    return () => {
      root.style.backgroundColor = previous;
    };
  }, [color]);

  return null;
}
