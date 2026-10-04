import type { MeshEdge } from '@wingmind/shared';
import { COLORS } from '../console/svg';

// Agent mesh visualizer (implementation 8.2): the agent worker counts messages
// per agent pair and the highest priority seen, posted at 10 Hz. Edges pulse by
// count and are coloured by priority; the visual never sees full messages.

const CLUSTERS: { name: string; ids: string[]; color: string }[] = [
  { name: 'Sensors', ids: ['SENS', 'SIM', 'pilot'], color: '#8fa8b8' },
  { name: 'Perception', ids: ['FUSE'], color: '#4fc3f7' },
  { name: 'Threat', ids: ['MAWS', 'AIR', 'GBAD', 'TAP'], color: '#ff6b81' },
  { name: 'Survivability', ids: ['SIG', 'EW', 'NAV'], color: '#ffd166' },
  { name: 'Systems', ids: ['SYS'], color: '#b388ff' },
  { name: 'Command', ids: ['ORCH'], color: '#5ee0a0' },
  { name: 'Interface', ids: ['NLU', 'PIA'], color: '#5ee0a0' },
];

export class MeshView {
  readonly canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private pos = new Map<string, { x: number; y: number; color: string }>();
  private heat = new Map<string, { v: number; p: number; from: string; to: string }>();
  private lastUrgentAt = -Infinity;
  selected: string | null = null;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.setAttribute('data-testid', 'agent-mesh');
    this.canvas.setAttribute('role', 'img');
    this.canvas.setAttribute('aria-label', 'Agent mesh: messages flowing between agents');
    this.canvas.dataset.maxPriority = 'none';
    this.canvas.dataset.pulses = '0';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.canvas.addEventListener('click', e => {
      const r = this.canvas.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      let best: string | null = null, bd = 18;
      for (const [id, p] of this.pos) { const d = Math.hypot(p.x - x, p.y - y); if (d < bd) { bd = d; best = id; } }
      this.selected = best;
      this.canvas.dispatchEvent(new CustomEvent('agent-select', { detail: best, bubbles: true }));
    });
  }

  private layout(w: number, h: number): void {
    this.pos.clear();
    const all = CLUSTERS.flatMap(c => c.ids.map(id => ({ id, color: c.color })));
    const cx = w / 2, cy = h / 2, R = Math.min(w, h) / 2 - 22;
    all.forEach((n, i) => {
      const a = (i / all.length) * Math.PI * 2 - Math.PI / 2;
      this.pos.set(n.id, { x: cx + Math.cos(a) * R, y: cy + Math.sin(a) * R, color: n.color });
    });
  }

  ingest(edges: MeshEdge[], nowMs: number): void {
    for (const e of edges) {
      const k = `${e.from}>${e.to}`;
      const h = this.heat.get(k) ?? { v: 0, p: 9, from: e.from, to: e.to };
      h.v = Math.min(1, h.v + Math.min(1, e.count / 6));
      h.p = Math.min(h.p, e.priority);
      this.heat.set(k, h);
      if (e.priority === 0) this.lastUrgentAt = nowMs;
    }
    let pulses = 0;
    let minP = 9;
    for (const h of this.heat.values()) if (h.v > 0.05) { pulses++; minP = Math.min(minP, h.p); }
    this.canvas.dataset.pulses = String(pulses);
    // the most urgent priority seen in the last second (0 = missile chain)
    this.canvas.dataset.maxPriority = nowMs - this.lastUrgentAt < 1500 ? '0' : pulses ? String(minP) : 'none';
  }

  draw(): void {
    const r = this.canvas.parentElement!.getBoundingClientRect();
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const w = Math.max(50, Math.floor(r.width)), h = Math.max(50, Math.floor(r.height));
    if (this.canvas.width !== w * dpr || this.canvas.height !== h * dpr || this.pos.size === 0) {
      this.canvas.width = w * dpr; this.canvas.height = h * dpr;
      this.canvas.style.width = `${w}px`; this.canvas.style.height = `${h}px`;
      this.layout(w, h);
    }
    const c = this.ctx;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.fillStyle = '#050b0e';
    c.fillRect(0, 0, w, h);
    for (const [k, e] of this.heat) {
      const a = this.pos.get(e.from), b = this.pos.get(e.to);
      if (a && b && e.v > 0.02) {
        c.strokeStyle = e.p === 0 ? COLORS.warning : e.p <= 3 ? COLORS.caution : COLORS.advisory;
        c.globalAlpha = 0.25 + 0.75 * e.v;
        c.lineWidth = 1 + 3 * e.v;
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x, b.y); c.stroke();
      }
      e.v *= 0.82;                                          // decay between 10 Hz updates
      if (e.v < 0.01) { this.heat.delete(k); }
      else if (e.v < 0.2) e.p = 9;
    }
    c.globalAlpha = 1;
    c.font = '10px ui-monospace, monospace';
    c.textAlign = 'center';
    for (const [id, p] of this.pos) {
      c.fillStyle = id === this.selected ? '#ffffff' : p.color;
      c.beginPath(); c.arc(p.x, p.y, 6, 0, Math.PI * 2); c.fill();
      c.fillStyle = COLORS.text;
      c.fillText(id, p.x, p.y - 9);
    }
    c.textAlign = 'start';
  }
}
