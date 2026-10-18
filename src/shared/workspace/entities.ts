import type { Appearance, PlayerState } from './types.ts';

export function makePlayer(p: {
  id: string;
  name: string;
  x: number;
  y: number;
  look: Appearance;
  desk?: string | null;
}): PlayerState {
  return {
    id: p.id,
    name: p.name,
    x: p.x,
    y: p.y,
    dir: 'down',
    moving: false,
    sitting: null,
    status: 'available',
    statusText: '',
    emote: null,
    look: p.look,
    desk: p.desk ?? null,
    activity: null,
  };
}
