// ui-check-ignore-file: pixel-art colors are game art, not app styling
import type { Appearance, Dir } from '../shared/workspace/types.ts';
import { makeCanvas, Pen, shade } from './pen.ts';

export const CHAR_W = 16;
export const CHAR_H = 28;
/** Still, step, still, other step. */
export const WALK_FRAMES = 4;
/** The sheet's column for the pose at a desk (only drawn facing away), and how tall that pose is. */
export const SEATED_COL = 4;
export const SEATED_H = 22;
export const DIR_ROW: Record<Dir, number> = { down: 0, left: 1, right: 2, up: 3 };

type View = 'front' | 'side' | 'back';
type Shape = [number, number, number, number] | [number, number, number, number, 'o'];
type Hair = Record<View, Shape[]>;

const CAP_F: Shape[] = [[5, 4, 6, 1], [4, 5, 8, 2]];
const SIDES_F: Shape[] = [[4, 7, 1, 2], [11, 7, 1, 2]];
const CAP_B: Shape[] = [[5, 4, 6, 1], [4, 5, 8, 7]];
const CAP_S: Shape[] = [[5, 4, 6, 1], [4, 5, 8, 2], [4, 7, 4, 3]];
const SPIKES: Shape[] = [[5, 2, 1, 3], [7, 1, 1, 4], [9, 1, 1, 4], [10, 2, 1, 3]];

// One entry per name in HAIR_STYLE_NAMES. Head: x 4..11, y 5..12. [x, y, w, h], or [cx, cy, rx, ry, 'o'] for a round shape.
const HAIR: Hair[] = [
  { front: [...CAP_F, ...SIDES_F], side: CAP_S, back: CAP_B },
  { front: [...CAP_F, [4, 7, 5, 1], [4, 8, 2, 1], [11, 7, 1, 2]], side: [...CAP_S, [9, 7, 3, 1]], back: CAP_B },
  { front: [...CAP_F, [3, 6, 2, 7], [11, 6, 2, 7]], side: [[5, 4, 6, 1], [4, 5, 8, 2], [3, 7, 5, 7]], back: [[5, 4, 6, 1], [3, 5, 10, 9]] },
  { front: [[5, 4, 6, 1], [4, 5, 8, 1]], side: [[5, 4, 6, 1], [4, 5, 8, 1], [4, 6, 3, 2]], back: [[5, 4, 6, 1], [4, 5, 8, 5]] },
  { front: [...CAP_F, ...SIDES_F, [8, 3, 3, 2, 'o']], side: [...CAP_S, [5, 3, 3, 2, 'o']], back: [...CAP_B, [8, 3, 3, 2, 'o']] },
  { front: [[8, 5, 7, 3, 'o'], [4, 8, 2, 3, 'o'], [12, 8, 2, 3, 'o']], side: [[7, 5, 6, 3, 'o'], [5, 8, 3, 3, 'o']], back: [[8, 6, 7, 5, 'o'], [3, 9, 1, 3, 'o'], [13, 9, 1, 3, 'o']] },
  { front: [...CAP_F, [3, 6, 2, 12], [11, 6, 2, 12]], side: [[5, 4, 6, 1], [4, 5, 8, 2], [3, 7, 5, 11]], back: [[5, 4, 6, 1], [3, 5, 10, 13]] },
  { front: [...CAP_F, ...SIDES_F, [12, 7, 2, 4]], side: [...CAP_S, [1, 7, 3, 6]], back: [...CAP_B, [7, 12, 2, 6]] },
  { front: [[7, 1, 2, 6], [6, 3, 4, 3]], side: [[6, 1, 3, 6], [5, 3, 3, 3]], back: [[7, 1, 2, 11], [6, 3, 4, 4]] },
  { front: [[8, 6, 8, 6, 'o']], side: [[7, 6, 8, 6, 'o']], back: [[8, 7, 8, 7, 'o']] },
  { front: [...CAP_F, ...SIDES_F, [2, 7, 2, 6], [12, 7, 2, 6]], side: [...CAP_S, [2, 8, 2, 5]], back: [...CAP_B, [2, 7, 2, 6], [12, 7, 2, 6]] },
  { front: [], side: [], back: [] },
  { front: [...CAP_F, ...SPIKES], side: [...CAP_S, [5, 2, 1, 3], [7, 1, 1, 4], [9, 2, 1, 3]], back: [...CAP_B, ...SPIKES] },
  { front: [...CAP_F, ...SIDES_F, [8, 3, 6, 3, 'o']], side: [...CAP_S, [8, 3, 5, 3, 'o']], back: [...CAP_B, [8, 3, 5, 3, 'o']] },
];

