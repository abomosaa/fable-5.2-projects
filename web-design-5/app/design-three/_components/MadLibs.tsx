"use client";

import { useState, type FormEvent } from "react";
import { buildMailto } from "../../_shared/mailto";
import { CONTACT_EMAIL } from "../content";

const needs = ["a whole new brand", "packaging", "illustration", "a website", "a bit of everything", "I’m not sure yet"];
const starts = ["as soon as possible", "next month", "in a few months", "whenever you’re free"];

/**
 * A fill-in-the-blanks brief. No backend: sending composes the sentence into
 * an email in the visitor's own mail client.
 */
export function MadLibs() {
  const [sent, setSent] = useState(false);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const get = (name: string) => String(data.get(name) ?? "").trim();
    const company = get("company");

    window.location.href = buildMailto(CONTACT_EMAIL, `Hi from ${get("name")}`, [
      `Hi Wiggle Room!`,
      "",
      `I’m ${get("name")}${company ? ` from ${company}` : ""}. We need a hand with ${get("need")} and we’d love to start ${get("start")}.`,
      "",
      `Write me back at ${get("email")}.`,
    ]);
    setSent(true);
  };

  return (
    <form className="d3-libs" onSubmit={onSubmit}>
      <p className="d3-libs__text">
        Hi Wiggle Room! I’m{" "}
        <label>
          <span className="sr-only">Your name</span>
          <input name="name" type="text" placeholder="your name" autoComplete="name" required />
        </label>{" "}
        from{" "}
        <label>
          <span className="sr-only">Your company</span>
          <input name="company" type="text" placeholder="company" autoComplete="organization" />
        </label>
        . We need a hand with{" "}
        <label>
          <span className="sr-only">What you need</span>
          <select name="need" defaultValue={needs[0]}>
            {needs.map((need) => (
              <option key={need}>{need}</option>
            ))}
          </select>
        </label>{" "}
        and we’d love to start{" "}
        <label>
          <span className="sr-only">When you would like to start</span>
          <select name="start" defaultValue={starts[1]}>
            {starts.map((start) => (
              <option key={start}>{start}</option>
            ))}
          </select>
        </label>
        . Write me back at{" "}
        <label>
          <span className="sr-only">Your email</span>
          <input name="email" type="email" placeholder="your email" autoComplete="email" required />
        </label>
        .
      </p>

      <div className="d3-libs__actions">
        <button type="submit" className="d3-btn d3-btn--yellow d3-btn--big">
          Send it <span aria-hidden="true">→</span>
        </button>
        <p role="status">
          {sent
            ? "Nice! Your mail app should have popped open with the note."
            : "Opens your email with the note written for you. We answer within a day."}
        </p>
      </div>
    </form>
  );
}
