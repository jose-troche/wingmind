import type { RenderFrame } from '@wingmind/shared';
import { COLORS, el, setAttr, setText } from './svg';

// Fuel page (spec 8): tank diagram with quantities, total, flow, bingo and joker
// marks, time and range remaining, fuel needed to return, centre of gravity.

export class FuelPage {
  readonly svg: SVGSVGElement;
  private tanks: Record<string, { fill: SVGRectElement; text: SVGTextElement; h: number; y: number }> = {};
  private total: SVGTextElement;
  private flow: SVGTextElement;
  private bingo: SVGTextElement;
  private time: SVGTextElement;
  private range: SVGTextElement;
  private cg: SVGTextElement;
  private bar: SVGRectElement;
  private bingoMark: SVGLineElement;
  private jokerMark: SVGLineElement;

  constructor(container: HTMLElement) {
    this.svg = el('svg', { viewBox: '0 0 320 300', class: 'page-svg', role: 'img', 'aria-label': 'Fuel page' });
    const g = el('g', { 'font-family': 'ui-monospace, monospace', 'font-size': 12 }, this.svg);
    // fuselage outline
    el('path', { d: 'M 110 20 L 130 10 L 150 20 L 150 250 L 110 250 Z', fill: 'none', stroke: COLORS.dim }, g);
    el('path', { d: 'M 110 120 L 30 170 L 30 190 L 110 170 M 150 120 L 230 170 L 230 190 L 150 170', fill: 'none', stroke: COLORS.dim }, g);
    const tank = (id: string, x: number, y: number, w: number, h: number, label: string) => {
      el('rect', { x, y, width: w, height: h, fill: 'none', stroke: COLORS.normal }, g);
      const fill = el('rect', { x, y, width: w, height: h, fill: COLORS.normal, opacity: 0.35 }, g);
      const text = el('text', { x: x + w / 2, y: y + h / 2 + 4, fill: COLORS.text, 'text-anchor': 'middle', 'font-size': 11, 'data-testid': `fuel-${id}` }, g);
      const lab = el('text', { x: x + w / 2, y: y - 3, fill: COLORS.dim, 'text-anchor': 'middle', 'font-size': 9 }, g);
      lab.textContent = label;
      this.tanks[id] = { fill, text, h, y };
    };
    tank('fwd', 115, 40, 30, 70, 'FWD');
    tank('aft', 115, 180, 30, 60, 'AFT');
    tank('wing', 45, 168, 60, 16, 'WING');
    const line = (y: number, testid: string) => el('text', { x: 180, y, fill: COLORS.text, 'data-testid': testid }, g);
    this.total = line(40, 'fuel-total');
    this.flow = line(60, 'fuel-flow');
    this.bingo = line(80, 'fuel-bingo');
    this.time = line(100, 'fuel-time');
    this.range = line(120, 'fuel-range');
    this.cg = line(140, 'fuel-cg');
    // total bar with bingo and joker marks
    el('rect', { x: 20, y: 272, width: 280, height: 12, fill: 'none', stroke: COLORS.dim }, g);
    this.bar = el('rect', { x: 20, y: 272, width: 0, height: 12, fill: COLORS.normal, opacity: 0.6 }, g);
    this.bingoMark = el('line', { x1: 0, x2: 0, y1: 266, y2: 290, stroke: COLORS.warning, 'stroke-width': 2 }, g);
    this.jokerMark = el('line', { x1: 0, x2: 0, y1: 266, y2: 290, stroke: COLORS.caution, 'stroke-width': 2 }, g);
    container.appendChild(this.svg);
  }

  draw(f: RenderFrame): void {
    const fuel = f.fuel;
    for (const t of fuel.tanks) {
      const tk = this.tanks[t.id];
      if (!tk) continue;
      const frac = t.capacityLb ? t.lb / t.capacityLb : 0;
      setAttr(tk.fill, 'height', (tk.h * frac).toFixed(1));
      setAttr(tk.fill, 'y', (tk.y + tk.h * (1 - frac)).toFixed(1));
      setText(tk.text, String(Math.round(t.lb / 10) * 10));
    }
    const total = fuel.totalLb;
    const color = total <= fuel.bingoLb ? COLORS.warning : total <= fuel.jokerLb ? COLORS.caution : COLORS.normal;
    setText(this.total, `TOTAL ${Math.round(total / 10) * 10} LB`);
    setAttr(this.total, 'fill', color);
    setText(this.flow, `FLOW  ${Math.round(fuel.flowPph / 10) * 10} PPH`);
    setText(this.bingo, `BINGO ${fuel.bingoLb}  JOKER ${fuel.jokerLb}`);
    const hours = fuel.flowPph > 0 ? total / fuel.flowPph : 0;
    setText(this.time, `TIME  ${Math.floor(hours)}:${String(Math.round((hours % 1) * 60)).padStart(2, '0')}`);
    setText(this.range, `RANGE ${Math.round(hours * f.own.tasKt)} NM`);
    setText(this.cg, `CG    ${fuel.cgPctMac.toFixed(1)} % MAC`);
    const max = 18_000;
    setAttr(this.bar, 'width', Math.min(280, (total / max) * 280).toFixed(1));
    setAttr(this.bar, 'fill', color);
    setAttr(this.bingoMark, 'x1', 20 + (fuel.bingoLb / max) * 280);
    setAttr(this.bingoMark, 'x2', 20 + (fuel.bingoLb / max) * 280);
    setAttr(this.jokerMark, 'x1', 20 + (fuel.jokerLb / max) * 280);
    setAttr(this.jokerMark, 'x2', 20 + (fuel.jokerLb / max) * 280);
  }
}
