// ui-check-ignore-file: pixel-art colors are game art, not app styling
import type { PropKind } from '../../shared/workspace/types.ts';
import { Pen, seeded, shade } from '../../pixel/pen.ts';

/** Draws one prop onto a canvas `w` x `h` art pixels big (the prop's art size), bottom aligned to its footprint. */
export type PropArt = (p: Pen, w: number, h: number, v: number) => void;

const WOODS = ['#b88655', '#a97b4e', '#c4925f', '#9e7048'];
const ACCENTS = ['#7aa2f7', '#9ece6a', '#e0af68', '#bb9af7'];
const FABRICS = ['#c0605a', '#4a73b8', '#5a9b72'];
const BOOKS = ['#d95a5a', '#4a73b8', '#e0af68', '#5a9b72', '#a06fe0', '#e6e8f0', '#d98ac4', '#2ac3de'];

const desk: PropArt = (p, w, h, v) => {
  const wood = WOODS[v % 4];
  const dark = shade(wood, -24);
  const accent = ACCENTS[v % 4];
  p.shadow(24, 30, 22, 2);
  p.r(2, 25, 44, 6, dark);
  p.r(2, 25, 44, 1, shade(dark, -14));
  p.r(30, 27, 13, 3, shade(dark, 10));
  p.r(35, 28, 3, 1, '#d9c07a');
  p.r(4, 28, 3, 3, shade(dark, -16));
  p.r(1, 17, 46, 8, wood);
  p.r(1, 17, 46, 1, shade(wood, 16));
  p.r(1, 24, 46, 1, dark);
  p.r(22, 14, 4, 3, '#3b4052');
  p.r(17, 4, 14, 11, '#2a2e3a');
  p.r(18, 5, 12, 8, shade(accent, -55));
  p.r(19, 6, 6, 1, accent);
  p.r(19, 8, 9, 1, shade(accent, 30));
  p.r(19, 10, 5, 1, accent);
  p.r(26, 10, 2, 1, '#ffffff');
  p.r(16, 19, 16, 3, '#cfd3dc');
  p.r(17, 20, 14, 1, '#aab0bc');
  p.r(37, 18, 4, 4, '#f3f5f8');
  p.r(41, 19, 1, 2, '#f3f5f8');
  p.r(38, 19, 2, 1, '#7b4a2a');
  p.r(4, 18, 8, 5, '#f3f5f8');
  p.r(5, 19, 6, 1, '#c8ccd6');
  p.r(5, 21, 5, 1, '#c8ccd6');
};

const chair: PropArt = (p, w, h, v) => {
  const c = ['#5b6ee1', '#d95a5a', '#4aa37a', '#e0a43a'][v % 4];
  p.shadow(8, 14, 6, 2);
  p.r(4, 2, 8, 6, shade(c, -20));
  p.r(3, 7, 10, 6, c);
  p.r(3, 7, 10, 1, shade(c, 22));
  p.r(7, 13, 2, 2, '#3b4052');
  p.r(4, 14, 8, 1, '#3b4052');
};

const plant: PropArt = (p, w, h, v) => {
  const pot = ['#c0714a', '#d9d4c7', '#4a5a7a'][v % 3];
  p.shadow(8, 30, 6, 2);
  p.blob(8, 14, 6, 8, '#3f8d46');
  p.blob(5, 13, 4, 6, '#4fa356');
  p.blob(11, 13, 4, 6, '#4fa356');
  p.blob(8, 9, 3, 5, '#63b86a');
  p.r(7, 6, 1, 1, '#8fd48f');
  p.r(3, 21, 10, 2, shade(pot, 14));
  p.r(4, 23, 8, 7, pot);
  p.r(4, 29, 8, 1, shade(pot, -20));
  p.r(4, 22, 8, 1, '#4a3322');
};

const plantBig: PropArt = (p) => {
  p.shadow(16, 46, 11, 2);
  p.blob(16, 22, 13, 17, '#2f7a3c');
  p.blob(9, 24, 8, 13, '#3f8d46');
  p.blob(23, 24, 8, 13, '#3f8d46');
  p.blob(16, 14, 8, 11, '#4fa356');
  p.blob(14, 8, 3, 5, '#63b86a');
  p.blob(21, 18, 3, 5, '#63b86a');
  p.r(6, 37, 20, 3, '#d98a5f');
  p.r(7, 40, 18, 7, '#c0714a');
  p.r(7, 46, 18, 1, '#9a5636');
  p.r(7, 38, 18, 1, '#4a3322');
};

