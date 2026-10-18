const clamp = (v: number, min: number, max: number) => Math.min(max, Math.max(min, v));

/**
 * Eases another person between the positions the server reports. The server sends about ten a second; drawing each one
 * as it arrives looks like stepping, so the figure glides from where it is drawn now to the newest report instead.
 */
export class Smoother {
  private fromX: number;
  private fromY: number;
  private toX: number;
  private toY: number;
  private start: number;
  private last: number;
  private span = 100;

  constructor(x: number, y: number, now: number) {
    this.fromX = this.toX = x;
    this.fromY = this.toY = y;
    this.start = this.last = now;
  }

  /** A new report. A long jump (a teleport, or a correction) is shown at once rather than as a slide across the room. */
  push(x: number, y: number, now: number) {
    const here = this.at(now);
    if (Math.hypot(x - here.x, y - here.y) > 4) {
      this.fromX = this.toX = x;
      this.fromY = this.toY = y;
    } else {
      this.fromX = here.x;
      this.fromY = here.y;
      this.toX = x;
      this.toY = y;
    }
    this.span = clamp(now - this.last, 60, 250);
    this.start = this.last = now;
  }

  at(now: number): { x: number; y: number } {
    const k = clamp((now - this.start) / this.span, 0, 1);
    return { x: this.fromX + (this.toX - this.fromX) * k, y: this.fromY + (this.toY - this.fromY) * k };
  }
}
