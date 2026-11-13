"use client";

import { useState, type FormEvent } from "react";
import { buildMailto } from "../../_shared/mailto";
import { CONTACT_EMAIL } from "../content";

const natures = [
  "A new house",
  "A house in need of renewal",
  "Packaging or a single object",
  "Art direction",
  "Something else entirely",
];

/**
 * The enquiry card. There is no backend: sending composes a letter in the
 * visitor's own mail client.
 */
export function Enquiry() {
  const [sent, setSent] = useState(false);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const get = (name: string) => String(data.get(name) ?? "").trim();

    window.location.href = buildMailto(CONTACT_EMAIL, `Enquiry — ${get("house") || get("name")}`, [
      "Dear Solène, dear Aksel,",
      "",
      get("words") || "(A few words about the house.)",
      "",
      `Nature of the commission: ${get("nature")}`,
      `House: ${get("house") || "—"}`,
      "",
      "With kind regards,",
      get("name"),
      get("email"),
    ]);
    setSent(true);
  };

  return (
    <form className="d4-form" onSubmit={onSubmit}>
      <label className="d4-field">
        <span>Your name</span>
        <input name="name" type="text" autoComplete="name" required />
      </label>
      <label className="d4-field">
        <span>Your house</span>
        <input name="house" type="text" autoComplete="organization" />
      </label>
      <label className="d4-field">
        <span>Email</span>
        <input name="email" type="email" autoComplete="email" required />
      </label>
      <label className="d4-field">
        <span>Nature of the commission</span>
        <select name="nature" defaultValue={natures[0]}>
          {natures.map((nature) => (
            <option key={nature}>{nature}</option>
          ))}
        </select>
      </label>
      <label className="d4-field d4-field--wide">
        <span>A few words</span>
        <textarea name="words" rows={3} />
      </label>
      <div className="d4-form__foot">
        <button type="submit" className="d4-button">
          <span>Send enquiry</span>
        </button>
        <p role="status">
          {sent
            ? "Thank you. Your letter has been drafted in your mail application."
            : "Opens a drafted letter in your mail application. We reply within two working days."}
        </p>
      </div>
    </form>
  );
}
