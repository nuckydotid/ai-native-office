import type { TextStyleOptions } from 'pixi.js';

// The canvas can't use CSS classes, so it reads the same theme tokens the HeroUI screens use and turns them into numbers.

const NAMES = ['foreground', 'content1', 'primary', 'primary-foreground', 'success', 'warning', 'danger', 'default-400', 'default-300'] as const;
export type ThemeColors = Record<(typeof NAMES)[number], number>;

/** HeroUI keeps each color as "H S% L%" in a CSS variable. */
function hslNumber(triple: string): number {
  const [h = 0, s = 0, l = 0] = (triple.match(/-?[\d.]+/g) ?? []).map(Number);
  const sat = s / 100;
  const light = l / 100;
  const a = sat * Math.min(light, 1 - light);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (light - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return (channel(0) << 16) | (channel(8) << 8) | channel(4);
}

export function readTheme(): ThemeColors {
  const style = getComputedStyle(document.documentElement);
  const out = {} as ThemeColors;
  for (const name of NAMES) out[name] = hslNumber(style.getPropertyValue(`--heroui-${name}`));
  return out;
}

export const isDark = () => document.documentElement.classList.contains('dark');

/** Calls back when the person switches between light and dark. */
export function onThemeChange(callback: () => void): () => void {
  const observer = new MutationObserver(callback);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['class'] });
  return () => observer.disconnect();
}

/** The font the rest of the page uses, so names on the floor match the app. It is read, never named here. */
export const pageFont = () => getComputedStyle(document.body).fontFamily; // ui-check-ignore: reads the page's font, names none

/** A Pixi text style in the page's font; the one place a font is handed to the canvas. */
export const textStyle = (font: string, style: TextStyleOptions): TextStyleOptions => ({ fontFamily: font, ...style }); // ui-check-ignore: the font is the page's own, passed in
