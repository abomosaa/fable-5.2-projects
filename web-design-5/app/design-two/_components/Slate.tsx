"use client";

import { useState, type FormEvent } from "react";
import { buildMailto } from "../../_shared/mailto";
import { CONTACT_EMAIL } from "../content";

const formats = [
  "Brand film",
  "Launch film",
  "Motion identity",
  "Title sequence",
  "Live / realtime visuals",
  "Not sure yet",
];

/**
 * The enquiry form, dressed as a clapperboard. There is no backend: submitting
 * composes an email in the visitor's own mail client.
 */
export function Slate() {
  const [sent, setSent] = useState(false);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const get = (name: string) => String(data.get(name) ?? "").trim();

    window.location.href = buildMailto(
      CONTACT_EMAIL,
      `New production — ${get("production") || "Untitled"}`,
      [
        `Production: ${get("production") || "Untitled"}`,
        `From: ${get("name")} <${get("email")}>`,
        `Format: ${get("format")}`,
        `Delivery: ${get("delivery") || "Flexible"}`,
        "",
        get("notes"),
      ],
    );
    setSent(true);
  };

  return (
    <form className="d2-slate" data-sent={sent} onSubmit={onSubmit}>
      <div className="d2-slate__sticks" aria-hidden="true">
        <span className="d2-slate__stick d2-slate__stick--top" />
        <span className="d2-slate__stick" />
      </div>

      <div className="d2-slate__body">
        <label className="d2-slate__field d2-slate__field--wide">
          <span className="d2-mono">Prod.</span>
          <input name="production" type="text" placeholder="Working title" autoComplete="off" />
        </label>
        <label className="d2-slate__field">
          <span className="d2-mono">Director</span>
          <input name="name" type="text" placeholder="Your name" autoComplete="name" required />
        </label>
        <label className="d2-slate__field">
          <span className="d2-mono">Contact</span>
          <input name="email" type="email" placeholder="you@company.com" autoComplete="email" required />
        </label>
        <label className="d2-slate__field">
          <span className="d2-mono">Format</span>
          <select name="format" defaultValue={formats[0]}>
            {formats.map((format) => (
              <option key={format}>{format}</option>
            ))}
          </select>
        </label>
        <label className="d2-slate__field">
          <span className="d2-mono">Delivery</span>
          <input name="delivery" type="text" placeholder="e.g. Spring 2027" autoComplete="off" />
        </label>
        <label className="d2-slate__field d2-slate__field--wide">
          <span className="d2-mono">Notes</span>
          <textarea name="notes" rows={3} placeholder="What is the film for, and who needs to feel what?" />
        </label>

        <div className="d2-slate__actions">
          <button type="submit" className="d2-btn d2-btn--solid">
            <span>Roll camera</span>
            <span aria-hidden="true">→</span>
          </button>
          <p className="d2-mono" role="status">
            {sent
              ? "Your mail app should have opened with the slate filled in."
              : "Opens a pre-filled email. We reply within one working day."}
          </p>
        </div>
      </div>
    </form>
  );
}
