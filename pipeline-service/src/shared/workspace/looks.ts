// Copied from Worktrees Studio (src/shared/workspace) by `npm run sync-core`. Do not edit here.
import { ACCESSORIES, HAIR_STYLES, OUTFIT_STYLES, PANTS_STYLES } from './types.ts';
import type { Appearance } from './types.ts';

export const SKIN_TONES = ['#f6d5b8', '#efc29a', '#d9a27a', '#b9805a', '#8d5a3c', '#5e3a26'];
export const HAIR_COLORS = ['#1b1620', '#3a2a22', '#6b4226', '#b5762f', '#d9b36a', '#e8d9a8', '#c2c7d4', '#c8531f', '#b04a4a', '#e56b9f', '#4a6fd9', '#2fb9a8', '#8a4fc7'];
export const OUTFIT_COLORS = ['#7aa2f7', '#9ece6a', '#e0af68', '#f7768e', '#a06fe0', '#73daca', '#ff9e64', '#e6e8f0', '#4a5163', '#2ac3de', '#d9534f', '#1f6f5c', '#f2d16b', '#2b3a67', '#d98ac4', '#15171f'];
export const PANTS_COLORS = ['#2b3042', '#3a4052', '#4a3b2f', '#27303f', '#5a4a6a', '#3b5b8c', '#b59f78', '#566246', '#15171f', '#cfd3dc'];

/** Stable cache key covering every field that changes how a character is drawn. */
export const lookKey = (l: Appearance): string =>
  `${l.skin}${l.hair}${l.hairStyle}${l.outfit}${l.pants}${l.accessory}/${l.outfitStyle ?? 0}/${l.pantsStyle ?? 0}`;

/** Deterministic string hash → 32-bit. */
export function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

const pick = <T,>(arr: T[], n: number): T => arr[n % arr.length];

/** A pleasant, deterministic look derived from any seed (e.g. a user id). */
export function lookFromSeed(seed: string): Appearance {
  const h = hash(seed);
  return {
    skin: pick(SKIN_TONES, h),
    hair: pick(HAIR_COLORS, h >>> 3),
    hairStyle: (h >>> 7) % HAIR_STYLES,
    outfit: pick(OUTFIT_COLORS, h >>> 11),
    pants: pick(PANTS_COLORS, h >>> 15),
    accessory: (h >>> 19) % ACCESSORIES,
    outfitStyle: (h >>> 23) % OUTFIT_STYLES,
    pantsStyle: (h >>> 27) % PANTS_STYLES,
  };
}
