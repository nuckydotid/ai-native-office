#!/usr/bin/env node
// Checks that the app's UI code follows the design-system rules in AGENTS.md.
//   npm run check:ui
// A line can opt out with a comment `ui-check-ignore: <why>` on the same or the previous line; a whole file with
// `ui-check-ignore-file: <why>` near the top. Say why: the reason is the point.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('../src/', import.meta.url).pathname;

const COLOR_WORDS = 'red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose|slate|gray|zinc|neutral|stone';

/** [name, pattern, what to do instead] */
const RULES = [
  ['plain <button>', /<button(\s|>|$)/, 'Use HeroUI Button (or Link as="button" via ui/TextButton for a text action, Tabs, Listbox, Switch).'],
  ['plain <select>', /<select(\s|>|$)/, 'Use HeroUI Select.'],
  ['plain <textarea>', /<textarea(\s|>|$)/, 'Use HeroUI Textarea.'],
  ['plain <input>', /<input(\s|>|$)/, 'Use HeroUI Input, Checkbox, Switch or Radio. (A native color picker has no HeroUI equivalent: opt out with a reason.)'],
  ['plain <a>', /<a(\s|>|$)/, 'Use HeroUI Link (and openExternal for web addresses).'],
  ['plain <dialog>', /<dialog(\s|>|$)/, 'Use HeroUI Modal or Popover.'],
  ['plain <table>', /<table(\s|>|$)/, 'Use HeroUI Table.'],
  ['browser tooltip (title=)', /<(div|span|p|li|button|a|g|rect|circle|path|svg|section|aside|header)\s[^>]*\btitle=/, 'Use HeroUI Tooltip.'],
  ['hand-built alert', /border-(success|warning|danger|primary)\/\d+[^"'`]*bg-(success|warning|danger|primary)\/\d+|bg-(success|warning|danger|primary)\/\d+[^"'`]*border-(success|warning|danger|primary)\/\d+/, 'Use HeroUI Alert (color, variant="flat", title, description).'],
  ['border on a surface', /[\s"'`]border(-[trblxy])?(?=[\s"'`])|\bborder(-[trblxy])?-(divider|default(-\d+)?|content[1-4]|primary|secondary|success|warning|danger|foreground)\b|\bborder-(dashed|dotted)\b|\bdivide-[xy]\b/, 'No borders on surfaces: separate with shadow tokens (shadow-small/medium/large) and fill (bg-content1..4, bg-default-50..100). A real separator is HeroUI Divider.'],
  ['outlined component', /variant="bordered"|\bisBordered\b/, 'Use variant="flat" (filled) or "solid"; the look has no outlines.'],
  ['arbitrary text/rounded/shadow value', /\b(text|rounded|shadow)-\[/, 'Use the theme scale: text-tiny/small/medium/large, rounded-small/medium/large, shadow-small/medium/large.'],
  ['Tailwind size name instead of the HeroUI one', /\btext-(xs|sm|base|lg)\b/, 'Use text-tiny, text-small, text-medium, text-large.'],
  ['Tailwind radius name instead of the HeroUI one', /\brounded-(lg|xl|2xl)\b/, 'Use rounded-small, rounded-medium, rounded-large.'],
  ['Tailwind shadow name instead of the HeroUI one', /\bshadow-(md|lg|xl|2xl)\b/, 'Use shadow-small, shadow-medium, shadow-large.'],
  ['Tailwind palette color', new RegExp(`\\b(bg|text|border|fill|stroke|ring|from|via|to|divide|outline|decoration|accent|caret|shadow)-(${COLOR_WORDS})-\\d{2,3}\\b`), 'Use theme colors: primary, secondary, success, warning, danger, default, foreground, content1..4, divider (with their shades).'],
  ['hard-coded color', /#[0-9a-fA-F]{3}\b|#[0-9a-fA-F]{6}\b|#[0-9a-fA-F]{8}\b|\brgba?\(\s*\d|\bhsla?\(\s*\d/, 'Use a theme token (class names, or hsl(var(--heroui-primary)) in SVG: see ui/charts COLORS).'],
  ['font named in a component', /\bfont-\[|\bfont-serif\b|\bfontFamily\b|\bfont-family\b/, 'Text is Plus Jakarta Sans by default (font-sans). Code uses font-mono. Fonts are set only in src/index.css.'],
  ['lucide-react imported directly', /from ['"]lucide-react['"]/, 'Import icons from src/ui (they are re-exported in ui/lucide.ts). A new icon is added there.'],
  ['another UI library', /from ['"](@mui\/|antd|@radix-ui\/|@chakra-ui\/|react-bootstrap|@mantine\/|@headlessui\/|react-aria-components|@nextui-org\/)/, 'HeroUI is the design system. Build what it lacks in src/ui (see AGENTS.md).'],
];

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return files(path);
    return /\.(tsx?|css)$/.test(name) && !name.endsWith('.d.ts') ? [path] : [];
  });
}

let problems = 0;
for (const file of files(root)) {
  if (file.endsWith('.css')) continue;
  const text = readFileSync(file, 'utf8');
  if (/ui-check-ignore-file:/.test(text.split('\n').slice(0, 5).join('\n'))) continue;
  const lines = text.split('\n');
  lines.forEach((line, i) => {
    if (/ui-check-ignore:/.test(line) || (i > 0 && /ui-check-ignore:/.test(lines[i - 1]))) return;
    // Strings in plain TypeScript data (not class names or markup) are not styling.
    if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
    for (const [name, pattern, fix] of RULES) {
      if (pattern.test(line)) {
        problems += 1;
        console.log(`${relative(process.cwd(), file)}:${i + 1}  ${name}\n    ${line.trim().slice(0, 140)}\n    → ${fix}\n`);
      }
    }
    // No editor library at all: every screen is HeroUI (AGENTS.md).
    if (/from ['"](monaco-editor|ace-builds|codemirror|@codemirror\/|@lezer\/)/.test(line)) {
      problems += 1;
      console.log(`${relative(process.cwd(), file)}:${i + 1}  an editor library\n    ${line.trim().slice(0, 140)}\n    → No editor library is allowed (AGENTS.md); every screen is HeroUI.\n`);
    }
  });
}

if (problems) {
  console.log(`${problems} problem${problems === 1 ? '' : 's'} against the design-system rules in AGENTS.md.`);
  process.exit(1);
}
console.log('UI rules: all good.');
