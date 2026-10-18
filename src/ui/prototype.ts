// What may be put in the sandboxed frame that shows a design: the page's HTML with everything that could run or fetch taken out, and
// a policy that forbids the rest. Pure and unit-tested; the PrototypeFrame component draws the result.

/** The policy of a prototype: its own styles and pictures that are part of the page, nothing else. */
export const PROTOTYPE_CSP = "default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; form-action 'none'; base-uri 'none'";

const REMOVE: RegExp[] = [
  /<script\b[\s\S]*?<\/script\s*>/gi,
  /<script\b[^>]*>/gi,
  /<(iframe|object|embed|frame|frameset|applet)\b[\s\S]*?<\/\1\s*>/gi,
  /<(iframe|object|embed|frame|frameset|applet|base|link)\b[^>]*>/gi,
  /<meta\b[^>]*http-equiv\s*=\s*["']?\s*(refresh|content-security-policy|set-cookie)[^>]*>/gi,
  /<form\b[^>]*>/gi,
];

/** Takes out anything that can run, load or navigate. The frame's `sandbox` and policy still apply to whatever is left. */
export function hardenHtml(html: string): string {
  let out = html;
  // Taking one tag out can leave the pieces of another next to each other (`<scr<script>ipt>`): go round until nothing changes.
  for (let round = 0; round < 8; round++) {
    const before = out;
    for (const re of REMOVE) out = out.replace(re, '');
    // Event handlers and script URLs inside what is left.
    out = out.replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '');
    out = out.replace(/\s(href|src|action|formaction|xlink:href)\s*=\s*("\s*(?:javascript|vbscript):[^"]*"|'\s*(?:javascript|vbscript):[^']*')/gi, '');
    if (out === before) return out;
  }
  // Still changing after eight rounds: that is not a page a person wrote.
  return '';
}

/** The document the frame shows: the policy first, then the hardened page. */
export function prototypeDocument(html: string): string {
  const policy = `<meta http-equiv="Content-Security-Policy" content="${PROTOTYPE_CSP}">`;
  return `<!doctype html><html><head><meta charset="utf-8">${policy}<meta name="viewport" content="width=device-width, initial-scale=1"></head><body>${hardenHtml(html)}</body></html>`;
}
