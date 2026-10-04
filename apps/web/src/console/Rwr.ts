import type { RenderFrame } from '@wingmind/shared';
import { COLORS } from './svg';

// Warning receiver scope (spec 8): emitter symbols by bearing relative to the
// nose and by lethality (guidance inner, track middle, search outer); a
// guidance emitter flashes. Canvas 2D at 30 Hz.

const LETTER: Record<string, string> = { sam_long: 'S', sam_short: 'A', fighter: 'F', ew_radar: 'E', unknown: 'U' };

export class Rwr {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Radar warning receiver');
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  draw(f: RenderFrame, tMs: number): void {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(50, Math.floor(r.width)), h = Math.max(50, Math.floor(r.height));
    if (this.canvas.width !== w * dpr) { this.canvas.width = w * dpr; this.canvas.height = h * dpr; this.canvas.style.width = `${w}px`; this.canvas.style.height = `${h}px`; }
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 10;
    c.fillStyle = '#050b0e';
    c.fillRect(0, 0, w, h);
    c.strokeStyle = COLORS.dim;
    c.lineWidth = 1;
    for (const k of [0.33, 0.66, 1]) { c.beginPath(); c.arc(cx, cy, R * k, 0, Math.PI * 2); c.stroke(); }
    for (let a = 0; a < 360; a += 30) {
      const rad = (a * Math.PI) / 180;
      c.beginPath(); c.moveTo(cx + Math.sin(rad) * R * 0.95, cy - Math.cos(rad) * R * 0.95); c.lineTo(cx + Math.sin(rad) * R, cy - Math.cos(rad) * R); c.stroke();
    }
    const blink = Math.floor(tMs / 200) % 2 === 0;
    let top: number | null = null;
    f.rwr.forEach((e, i) => { if (top === null || e.strength > f.rwr[top]!.strength) top = i; });
    f.rwr.forEach((e, i) => {
      const rel = ((e.bearingDeg - f.own.headingDeg) * Math.PI) / 180;
      const ring = e.mode === 'guidance' ? 0.3 : e.mode === 'track' ? 0.6 : 0.88;
      const x = cx + Math.sin(rel) * R * ring, y = cy - Math.cos(rel) * R * ring;
      const color = e.mode === 'guidance' ? COLORS.warning : e.mode === 'track' ? COLORS.caution : COLORS.normal;
      if (e.mode === 'guidance' && !blink) return;
      c.strokeStyle = color;
      c.fillStyle = color;
      c.font = 'bold 14px ui-monospace, monospace';
      c.textAlign = 'center';
      c.textBaseline = 'middle';
      c.fillText(LETTER[e.type] ?? 'U', x, y);
      if (i === top) {
        // priority emitter: diamond around the symbol
        c.beginPath(); c.moveTo(x, y - 12); c.lineTo(x + 12, y); c.lineTo(x, y + 12); c.lineTo(x - 12, y); c.closePath(); c.stroke();
      }
      if (e.mode === 'guidance') { c.beginPath(); c.arc(x, y, 14, 0, Math.PI * 2); c.stroke(); }
    });
    c.textAlign = 'start';
    c.textBaseline = 'alphabetic';
    this.canvas.dataset.emitters = String(f.rwr.length);
  }
}
