"use client";

import { useState } from "react";
import { categories, type Category, type WorkItem } from "../content";
import { WorkArt } from "./WorkArt";

type Filter = Category | "All";

export function WorkGrid({ items }: { items: WorkItem[] }) {
  const [filter, setFilter] = useState<Filter>("All");
  const visible = filter === "All" ? items : items.filter((item) => item.tags.includes(filter));
  const filters: Filter[] = ["All", ...categories];

  return (
    <div className="d3-work">
      <div className="d3-chips" role="group" aria-label="Filter work by type">
        {filters.map((name) => (
          <button
            key={name}
            type="button"
            className="d3-chip"
            aria-pressed={filter === name}
            onClick={() => setFilter(name)}
          >
            {name}
            <span aria-hidden="true">
              {name === "All" ? items.length : items.filter((item) => item.tags.includes(name)).length}
            </span>
          </button>
        ))}
      </div>

      <p className="sr-only" role="status">
        Showing {visible.length} of {items.length} projects
      </p>

      {/* Re-keying on the filter restarts the pop-in animation for the new set. */}
      <ul className="d3-cards" key={filter}>
        {visible.map((item, i) => (
          <li key={item.id} className="d3-card" style={{ "--i": i } as React.CSSProperties}>
            <div className="d3-card__art" style={{ background: item.color }}>
              <WorkArt id={item.id} />
            </div>
            <div className="d3-card__body">
              <h3>{item.name}</h3>
              <p className="d3-card__what">{item.what}</p>
              <p className="d3-card__result">
                <span aria-hidden="true">★</span> {item.result}
              </p>
              <ul className="d3-card__tags">
                {item.tags.map((tag) => (
                  <li key={tag}>{tag}</li>
                ))}
              </ul>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
