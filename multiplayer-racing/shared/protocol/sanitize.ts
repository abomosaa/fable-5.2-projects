/**
 * Sanitisation for every user-controlled string (player names, room names,
 * chat). Applied by the schemas, so it runs on both sides of the wire.
 */

/**
 * Invisible code points that are removed outright: soft hyphen, zero-width
 * characters, bidirectional overrides/isolates, line/paragraph separators,
 * Hangul fillers, variation selectors, BOM and interlinear annotations.
 * (Kept as numeric ranges so this source file stays plain ASCII.)
 */
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202f],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe0fff],
];

// Characters with meaning in HTML. The client never renders user text as
// HTML, this is defence in depth.
const MARKUP = /[<>]/g;
const WHITESPACE = /\s+/g;
// Combining marks stacked absurdly high ("zalgo").
const STACKED_MARKS = /(\p{M}{3})\p{M}+/gu;

function isControl(code: number): boolean {
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
}

function isInvisible(code: number): boolean {
  for (const [lo, hi] of INVISIBLE_RANGES) {
    if (code >= lo && code <= hi) return true;
  }
  return false;
}

/** Normalises and cleans a string, then truncates it to `maxLength` code points. */
export function sanitizeText(input: string, maxLength: number): string {
  const bounded = input.length > maxLength * 8 + 64 ? input.slice(0, maxLength * 8 + 64) : input;
  let text = '';
  for (const ch of bounded.normalize('NFKC')) {
    const code = ch.codePointAt(0) ?? 0;
    // Lone surrogates cannot be encoded as UTF-8; drop them.
    if (code >= 0xd800 && code <= 0xdfff) continue;
    if (isControl(code)) text += ' ';
    else if (!isInvisible(code)) text += ch;
  }
  text = text.replace(MARKUP, '').replace(STACKED_MARKS, '$1').replace(WHITESPACE, ' ').trim();
  const points = [...text];
  if (points.length > maxLength) text = points.slice(0, maxLength).join('').trim();
  return text;
}

export function sanitizer(maxLength: number): (value: string) => string {
  return (value) => sanitizeText(value, maxLength);
}

/** Canonical form of a room code typed or pasted by a user. */
export function normalizeRoomCode(input: string): string {
  return input
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, 12);
}
