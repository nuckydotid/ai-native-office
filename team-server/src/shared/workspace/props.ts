// Copied from Worktrees Studio (src/shared/workspace) by `npm run sync-core`. Do not edit here.
import type { PropKind } from './types.ts';

export type PropLayer = 'floor' | 'wall' | 'object';

export interface PropDef {
  kind: PropKind;
  label: string;
  category: 'work' | 'social' | 'decor' | 'nature' | 'info';
  /** Footprint in tiles. */
  w: number;
  h: number;
  /** Rendered sprite size in tiles (centered over footprint, bottom aligned). */
  artW: number;
  artH: number;
  /** Footprint blocks movement. */
  solid: boolean;
  layer: PropLayer;
  interact?: 'desk' | 'board' | 'whiteboard' | 'terminal' | 'coffee';
  /** Light emitted, in tiles from the footprint's top-left + radius. */
  light?: { dx: number; dy: number; radius: number; color: string; intensity: number };
  variants?: number;
}

const defs: PropDef[] = [
  {
    kind: 'desk', label: 'Desk', category: 'work', w: 3, h: 1, artW: 3, artH: 2,
    solid: true, layer: 'object', interact: 'desk', variants: 4,
    light: { dx: 1.5, dy: 0, radius: 2.6, color: '#7aa2f7', intensity: 0.35 },
  },
  { kind: 'chair', label: 'Chair', category: 'work', w: 1, h: 1, artW: 1, artH: 1, solid: false, layer: 'object', variants: 4 },
  { kind: 'plant', label: 'Plant', category: 'nature', w: 1, h: 1, artW: 1, artH: 2, solid: true, layer: 'object', variants: 3 },
  { kind: 'plantBig', label: 'Big plant', category: 'nature', w: 1, h: 1, artW: 2, artH: 3, solid: true, layer: 'object' },
  { kind: 'tree', label: 'Tree', category: 'nature', w: 1, h: 1, artW: 4, artH: 4, solid: true, layer: 'object', variants: 2 },
  { kind: 'sofa', label: 'Sofa', category: 'social', w: 3, h: 1, artW: 3, artH: 2, solid: true, layer: 'object', variants: 3 },
  {
    kind: 'coffeeBar', label: 'Espresso bar', category: 'social', w: 4, h: 1, artW: 4, artH: 2,
    solid: true, layer: 'object', interact: 'coffee',
    light: { dx: 2, dy: 0.2, radius: 3.4, color: '#ffb86b', intensity: 0.45 },
  },
  { kind: 'roundTable', label: 'Round table', category: 'social', w: 2, h: 2, artW: 2, artH: 2, solid: true, layer: 'object' },
  { kind: 'meetingTable', label: 'Meeting table', category: 'work', w: 5, h: 2, artW: 5, artH: 2, solid: true, layer: 'object' },
  {
    kind: 'whiteboard', label: 'Whiteboard', category: 'info', w: 3, h: 1, artW: 3, artH: 2,
    solid: true, layer: 'object', interact: 'whiteboard',
  },
  {
    kind: 'branchBoard', label: 'Branch board', category: 'info', w: 6, h: 1, artW: 6, artH: 3,
    solid: true, layer: 'object', interact: 'board',
    light: { dx: 3, dy: 0, radius: 4.5, color: '#7aa2f7', intensity: 0.4 },
  },
  { kind: 'bookshelf', label: 'Bookshelf', category: 'decor', w: 2, h: 1, artW: 2, artH: 2, solid: true, layer: 'object', variants: 2 },
  { kind: 'fountain', label: 'Fountain', category: 'nature', w: 3, h: 3, artW: 3, artH: 3, solid: true, layer: 'object' },
  {
    kind: 'lamp', label: 'Floor lamp', category: 'decor', w: 1, h: 1, artW: 1, artH: 2, solid: true, layer: 'object',
    light: { dx: 0.5, dy: -0.8, radius: 3.2, color: '#ffd27a', intensity: 0.55 },
  },
  { kind: 'rugBlue', label: 'Rug (blue)', category: 'decor', w: 4, h: 3, artW: 4, artH: 3, solid: false, layer: 'floor' },
  { kind: 'rugWarm', label: 'Rug (warm)', category: 'decor', w: 4, h: 3, artW: 4, artH: 3, solid: false, layer: 'floor' },
  { kind: 'terminal', label: 'Terminal', category: 'work', w: 1, h: 1, artW: 1, artH: 2, solid: true, layer: 'object', interact: 'terminal',
    light: { dx: 0.5, dy: 0, radius: 2, color: '#9ece6a', intensity: 0.35 } },
  { kind: 'cooler', label: 'Water cooler', category: 'social', w: 1, h: 1, artW: 1, artH: 2, solid: true, layer: 'object' },
  { kind: 'reception', label: 'Reception desk', category: 'social', w: 4, h: 1, artW: 4, artH: 2, solid: true, layer: 'object',
    light: { dx: 2, dy: 0, radius: 3, color: '#ffd27a', intensity: 0.35 } },
  { kind: 'window', label: 'Window', category: 'decor', w: 2, h: 1, artW: 2, artH: 1, solid: false, layer: 'wall', variants: 2 },
  { kind: 'poster', label: 'Poster', category: 'decor', w: 1, h: 1, artW: 1, artH: 1, solid: false, layer: 'wall', variants: 4 },
];

export const PROP_DEFS: Record<PropKind, PropDef> = Object.fromEntries(
  defs.map((d) => [d.kind, d]),
) as Record<PropKind, PropDef>;

export const PROP_KINDS = defs.map((d) => d.kind);

export function isPropKind(k: unknown): k is PropKind {
  return typeof k === 'string' && k in PROP_DEFS;
}

/** The seat tile of a desk prop (chair position, south of the desk centre). */
export function deskSeat(desk: { x: number; y: number }): { x: number; y: number } {
  return { x: desk.x + 1, y: desk.y + 1 };
}
