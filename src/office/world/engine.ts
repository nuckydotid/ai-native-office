// Pixi's shader code is generated with `new Function`; the app's content-security policy forbids that, so this build avoids it.
import 'pixi.js/unsafe-eval';
import { Application, Container, Sprite, Texture } from 'pixi.js';
import { PLAYER_SPEED, dirFromDelta, findPath, moveWithCollision } from '../../shared/workspace/grid.ts';
import { pageRoomTargets } from '../../shared/workspace/layout.ts';
import { isAgentId } from '../cast.ts';
import { PROP_DEFS } from '../../shared/workspace/props.ts';
import { TILE, type Vec, type WorkspaceMap } from '../../shared/workspace/types.ts';
import type { OfficeSession } from '../session.ts';
import { ArtSet } from './art.ts';
import { PersonView, type Frame } from './entities.ts';
import { bakeGround } from './ground.ts';
import { Lighting } from './lighting.ts';
import { isDark, onThemeChange, pageFont, readTheme, type ThemeColors } from './theme.ts';

const MIN_ZOOM = 1;
const MAX_ZOOM = 4;
const ZOOM_KEY = 'office-zoom';
const MOVE_KEYS = new Set(['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd']);

const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && !!target.closest('input, textarea, select, [contenteditable="true"], [role="textbox"]');

function savedZoom(): number | null {
  try {
    const n = Number(localStorage.getItem(ZOOM_KEY));
    return Number.isInteger(n) && n >= MIN_ZOOM && n <= MAX_ZOOM ? n : null;
  } catch {
    return null;
  }
}

/**
 * The picture of the office: draws what the session's world says, and turns the keyboard and mouse into the person's
 * own movement. Everything about the office itself (who is where, what is said) stays in the session.
 */
export class OfficeEngine {
  private art = new ArtSet();
  private world = new Container();
  private ground: Sprite | null = null;
  private shadows = new Container();
  private objects = new Container();
  private lighting = new Lighting(this.art);
  private hud = new Container();
  private views = new Map<string, PersonView>();
  private props: Sprite[] = [];
  private keys = new Set<string>();
  private path: Vec[] | null = null;
  private builtVersion = -1;
  private zoom = 2;
  private cam = { x: 0, y: 0, ready: false };
  private theme: ThemeColors = readTheme();
  private themeVersion = 0;
  private font = pageFont();
  private time = 0;
  private lastLook = 0;
  private lastWheel = 0;
  private visible = true;
  private disposed = false;
  private readonly offs: (() => void)[] = [];

  private constructor(
    private app: Application,
    private session: OfficeSession,
    private onZoom: (zoom: number) => void,
  ) {
    this.objects.sortableChildren = true;
    this.world.addChild(this.shadows, this.objects, this.lighting.layer);
    this.app.stage.addChild(this.world, this.hud);
    this.hud.eventMode = 'none';
    const canvas = app.canvas;
    canvas.style.display = 'block';
    canvas.style.touchAction = 'none';

    const keydown = (e: KeyboardEvent) => this.onKeyDown(e);
    const keyup = (e: KeyboardEvent) => this.keys.delete(e.key.toLowerCase());
    const blur = () => this.keys.clear();
    const pointer = (e: PointerEvent) => this.onPointer(e);
    const wheel = (e: WheelEvent) => this.onWheel(e);
    window.addEventListener('keydown', keydown);
    window.addEventListener('keyup', keyup);
    window.addEventListener('blur', blur);
    canvas.addEventListener('pointerdown', pointer);
    canvas.addEventListener('wheel', wheel, { passive: false });
    this.offs.push(
      () => window.removeEventListener('keydown', keydown),
      () => window.removeEventListener('keyup', keyup),
      () => window.removeEventListener('blur', blur),
      () => canvas.removeEventListener('pointerdown', pointer),
      () => canvas.removeEventListener('wheel', wheel),
      onThemeChange(() => {
        this.theme = readTheme();
        this.themeVersion += 1;
        this.lighting.setNight(isDark());
      }),
      session.bubbles.on(({ from, text }) => this.views.get(from)?.say(text, performance.now())),
    );
    app.ticker.add((ticker) => this.frame(ticker.deltaMS / 1000));
  }

