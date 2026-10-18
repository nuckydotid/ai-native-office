import { Container, Graphics, Sprite } from 'pixi.js';
import { PROP_DEFS } from '../../shared/workspace/props.ts';
import { TILE, type WorkspaceMap } from '../../shared/workspace/types.ts';
import type { ArtSet } from './art.ts';

const NIGHT_TINT = 0x8a93c4;

/** Lamps, screens and the espresso bar glow; at night (dark theme) the whole office is dimmed and the glows stand out. */
export class Lighting {
  readonly layer = new Container();
  private dim = new Graphics();
  private glows: { sprite: Sprite; intensity: number }[] = [];
  private night = false;

  constructor(private art: ArtSet) {
    this.dim.blendMode = 'multiply';
    this.layer.addChild(this.dim);
    this.layer.eventMode = 'none';
  }

  build(map: WorkspaceMap) {
    for (const g of this.glows) g.sprite.destroy();
    this.glows = [];
    this.dim.clear().rect(0, 0, map.width * TILE, map.height * TILE).fill({ color: NIGHT_TINT });
    for (const p of map.props) {
      const light = PROP_DEFS[p.kind]?.light;
      if (!light) continue;
      const sprite = new Sprite(this.art.glow);
      sprite.anchor.set(0.5);
      sprite.position.set((p.x + light.dx) * TILE, (p.y + light.dy) * TILE);
      sprite.width = sprite.height = light.radius * TILE * 2;
      sprite.tint = parseInt(light.color.slice(1), 16);
      sprite.blendMode = 'add';
      this.layer.addChild(sprite);
      this.glows.push({ sprite, intensity: light.intensity });
    }
    this.setNight(this.night);
  }

  setNight(night: boolean) {
    this.night = night;
    this.dim.visible = night;
    for (const g of this.glows) g.sprite.alpha = night ? Math.min(1, g.intensity * 1.5) : g.intensity * 0.18;
  }
}