const tree: PropArt = (p, w, h, v) => {
  const dark = v ? '#4b8f3a' : '#2f7a3c';
  const mid = v ? '#63a846' : '#3f8d46';
  const light = v ? '#86c25a' : '#5fae5a';
  p.shadow(32, 60, 18, 3);
  p.r(28, 38, 8, 22, '#6b4a2e');
  p.r(28, 38, 3, 22, '#7d5a38');
  p.r(25, 56, 3, 4, '#6b4a2e');
  p.r(36, 56, 3, 4, '#6b4a2e');
  p.blob(32, 24, 25, 20, dark);
  p.blob(22, 26, 15, 13, mid);
  p.blob(42, 24, 15, 13, mid);
  p.blob(32, 16, 17, 11, mid);
  p.blob(25, 14, 8, 6, light);
  p.blob(41, 19, 6, 4, light);
  const rnd = seeded(v + 5);
  for (let i = 0; i < 14; i++) p.r(14 + Math.floor(rnd() * 36), 8 + Math.floor(rnd() * 32), 2, 1, rnd() < 0.5 ? light : dark);
};

const sofa: PropArt = (p, w, h, v) => {
  const c = FABRICS[v % 3];
  const dark = shade(c, -22);
  p.shadow(24, 30, 22, 2);
  p.r(2, 10, 44, 9, dark);
  p.r(3, 9, 42, 1, shade(dark, 10));
  p.r(1, 13, 6, 15, dark);
  p.r(41, 13, 6, 15, dark);
  p.r(7, 17, 34, 10, c);
  p.r(7, 17, 34, 1, shade(c, 20));
  p.r(24, 17, 1, 10, shade(c, -16));
  p.r(7, 26, 34, 1, shade(c, -22));
  p.r(3, 28, 3, 2, '#3b2a20');
  p.r(42, 28, 3, 2, '#3b2a20');
};

const coffeeBar: PropArt = (p) => {
  p.shadow(32, 30, 30, 2);
  p.r(2, 16, 60, 14, '#6d4a33');
  p.r(2, 21, 60, 1, '#573a27');
  p.r(2, 26, 60, 1, '#573a27');
  p.r(0, 14, 64, 4, '#c49362');
  p.r(0, 14, 64, 1, '#dcae7e');
  p.r(8, 3, 16, 11, '#aab0bc');
  p.r(9, 4, 14, 4, '#2a2e3a');
  p.r(10, 5, 4, 1, '#9ece6a');
  p.r(12, 9, 3, 4, '#d95a5a');
  p.r(18, 9, 3, 4, '#2a2e3a');
  for (const x of [32, 38, 44]) {
    p.r(x, 9, 4, 4, '#f3f5f8');
    p.r(x + 4, 10, 1, 2, '#f3f5f8');
  }
  p.r(52, 5, 8, 9, '#c9e3f0');
  p.r(53, 8, 6, 6, '#6b4226');
};

const roundTable: PropArt = (p) => {
  p.shadow(16, 28, 13, 3);
  p.r(14, 16, 4, 10, '#573a27');
  p.r(10, 25, 12, 2, '#573a27');
  p.blob(16, 14, 14, 9, '#8a5f3c');
  p.blob(16, 13, 14, 8, '#a8774a');
  p.blob(13, 11, 8, 4, '#c49362');
  p.r(19, 9, 3, 3, '#f3f5f8');
  p.r(11, 13, 4, 3, '#f3f5f8');
};

const meetingTable: PropArt = (p) => {
  p.shadow(40, 30, 38, 2);
  p.r(6, 24, 4, 7, '#573a27');
  p.r(70, 24, 4, 7, '#573a27');
  p.r(2, 13, 76, 12, '#a8774a');
  p.r(1, 14, 78, 10, '#a8774a');
  p.r(3, 12, 74, 2, '#c49362');
  p.r(1, 24, 78, 5, '#7a5232');
  p.r(3, 29, 74, 1, '#573a27');
  for (const x of [12, 52]) {
    p.r(x, 14, 12, 7, '#2a2e3a');
    p.r(x + 1, 15, 10, 5, '#7aa2f7');
    p.r(x + 2, 16, 5, 1, '#ffffff');
    p.r(x - 1, 21, 14, 2, '#aab0bc');
  }
  p.r(31, 15, 10, 6, '#f3f5f8');
  p.r(32, 16, 8, 1, '#c8ccd6');
  p.r(32, 18, 6, 1, '#c8ccd6');
  p.r(66, 13, 4, 8, '#c9e3f0');
  p.r(62, 18, 3, 3, '#f3f5f8');
  p.r(44, 15, 5, 5, '#6b4226');
  p.blob(46, 14, 3, 3, '#4fa356');
};

