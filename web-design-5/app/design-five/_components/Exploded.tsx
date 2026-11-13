"use client";

import { useState } from "react";
import { layers } from "../content";

/**
 * Hero figure: an exploded isometric view of how an interface is built.
 * The stack is plain CSS 3D; state only decides which layer is highlighted
 * and whether the view is exploded or assembled.
 */
export function Exploded() {
  const [exploded, setExploded] = useState(true);
  const [active, setActive] = useState<number | null>(null);

  return (
    <figure className="d5-fig" data-exploded={exploded}>
      <div className="d5-fig__stage" aria-hidden="true">
        <div className="d5-iso">
          {layers.map((layer, i) => (
            <div
              key={layer.no}
              className="d5-iso__layer"
              data-layer={layer.no}
              data-active={active === i}
              style={{ "--z": layers.length - 1 - i } as React.CSSProperties}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive(null)}
            >
              <span className="d5-iso__tag">
                {layer.no} {layer.name}
              </span>
              <span className="d5-iso__art">
                <i />
                <i />
                <i />
                <i />
                <i />
                <i />
              </span>
            </div>
          ))}
          <span className="d5-iso__axis" />
        </div>
      </div>

      <figcaption className="d5-fig__legend">
        <p className="d5-fig__title">
          <span>Fig. 1</span> Interface, exploded view
        </p>
        <ol>
          {layers.map((layer, i) => (
            <li
              key={layer.no}
              data-active={active === i}
              onPointerEnter={() => setActive(i)}
              onPointerLeave={() => setActive(null)}
            >
              <span className="d5-fig__no">{layer.no}</span>
              <span>
                <strong>{layer.name}</strong>
                {layer.spec}
              </span>
            </li>
          ))}
        </ol>
        <button
          type="button"
          className="d5-toggle"
          aria-pressed={exploded}
          onClick={() => setExploded((value) => !value)}
        >
          <span className="d5-toggle__box" aria-hidden="true" />
          Exploded view
        </button>
      </figcaption>
    </figure>
  );
}