  static async create(host: HTMLElement, session: OfficeSession, onZoom: (zoom: number) => void): Promise<OfficeEngine> {
    const app = new Application();
    await app.init({
      width: Math.max(1, host.clientWidth),
      height: Math.max(1, host.clientHeight),
      backgroundAlpha: 0,
      antialias: false,
      autoDensity: true,
      resolution: Math.max(1, Math.round(window.devicePixelRatio || 1)),
      roundPixels: true,
      preference: 'webgl',
    });
    host.appendChild(app.canvas);
    const engine = new OfficeEngine(app, session, onZoom);
    // Pixi's own `resizeTo` only hears about the window, not about this page being shown after it was hidden.
    const watch = new ResizeObserver(() => {
      if (host.clientWidth > 0 && host.clientHeight > 0 && !engine.disposed) app.renderer.resize(host.clientWidth, host.clientHeight);
    });
    watch.observe(host);
    engine.offs.push(() => watch.disconnect());
    return engine;
  }

  setVisible(visible: boolean) {
    this.visible = visible;
    if (visible) this.app.ticker.start();
    else {
      this.app.ticker.stop();
      this.keys.clear();
      const me = this.session.world.me;
      if (me) me.moving = false;
    }
  }

  zoomBy(delta: number) {
    this.setZoom(this.zoom + delta);
  }

  /** Walks the person to a spot (tile units) the way a click on it does. */
  walkTo(x: number, y: number) {
    const { world } = this.session;
    if (!world.me || !world.grid) return;
    this.path = findPath(world.grid, world.me, { x, y });
  }

  destroy() {
    if (this.disposed) return;
    this.disposed = true;
    for (const off of this.offs.splice(0)) off();
    this.app.ticker.stop();
    this.app.destroy({ removeView: true }, { children: true, texture: true, textureSource: true });
  }

