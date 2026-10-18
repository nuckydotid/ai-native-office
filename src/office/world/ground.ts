import { PROP_DEFS } from '../../shared/workspace/props.ts';
import { TILE, Wall, type WorkspaceMap } from '../../shared/workspace/types.ts';
import type { ArtSet } from './art.ts';
import { makeCanvas, SCALE } from '../../pixel/pen.ts';
import { drawFloor, drawWall, FLOOR_VARIANTS } from './terrain.ts';

const tiles = new Map<string, HTMLCanvasElement>();

function tile(key: string, draw: (pen: import('../../pixel/pen.ts').Pen) => void): HTMLCanvasElement {
  let canvas = tiles.get(key);
  if (!canvas) {
    const made = makeCanvas(16, 16);
    draw(made.pen);
    canvas = made.canvas;
    tiles.set(key, canvas);
  }
  return canvas;
}

/**
 * Paints everything that lies flat or is part of a wall into one picture: floors, rugs, walls, windows and posters.
 * People and furniture that can be walked behind are separate, because what hides what depends on where they stand.
 */
export function bakeGround(map: WorkspaceMap, art: ArtSet): HTMLCanvasElement {
  const ground = document.createElement('canvas');
  ground.width = map.width * TILE;
  ground.height = map.height * TILE;
  const ctx = ground.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;
  const at = (x: number, y: number) => y * map.width + x;
  const wallAt = (x: number, y: number) => x >= 0 && y >= 0 && x < map.width && y < map.height && map.wall[at(x, y)] !== 0;
  const variant = (x: number, y: number) => (((x * 73856093) ^ (y * 19349663)) >>> 0) % FLOOR_VARIANTS;

  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const id = map.floor[at(x, y)];
      const v = variant(x, y);
      ctx.drawImage(tile(`f${id}:${v}`, (pen) => drawFloor(pen, id, v)), x * TILE, y * TILE);
    }
  }
  const drawProps = (layer: 'floor' | 'wall') => {
    for (const p of map.props) {
      const def = PROP_DEFS[p.kind];
      if (!def || def.layer !== layer) continue;
      ctx.drawImage(art.propCanvas(p.kind, p.variant ?? 0), (p.x + def.w / 2 - def.artW / 2) * TILE, (p.y + def.h - def.artH) * TILE);
    }
  };
  drawProps('floor');
  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const id = map.wall[at(x, y)];
      if (id === Wall.None) continue;
      const sides = { s: wallAt(x, y + 1), e: wallAt(x + 1, y), w: wallAt(x - 1, y) };
      const v = variant(x, y);
      ctx.drawImage(tile(`w${id}:${+sides.s}${+sides.e}${+sides.w}:${v}`, (pen) => drawWall(pen, id, sides, v)), x * TILE, y * TILE);
    }
  }
  drawProps('wall');
  void SCALE;
  return ground;
}
