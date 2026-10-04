import { NM, bearingVec, type BoardSummary, type RenderFrame, type Scenario, type Track } from '@wingmind/shared';
import { COLORS } from './svg';

// Tactical situation display (spec 8, implementation 8.1): Canvas 2D at 30 Hz,
// north up with own ship centred. Fused tracks by identity (shape and colour),
// threat rings cut by terrain, own detection rings, route and proposed re-route.

export class Tsd {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  highlight: string | null = null;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('data-testid', 'tsd-canvas');
    this.canvas.setAttribute('aria-label', 'Tactical situation display');
    this.canvas.setAttribute('role', 'img');
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
  }

  private fit(): { w: number; h: number } {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(50, Math.floor(r.width)), h = Math.max(50, Math.floor(r.height));
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr) {
      this.canvas.width = w * dpr;
      this.canvas.height = h * dpr;
      this.canvas.style.width = `${w}px`;
      this.canvas.style.height = `${h}px`;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    return { w, h };
  }

  draw(f: RenderFrame, board: BoardSummary | null, scenario: Scenario | null, rangeNm: number, showRings: boolean): void {
    const { w, h } = this.fit();
    const c = this.ctx;
    const cx = w / 2, cy = h / 2;
    const scale = (Math.min(w, h) / 2 - 8) / (rangeNm * NM);
    const own = f.own.pos;
    const P = (x: number, y: number): [number, number] => [cx + (x - own[0]) * scale, cy - (y - own[1]) * scale];
    c.fillStyle = '#050b0e';
    c.fillRect(0, 0, w, h);
    // range rings
    c.strokeStyle = COLORS.dim;
    c.lineWidth = 1;
    c.font = '10px ui-monospace, monospace';
    c.fillStyle = COLORS.dim;
    for (let k = 1; k <= 4; k++) {
      const r = (rangeNm * NM * k) / 4 * scale;
      c.beginPath(); c.arc(cx, cy, r, 0, Math.PI * 2); c.stroke();
      c.fillText(`${Math.round((rangeNm * k) / 4)}`, cx + 3, cy - r + 11);
    }
    if (scenario) {
      // weather cells
      for (const cell of scenario.weather.cells) {
        const [x, y] = P(cell.pos[0], cell.pos[1]);
        c.fillStyle = 'rgba(255,176,0,0.12)';
        c.strokeStyle = COLORS.caution;
        c.setLineDash([2, 3]);
        c.beginPath(); c.arc(x, y, cell.radiusM * scale, 0, Math.PI * 2); c.fill(); c.stroke();
        c.setLineDash([]);
      }
      // towers: small T glyph
      c.strokeStyle = COLORS.caution;
      for (const t of scenario.theater.towers) {
        const [x, y] = P(t.pos[0], t.pos[1]);
        c.beginPath(); c.moveTo(x - 4, y - 5); c.lineTo(x + 4, y - 5); c.moveTo(x, y - 5); c.lineTo(x, y + 4); c.stroke();
      }
      // home plate
      const [hx, hy] = P(scenario.theater.homePlate[0], scenario.theater.homePlate[1]);
      c.strokeStyle = COLORS.advisory;
      c.strokeRect(hx - 5, hy - 5, 10, 10);
    }
    if (board) {
      // route
      const route = board.route;
      c.strokeStyle = COLORS.advisory;
      c.lineWidth = 1.5;
      c.beginPath();
      c.moveTo(cx, cy);
      route.slice(board.activeWp).forEach(p => { const [x, y] = P(p[0], p[1]); c.lineTo(x, y); });
      c.stroke();
      route.forEach((p, i) => {
        const [x, y] = P(p[0], p[1]);
        c.fillStyle = i === board.activeWp ? COLORS.advisory : COLORS.dim;
        c.beginPath(); c.arc(x, y, 3.5, 0, Math.PI * 2); c.fill();
        c.fillText(String(i + 1), x + 5, y - 4);
      });
      if (board.proposedRoute) {
        c.strokeStyle = COLORS.normal;
        c.setLineDash([6, 4]);
        c.beginPath(); c.moveTo(cx, cy);
        board.proposedRoute.forEach(p => { const [x, y] = P(p[0], p[1]); c.lineTo(x, y); });
        c.stroke(); c.setLineDash([]);
      }
      if (showRings) {
        // threat rings cut by line of sight
        for (const ring of board.gbadRings) {
          c.strokeStyle = ring.type === 'sam_long' ? COLORS.warning : COLORS.caution;
          c.fillStyle = ring.type === 'sam_long' ? 'rgba(255,77,109,0.07)' : 'rgba(255,176,0,0.07)';
          c.setLineDash(ring.known ? [] : [4, 4]);
          c.beginPath();
          ring.radii.forEach((r, k) => {
            const [dx, dy] = bearingVec((k * 360) / ring.radii.length);
            const [x, y] = P(ring.pos[0] + dx * r, ring.pos[1] + dy * r);
            if (k === 0) c.moveTo(x, y); else c.lineTo(x, y);
          });
          c.closePath(); c.fill(); c.stroke(); c.setLineDash([]);
          const [sx, sy] = P(ring.pos[0], ring.pos[1]);
          c.fillStyle = COLORS.warning;
          c.beginPath(); c.moveTo(sx, sy - 6); c.lineTo(sx + 6, sy + 5); c.lineTo(sx - 6, sy + 5); c.closePath(); c.fill();
        }
        // own detection rings (where each radar can see us at the current aspect)
        for (const d of board.detection) {
          const [x, y] = P(d.pos[0], d.pos[1]);
          c.strokeStyle = d.pDetect > 0.5 ? COLORS.warning : COLORS.advisory;
          c.setLineDash([1, 3]);
          c.beginPath(); c.arc(x, y, d.radiusM * scale, 0, Math.PI * 2); c.stroke();
          c.setLineDash([]);
        }
      }
      for (const t of board.tracks) this.drawTrack(t, P, c);
    }
    // own ship
    c.save();
    c.translate(cx, cy);
    c.rotate((f.own.headingDeg * Math.PI) / 180);
    c.strokeStyle = COLORS.normal;
    c.lineWidth = 2;
    c.beginPath(); c.moveTo(0, -9); c.lineTo(6, 7); c.lineTo(0, 3); c.lineTo(-6, 7); c.closePath(); c.stroke();
    c.restore();
    c.fillStyle = COLORS.text;
    c.fillText(`${rangeNm} NM  N↑`, 6, 12);
  }

  private drawTrack(t: Track, P: (x: number, y: number) => [number, number], c: CanvasRenderingContext2D): void {
    const [x, y] = P(t.pos[0], t.pos[1]);
    const color = t.identity === 'hostile' ? COLORS.hostile : t.identity === 'friend' ? COLORS.friend : COLORS.unknown;
    c.strokeStyle = color;
    c.fillStyle = color;
    c.lineWidth = this.highlight === t.id ? 3 : 1.5;
    c.beginPath();
    switch (t.kind) {
      case 'missile': c.moveTo(x, y - 6); c.lineTo(x + 5, y + 4); c.lineTo(x - 5, y + 4); c.closePath(); c.fill(); break;
      case 'drone': c.rect(x - 3.5, y - 3.5, 7, 7); c.stroke(); break;
      case 'air': c.moveTo(x, y - 7); c.lineTo(x + 7, y); c.lineTo(x, y + 7); c.lineTo(x - 7, y); c.closePath(); c.stroke(); break;
      default: c.arc(x, y, 5, 0, Math.PI * 2); c.stroke();
    }
    // velocity leader, one minute
    const sp = Math.hypot(t.vel[0], t.vel[1]);
    if (sp > 5) {
      const [vx, vy] = P(t.pos[0] + t.vel[0] * 30, t.pos[1] + t.vel[1] * 30);
      c.beginPath(); c.moveTo(x, y); c.lineTo(vx, vy); c.stroke();
    }
    c.font = '10px ui-monospace, monospace';
    c.fillText(t.id, x + 8, y + 3);
  }
}
