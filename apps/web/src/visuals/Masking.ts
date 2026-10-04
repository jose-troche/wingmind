import * as d3 from 'd3';
import { FT, dist2d, type BoardSummary, type RenderFrame } from '@wingmind/shared';
import type { Terrain } from '@wingmind/sim-core';
import { COLORS } from '../console/svg';

// Terrain masking profile (implementation 8.2): 128 terrain samples along the
// radar-to-own-ship line. The sight line is green while terrain blocks it and
// red once it is clear.

const SAMPLES = 128;

export class MaskingProfile {
  readonly svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private area: d3.Selection<SVGPathElement, unknown, null, undefined>;
  private sight: d3.Selection<SVGLineElement, unknown, null, undefined>;
  private label: d3.Selection<SVGTextElement, unknown, null, undefined>;
  private W = 300;
  private H = 110;

  constructor(container: HTMLElement) {
    this.svg = d3.select(container).append('svg').attr('viewBox', `0 0 ${this.W} ${this.H}`).attr('class', 'masking-svg')
      .attr('data-testid', 'masking').attr('role', 'img').attr('aria-label', 'Terrain masking profile from the nearest ground radar');
    this.area = this.svg.append('path').attr('fill', '#3a3424').attr('stroke', '#7a6a4a');
    this.sight = this.svg.append('line').attr('data-testid', 'masking-line').attr('stroke-width', 2).attr('data-state', 'none');
    this.label = this.svg.append('text').attr('x', 6).attr('y', 12).attr('fill', COLORS.text).attr('font-size', 9);
  }

  draw(f: RenderFrame, board: BoardSummary | null, terrain: Terrain | null): void {
    const rings = board?.gbadRings ?? [];
    if (!terrain || rings.length === 0) {
      this.label.text('No ground radar known');
      this.sight.attr('data-state', 'none').attr('stroke', 'none');
      this.area.attr('d', null);
      return;
    }
    const own = f.own.pos;
    const site = [...rings].sort((a, b) => dist2d(a.pos, own) - dist2d(b.pos, own))[0]!;
    const siteZ = terrain.height(site.pos[0], site.pos[1]) + 10;
    const prof = terrain.profile(site.pos, own, SAMPLES);
    const maxZ = Math.max(own[2], siteZ, ...prof) * 1.1;
    const x = d3.scaleLinear().domain([0, SAMPLES - 1]).range([4, this.W - 4]);
    const y = d3.scaleLinear().domain([0, maxZ]).range([this.H - 4, 18]);
    const ar = d3.area<number>().x((_, i) => x(i)).y0(this.H - 4).y1(d => y(d));
    this.area.attr('d', ar(prof));
    let blocked = false;
    for (let i = 1; i < SAMPLES - 1; i++) {
      const z = siteZ + ((own[2] - siteZ) * i) / (SAMPLES - 1);
      if (prof[i]! > z) { blocked = true; break; }
    }
    this.sight
      .attr('x1', x(0)).attr('y1', y(siteZ)).attr('x2', x(SAMPLES - 1)).attr('y2', y(own[2]))
      .attr('stroke', blocked ? COLORS.normal : COLORS.warning)
      .attr('stroke-dasharray', blocked ? '5 3' : null)
      .attr('data-state', blocked ? 'masked' : 'clear');
    this.label.text(`${site.siteId}: ${blocked ? 'MASKED' : 'LINE OF SIGHT'} · own ${Math.round(own[2] / FT / 100) * 100} ft · ${Math.round(dist2d(site.pos, own) / 1852)} nm`);
  }
}
