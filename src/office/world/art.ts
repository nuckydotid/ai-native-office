// ui-check-ignore-file: pixel-art colors are game art, not app styling
import { Rectangle, Texture, TextureStyle } from 'pixi.js';
import { PROP_DEFS } from '../../shared/workspace/props.ts';
import { lookKey } from '../../shared/workspace/looks.ts';
import type { Appearance, Dir, PropKind } from '../../shared/workspace/types.ts';
import { PROP_ART } from './furniture.ts';
import { makeCanvas, SCALE } from '../../pixel/pen.ts';
import { CHAR_H, CHAR_W, DIR_ROW, drawSheet, SEATED_COL, SEATED_H, WALK_FRAMES } from '../../pixel/people.ts';

// Pixel art stays sharp only if it is never smoothed.
TextureStyle.defaultOptions.scaleMode = 'nearest';

export interface CharacterFrames {
  frame(dir: Dir, step: number): Texture;
  readonly seated: Texture;
}

/** Every picture the office needs, drawn on first use and kept. */
export class ArtSet {
  private props = new Map<string, Texture>();
  private propCanvases = new Map<string, HTMLCanvasElement>();
  private characters = new Map<string, CharacterFrames>();
  private extras = new Map<string, Texture>();

  /** A prop's picture as a canvas (the ground bakes rugs, windows and posters into itself). */
  propCanvas(kind: PropKind, variant: number): HTMLCanvasElement {
    const key = `${kind}:${variant}`;
    let canvas = this.propCanvases.get(key);
    if (!canvas) {
      const def = PROP_DEFS[kind];
      const made = makeCanvas(def.artW * 16, def.artH * 16);
      PROP_ART[kind](made.pen, def.artW * 16, def.artH * 16, variant);
      canvas = made.canvas;
      this.propCanvases.set(key, canvas);
    }
    return canvas;
  }

  prop(kind: PropKind, variant: number): Texture {
    const key = `${kind}:${variant}`;
    let texture = this.props.get(key);
    if (!texture) {
      texture = Texture.from(this.propCanvas(kind, variant));
      this.props.set(key, texture);
    }
    return texture;
  }

  character(look: Appearance): CharacterFrames {
    const key = lookKey(look);
    let frames = this.characters.get(key);
    if (!frames) {
      const sheet = Texture.from(drawSheet(look));
      const cell = (col: number, row: number, h = CHAR_H) =>
        new Texture({ source: sheet.source, frame: new Rectangle(col * CHAR_W * SCALE, row * CHAR_H * SCALE, CHAR_W * SCALE, h * SCALE) });
      const walk = new Map<string, Texture>();
      for (const dir of Object.keys(DIR_ROW) as Dir[]) for (let step = 0; step < WALK_FRAMES; step++) walk.set(`${dir}${step}`, cell(step, DIR_ROW[dir]));
      // The seated pose is cropped from the bottom: only the part above the desk is drawn.
      const seated = cell(SEATED_COL, DIR_ROW.up, SEATED_H);
      frames = { frame: (dir, step) => walk.get(`${dir}${step % WALK_FRAMES}`)!, seated };
      this.characters.set(key, frames);
    }
    return frames;
  }

  /** A soft dark ellipse for under people. */
  get shadow(): Texture {
    return this.extra('shadow', 14, 5, (ctx, w, h) => {
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(20, 18, 30, 0.38)');
      g.addColorStop(1, 'rgba(20, 18, 30, 0)');
      ctx.save();
      ctx.scale(1, h / w);
      ctx.translate(0, (w - h) / 2 / (h / w));
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, w);
      ctx.restore();
    });
  }

  /** A round glow, white in the middle and clear at the edge, tinted and added over the scene for lamps and screens. */
  get glow(): Texture {
    return this.extra('glow', 64, 64, (ctx, w, h) => {
      const g = ctx.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, w / 2);
      g.addColorStop(0, 'rgba(255, 255, 255, 1)');
      g.addColorStop(0.35, 'rgba(255, 255, 255, 0.45)');
      g.addColorStop(1, 'rgba(255, 255, 255, 0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, w, h);
    });
  }

  private extra(key: string, w: number, h: number, draw: (ctx: CanvasRenderingContext2D, w: number, h: number) => void): Texture {
    let texture = this.extras.get(key);
    if (!texture) {
      const canvas = document.createElement('canvas');
      canvas.width = w;
      canvas.height = h;
      draw(canvas.getContext('2d')!, w, h);
      texture = Texture.from(canvas);
      this.extras.set(key, texture);
    }
    return texture;
  }
}
