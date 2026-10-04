// Illustrative, generic, parametric tables (spec section 1 non-goals): nothing here
// describes a real aircraft, radar or weapon. Sim truth and onboard agent knowledge
// both read these, as a real crew would carry a threat library.

import { interp1, wrap360 } from './math';

/** Own radar signature in dBsm by aspect (0 = nose-on), 36 bins of 10 degrees, symmetric. */
export const SIG_ASPECT_DBSM: readonly number[] = (() => {
  const half = [-28, -27, -25, -22, -18, -14, -10, -6, -2, 4, -2, -6, -10, -13, -15, -16, -17, -18, -19];
  // half covers 0..180 in 10 degree steps (19 values); mirror for 190..350
  const out: number[] = [];
  for (let i = 0; i < 36; i++) out.push(i <= 18 ? half[i]! : half[36 - i]!);
  return out;
})();

export const dbsmToM2 = (db: number): number => 10 ** (db / 10);

/** Own radar cross-section (m^2) seen from a sensor at the given aspect relative to the nose. */
export function ownRcsM2(aspectDeg: number, bayOpen = false): number {
  const a = wrap360(aspectDeg);
  const i = Math.floor(a / 10) % 36;
  const j = (i + 1) % 36;
  const t = (a - i * 10) / 10;
  const db = SIG_ASPECT_DBSM[i]! * (1 - t) + SIG_ASPECT_DBSM[j]! * t;
  return dbsmToM2(db + (bayOpen ? 8 : 0));
}

/** Detection range scales with the fourth root of signature (radar range equation). */
export const detectionRangeM = (r0M: number, rcsM2: number): number => r0M * Math.pow(Math.max(rcsM2, 1e-6), 0.25);

/** Own infrared intensity, relative units. Afterburner dominates, the tail is hottest. */
export function ownIrIntensity(throttle: number, mach: number, aspectDeg: number): number {
  const ab = throttle > 0.86 ? 4 + 8 * ((throttle - 0.86) / 0.14) : 0;
  const engine = 0.3 + throttle * 1.2 + ab;
  const tail = Math.abs(((wrap360(aspectDeg) + 180) % 360) - 180) / 180; // 0 nose, 1 tail
  const skin = 0.2 + mach * mach * 0.4;
  return skin + engine * (0.25 + 0.75 * tail * tail);
}

export interface RadarProfile {
  type: 'sam_long' | 'sam_short' | 'fighter' | 'ew_radar';
  r0M: number;           // detection range against a 1 m^2 target
  trackFrac: number;     // fraction of detection range at which it goes to track
  fovDeg: number;        // scan half-angle (360 for search radars)
}

export const RADARS: Record<string, RadarProfile> = {
  sam_long: { type: 'sam_long', r0M: 160_000, trackFrac: 0.8, fovDeg: 360 },
  fighter_gen4: { type: 'fighter', r0M: 110_000, trackFrac: 0.85, fovDeg: 60 },
  ew_radar: { type: 'ew_radar', r0M: 250_000, trackFrac: 1, fovDeg: 360 },
};

export interface WeaponProfile {
  guidance: 'radar' | 'ir';
  rMaxByAltFt: { altFt: number[]; rMaxM: number[]; rNoEscM: number[] };
  boostS: number; sustainS: number; boostAccel: number; sustainAccel: number;
  maxG: number; navConst: number; gimbalDeg: number; maxTimeS: number; fuzeM: number;
  cmSusceptibility: number;   // base chance per decoy to break lock
  lethality: number;
}

export const WEAPONS: Record<string, WeaponProfile> = {
  aam_radar: {
    guidance: 'radar',
    rMaxByAltFt: { altFt: [0, 10000, 20000, 30000, 40000], rMaxM: [25_000, 35_000, 48_000, 62_000, 75_000], rNoEscM: [8_000, 11_000, 15_000, 19_000, 23_000] },
    boostS: 3, sustainS: 6, boostAccel: 220, sustainAccel: 40, maxG: 35, navConst: 4, gimbalDeg: 60, maxTimeS: 70, fuzeM: 25,
    cmSusceptibility: 0.18, lethality: 0.9,
  },
  sam_radar: {
    guidance: 'radar',
    rMaxByAltFt: { altFt: [0, 5000, 20000, 40000, 60000], rMaxM: [20_000, 45_000, 70_000, 75_000, 60_000], rNoEscM: [6_000, 15_000, 25_000, 28_000, 20_000] },
    boostS: 4, sustainS: 8, boostAccel: 200, sustainAccel: 45, maxG: 30, navConst: 3.5, gimbalDeg: 70, maxTimeS: 80, fuzeM: 30,
    cmSusceptibility: 0.15, lethality: 1,
  },
  sam_ir: {
    guidance: 'ir',
    rMaxByAltFt: { altFt: [0, 5000, 10000, 15000], rMaxM: [5_500, 5_000, 3_500, 0], rNoEscM: [2_500, 2_000, 1_000, 0] },
    boostS: 2, sustainS: 2, boostAccel: 250, sustainAccel: 30, maxG: 25, navConst: 4, gimbalDeg: 40, maxTimeS: 15, fuzeM: 12,
    cmSusceptibility: 0.3, lethality: 0.8,
  },
};

export function weaponEnvelope(w: WeaponProfile, altFt: number): { rMaxM: number; rNoEscapeM: number } {
  return {
    rMaxM: interp1(w.rMaxByAltFt.altFt, w.rMaxByAltFt.rMaxM, altFt),
    rNoEscapeM: interp1(w.rMaxByAltFt.altFt, w.rMaxByAltFt.rNoEscM, altFt),
  };
}

export const THREAT_LETHALITY: Record<string, number> = {
  radar_missile: 1, ir_missile: 1, fighter: 0.85, sam: 0.9, shorad: 0.7, gun: 0.5, drone: 0.3, swarm: 0.45, radar: 0.2,
};

/** Generic aircraft constants for the own ship. */
export const AIRFRAME = {
  wingAreaM2: 42,
  emptyMassKg: 14_500,
  storesKg: 1_200,
  gMax: 9,
  gMin: -3,
  aoaMaxDeg: 26,
  rollRateMaxDps: 240,
};
