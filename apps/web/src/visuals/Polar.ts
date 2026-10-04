import * as d3 from 'd3';
import { SIG_ASPECT_DBSM, type BoardSummary } from '@wingmind/shared';
import { COLORS } from '../console/svg';

// Signature polar plot (implementation 8.2): the 36-bin aspect table as a radial
// line, with one needle per known enemy radar at the aspect that radar sees.
// Turn the aircraft and watch the needles cross the lobes.

export class PolarPlot {
  readonly svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private needles: d3.Selection<SVGGElement, unknown, null, undefined>;
  private r: d3.ScaleLinear<number, number>;
  private size = 200;

  constructor(container: HTMLElement) {
    const S = this.size, R = S / 2 - 14;
    this.svg = d3.select(container).append('svg').attr('viewBox', `${-S / 2} ${-S / 2} ${S} ${S}`).attr('class', 'polar-svg')
      .attr('data-testid', 'polar').attr('role', 'img').attr('aria-label', 'Own radar signature by aspect, with enemy radar needles');
    this.r = d3.scaleLinear().domain([-30, 6]).range([R * 0.1, R]);
    const g = this.svg.append('g');
    for (const db of [-30, -20, -10, 0]) {
      g.append('circle').attr('r', this.r(db)).attr('fill', 'none').attr('stroke', COLORS.dim).attr('stroke-dasharray', '2 3');
      g.append('text').attr('x', 2).attr('y', -this.r(db) + 9).attr('fill', COLORS.dim).attr('font-size', 7).text(`${db} dB`);
    }
    const pts: [number, number][] = SIG_ASPECT_DBSM.map((db, i) => [(i * 10 * Math.PI) / 180, this.r(db)]);
    const line = d3.lineRadial<[number, number]>().angle(d => d[0]).radius(d => d[1]).curve(d3.curveCardinalClosed);
    g.append('path').attr('d', line(pts)).attr('fill', 'rgba(94,224,160,0.15)').attr('stroke', COLORS.normal).attr('stroke-width', 1.5);
    g.append('text').attr('y', -R - 3).attr('text-anchor', 'middle').attr('fill', COLORS.text).attr('font-size', 8).text('NOSE');
    g.append('text').attr('y', R + 10).attr('text-anchor', 'middle').attr('fill', COLORS.text).attr('font-size', 8).text('TAIL');
    this.needles = g.append('g');
  }

  draw(board: BoardSummary | null): void {
    const R = this.size / 2 - 14;
    const data = board?.detection ?? [];
    const sel = this.needles.selectAll<SVGLineElement, (typeof data)[number]>('line').data(data, d => d.emitterId);
    sel.exit().remove();
    sel.enter().append('line').attr('data-testid', 'polar-needle').attr('stroke-width', 2)
      .merge(sel)
      .attr('data-emitter', d => d.emitterId)
      .attr('data-aspect', d => Math.round(d.aspectDeg))
      .attr('stroke', d => (d.pDetect > 0.5 ? COLORS.warning : COLORS.advisory))
      .attr('x1', 0).attr('y1', 0)
      .attr('x2', d => Math.sin((d.aspectDeg * Math.PI) / 180) * R)
      .attr('y2', d => -Math.cos((d.aspectDeg * Math.PI) / 180) * R);
  }
}