interface Paint {
  skin: string;
  skinDark: string;
  hair: string;
  hairDark: string;
  hairLight: string;
  outfit: string;
  outfitDark: string;
  outfitLight: string;
  pants: string;
  pantsDark: string;
}

const EYE = '#2a2733';
const SHOE = '#2a2733';
const WHITE = '#f3f5f8';

function paint(look: Appearance): Paint {
  return {
    skin: look.skin,
    skinDark: shade(look.skin, -14),
    hair: look.hair,
    hairDark: shade(look.hair, -28),
    hairLight: shade(look.hair, 20),
    outfit: look.outfit,
    outfitDark: shade(look.outfit, -20),
    outfitLight: shade(look.outfit, 18),
    pants: look.pants,
    pantsDark: shade(look.pants, -22),
  };
}

function shapes(p: Pen, list: Shape[], color: string) {
  for (const s of list) {
    if (s.length === 5) p.blob(s[0], s[1], s[2], s[3], color);
    else p.r(s[0], s[1], s[2], s[3], color);
  }
}

/** One leg from the hip (row 20) down to `end`, in the trousers' style, with its shoe below. */
function leg(p: Pen, c: Paint, x: number, end: number, style: number, width = 3, shoeWidth = 3) {
  const top = 20;
  const len = end - top + 1;
  const bare = style === 1 ? Math.max(0, len - 2) : style === 3 ? 1 : style === 2 ? len : 0;
  p.r(x, top, width, len - bare, c.pants);
  p.r(x + width - 1, top, 1, len - bare, c.pantsDark);
  if (bare) p.r(x, end - bare + 1, width, bare, c.skin);
  if (style === 5) p.r(x, end - 1, width, 2, c.pantsDark);
  if (style === 4) p.r(x, top + 2, 2, 2, shade(c.pants, 16));
  p.r(x, end + 1, shoeWidth, 2, SHOE);
  p.r(x, end + 1, shoeWidth, 1, shade(SHOE, 30));
}

function skirt(p: Pen, c: Paint) {
  p.r(4, 20, 8, 3, c.pants);
  p.r(3, 22, 10, 1, c.pants);
  p.r(3, 22, 10, 1, c.pantsDark);
  p.r(4, 20, 8, 1, c.pantsDark);
}

function torso(p: Pen, c: Paint, style: number, view: View, x = 4, w = 8) {
  const y = 13;
  const h = 7;
  p.r(x, y, w, h, c.outfit);
  p.r(x + w - 1, y, 1, h, c.outfitDark);
  p.r(x, y + h - 1, w, 1, c.outfitDark);
  const front = view === 'front';
  switch (style) {
    case 1:
      p.r(x + 1, 12, w - 2, 2, c.outfitDark);
      p.r(x + 1, 17, w - 2, 2, c.outfitDark);
      if (front) {
        p.r(x + 2, 14, 1, 3, WHITE);
        p.r(x + w - 3, 14, 1, 3, WHITE);
      }
      break;
    case 2:
      p.r(x, y, w, h, c.outfitDark);
      if (front) {
        p.r(x + w / 2 - 1, y, 2, h, WHITE);
        p.r(x + 2, y, 1, 4, c.outfit);
        p.r(x + w - 3, y, 1, 4, c.outfit);
      }
      break;
    case 3:
      for (let yy = y + 1; yy < y + h - 1; yy += 2) p.r(x, yy, w - 1, 1, c.outfitLight);
      break;
    case 5:
      if (front) p.r(x + 2, 15, w - 4, 5, c.pants);
      p.r(x + 1, y, 1, 3, c.pants);
      p.r(x + w - 2, y, 1, 3, c.pants);
      if (front) p.r(x + 2, 16, 1, 1, c.outfitLight);
      break;
    case 6:
      p.r(x + 1, 12, w - 2, 2, c.outfitLight);
      break;
    case 7:
      if (front) {
        p.r(x + 1, y, 2, 1, WHITE);
        p.r(x + w - 3, y, 2, 1, WHITE);
        p.r(x + w / 2 - 1, y + 1, 2, 3, c.outfitDark);
      }
      break;
  }
}

