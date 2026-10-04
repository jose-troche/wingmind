import { clamp, type TerrainSpec, type Vec3 } from '@wingmind/shared';

// Procedural terrain (implementation doc 5.6). The grid is built from the
// scenario's seed and feature list, so the sim worker, the agent worker and the
// console all derive identical heights without shipping height tiles.

function hash(ix: number, iy: number, seed: number): number {
  let h = (ix * 374761393 + iy * 668265263 + seed * 2246822519) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

function valueNoise(x: number, y: number, seed: number): number {
  const ix = Math.floor(x), iy = Math.floor(y);
  const fx = x - ix, fy = y - iy;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy);
  const a = hash(ix, iy, seed), b = hash(ix + 1, iy, seed);
  const c = hash(ix, iy + 1, seed), d = hash(ix + 1, iy + 1, seed);
  return (a + (b - a) * sx + (c - a) * sy + (a - b - c + d) * sx * sy) * 2 - 1;
}

function fbm(x: number, y: number, seed: number): number {
  let sum = 0, amp = 0.5, freq = 1;
  for (let o = 0; o < 5; o++) {
    sum += amp * valueNoise(x * freq, y * freq, seed + o * 101);
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum;
}

function segDist(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy || 1;
  const t = clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

export class Terrain {
  readonly nx: number;
  readonly ny: number;
  readonly x0: number;
  readonly y0: number;
  readonly spacing: number;
  readonly heights: Int16Array;
  readonly maxM: number;

  constructor(readonly spec: TerrainSpec, heights?: Int16Array) {
    const [xmin, ymin, xmax, ymax] = spec.bounds;
    this.spacing = spec.spacingM;
    this.x0 = xmin;
    this.y0 = ymin;
    this.nx = Math.floor((xmax - xmin) / spec.spacingM) + 1;
    this.ny = Math.floor((ymax - ymin) / spec.spacingM) + 1;
    this.heights = heights ?? Terrain.generate(spec, this.nx, this.ny);
    let m = 0;
    for (let i = 0; i < this.heights.length; i++) if (this.heights[i]! > m) m = this.heights[i]!;
    this.maxM = m;
  }

  static generate(spec: TerrainSpec, nx: number, ny: number): Int16Array {
    const out = new Int16Array(nx * ny);
    const [xmin, ymin] = spec.bounds;
    const s = spec.spacingM;
    const noiseScale = 1 / 6000;
    for (let j = 0; j < ny; j++) {
      const y = ymin + j * s;
      for (let i = 0; i < nx; i++) {
        const x = xmin + i * s;
        let h = spec.baseM + spec.roughnessM * fbm(x * noiseScale, y * noiseScale, spec.seed);
        for (const f of spec.features) h += featureHeight(f, x, y, spec.seed);
        out[j * nx + i] = Math.round(clamp(h, 0, 8000));
      }
    }
    return out;
  }

  private at(i: number, j: number): number {
    const ci = i < 0 ? 0 : i >= this.nx ? this.nx - 1 : i;
    const cj = j < 0 ? 0 : j >= this.ny ? this.ny - 1 : j;
    return this.heights[cj * this.nx + ci]!;
  }

  /** Terrain height (m MSL) at a point, bilinear; edge values continue outside the grid. */
  height(x: number, y: number): number {
    const gx = (x - this.x0) / this.spacing;
    const gy = (y - this.y0) / this.spacing;
    const i = Math.floor(gx), j = Math.floor(gy);
    const fx = gx - i, fy = gy - j;
    const a = this.at(i, j), b = this.at(i + 1, j), c = this.at(i, j + 1), d = this.at(i + 1, j + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  }

  /** True when the straight line from a to b clears terrain by `clearanceM`. */
  los(a: Vec3, b: Vec3, clearanceM = 0): boolean {
    const dx = b[0] - a[0], dy = b[1] - a[1], dz = b[2] - a[2];
    const len = Math.hypot(dx, dy);
    const steps = Math.max(2, Math.ceil(len / (this.spacing * 1.5)));
    for (let k = 1; k < steps; k++) {
      const t = k / steps;
      const z = a[2] + dz * t;
      if (z < this.maxM + clearanceM && this.height(a[0] + dx * t, a[1] + dy * t) + clearanceM > z) return false;
    }
    return true;
  }

  /** Terrain heights sampled along a ground line, for the masking profile and route checks. */
  profile(a: readonly number[], b: readonly number[], n: number): number[] {
    const out: number[] = [];
    for (let k = 0; k < n; k++) {
      const t = n === 1 ? 0 : k / (n - 1);
      out.push(this.height(a[0]! + (b[0]! - a[0]!) * t, a[1]! + (b[1]! - a[1]!) * t));
    }
    return out;
  }

  /** Lowest altitude (m MSL) at which a point at range r along a radial is visible from the site. */
  maskAltitude(site: Vec3, dirX: number, dirY: number, r: number): number {
    const steps = Math.max(4, Math.ceil(r / (this.spacing * 2)));
    let maxSlope = -Infinity;
    for (let k = 1; k < steps; k++) {
      const d = (r * k) / steps;
      const h = this.height(site[0] + dirX * d, site[1] + dirY * d);
      const slope = (h - site[2]) / d;
      if (slope > maxSlope) maxSlope = slope;
    }
    return Math.max(site[2] + maxSlope * r, this.height(site[0] + dirX * r, site[1] + dirY * r));
  }
}

function featureHeight(f: TerrainSpec['features'][number], x: number, y: number, seed: number): number {
  const wobble = 1 + 0.25 * valueNoise(x / 2500, y / 2500, seed + 7);
  switch (f.type) {
    case 'ridge':
    case 'valley': {
      if (!f.from || !f.to) return 0;
      const d = segDist(x, y, f.from[0], f.from[1], f.to[0], f.to[1]);
      const w = f.widthM ?? 3000;
      const h = f.heightM * Math.exp(-((d / w) ** 2)) * wobble;
      return f.type === 'ridge' ? h : -h;
    }
    case 'hill': {
      if (!f.at) return 0;
      const d = Math.hypot(x - f.at[0], y - f.at[1]);
      const r = f.radiusM ?? 2000;
      return f.heightM * Math.exp(-((d / r) ** 2)) * wobble;
    }
    case 'plateau': {
      if (!f.at) return 0;
      const d = Math.hypot(x - f.at[0], y - f.at[1]);
      const r = f.radiusM ?? 5000;
      const t = clamp((r - d) / (r * 0.3), 0, 1);
      return f.heightM * t * t * (3 - 2 * t);
    }
  }
}
