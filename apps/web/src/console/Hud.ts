import { RAD, qRotInv, wrap360, type BoardSummary, type RenderFrame } from '@wingmind/shared';
import { COLORS, el, setAttr, setText } from './svg';

// Head-up display (spec section 8), SVG at 60 Hz: pitch ladder, flight-path
// marker, heading tape, airspeed and Mach, barometric and radar altitude,
// vertical speed, G, angle of attack, plus the break, pull-up and steering cues.

const W = 1000, H = 600, CX = W / 2, CY = H / 2;
const PX_PER_DEG = 12;

export class Hud {
  readonly svg: SVGSVGElement;
  private ladder: SVGGElement;
  private fpm: SVGGElement;
  private tape: SVGGElement;
  private tapeTicks: SVGTextElement[] = [];
  private tapeLines: SVGLineElement[] = [];
  private hdg: SVGTextElement;
  private kcas: SVGTextElement;
  private mach: SVGTextElement;
  private alt: SVGTextElement;
  private ralt: SVGTextElement;
  private vs: SVGTextElement;
  private g: SVGTextElement;
  private aoa: SVGTextElement;
  private breakCue: SVGGElement;
  private breakText: SVGTextElement;
  private pullCue: SVGGElement;
  private steer: SVGPathElement;
  private flash: SVGRectElement;
  private ap: SVGTextElement;