const whiteboard: PropArt = (p) => {
  p.shadow(24, 30, 18, 2);
  p.r(6, 27, 2, 4, '#6c7280');
  p.r(40, 27, 2, 4, '#6c7280');
  p.r(3, 5, 42, 23, '#8b92a3');
  p.r(4, 6, 40, 21, '#f3f5f8');
  p.r(8, 10, 14, 1, '#d95a5a');
  p.r(8, 13, 20, 1, '#4a73b8');
  p.r(8, 16, 10, 1, '#4aa37a');
  p.r(8, 19, 16, 1, '#4a73b8');
  p.r(32, 9, 7, 7, '#f2d16b');
  p.r(33, 11, 5, 1, '#c9a93f');
  p.r(32, 18, 7, 6, '#e8a0c0');
  p.r(10, 26, 26, 2, '#6c7280');
};

const branchBoard: PropArt = (p) => {
  p.shadow(48, 46, 44, 2);
  p.r(10, 41, 3, 6, '#6c7280');
  p.r(83, 41, 3, 6, '#6c7280');
  p.r(4, 7, 88, 35, '#6c7280');
  p.r(6, 9, 84, 31, '#1f2330');
  p.r(6, 9, 84, 6, '#2f3548');
  p.r(9, 11, 2, 2, '#d95a5a');
  p.r(13, 11, 2, 2, '#e0af68');
  p.r(17, 11, 2, 2, '#9ece6a');
  p.r(26, 11, 30, 2, '#4a5163');
  const line = (x0: number, x1: number, y: number, c: string) => p.r(x0, y, x1 - x0, 1, c);
  line(10, 86, 28, '#7aa2f7');
  line(28, 62, 20, '#9ece6a');
  p.r(27, 21, 1, 7, '#9ece6a');
  p.r(62, 21, 1, 7, '#9ece6a');
  line(40, 72, 35, '#bb9af7');
  p.r(39, 29, 1, 6, '#bb9af7');
  p.r(72, 29, 1, 6, '#bb9af7');
  for (const x of [12, 24, 36, 48, 60, 72, 84]) p.r(x, 27, 3, 3, '#e6e8f0');
  for (const x of [32, 44, 56]) p.r(x, 19, 3, 3, '#e6e8f0');
  for (const x of [46, 62]) p.r(x, 34, 3, 3, '#e6e8f0');
  p.r(10, 33, 14, 1, '#4a5163');
  p.r(10, 36, 9, 1, '#4a5163');
};

const bookshelf: PropArt = (p, w, h, v) => {
  const rnd = seeded(v * 7 + 2);
  p.shadow(16, 30, 14, 2);
  p.r(1, 3, 30, 28, '#6d4a33');
  p.r(3, 5, 26, 24, '#3b2a20');
  for (const y of [12, 20, 28]) p.r(3, y, 26, 2, '#8a5f3c');
  for (const top of [6, 14, 22]) {
    let x = 4;
    while (x < 27) {
      const bw = 2 + Math.floor(rnd() * 2);
      const bh = 5 + Math.floor(rnd() * 3);
      p.r(x, top + (7 - bh), bw, bh, BOOKS[Math.floor(rnd() * BOOKS.length)]);
      x += bw + (rnd() < 0.2 ? 2 : 0);
    }
  }
  p.r(1, 3, 30, 1, '#8a5f3c');
};

const fountain: PropArt = (p) => {
  p.shadow(24, 44, 22, 3);
  p.blob(24, 34, 23, 13, '#8e95a8');
  p.blob(24, 33, 23, 12, '#a6adc0');
  p.blob(24, 33, 19, 9, '#6f7690');
  p.blob(24, 33, 17, 8, '#5fb6e0');
  p.blob(20, 31, 8, 3, '#8fd3f0');
  p.r(22, 14, 4, 19, '#aab0bc');
  p.blob(24, 15, 9, 4, '#8e95a8');
  p.blob(24, 14, 7, 3, '#8fd3f0');
  p.r(23, 8, 2, 6, '#b8e6f7');
  for (const [x, y] of [[19, 12], [29, 12], [17, 18], [31, 18]]) p.r(x, y, 1, 2, '#b8e6f7');
};

const lamp: PropArt = (p) => {
  p.shadow(8, 30, 5, 1);
  p.r(7, 10, 2, 19, '#3b4052');
  p.r(4, 29, 8, 2, '#3b4052');
  p.r(4, 3, 8, 7, '#ffd27a');
  p.r(5, 2, 6, 1, '#ffe7a8');
  p.r(3, 9, 10, 2, '#e0b35a');
  p.r(6, 4, 4, 2, '#fff3c9');
};

