import { Container, Graphics, Sprite, Text } from 'pixi.js';
import { TILE, type EmoteKind, type PlayerState } from '../../shared/workspace/types.ts';
import type { ArtSet } from './art.ts';
import { CHAR_H, SEATED_H } from '../../pixel/people.ts';
import { SCALE } from '../../pixel/pen.ts';
import { textStyle, type ThemeColors } from './theme.ts';

/** What a frame needs to know about the camera and the clock. */
export interface Frame {
  /** Seconds since the office opened. */
  t: number;
  /** Milliseconds, comparable with `Date.now()` for emotes. */
  now: number;
  zoom: number;
  /** Where the world's origin is on screen. */
  ox: number;
  oy: number;
  theme: ThemeColors;
  themeVersion: number;
}

const EMOJI: Record<EmoteKind, string> = { wave: '👋', heart: '❤️', clap: '👏', coffee: '☕', idea: '💡', party: '🎉', think: '💭', thumbsUp: '👍' };
const EMOTE_MS = 3200;
const BUBBLE_MS = 6500;
/** The feet sit a little below the tile's centre, so a person looks like they stand on the floor, not hover over it. */
const FEET = 12;

/** One person in the picture: their figure in the world, and their name, speech and mood on top of the screen. */
export class PersonView {
  private body = new Sprite();
  private shadow: Sprite;
  private hud = new Container();
  private pill = new Graphics();
  private dot = new Graphics();
  private name: Text;
  private marker = new Graphics();
  private bubble = new Container();
  private bubbleBox = new Graphics();
  private bubbleText: Text;
  private bubbleUntil = 0;
  private emote: Text;
  private labelKey = '';
  private labelW = 0;
  private bubbleKey = '';
  private bubbleH = 24;

  constructor(
    private art: ArtSet,
    objects: Container,
    shadows: Container,
    hud: Container,
    private isYou: boolean,
    font: string,
  ) {
    this.body.anchor.set(0.5, 1);
    this.shadow = new Sprite(art.shadow);
    this.shadow.anchor.set(0.5);
    this.shadow.width = 14 * SCALE;
    this.shadow.height = 5 * SCALE;
    objects.addChild(this.body);
    shadows.addChild(this.shadow);
    this.name = new Text({ text: '', style: textStyle(font, { fontSize: 11, fontWeight: '600' }) });
    this.name.anchor.set(0, 0.5);
    this.bubbleText = new Text({ text: '', style: textStyle(font, { fontSize: 12, wordWrap: true, wordWrapWidth: 150, lineHeight: 15 }) });
    this.bubbleText.anchor.set(0.5, 0.5);
    this.emote = new Text({ text: '', style: textStyle(font, { fontSize: 20 }) });
    this.emote.anchor.set(0.5, 1);
    this.bubble.addChild(this.bubbleBox, this.bubbleText);
    this.hud.addChild(this.marker, this.pill, this.dot, this.name, this.bubble, this.emote);
    hud.addChild(this.hud);
  }

  say(text: string, now: number) {
    const clean = text.replace(/\s+/g, ' ').trim().slice(0, 140);
    if (!clean) return;
    this.bubbleText.text = clean;
    this.bubbleUntil = now + BUBBLE_MS;
    this.bubbleKey = '';
  }

  destroy() {
    this.body.destroy();
    this.shadow.destroy();
    this.hud.destroy({ children: true });
  }

  /** Puts the figure in the world and its overlays on screen. `x` and `y` are tile units. */
  update(p: PlayerState, x: number, y: number, f: Frame) {
    const px = x * TILE;
    const py = y * TILE;
    const frames = this.art.character(p.look);
    const seated = !!p.sitting;
    this.body.texture = seated ? frames.seated : frames.frame(p.dir, p.moving ? Math.floor(f.t * 9) % 4 : 0);
    this.body.position.set(Math.round(px), Math.round(py + (seated ? FEET - 2 : FEET)));
    this.body.zIndex = py + FEET;
    this.shadow.position.set(Math.round(px), Math.round(py + FEET - 2));
    this.shadow.visible = !seated;

    const height = (seated ? SEATED_H : CHAR_H) * SCALE;
    const sx = Math.round(f.ox + px * f.zoom);
    const headTop = f.oy + (py + FEET - height) * f.zoom;
    this.layout(p, sx, headTop, f);
  }

  private layout(p: PlayerState, sx: number, headTop: number, f: Frame) {
    const key = `${p.name}|${p.status}|${f.themeVersion}`;
    if (key !== this.labelKey) {
      this.labelKey = key;
      this.drawLabel(p, f.theme);
    }
    const labelY = Math.round(headTop - 12);
    this.pill.position.set(sx, labelY);
    this.dot.position.set(sx, labelY);
    this.name.position.set(sx - this.labelW / 2 + 14, labelY);
    this.marker.visible = this.isYou;
    this.marker.position.set(sx, labelY - 12);

    const above = labelY - 12 - (this.isYou ? 6 : 0);
    const showBubble = f.now < this.bubbleUntil;
    this.bubble.visible = showBubble;
    if (showBubble) {
      if (this.bubbleKey !== `${this.bubbleText.text}|${f.themeVersion}`) {
        this.bubbleKey = `${this.bubbleText.text}|${f.themeVersion}`;
        const w = this.bubbleText.width + 16;
        const h = this.bubbleText.height + 10;
        this.bubbleBox.clear().roundRect(-w / 2, -h / 2, w, h, 8).fill({ color: f.theme.content1, alpha: 0.97 });
        this.bubbleText.style.fill = f.theme.foreground;
        this.bubbleH = h;
      }
      this.bubble.position.set(sx, above - this.bubbleH / 2);
      this.bubble.alpha = Math.min(1, (this.bubbleUntil - f.now) / 700);
    }
    const age = Date.now() - (p.emote?.at ?? 0);
    const showEmote = !!p.emote && age >= 0 && age < EMOTE_MS;
    this.emote.visible = showEmote;
    if (showEmote && p.emote) {
      this.emote.text = EMOJI[p.emote.kind];
      this.emote.position.set(sx + 20, labelY - 4 - (age / EMOTE_MS) * 12);
      this.emote.alpha = Math.min(1, (EMOTE_MS - age) / 500);
    }
  }

  private drawLabel(p: PlayerState, theme: ThemeColors) {
    this.name.text = p.name;
    this.name.style.fill = theme.foreground;
    const w = Math.ceil(this.name.width) + 24;
    const h = 17;
    this.pill.clear().roundRect(-w / 2, -h / 2, w, h, h / 2).fill({ color: theme.content1, alpha: 0.94 });
    const status = p.status === 'available' ? theme.success : p.status === 'focus' ? theme.warning : p.status === 'meeting' ? theme.danger : theme['default-400'];
    this.dot.clear().circle(-w / 2 + 8, 0, 3).fill({ color: status });
    this.marker.clear().poly([-5, 0, 5, 0, 0, 6]).fill({ color: theme.primary });
    this.labelW = w;
  }
}