  constructor(container: HTMLElement) {
    const svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'hud-svg', 'data-testid': 'hud', role: 'img', 'aria-label': 'Head-up display' });
    this.svg = svg;
    const g = el('g', { stroke: COLORS.normal, fill: 'none', 'stroke-width': 2, 'font-family': 'ui-monospace, monospace', 'font-size': 18 }, svg);
    this.flash = el('rect', { x: 4, y: 4, width: W - 8, height: H - 8, stroke: COLORS.warning, 'stroke-width': 6, opacity: 0 }, g);

    // pitch ladder in a clipped group
    const clip = el('clipPath', { id: 'hud-clip' }, svg);
    el('rect', { x: CX - 260, y: 70, width: 520, height: 430 }, clip);
    const ladderClip = el('g', { 'clip-path': 'url(#hud-clip)' }, g);
    this.ladder = el('g', {}, ladderClip);
    for (let p = -90; p <= 90; p += 5) {
      if (p === 0) {
        el('line', { x1: -240, y1: 0, x2: -40, y2: 0 }, this.ladder);
        el('line', { x1: 40, y1: 0, x2: 240, y2: 0 }, this.ladder);
        continue;
      }
      const y = -p * PX_PER_DEG;
      const dash = p < 0 ? '10 6' : '';
      el('path', { d: `M -120 ${y + (p > 0 ? 10 : -10)} V ${y} H -40 M 40 ${y} H 120 V ${y + (p > 0 ? 10 : -10)}`, 'stroke-dasharray': dash }, this.ladder);
      const t1 = el('text', { x: -150, y: y + 6, fill: COLORS.normal, stroke: 'none', 'text-anchor': 'middle', 'font-size': 14 }, this.ladder);
      t1.textContent = String(Math.abs(p));
      const t2 = el('text', { x: 150, y: y + 6, fill: COLORS.normal, stroke: 'none', 'text-anchor': 'middle', 'font-size': 14 }, this.ladder);
      t2.textContent = String(Math.abs(p));
    }
    // fixed aircraft reference (waterline)
    el('path', { d: `M ${CX - 30} ${CY} h 15 l 15 10 l 15 -10 h 15` }, g);
    // flight path marker
    this.fpm = el('g', {}, g);
    el('circle', { cx: 0, cy: 0, r: 10 }, this.fpm);
    el('path', { d: 'M -24 0 H -10 M 10 0 H 24 M 0 -10 V -20' }, this.fpm);

    // heading tape
    this.tape = el('g', { 'data-testid': 'heading-tape' }, g);
    el('rect', { x: CX - 200, y: 18, width: 400, height: 40, stroke: COLORS.dim }, this.tape);
    for (let i = 0; i < 9; i++) {
      this.tapeLines.push(el('line', { x1: 0, y1: 46, x2: 0, y2: 58 }, this.tape));
      const t = el('text', { x: 0, y: 40, fill: COLORS.normal, stroke: 'none', 'text-anchor': 'middle', 'font-size': 14 }, this.tape);
      this.tapeTicks.push(t);
    }
    el('rect', { x: CX - 32, y: 60, width: 64, height: 26, fill: '#000a', stroke: COLORS.normal }, g);
    this.hdg = el('text', { x: CX, y: 80, fill: COLORS.normal, stroke: 'none', 'text-anchor': 'middle', 'data-testid': 'heading-readout' }, g);
    this.steer = el('path', { d: 'M -8 0 L 0 -10 L 8 0 Z', fill: COLORS.advisory, stroke: 'none', opacity: 0 }, g);

    // airspeed (left) and altitude (right) boxes
    el('rect', { x: 120, y: CY - 20, width: 110, height: 40, fill: '#000a' }, g);
    this.kcas = el('text', { x: 220, y: CY + 7, fill: COLORS.normal, stroke: 'none', 'text-anchor': 'end', 'font-size': 24, 'data-testid': 'hud-kcas' }, g);
    this.mach = el('text', { x: 175, y: CY + 45, fill: COLORS.normal, stroke: 'none', 'text-anchor': 'middle', 'data-testid': 'hud-mach' }, g);
    this.g = el('text', { x: 175, y: CY - 70, fill: COLORS.normal, stroke: 'none', 'text-anchor': 'middle', 'data-testid': 'hud-g' }, g);
    this.aoa = el('text', { x: 175, y: CY - 45, fill: COLORS.normal, stroke: 'none', 'text-anchor': 'middle', 'data-testid': 'hud-aoa' }, g);
    el('rect', { x: W - 240, y: CY - 20, width: 120, height: 40, fill: '#000a' }, g);
    this.alt = el('text', { x: W - 130, y: CY + 7, fill: COLORS.normal, stroke: 'none', 'text-anchor': 'end', 'font-size': 24, 'data-testid': 'hud-alt' }, g);
    this.ralt = el('text', { x: W - 180, y: CY + 45, fill: COLORS.normal, stroke: 'none', 'text-anchor': 'middle', 'data-testid': 'hud-ralt' }, g);
    this.vs = el('text', { x: W - 180, y: CY - 45, fill: COLORS.normal, stroke: 'none', 'text-anchor': 'middle', 'data-testid': 'hud-vs' }, g);
    this.ap = el('text', { x: CX, y: H - 70, fill: COLORS.advisory, stroke: 'none', 'text-anchor': 'middle', 'font-size': 14 }, g);

    // cues
    this.breakCue = el('g', { opacity: 0, 'data-testid': 'break-cue' }, g);
    el('path', { d: 'M -60 -20 H 20 V -45 L 80 0 L 20 45 V 20 H -60 Z', stroke: COLORS.warning, 'stroke-width': 4 }, this.breakCue);
    this.breakText = el('text', { x: 0, y: 80, fill: COLORS.warning, stroke: 'none', 'text-anchor': 'middle', 'font-size': 26 }, this.breakCue);
    this.pullCue = el('g', { opacity: 0, 'data-testid': 'pullup-cue' }, g);
    el('path', { d: `M ${CX - 70} ${CY + 120} L ${CX} ${CY + 70} L ${CX + 70} ${CY + 120} M ${CX - 70} ${CY + 150} L ${CX} ${CY + 100} L ${CX + 70} ${CY + 150}`, stroke: COLORS.warning, 'stroke-width': 5 }, this.pullCue);
    const pt = el('text', { x: CX, y: CY + 190, fill: COLORS.warning, stroke: 'none', 'text-anchor': 'middle', 'font-size': 28 }, this.pullCue);
    pt.textContent = 'PULL UP';
    container.appendChild(svg);
  }

  draw(f: RenderFrame, board: BoardSummary | null, warning: boolean, tMs: number): void {
    const o = f.own;
    // ladder: rotate by roll about the center, translate by pitch
    setAttr(this.ladder, 'transform', `translate(${CX} ${CY}) rotate(${-o.rollDeg}) translate(0 ${o.pitchDeg * PX_PER_DEG})`);
    // flight path marker from velocity in the body frame
    // (body frame, so it stays put relative to the waterline as the ladder rolls)
    const vb = qRotInv(o.att, o.vel);
    const up = Math.atan2(vb[2], vb[0]) * RAD;            // degrees above the nose
    const side = Math.atan2(-vb[1], vb[0]) * RAD;         // degrees right of the nose
    const fx = CX + side * PX_PER_DEG;
    const fy = CY - up * PX_PER_DEG;
    setAttr(this.fpm, 'transform', `translate(${Math.max(CX - 240, Math.min(CX + 240, fx)).toFixed(1)} ${Math.max(90, Math.min(H - 90, fy)).toFixed(1)})`);
    // heading tape: ticks every 10 degrees
    const hdg = o.headingDeg;
    const base = Math.floor(hdg / 10) * 10 - 40;
    for (let i = 0; i < 9; i++) {
      const h = base + i * 10;
      const x = CX + (h - hdg) * 4.5;
      const visible = Math.abs(x - CX) < 195;
      setAttr(this.tapeLines[i]!, 'transform', `translate(${x.toFixed(1)} 0)`);
      setAttr(this.tapeLines[i]!, 'opacity', visible ? 1 : 0);
      setAttr(this.tapeTicks[i]!, 'x', x.toFixed(1));
      setAttr(this.tapeTicks[i]!, 'opacity', visible ? 1 : 0);
      setText(this.tapeTicks[i]!, String(Math.round(wrap360(h) / 10)).padStart(2, '0'));
    }
    setText(this.hdg, String(Math.round(wrap360(hdg)) % 360).padStart(3, '0'));
    setText(this.kcas, String(Math.round(o.kcas)));
    setText(this.mach, `M ${o.mach.toFixed(2)}`);
    setText(this.alt, String(Math.round(o.altFt / 10) * 10));
    setText(this.ralt, o.aglFt < 5000 ? `R ${Math.round(o.aglFt / 10) * 10}` : '');
    setText(this.vs, `${o.vsFpm >= 0 ? '+' : ''}${Math.round(o.vsFpm / 100) * 100}`);
    setText(this.g, `G ${o.g.toFixed(1)}  ${o.gMax.toFixed(1)}`);
    setAttr(this.g, 'fill', o.g > 9 ? COLORS.warning : o.g > 7.5 ? COLORS.caution : COLORS.normal);
    setText(this.aoa, `α ${o.aoaDeg.toFixed(1)}`);
    setAttr(this.aoa, 'fill', o.aoaDeg > 24 ? COLORS.warning : o.aoaDeg > 20 ? COLORS.caution : COLORS.normal);
    const ap = f.autopilot;
    setText(this.ap, ap.flyup ? 'AUTO GCAS' : [ap.heading !== undefined ? `HDG ${String(Math.round(ap.heading)).padStart(3, '0')}` : '', ap.altFt !== undefined ? `ALT ${Math.round(ap.altFt / 100) * 100}` : '', ap.kcas !== undefined ? `SPD ${Math.round(ap.kcas)}` : ''].filter(Boolean).join('  '));

    // cues from ORCH
    const cue = board?.cue ?? { kind: null };
    const blink = Math.floor(tMs / 250) % 2 === 0;
    setAttr(this.flash, 'opacity', warning && blink ? 0.9 : 0);
    if (cue.kind === 'break' && cue.side) {
      setAttr(this.breakCue, 'opacity', 1);
      setAttr(this.breakCue, 'transform', `translate(${CX + (cue.side === 'right' ? 140 : -140)} ${CY - 120}) scale(${cue.side === 'right' ? 1 : -1} 1)`);
      setText(this.breakText, `BREAK ${cue.side === 'right' ? 'R' : 'L'}`);
      setAttr(this.breakText, 'transform', `scale(${cue.side === 'right' ? 1 : -1} 1)`);
    } else setAttr(this.breakCue, 'opacity', 0);
    setAttr(this.pullCue, 'opacity', cue.kind === 'pullup' || ap.flyup ? 1 : 0);
    if (cue.kind === 'steer' && cue.headingDeg !== undefined) {
      const d = ((cue.headingDeg - hdg + 540) % 360) - 180;
      const x = CX + Math.max(-190, Math.min(190, d * 4.5));
      setAttr(this.steer, 'transform', `translate(${x.toFixed(1)} 70)`);
      setAttr(this.steer, 'opacity', 1);
    } else setAttr(this.steer, 'opacity', 0);
  }
}
