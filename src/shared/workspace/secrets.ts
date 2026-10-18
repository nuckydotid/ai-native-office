// Redacts things that look like credentials from text that is about to be posted to the whole room (and kept). It is a
// safety net for an agent's reply, not a security boundary: it only knows common shapes. Used by the app before it
// sends a reply and by the team server before it saves one, from this one copy, so the two cannot disagree.
//
// Every pattern is anchored on something specific and its repeats are bounded, so hostile text can't make it slow.
// A replacement may be longer than what it replaces; callers that have a length limit check it again afterwards.

const MARK = '[redacted]';

type Rule = [RegExp, (...groups: string[]) => string];

const mark = () => MARK;

const RULES: Rule[] = [
  // A private key block (PEM, or PGP's "… KEY BLOCK"), to its end, or to the end of the text if it was cut off.
  [/-----BEGIN [A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z ]{0,30}PRIVATE KEY(?: BLOCK)?-----|$)/g, () => '[redacted key]'],
  // A value of a secret-looking key, quoted: `"client_secret": "…"`, `refresh_token = '…'`.
  [/(\b(?:client_secret|refresh_token|private_key|access_token|api[_-]?key|secret[_-]?key|auth[_-]?token)\b["']?\s*[:=]\s*["'])[A-Za-z0-9._~/+=-]{16,512}(["'])/gi, (_m, key, quote) => key + MARK + quote],
  // The same without quotes, for the keys that are only ever secrets: `refresh_token=1//0g…`.
  [/(\b(?:client_secret|refresh_token|access_token)\s*[:=]\s*)[A-Za-z0-9._~/+=-]{16,512}/gi, (_m, key) => key + MARK],
  // A bearer token in a header.
  [/(\bBearer\s+)[A-Za-z0-9._~+/=-]{20,2048}/g, (_m, head) => head + MARK],
  // A Google refresh token on its own.
  [/\b1\/\/0[A-Za-z0-9_-]{20,512}/g, mark],
  // A password inside an address: postgres://user:pass@host, redis://:pass@host. The password may itself contain an `@`.
  [/\b([a-z][a-z0-9+.-]{0,31}:\/\/)[^\s:@/]{0,256}:[^\s/]{1,512}@/gi, (_m, scheme) => scheme + MARK + '@'],
  [/\bya29\.[A-Za-z0-9_-]{20,2048}/g, mark],
  [/\bAIza[0-9A-Za-z_-]{35}\b/g, mark],
  [/\bGOCSPX-[A-Za-z0-9_-]{20,128}/g, mark],
  [/\bgh[pousr]_[A-Za-z0-9]{30,255}/g, mark],
  [/\bgithub_pat_[A-Za-z0-9_]{40,255}/g, mark],
  [/\bAKIA[0-9A-Z]{16}\b/g, mark],
  [/\bsk_live_[A-Za-z0-9]{16,255}/g, mark],
  // `sk-…` keys always carry digits; ordinary hyphenated words (CSS class names) don't.
  [/\bsk-(?=[A-Za-z0-9_-]{0,255}\d)[A-Za-z0-9_-]{20,255}/g, mark],
  [/\bxox[baprs]-[A-Za-z0-9-]{10,255}/g, mark],
  [/\beyJ[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}\.[A-Za-z0-9_-]{8,2048}/g, mark],
];

/** Redacts in place (never rejects) and says how many things it redacted. Running it again changes nothing. */
export function scrubSecrets(text: string): { text: string; hits: number } {
  let out = text;
  let hits = 0;
  for (const [pattern, replace] of RULES) {
    out = out.replace(pattern, (...m) => {
      hits += 1;
      return replace(...(m as string[]));
    });
  }
  return { text: out, hits };
}
