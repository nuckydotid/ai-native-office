// ui-check-ignore-file: pixel-art colors are game art, not app styling
import { Floor, Wall } from '../../shared/workspace/types.ts';
import { Pen, seeded, shade } from '../../pixel/pen.ts';

type Carpet = { base: string; dark: string; light: string };
const CARPETS: Record<number, Carpet> = {
  [Floor.CarpetBlue]: { base: '#4d6fa8', dark: '#43639a', light: '#5a7db8' },
  [Floor.CarpetPurple]: { base: '#7a5aa6', dark: '#6d4e98', light: '#8868b3' },
  [Floor.CarpetGreen]: { base: '#5c8f5a', dark: '#518350', light: '#6a9e68' },
  [Floor.CarpetWarm]: { base: '#c9855a', dark: '#b9774e', light: '#d8946a' },
};

export const FLOOR_VARIANTS = 4;

/** One 16x16 floor tile. `variant` breaks up the repetition so a big room doesn't look like wallpaper. */
export function drawFloor(p: Pen, id: number, variant: number) {
  const rnd = seeded(id * 131 + variant * 17 + 3);
  switch (id) {
    case Floor.Wood:
    case Floor.DarkWood: {
      const dark = id === Floor.DarkWood;
      const base = dark ? '#6d4a33' : '#b98a5a';
      const line = dark ? '#573a27' : '#9d7248';
      const hi = dark ? '#7d5840' : '#c89c6a';
      p.r(0, 0, 16, 16, base);
      for (let row = 0; row < 4; row++) {
        const y = row * 4;
        p.r(0, y + 3, 16, 1, line);
        p.r(Math.floor(rnd() * 14) + 1, y, 1, 3, line);
        p.r(Math.floor(rnd() * 12), y + 1, 3, 1, hi);
      }
      return;
    }
    case Floor.CarpetBlue:
    case Floor.CarpetPurple:
    case Floor.CarpetGreen:
    case Floor.CarpetWarm: {
      const c = CARPETS[id];
      p.r(0, 0, 16, 16, c.base);
      for (let y = 0; y < 16; y += 2) for (let x = (y / 2) % 2; x < 16; x += 2) if (rnd() < 0.55) p.r(x, y, 1, 1, rnd() < 0.5 ? c.light : c.dark);
      return;
    }
    case Floor.TileLight: {
      p.r(0, 0, 16, 16, '#d9dde4');
      p.r(0, 7, 16, 1, '#bfc5d0');
      p.r(0, 15, 16, 1, '#bfc5d0');
      p.r(7, 0, 1, 16, '#bfc5d0');
      p.r(15, 0, 1, 16, '#bfc5d0');
      p.r(0, 0, 7, 1, '#eceff4');
      p.r(8, 8, 7, 1, '#eceff4');
      return;
    }
    case Floor.Concrete: {
      p.r(0, 0, 16, 16, '#9aa0aa');
      for (let i = 0; i < 9; i++) p.r(Math.floor(rnd() * 16), Math.floor(rnd() * 16), 1, 1, rnd() < 0.5 ? '#868c97' : '#aeb3bc');
      if (variant === 1) p.r(0, 8, 16, 1, '#8c929c');
      return;
    }
    case Floor.Grass: {
      p.r(0, 0, 16, 16, '#6fae4e');
      for (let i = 0; i < 7; i++) {
        const x = Math.floor(rnd() * 15);
        const y = Math.floor(rnd() * 14);
        p.r(x, y, 1, 2, rnd() < 0.5 ? '#5d9a41' : '#82c15f');
      }
      if (variant === 3) {
        const x = 3 + Math.floor(rnd() * 9);
        const y = 3 + Math.floor(rnd() * 9);
        p.r(x, y, 1, 1, '#fff6c9');
        p.r(x, y + 1, 1, 1, '#4e8a38');
      }
      return;
    }
    case Floor.Path: {
      p.r(0, 0, 16, 16, '#b9a47a');
      const stones: [number, number, number, number][] = [[1, 1, 6, 5], [8, 1, 7, 4], [1, 7, 5, 6], [7, 6, 8, 5], [2, 13, 7, 3], [10, 12, 5, 3]];
      for (const [x, y, w, h] of stones) {
        p.r(x, y, w, h, '#d3bf95');
        p.r(x, y + h - 1, w, 1, '#a8946a');
      }
      return;
    }
    default:
      p.r(0, 0, 16, 16, '#1b1d2b');
  }
}

export interface WallSides {
  /** A wall cell on that side, so the run continues. */
  s: boolean;
  e: boolean;
  w: boolean;
}

/** One 16x16 wall cell. Seen from slightly above: a lit top, and a front face when nothing continues below. */
export function drawWall(p: Pen, id: number, { s, e, w }: WallSides, variant: number) {
  const rnd = seeded(id * 977 + variant * 31 + 11);
  switch (id) {
    case Wall.Plaster: {
      if (s) {
        p.r(0, 0, 16, 16, '#ece6da');
        if (!w) p.r(0, 0, 1, 16, '#cfc6b4');
        if (!e) p.r(15, 0, 1, 16, '#cfc6b4');
        return;
      }
      p.r(0, 0, 16, 5, '#ece6da');
      p.r(0, 0, 16, 1, '#f7f3ea');
      p.r(0, 5, 16, 1, '#a89c86');
      p.r(0, 6, 16, 10, '#d4cab8');
      p.r(0, 14, 16, 2, '#8c7d68');
      p.r(0, 6, 16, 1, '#e0d7c6');
      if (!w) p.r(0, 0, 1, 16, '#bfb59f');
      if (!e) p.r(15, 0, 1, 16, '#bfb59f');
      return;
    }
    case Wall.Glass: {
      if (s) {
        p.r(0, 0, 16, 16, '#9ec3e0');
        p.r(5, 0, 6, 16, '#c8e3f4');
        return;
      }
      p.r(0, 0, 16, 3, '#8fb4d6');
      p.r(0, 3, 16, 11, '#bfe0f2');
      p.r(0, 14, 16, 2, '#6f95b8');
      p.r(3, 4, 2, 1, '#ffffff');
      p.r(5, 5, 2, 1, '#ffffff');
      p.r(7, 6, 2, 1, '#ffffff');
      p.r(10, 8, 2, 1, '#e8f6ff');
      p.r(12, 9, 2, 1, '#e8f6ff');
      p.r(0, 3, 16, 1, '#a6cde6');
      return;
    }
    case Wall.Brick: {
      p.r(0, 0, 16, 4, '#c9735a');
      p.r(0, 0, 16, 1, '#dd8a70');
      p.r(0, 4, 16, 12, '#a5533a');
      for (let y = 4; y < 16; y += 4) {
        p.r(0, y, 16, 1, '#7a3b2a');
        const off = (y / 4) % 2 ? 3 : 8;
        p.r(off, y + 1, 1, 3, '#7a3b2a');
        p.r((off + 8) % 16, y + 1, 1, 3, '#7a3b2a');
      }
      return;
    }
    case Wall.Hedge: {
      p.r(0, 0, 16, 16, '#3f7d3a');
      for (let i = 0; i < 9; i++) p.blob(1 + Math.floor(rnd() * 14), 2 + Math.floor(rnd() * 12), 3, 2, rnd() < 0.5 ? '#4c8f45' : '#356e32');
      for (let i = 0; i < 6; i++) p.r(Math.floor(rnd() * 15), Math.floor(rnd() * 14), 2, 1, '#69ad57');
      p.r(0, 15, 16, 1, '#2d5e2c');
      return;
    }
    default:
      p.r(0, 0, 16, 16, shade('#888888', 0));
  }
}