function arm(p: Pen, c: Paint, x: number, oy: number, style: number) {
  const bare = style === 4;
  p.r(x, 13 + oy, 2, 6, bare ? c.skin : c.outfit);
  if (!bare) p.r(x, 13 + oy, 1, 6, c.outfitDark);
  p.r(x, 18 + oy, 2, 2, c.skin);
}

function head(p: Pen, c: Paint, view: View) {
  p.r(4, 5, 8, 8, c.skin);
  p.r(4, 12, 8, 1, c.skinDark);
  if (view === 'front') {
    p.r(3, 8, 1, 2, c.skinDark);
    p.r(12, 8, 1, 2, c.skinDark);
    p.r(6, 8, 1, 2, EYE);
    p.r(9, 8, 1, 2, EYE);
    p.r(5, 10, 1, 1, 'rgba(232, 120, 130, 0.45)');
    p.r(10, 10, 1, 1, 'rgba(232, 120, 130, 0.45)');
    p.r(7, 11, 2, 1, shade(c.skin, -32));
  } else if (view === 'side') {
    p.r(12, 9, 1, 2, c.skin);
    p.r(9, 8, 1, 2, EYE);
    p.r(6, 8, 2, 2, c.skinDark);
    p.r(10, 11, 2, 1, shade(c.skin, -32));
  }
}

function hair(p: Pen, c: Paint, style: number, view: View) {
  const shapesFor = HAIR[style % HAIR.length][view];
  shapes(p, shapesFor, style === 3 ? c.hairDark : c.hair);
  if (shapesFor.length) p.r(5, 5, view === 'back' ? 4 : 3, 1, c.hairLight);
}

function accessory(p: Pen, c: Paint, look: Appearance, view: View) {
  const front = view === 'front';
  const back = view === 'back';
  switch (look.accessory) {
    case 1:
      if (back) return;
      if (front) {
        for (const x of [5, 8]) {
          p.r(x, 7, 3, 1, EYE);
          p.r(x, 10, 3, 1, EYE);
          p.r(x, 7, 1, 4, EYE);
          p.r(x + 2, 7, 1, 4, EYE);
        }
      } else {
        p.r(8, 7, 3, 1, EYE);
        p.r(8, 10, 3, 1, EYE);
        p.r(8, 7, 1, 4, EYE);
        p.r(10, 7, 1, 4, EYE);
        p.r(6, 8, 2, 1, EYE);
      }
      return;
    case 2:
      p.r(5, 3, 6, 1, '#2a2e3a');
      p.r(4, 4, 1, 3, '#2a2e3a');
      p.r(11, 4, 1, 3, '#2a2e3a');
      if (view === 'side') p.r(6, 7, 3, 4, c.outfit);
      else {
        p.r(2, 7, 2, 4, c.outfit);
        p.r(12, 7, 2, 4, c.outfit);
      }
      return;
    case 3:
      p.r(4, 3, 8, 3, c.outfit);
      p.r(4, 3, 8, 1, c.outfitLight);
      if (front) p.r(3, 6, 10, 1, c.outfitDark);
      else if (view === 'side') p.r(10, 6, 4, 1, c.outfitDark);
      else p.r(6, 6, 4, 1, c.outfitDark);
      return;
    case 4:
      if (back) return;
      if (front) {
        p.r(5, 8, 6, 2, '#15171f');
        p.r(6, 8, 1, 1, '#5a6075');
      } else {
        p.r(8, 8, 4, 2, '#15171f');
        p.r(6, 8, 2, 1, '#15171f');
      }
      return;
    case 5:
      p.r(4, 6, 8, 1, c.outfit);
      p.r(4, 6, 8, 1, c.outfitLight);
      return;
    case 6:
      p.r(4, 3, 8, 4, c.outfit);
      p.r(4, 6, 8, 1, c.outfitDark);
      p.r(7, 1, 2, 2, WHITE);
      return;
    case 7:
      if (front) p.r(6, 10, 4, 1, c.hairDark);
      else if (view === 'side') p.r(10, 10, 2, 1, c.hairDark);
      return;
    case 8:
      p.r(9, 3, 4, 3, '#e8789c');
      p.r(10, 4, 2, 1, '#c25a7c');
      return;
    case 9:
      p.r(5, 3, 6, 2, '#e0c050');
      for (const x of [5, 7, 9]) p.r(x, 2, 1, 1, '#e0c050');
      p.r(7, 4, 1, 1, '#d95a5a');
      return;
  }
}