const rug = (base: string, edge: string, pattern: string): PropArt => (p, w, h) => {
  p.r(1, 1, w - 2, h - 2, edge);
  p.r(3, 3, w - 6, h - 6, base);
  p.r(5, 5, w - 10, h - 10, shade(base, -10));
  for (let x = 8; x < w - 8; x += 8) for (let y = 8; y < h - 8; y += 8) p.r(x, y, 2, 2, pattern);
  for (let x = 2; x < w - 2; x += 2) {
    p.r(x, 0, 1, 1, shade(edge, 18));
    p.r(x, h - 1, 1, 1, shade(edge, 18));
  }
};

const terminal: PropArt = (p) => {
  p.shadow(8, 30, 6, 1);
  p.r(2, 5, 12, 25, '#2a2e3a');
  p.r(2, 5, 12, 1, '#4a5163');
  p.r(4, 8, 8, 7, '#12141d');
  p.r(5, 9, 5, 1, '#9ece6a');
  p.r(5, 11, 3, 1, '#9ece6a');
  p.r(5, 13, 6, 1, '#7aa2f7');
  for (let y = 18; y < 28; y += 3) {
    p.r(4, y, 8, 2, '#3b4052');
    p.r(10, y, 1, 1, y % 2 ? '#9ece6a' : '#e0af68');
  }
};

const cooler: PropArt = (p) => {
  p.shadow(8, 30, 6, 1);
  p.r(4, 2, 8, 10, '#9bd3f0');
  p.r(5, 3, 2, 7, '#d4effa');
  p.r(6, 12, 4, 2, '#c9e3f0');
  p.r(3, 14, 10, 16, '#e6e8f0');
  p.r(3, 14, 10, 1, '#ffffff');
  p.r(5, 18, 2, 2, '#4a73b8');
  p.r(9, 18, 2, 2, '#d95a5a');
  p.r(5, 24, 6, 1, '#c8ccd6');
};

const reception: PropArt = (p) => {
  p.shadow(32, 30, 30, 2);
  p.r(2, 15, 60, 15, '#4a5163');
  p.r(2, 15, 60, 1, '#5d6580');
  p.r(0, 12, 64, 5, '#e6e8f0');
  p.r(0, 12, 64, 1, '#ffffff');
  p.r(26, 20, 12, 5, '#e0af68');
  p.r(28, 22, 8, 1, '#b8872f');
  p.r(10, 9, 5, 3, '#e0c050');
  p.r(11, 8, 3, 1, '#e0c050');
  p.r(40, 2, 13, 10, '#2a2e3a');
  p.r(41, 3, 11, 7, '#7aa2f7');
  p.r(44, 12, 5, 1, '#3b4052');
  p.r(54, 8, 4, 4, '#4aa37a');
};

const windowArt: PropArt = (p, w, h, v) => {
  p.r(0, 14, 32, 2, '#c9c0ae');
  p.r(1, 1, 30, 14, '#eae6dc');
  p.r(3, 3, 26, 10, v ? '#f2c58a' : '#9fd0f0');
  p.r(3, 3, 26, 3, v ? '#f0a977' : '#b8e0f7');
  p.r(15, 3, 2, 10, '#eae6dc');
  p.r(5, 6, 6, 2, '#ffffff');
  p.r(19, 8, 7, 2, '#ffffff');
};

const poster: PropArt = (p, w, h, v) => {
  p.r(3, 1, 10, 13, '#3b4052');
  p.r(4, 2, 8, 11, ['#9fd0f0', '#f2d16b', '#e8a0c0', '#e6e8f0'][v % 4]);
  if (v % 4 === 0) {
    p.blob(8, 6, 2, 2, '#ffd27a');
    p.r(4, 9, 8, 4, '#4a73b8');
  } else if (v % 4 === 1) {
    p.r(5, 4, 3, 3, '#d95a5a');
    p.r(8, 7, 3, 4, '#4a73b8');
  } else if (v % 4 === 2) {
    p.r(5, 8, 3, 4, '#5a9b72');
    p.r(7, 6, 3, 6, '#3f7d5a');
    p.r(9, 9, 2, 3, '#5a9b72');
  } else {
    p.r(6, 6, 4, 4, '#a8774a');
    p.r(10, 7, 1, 2, '#a8774a');
    p.r(7, 4, 1, 1, '#9aa0aa');
    p.r(9, 3, 1, 2, '#9aa0aa');
  }
};

export const PROP_ART: Record<PropKind, PropArt> = {
  desk,
  chair,
  plant,
  plantBig,
  tree,
  sofa,
  coffeeBar,
  roundTable,
  meetingTable,
  whiteboard,
  branchBoard,
  bookshelf,
  fountain,
  lamp,
  rugBlue: rug('#4d6fa8', '#e6c36a', '#7a98c8'),
  rugWarm: rug('#c9855a', '#f0d6a0', '#e0a47a'),
  terminal,
  cooler,
  reception,
  window: windowArt,
  poster,
};