  private setZoom(zoom: number) {
    const next = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, Math.round(zoom)));
    if (next === this.zoom) return;
    this.zoom = next;
    try {
      localStorage.setItem(ZOOM_KEY, String(next));
    } catch {
      // Remembering the zoom is a nicety.
    }
    this.onZoom(next);
  }

  /* ───────────── input ───────────── */

  private onKeyDown(e: KeyboardEvent) {
    if (!this.visible || e.metaKey || e.ctrlKey || e.altKey || isTyping(e.target)) return;
    const key = e.key.toLowerCase();
    if (MOVE_KEYS.has(key)) {
      this.keys.add(key);
      this.path = null;
      this.session.walkEnded();
      e.preventDefault();
    } else if (key === 'e' && !e.repeat) {
      this.session.interact();
    } else if (key === '+' || key === '=') {
      this.setZoom(this.zoom + 1);
    } else if (key === '-' || key === '_') {
      this.setZoom(this.zoom - 1);
    }
  }

  private onWheel(e: WheelEvent) {
    if (!this.visible) return;
    e.preventDefault();
    if (e.timeStamp - this.lastWheel < 180) return;
    this.lastWheel = e.timeStamp;
    this.setZoom(this.zoom + (e.deltaY < 0 ? 1 : -1));
  }

  private onPointer(e: PointerEvent) {
    const { world } = this.session;
    const me = world.me;
    if (e.button !== 0 || !me || !world.grid) return;
    const rect = this.app.canvas.getBoundingClientRect();
    const x = (e.clientX - rect.left - this.world.x) / this.zoom / TILE;
    const y = (e.clientY - rect.top - this.world.y) / this.zoom / TILE;
    this.path = findPath(world.grid, me, { x, y });
    this.session.walkEnded();
  }

  /* ───────────── the person's own movement ───────────── */

  private move(dt: number) {
    const { world } = this.session;
    const me = world.me;
    const grid = world.grid;
    if (!me || !grid) return;
    // A page asked the character to walk to its room: find the way there from wherever they stand.
    const page = this.session.takeWalkRequest();
    if (page) {
      let path: Vec[] | null = null;
      for (const target of pageRoomTargets(world.map ?? { zones: [], spawns: [] }, page)) {
        path = findPath(grid, me, target);
        if (path?.length) break;
      }
      this.path = path;
      if (!this.path?.length) this.session.walkEnded();
    }
    const k = this.keys;
    let dx = (k.has('arrowright') || k.has('d') ? 1 : 0) - (k.has('arrowleft') || k.has('a') ? 1 : 0);
    let dy = (k.has('arrowdown') || k.has('s') ? 1 : 0) - (k.has('arrowup') || k.has('w') ? 1 : 0);
    const step = PLAYER_SPEED * dt;
    if (dx || dy) {
      this.path = null;
      const len = Math.hypot(dx, dy);
      dx /= len;
      dy /= len;
    } else if (this.path?.length) {
      const next = this.path[0];
      const rx = next.x - me.x;
      const ry = next.y - me.y;
      const d = Math.hypot(rx, ry);
      if (d <= step) {
        me.sitting = null;
        me.x = next.x;
        me.y = next.y;
        this.path.shift();
        me.moving = this.path.length > 0;
        if (!me.moving) this.session.walkEnded();
        return;
      }
      dx = rx / d;
      dy = ry / d;
    } else {
      me.moving = false;
      return;
    }
    // Walking away from a desk stands the person up; the server does the same when it hears the move.
    me.sitting = null;
    const m = moveWithCollision(grid, me.x, me.y, dx * step, dy * step);
    const moved = m.x !== me.x || m.y !== me.y;
    me.x = m.x;
    me.y = m.y;
    me.dir = dirFromDelta(dx, dy, me.dir);
    me.moving = moved;
    if (!moved) {
      this.path = null;
      this.session.walkEnded();
    }
  }

  /* ───────────── drawing ───────────── */

  private build(map: WorkspaceMap) {
    this.ground?.destroy({ texture: true, textureSource: true });
    this.ground = new Sprite(Texture.from(bakeGround(map, this.art)));
    this.world.addChildAt(this.ground, 0);
    for (const s of this.props) s.destroy();
    this.props = [];
    for (const p of map.props) {
      const def = PROP_DEFS[p.kind];
      if (!def || def.layer !== 'object') continue;
      const sprite = new Sprite(this.art.prop(p.kind, p.variant ?? 0));
      sprite.position.set((p.x + def.w / 2 - def.artW / 2) * TILE, (p.y + def.h - def.artH) * TILE);
      // Solid things hide whoever stands behind them; flat ones (a chair) are always under whoever is on them.
      sprite.zIndex = def.solid ? (p.y + def.h) * TILE - 0.5 : p.y * TILE;
      this.objects.addChild(sprite);
      this.props.push(sprite);
    }
    this.lighting.build(map);
    this.lighting.setNight(isDark());
    if (this.builtVersion < 0) {
      // Close up (about 13 tiles across, like a farm game) when there is room for it, otherwise a wider view.
      this.zoom = savedZoom() ?? (this.app.screen.width >= 800 ? 2 : 1);
      this.onZoom(this.zoom);
    }
    this.builtVersion = this.session.world.mapVersion;
  }

  private updateCamera(dt: number, map: WorkspaceMap) {
    const { width, height } = this.app.screen;
    const z = this.zoom;
    const me = this.session.world.me;
    const mapW = map.width * TILE;
    const mapH = map.height * TILE;
    const halfW = width / (2 * z);
    const halfH = height / (2 * z);
    const fit = (target: number, half: number, size: number) => (size <= half * 2 ? size / 2 : Math.min(size - half, Math.max(half, target)));
    const tx = fit(me ? me.x * TILE : mapW / 2, halfW, mapW);
    const ty = fit(me ? me.y * TILE - 8 : mapH / 2, halfH, mapH);
    if (!this.cam.ready) {
      this.cam = { x: tx, y: ty, ready: true };
    } else {
      const k = 1 - Math.exp(-dt * 9);
      this.cam.x += (tx - this.cam.x) * k;
      this.cam.y += (ty - this.cam.y) * k;
    }
    this.world.scale.set(z);
    this.world.position.set(Math.round(width / 2 - this.cam.x * z), Math.round(height / 2 - this.cam.y * z));
  }

  private frame(dt: number) {
    if (this.disposed) return;
    dt = Math.min(dt, 0.1);
    const { world } = this.session;
    const map = world.map;
    if (!map) return;
    const now = performance.now();
    this.time += dt;
    if (this.builtVersion !== world.mapVersion) this.build(map);
    this.move(dt);
    this.session.reportMove(now);
    if (now - this.lastLook > 120) {
      this.lastLook = now;
      this.session.look();
    }
    this.updateCamera(dt, map);

    const f: Frame = { t: this.time, now, zoom: this.zoom, ox: this.world.x, oy: this.world.y, theme: this.theme, themeVersion: this.themeVersion };
    for (const p of world.players.values()) {
      // The team's agents are in the office on every page; people are seen only on the page they are on.
      if ((p.page ?? 'progress') !== world.page && p.id !== world.you && !isAgentId(p.id)) continue;
      let view = this.views.get(p.id);
      if (!view) {
        view = new PersonView(this.art, this.objects, this.shadows, this.hud, p.id === world.you, this.font);
        this.views.set(p.id, view);
      }
      const at = world.position(p.id, now) ?? p;
      view.update(p, at.x, at.y, f);
    }
    for (const [id, view] of this.views) {
      const p = world.players.get(id);
      if (p && ((p.page ?? 'progress') === world.page || id === world.you || isAgentId(id))) continue;
      view.destroy();
      this.views.delete(id);
    }
  }
}
