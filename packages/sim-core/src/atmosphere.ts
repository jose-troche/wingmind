import { DEG, FT, KT, Rng, clamp, interp1, type Scenario, type Vec3 } from '@wingmind/shared';

const R = 287.053;
const GAMMA = 1.4;
export const RHO0 = 1.225;
const T0 = 288.15;
const P0 = 101_325;

export interface AirData { tK: number; pPa: number; rho: number; a: number; sigma: number }

/** ISA 1976 to 20 km, with a scenario temperature offset (hot or cold day). */
export function isa(altM: number, deltaC = 0): AirData {
  const h = clamp(altM, -500, 20_000);
  let tStd: number, p: number;
  if (h <= 11_000) {
    tStd = T0 - 0.0065 * h;
    p = P0 * Math.pow(tStd / T0, 5.255877);
  } else {
    tStd = 216.65;
    p = 22_632.06 * Math.exp(-(h - 11_000) / 6341.62);
  }
  const tK = tStd + deltaC;
  const rho = p / (R * tK);
  return { tK, pPa: p, rho, a: Math.sqrt(GAMMA * R * tK), sigma: rho / RHO0 };
}

/** Calibrated airspeed (m/s) from true airspeed via impact pressure (subsonic formula, adequate for display). */
export function casFromTas(tas: number, air: AirData): number {
  const mach = tas / air.a;
  const qc = air.pPa * (Math.pow(1 + 0.2 * mach * mach, 3.5) - 1);
  return Math.sqrt(5 * (P0 / RHO0) * (Math.pow(qc / P0 + 1, 2 / 7) - 1));
}

export function tasFromCas(cas: number, air: AirData): number {
  let tas = cas / Math.sqrt(air.sigma);
  for (let i = 0; i < 6; i++) tas *= cas / Math.max(casFromTas(tas, air), 1);
  return tas;
}

/** Layered wind with a filtered-noise gust component (a light Dryden stand-in) and shear near the ground. */
export class Weather {
  private gust: Vec3 = [0, 0, 0];
  private rng: Rng;
  constructor(readonly spec: Scenario['weather'], seed: number) {
    this.rng = new Rng(seed ^ 0x5eed);
  }

  /** Steady wind vector (m/s, ENU; the direction the air moves toward) at an altitude. */
  steady(altM: number, aglM: number): Vec3 {
    const layers = this.spec.wind;
    if (layers.length === 0) return [0, 0, 0];
    const altFt = altM / FT;
    const alts = layers.map(l => l.altFt);
    const kt = interp1(alts, layers.map(l => l.kt), altFt);
    // interpolate direction through the shortest arc
    const dirs = layers.map(l => l.dirDeg);
    const dir = interp1(alts, dirs, altFt);
    const shear = clamp(aglM / 300, 0.3, 1);         // log-ish boundary layer
    const toward = (dir + 180) * DEG;                 // "from" direction -> toward
    const v = kt * KT * shear;
    return [Math.sin(toward) * v, Math.cos(toward) * v, 0];
  }

  /** Advance gusts by dt seconds and return the total wind. */
  step(dt: number, altM: number, aglM: number): Vec3 {
    const sigma = this.spec.gustKt * KT * clamp(1 - altM / 12_000, 0.2, 1);
    const tau = 2.5;
    const a = Math.exp(-dt / tau);
    const b = sigma * Math.sqrt(1 - a * a);
    this.gust = [
      a * this.gust[0] + b * this.rng.gauss(),
      a * this.gust[1] + b * this.rng.gauss(),
      a * this.gust[2] + b * 0.5 * this.rng.gauss(),
    ];
    const w = this.steady(altM, aglM);
    return [w[0] + this.gust[0], w[1] + this.gust[1], w[2] + this.gust[2]];
  }

  /** Fraction of IR/visual energy left after crossing cloud layers between two altitudes. */
  cloudTransmission(altA_M: number, altB_M: number): number {
    const lo = Math.min(altA_M, altB_M) / FT;
    const hi = Math.max(altA_M, altB_M) / FT;
    let t = 1;
    for (const c of this.spec.clouds) {
      const overlap = Math.max(0, Math.min(hi, c.topFt) - Math.max(lo, c.baseFt));
      const inside = (altA_M / FT > c.baseFt && altA_M / FT < c.topFt) || (altB_M / FT > c.baseFt && altB_M / FT < c.topFt);
      if (overlap > 0 || inside) t *= 1 - c.cover * clamp(overlap / 3000 + (inside ? 0.5 : 0), 0, 0.95);
    }
    return t;
  }
}
