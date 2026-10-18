// ui-check-ignore-file: pixel-art colors are game art, not app styling

/** Each art pixel is drawn 2x2 screen pixels big, so a 16-pixel tile is the shared world's 32-pixel tile. */
export const SCALE = 2;
export const ART_TILE = 16;

export function shade(hex: string, percent: number): string {
  const n = parseInt(hex.slice(1), 16);
  const target = percent < 0 ? 0 : 255;
  const k = Math.abs(percent) / 100;
  const ch = (shift: number) => Math.round(((n >> shift) & 255) * (1 - k) + target * k);
  return `#${((1 << 24) | (ch(16) << 16) | (ch(8) << 8) | ch(0)).toString(16).slice(1)}`;
}

/** A small deterministic random generator, so the same tile always looks the same. */
export function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Draws in art pixels onto a canvas that is SCALE times as big. */
export class Pen {
  constructor(readonly ctx: CanvasRenderingContext2D) {}

  r(x: number, y: number, w: number, h: number, color: string) {
    this.ctx.fillStyle = color;
    this.ctx.fillRect(x, y, w, h);
  }

  /** A filled ellipse, row by row, so its edge stays pixelated. */
  blob(cx: number, cy: number, rx: number, ry: number, color: string) {
    this.ctx.fillStyle = color;
    for (let dy = -ry; dy < ry; dy++) {
      const k = (dy + 0.5) / ry;
      const half = Math.round(rx * Math.sqrt(Math.max(0, 1 - k * k)));
      if (half > 0) this.ctx.fillRect(cx - half, cy + dy, half * 2, 1);
    }
  }

  /** A soft shadow on the ground. */
  shadow(cx: number, cy: number, rx: number, ry: number) {
    this.blob(cx, cy, rx, ry, 'rgba(20, 18, 30, 0.22)');
  }
}

export function makeCanvas(artW: number, artH: number): { canvas: HTMLCanvasElement; pen: Pen } {
  const canvas = document.createElement('canvas');
  canvas.width = artW * SCALE;
  canvas.height = artH * SCALE;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(SCALE, SCALE);
  ctx.imageSmoothingEnabled = false;
  return { canvas, pen: new Pen(ctx) };
}
