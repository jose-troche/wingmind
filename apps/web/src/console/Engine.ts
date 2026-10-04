import type { EngineState, RenderFrame } from '@wingmind/shared';
import { COLORS, band, el, setAttr, setText } from './svg';

// Engine page (spec 8): N1 and N2, turbine temperature, nozzle, oil pressure and
// temperature, fuel flow, thrust, afterburner stage, vibration. SVG at 10 Hz.

interface Gauge { bar: SVGRectElement; value: SVGTextElement }

const ROWS: { key: string; label: string; max: number; fmt: (e: EngineState) => string; val: (e: EngineState) => number; color: (e: EngineState) => string }[] = [
  { key: 'n1', label: 'N1 %', max: 110, val: e => e.n1, fmt: e => e.n1.toFixed(0), color: e => band(e.n1, 101, 105) },
  { key: 'n2', label: 'N2 %', max: 110, val: e => e.n2, fmt: e => e.n2.toFixed(0), color: e => band(e.n2, 102, 106) },
  { key: 'tit', label: 'TIT °C', max: 1200, val: e => e.titC, fmt: e => e.titC.toFixed(0), color: e => band(e.titC, 980, 1050) },
  { key: 'noz', label: 'NOZ %', max: 100, val: e => e.nozzlePct, fmt: e => e.nozzlePct.toFixed(0), color: () => COLORS.normal },
  { key: 'oilp', label: 'OIL PSI', max: 80, val: e => e.oilPsi, fmt: e => e.oilPsi.toFixed(0), color: e => band(e.oilPsi, 25, 15, true) },
  { key: 'oilt', label: 'OIL °C', max: 150, val: e => e.oilC, fmt: e => e.oilC.toFixed(0), color: e => band(e.oilC, 120, 135) },
  { key: 'ff', label: 'FF PPH', max: 60000, val: e => e.fuelFlowPph, fmt: e => String(Math.round(e.fuelFlowPph / 10) * 10), color: () => COLORS.normal },
  { key: 'thr', label: 'THRUST %', max: 160, val: e => e.thrustPct, fmt: e => e.thrustPct.toFixed(0), color: () => COLORS.normal },
  { key: 'vib', label: 'VIB IPS', max: 4, val: e => e.vibration, fmt: e => e.vibration.toFixed(1), color: e => band(e.vibration, 1.5, 2.5) },
];

export class EnginePage {
  readonly svg: SVGSVGElement;
  private gauges: Record<'left' | 'right', Record<string, Gauge>> = { left: {}, right: {} };
  private mode: Record<'left' | 'right', SVGTextElement>;

  constructor(container: HTMLElement) {
    const W = 320, H = 300;
    this.svg = el('svg', { viewBox: `0 0 ${W} ${H}`, class: 'page-svg', role: 'img', 'aria-label': 'Engine page' });
    const g = el('g', { 'font-family': 'ui-monospace, monospace', 'font-size': 12 }, this.svg);
    const head = (x: number, t: string) => { const e = el('text', { x, y: 16, fill: COLORS.text, 'text-anchor': 'middle' }, g); e.textContent = t; };
    head(95, 'LEFT');
    head(255, 'RIGHT');
    ROWS.forEach((row, i) => {
      const y = 32 + i * 26;
      const lab = el('text', { x: 160, y: y + 11, fill: COLORS.dim, 'text-anchor': 'middle', 'font-size': 10 }, g);
      lab.textContent = row.label;
      for (const side of ['left', 'right'] as const) {
        const x0 = side === 'left' ? 20 : 200;
        el('rect', { x: x0, y, width: 100, height: 14, fill: 'none', stroke: COLORS.dim }, g);
        const bar = el('rect', { x: x0, y, width: 0, height: 14, fill: COLORS.normal, opacity: 0.6 }, g);
        const value = el('text', { x: x0 + 104, y: y + 11, fill: COLORS.text, 'font-size': 11, 'data-testid': `eng-${row.key}-${side}` }, g);
        this.gauges[side][row.key] = { bar, value };
      }
    });
    this.mode = {
      left: el('text', { x: 70, y: H - 16, fill: COLORS.normal, 'text-anchor': 'middle', 'data-testid': 'eng-mode-left' }, g),
      right: el('text', { x: 250, y: H - 16, fill: COLORS.normal, 'text-anchor': 'middle', 'data-testid': 'eng-mode-right' }, g),
    };
    container.appendChild(this.svg);
  }

  draw(f: RenderFrame): void {
    for (const e of f.own.engines) {
      const side = e.side;
      for (const row of ROWS) {
        const gauge = this.gauges[side][row.key]!;
        setAttr(gauge.bar, 'width', Math.max(0, Math.min(100, (row.val(e) / row.max) * 100)).toFixed(1));
        setAttr(gauge.bar, 'fill', row.color(e));
        setText(gauge.value, row.fmt(e));
      }
      const label = e.mode === 'afterburner' ? `AB ${e.abStage}` : e.mode.toUpperCase();
      setText(this.mode[side], e.fault ? `${label} · ${e.fault.replace('_', ' ').toUpperCase()}` : label);
      setAttr(this.mode[side], 'fill', e.mode === 'fire' ? COLORS.warning : e.fault ? COLORS.caution : COLORS.normal);
    }
  }
}
