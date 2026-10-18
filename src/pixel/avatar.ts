import { lookFromSeed, lookKey } from '../shared/workspace/looks.ts';
import { validAppearance } from '../shared/workspace/protocol.ts';
import type { Appearance, Dir } from '../shared/workspace/types.ts';
import { HEAD_ART, drawFigure, drawHead } from './people.ts';

/** The sizes an avatar is shown at, in CSS pixels: 2, 3 and 4 screen pixels per art pixel, so every pixel stays a clean square. */
export const HEAD_SIZES = [24, 36, 48] as const;
export type HeadSize = (typeof HEAD_SIZES)[number];

/** How many screen pixels one art pixel is at this avatar size. */
export const headScale = (cssPx: number) => Math.max(1, Math.round(cssPx / HEAD_ART));

export const headCacheKey = (look: Appearance, cssPx: number) => `${lookKey(look)}@${cssPx}`;

/** What to draw for someone whose saved look is missing or malformed (old messages, a hand-edited file): a look made from their id. */
export function safeLook(look: unknown, fallbackSeed: string): Appearance {
  return validAppearance(look) ? look : lookFromSeed(fallbackSeed);
}

const MAX_CACHED = 500;
const cache = new Map<string, string>();

function remember(key: string, make: () => HTMLCanvasElement): string {
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const url = make().toDataURL('image/png');
  if (cache.size >= MAX_CACHED) cache.delete(cache.keys().next().value as string);
  cache.set(key, url);
  return url;
}

/** A picture (a data address) of a person's head for an `<img>`. Empty where there is no canvas (tests, server rendering). */
export function headUrl(look: Appearance, cssPx: HeadSize | number): string {
  if (typeof document === 'undefined') return '';
  return remember(headCacheKey(look, cssPx), () => drawHead(look, headScale(cssPx)));
}

/** A picture of a whole person for the editor's preview. */
export function figureUrl(look: Appearance, dir: Dir, scale: number): string {
  if (typeof document === 'undefined') return '';
  return remember(`${lookKey(look)}/${dir}@${scale}`, () => drawFigure(look, dir, scale));
}
