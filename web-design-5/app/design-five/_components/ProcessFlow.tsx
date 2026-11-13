"use client";

import { useRef, useState, type KeyboardEvent } from "react";
import { process } from "../content";

/** A flow diagram that doubles as a tab list: pick a node, read its spec. */
export function ProcessFlow() {
  const [active, setActive] = useState(1);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const step = process[active];

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const delta = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (!delta) return;
    event.preventDefault();
    const next = (active + delta + process.length) % process.length;
    setActive(next);
    tabs.current[next]?.focus();
  };

  return (
    <div className="d5-flow">
      <div
        className="d5-flow__nodes"
        role="tablist"
        aria-label="Process stages"
        onKeyDown={onKeyDown}
        style={{ "--progress": active / (process.length - 1) } as React.CSSProperties}
      >
        {process.map((item, i) => (
          <button
            key={item.code}
            ref={(el) => {
              tabs.current[i] = el;
            }}
            type="button"
            role="tab"
            id={`d5-tab-${item.code}`}
            aria-selected={i === active}
            aria-controls="d5-flow-panel"
            tabIndex={i === active ? 0 : -1}
            className="d5-flow__node"
            data-done={i < active}
            onClick={() => setActive(i)}
          >
            <span className="d5-flow__code">{item.code}</span>
            <span className="d5-flow__name">{item.name}</span>
            <span className="d5-flow__time">{item.time}</span>
          </button>
        ))}
      </div>

      <div
        id="d5-flow-panel"
        role="tabpanel"
        aria-labelledby={`d5-tab-${step.code}`}
        className="d5-flow__panel"
      >
        <div key={step.code} className="d5-flow__panel-inner">
          <p className="d5-flow__ref">
            Detail {step.code} — {step.time}
          </p>
          <h3>{step.name}</h3>
          <p className="d5-flow__text">{step.text}</p>
          <ul>
            {step.outputs.map((output) => (
              <li key={output}>{output}</li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
