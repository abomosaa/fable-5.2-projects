/** Builds a `mailto:` URL with a pre-filled subject and multi-line body. */
export function buildMailto(to: string, subject: string, lines: string[]) {
  const params = new URLSearchParams({ subject, body: lines.join("\n") });
  // URLSearchParams encodes spaces as "+", which mail clients render literally.
  return `mailto:${to}?${params.toString().replace(/\+/g, "%20")}`;
}
