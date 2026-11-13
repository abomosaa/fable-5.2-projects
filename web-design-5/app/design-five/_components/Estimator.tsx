"use client";

import { useState } from "react";
import { buildMailto } from "../../_shared/mailto";
import { CONTACT_EMAIL } from "../content";
import {
  estimate,
  modules,
  paces,
  projectTypes,
  type ModuleId,
  type ProjectTypeId,
} from "../estimate";

const MAX_WEEKS = 24;

/**
 * Interactive estimator. Everything is computed client-side from
 * `estimate.ts`; "Request this build" hands the spec to the visitor's
 * mail client.
 */
export function Estimator() {
  const [type, setType] = useState<ProjectTypeId>("system");
  const [selected, setSelected] = useState<ModuleId[]>(["audit", "docs"]);
  const [pace, setPace] = useState(1);

  const result = estimate(type, selected, pace);
  const project = projectTypes.find((item) => item.id === type) ?? projectTypes[0];

  const toggle = (id: ModuleId) =>
    setSelected((current) =>
      current.includes(id) ? current.filter((item) => item !== id) : [...current, id],
    );

  const mailto = buildMailto(CONTACT_EMAIL, `Estimate request — ${project.label}`, [
    "Hello Datum,",
    "",
    "We would like to talk about the following build:",
    "",
    `Type:      ${project.label}`,
    `Modules:   ${
      modules
        .filter((item) => selected.includes(item.id))
        .map((item) => item.label)
        .join(", ") || "None"
    }`,
    `Pace:      ${paces[pace].label}`,
    `Estimate:  ${result.weeksLow}–${result.weeksHigh} weeks, €${result.costLow}k–€${result.costHigh}k`,
    "",
    "A little about us and the project:",
    "",
  ]);

  return (
    <div className="d5-est">
      <form className="d5-est__form" onSubmit={(event) => event.preventDefault()}>
        <fieldset>
          <legend>
            <span>01</span> Type of build
          </legend>
          <div className="d5-est__types">
            {projectTypes.map((item) => (
              <label key={item.id} className="d5-radio">
                <input
                  type="radio"
                  name="d5-type"
                  value={item.id}
                  checked={type === item.id}
                  onChange={() => setType(item.id)}
                />
                <span>{item.label}</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>
            <span>02</span> Modules
          </legend>
          <div className="d5-est__modules">
            {modules.map((item) => (
              <label key={item.id} className="d5-check">
                <input
                  type="checkbox"
                  checked={selected.includes(item.id)}
                  onChange={() => toggle(item.id)}
                />
                <span className="d5-check__box" aria-hidden="true" />
                <span>{item.label}</span>
                <span className="d5-check__add">+{item.weeks} wk</span>
              </label>
            ))}
          </div>
        </fieldset>

        <fieldset>
          <legend>
            <span>03</span> Pace
          </legend>
          <label className="d5-range">
            <span className="sr-only">Pace</span>
            <input
              type="range"
              min={0}
              max={paces.length - 1}
              step={1}
              value={pace}
              onChange={(event) => setPace(Number(event.target.value))}
              aria-valuetext={paces[pace].label}
            />
          </label>
          <div className="d5-range__labels" aria-hidden="true">
            {paces.map((item, i) => (
              <span key={item.label} data-active={i === pace}>
                {item.label}
              </span>
            ))}
          </div>
          <p className="d5-range__note">{paces[pace].note}</p>
        </fieldset>
      </form>

      <div className="d5-est__sheet" aria-live="polite">
        <p className="d5-est__stamp" aria-hidden="true">
          Preliminary
        </p>
        <p className="d5-est__label">Estimate — {project.label}</p>

        <dl className="d5-est__figures">
          <div>
            <dt>Duration</dt>
            <dd>
              {result.weeksLow}–{result.weeksHigh}
              <small>weeks</small>
            </dd>
          </div>
          <div>
            <dt>Budget</dt>
            <dd>
              €{result.costLow}–{result.costHigh}k
              <small>excl. VAT</small>
            </dd>
          </div>
        </dl>

        <div className="d5-est__scale" aria-hidden="true">
          <span
            className="d5-est__bar"
            style={{
              left: `${(result.weeksLow / MAX_WEEKS) * 100}%`,
              width: `${((result.weeksHigh - result.weeksLow) / MAX_WEEKS) * 100}%`,
            }}
          />
          <span
            className="d5-est__fill"
            style={{ width: `${(result.weeksLow / MAX_WEEKS) * 100}%` }}
          />
          <div className="d5-est__ticks">
            {[0, 4, 8, 12, 16, 20, 24].map((week) => (
              <i key={week}>{week}</i>
            ))}
          </div>
        </div>

        <dl className="d5-est__spec">
          <div>
            <dt>Team</dt>
            <dd>{result.team}</dd>
          </div>
          <div>
            <dt>Earliest start</dt>
            <dd>January 2027</dd>
          </div>
          <div>
            <dt>Terms</dt>
            <dd>Fixed price per phase · 90-day warranty</dd>
          </div>
        </dl>

        <a className="d5-btn d5-btn--solid" href={mailto}>
          Request this build <span aria-hidden="true">→</span>
        </a>
        <p className="d5-est__fine">
          Opens an email with this spec attached. Figures are indicative; a fixed quote follows a
          one-hour survey call.
        </p>
      </div>
    </div>
  );
}
