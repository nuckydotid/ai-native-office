// Text safety shared by the app and the team server. No DOM, no Node: it also runs in older browsers (Safari 15), so
// no regex lookbehind.

/** Removes unpaired UTF-16 surrogates (a half emoji). Postgres refuses them in `jsonb`, and `JSON.stringify` writes them as `\ud83d`. */
export function stripLoneSurrogates(s: string): string {
  let out = '';
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        out += s[i] + s[i + 1];
        i += 1;
      }
    } else if (c < 0xdc00 || c > 0xdfff) {
      out += s[i];
    }
  }
  return out;
}

/** Number of Unicode code points (an emoji is one). */
export function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const next = s.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) i += 1;
    }
    n += 1;
  }
  return n;
}

/** The first `max` code points of `s`, never cutting an emoji in half. */
export function clampCodePoints(s: string, max: number): string {
  let n = 0;
  let i = 0;
  while (i < s.length && n < max) {
    const c = s.charCodeAt(i);
    i += c >= 0xd800 && c <= 0xdbff && i + 1 < s.length && s.charCodeAt(i + 1) >= 0xdc00 && s.charCodeAt(i + 1) <= 0xdfff ? 2 : 1;
    n += 1;
  }
  return s.slice(0, i);
}

// Characters that are never wanted in chat text, as code ranges: control characters (but not tab, line feed, carriage return),
// the line and paragraph separators, and the invisible ones that flip or hide text (zero-width space, bidi marks, overrides
// and isolates, the byte-order mark, and the "tag" characters that can hide a whole sentence). The zero-width joiner and
// non-joiner are kept: emoji sequences (a family, a person at a laptop) and Persian and Indic words need them.
const UNWANTED: [number, number][] = [
  [0x00, 0x08],
  [0x0b, 0x0c],
  [0x0e, 0x1f],
  [0x7f, 0x7f],
  [0x061c, 0x061c],
  [0x180e, 0x180e],
  [0x200b, 0x200b],
  [0x200e, 0x200f],
  [0x2028, 0x2029],
  [0x202a, 0x202e],
  [0x2060, 0x2064],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
  [0xe0000, 0xe007f],
];

const unwanted = (code: number) => UNWANTED.some(([lo, hi]) => code >= lo && code <= hi);

/** Cleans untrusted text: no control or invisible characters, no half emoji, trimmed, at most `max` code points. */
export function sanitizeText(s: string, max: number): string {
  let kept = '';
  // Iterating a string walks it by code point (a lone half of an emoji comes out on its own, and is removed next).
  for (const ch of s) if (!unwanted(ch.codePointAt(0) as number)) kept += ch;
  return clampCodePoints(stripLoneSurrogates(kept).trim(), max);
}