/** One pose. `ph` is the walk phase: 0 standing, 1 left foot forward, -1 right foot forward. */
function pose(p: Pen, look: Appearance, dir: Dir, ph: number, seated: boolean) {
  const c = paint(look);
  const outfit = look.outfitStyle ?? 0;
  const pants = look.pantsStyle ?? 0;
  const view: View = dir === 'up' ? 'back' : dir === 'down' ? 'front' : 'side';
  const ctx = p.ctx;
  ctx.save();
  if (dir === 'left') {
    ctx.translate(CHAR_W, 0);
    ctx.scale(-1, 1);
  }
  if (view === 'side') {
    const frontEnd = 24;
    if (!seated) {
      leg(p, c, 5 - ph, frontEnd - (ph === 1 ? 1 : 0), pants === 2 ? 0 : pants, 3, 4);
      leg(p, c, 8 + ph, frontEnd - (ph === -1 ? 1 : 0), pants === 2 ? 0 : pants, 3, 4);
      if (pants === 2) skirt(p, c);
    }
    torso(p, c, outfit, view, 5, 6);
    arm(p, c, 7 + ph, 0, outfit);
  } else {
    if (seated) {
      p.r(4, 20, 8, 2, c.pants);
    } else {
      const endL = 24 + (ph === 1 ? 1 : ph === -1 ? -1 : 0);
      const endR = 24 + (ph === -1 ? 1 : ph === 1 ? -1 : 0);
      leg(p, c, 5, endL, pants);
      leg(p, c, 8, endR, pants);
      if (pants === 2) skirt(p, c);
    }
    torso(p, c, outfit, view);
    arm(p, c, 2, ph === 1 ? 1 : ph === -1 ? -1 : 0, outfit);
    arm(p, c, 12, ph === -1 ? 1 : ph === 1 ? -1 : 0, outfit);
  }
  head(p, c, view);
  hair(p, c, look.hairStyle, view);
  accessory(p, c, look, view);
  ctx.restore();
}

/** All poses for one look: four directions by four walk frames, plus the seated pose in the last column of the "up" row. */
export function drawSheet(look: Appearance): HTMLCanvasElement {
  const { canvas, pen } = makeCanvas(CHAR_W * (WALK_FRAMES + 1), CHAR_H * 4);
  const ctx = pen.ctx;
  const phase = [0, 1, 0, -1];
  for (const dir of Object.keys(DIR_ROW) as Dir[]) {
    for (let frame = 0; frame < WALK_FRAMES; frame++) {
      ctx.save();
      ctx.translate(frame * CHAR_W, DIR_ROW[dir] * CHAR_H);
      ctx.beginPath();
      ctx.rect(0, 0, CHAR_W, CHAR_H);
      ctx.clip();
      pose(pen, look, dir, phase[frame], false);
      ctx.restore();
    }
  }
  ctx.save();
  ctx.translate(SEATED_COL * CHAR_W, DIR_ROW.up * CHAR_H);
  ctx.beginPath();
  ctx.rect(0, 0, CHAR_W, CHAR_H);
  ctx.clip();
  pose(pen, look, 'up', 0, true);
  ctx.restore();
  return canvas;
}

/** The head and a little shoulder of the front pose: the square of art pixels an avatar shows. */
export const HEAD_ART = 12;
const HEAD_X = 2;
const HEAD_Y = 2;

function poseCanvas(look: Appearance, dir: Dir, scale: number, x: number, y: number, w: number, h: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = w * scale;
  canvas.height = h * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  ctx.scale(scale, scale);
  ctx.translate(-x, -y);
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  pose(new Pen(ctx), look, dir, 0, false);
  return canvas;
}

/** A person's head (facing the viewer) as a square canvas, each art pixel drawn `scale` pixels big (a whole number, so it stays sharp). */
export function drawHead(look: Appearance, scale: number): HTMLCanvasElement {
  return poseCanvas(look, 'down', scale, HEAD_X, HEAD_Y, HEAD_ART, HEAD_ART);
}

/** A person standing, facing `dir`, for the editor's preview. */
export function drawFigure(look: Appearance, dir: Dir, scale: number): HTMLCanvasElement {
  return poseCanvas(look, dir, scale, 0, 0, CHAR_W, CHAR_H);
}
