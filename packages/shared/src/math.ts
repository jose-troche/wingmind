import type { Quat, Vec3 } from './types';

export const DEG = Math.PI / 180;
export const RAD = 180 / Math.PI;
export const G0 = 9.80665;
export const FT = 0.3048;
export const NM = 1852;
export const KT = 0.514444;
export const LB = 0.45359237;

export const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;
export const wrap360 = (d: number): number => ((d % 360) + 360) % 360;
export const wrap180 = (d: number): number => {
  const w = wrap360(d);
  return w > 180 ? w - 360 : w;
};
/** Smallest absolute difference between two angles in degrees. */
export const angleDiff = (a: number, b: number): number => Math.abs(wrap180(a - b));

export const add = (a: Vec3, b: Vec3): Vec3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: Vec3, s: number): Vec3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: Vec3, b: Vec3): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: Vec3, b: Vec3): Vec3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const norm = (a: Vec3): number => Math.hypot(a[0], a[1], a[2]);
export const unit = (a: Vec3): Vec3 => {
  const n = norm(a);
  return n > 1e-9 ? [a[0] / n, a[1] / n, a[2] / n] : [0, 0, 0];
};
export const dist2d = (a: readonly number[], b: readonly number[]): number =>
  Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0));

/** Bearing in degrees true from a to b (ENU: x east, y north). */
export const bearingTo = (a: readonly number[], b: readonly number[]): number =>
  wrap360(Math.atan2((b[0] ?? 0) - (a[0] ?? 0), (b[1] ?? 0) - (a[1] ?? 0)) * RAD);

/** Unit vector on the ground plane for a true bearing. */
export const bearingVec = (deg: number): [number, number] => [Math.sin(deg * DEG), Math.cos(deg * DEG)];

// ---------- quaternions (w, x, y, z), body FLU -> world ENU ----------

export const qMul = (a: Quat, b: Quat): Quat => [
  a[0] * b[0] - a[1] * b[1] - a[2] * b[2] - a[3] * b[3],
  a[0] * b[1] + a[1] * b[0] + a[2] * b[3] - a[3] * b[2],
  a[0] * b[2] - a[1] * b[3] + a[2] * b[0] + a[3] * b[1],
  a[0] * b[3] + a[1] * b[2] - a[2] * b[1] + a[3] * b[0],
];
export const qConj = (q: Quat): Quat => [q[0], -q[1], -q[2], -q[3]];
export const qNorm = (q: Quat): Quat => {
  const n = Math.hypot(q[0], q[1], q[2], q[3]) || 1;
  return [q[0] / n, q[1] / n, q[2] / n, q[3] / n];
};
/** Rotate a body vector into the world frame. */
export const qRot = (q: Quat, v: Vec3): Vec3 => {
  const p = qMul(qMul(q, [0, v[0], v[1], v[2]]), qConj(q));
  return [p[1], p[2], p[3]];
};
/** Rotate a world vector into the body frame. */
export const qRotInv = (q: Quat, v: Vec3): Vec3 => qRot(qConj(q), v);

/**
 * Build the body->world quaternion from heading (deg true), pitch (deg up) and roll (deg right wing down).
 * Body frame is FLU: x forward, y left, z up. World is ENU.
 */
export function qFromEuler(headingDeg: number, pitchDeg: number, rollDeg: number): Quat {
  // yaw about world z: body x points north at heading 0, so yaw angle = 90 - heading
  const yaw = (90 - headingDeg) * DEG;
  const pitch = -pitchDeg * DEG; // FLU: positive rotation about y (left) pitches the nose down
  const roll = rollDeg * DEG;    // positive rotation about x (forward) lowers the right wing
  const qz: Quat = [Math.cos(yaw / 2), 0, 0, Math.sin(yaw / 2)];
  const qy: Quat = [Math.cos(pitch / 2), 0, Math.sin(pitch / 2), 0];
  const qx: Quat = [Math.cos(roll / 2), Math.sin(roll / 2), 0, 0];
  return qNorm(qMul(qMul(qz, qy), qx));
}

/** Heading, pitch and roll in degrees from a body->world quaternion. */
export function eulerFromQ(q: Quat): { headingDeg: number; pitchDeg: number; rollDeg: number } {
  const fwd = qRot(q, [1, 0, 0]);
  const left = qRot(q, [0, 1, 0]);
  const up = qRot(q, [0, 0, 1]);
  const headingDeg = wrap360(Math.atan2(fwd[0], fwd[1]) * RAD);
  const pitchDeg = Math.asin(clamp(fwd[2], -1, 1)) * RAD;
  // roll: angle of the wing line about the forward axis; right wing down is positive
  const rollDeg = Math.atan2(left[2], up[2]) * RAD;
  return { headingDeg, pitchDeg, rollDeg };
}

// ---------- tables ----------

/** Piecewise-linear interpolation over sorted breakpoints. */
export function interp1(xs: readonly number[], ys: readonly number[], x: number): number {
  const n = xs.length;
  if (n === 0) return 0;
  if (x <= xs[0]!) return ys[0]!;
  if (x >= xs[n - 1]!) return ys[n - 1]!;
  let i = 1;
  while (xs[i]! < x) i++;
  const x0 = xs[i - 1]!, x1 = xs[i]!;
  return lerp(ys[i - 1]!, ys[i]!, (x - x0) / (x1 - x0));
}

/** Bilinear interpolation on a row-major table indexed [row(x)][col(y)]. */
export function interp2(xs: readonly number[], ys: readonly number[], table: readonly (readonly number[])[], x: number, y: number): number {
  const row = (r: readonly number[]) => interp1(ys, r, y);
  const vals = table.map(row);
  return interp1(xs, vals, x);
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[idx]!;
}

export function groupBy<T, K extends string>(items: readonly T[], key: (t: T) => K): Record<K, T[]> {
  const out = {} as Record<K, T[]>;
  for (const it of items) (out[key(it)] ??= []).push(it);
  return out;
}

let uidCounter = 0;
export const uid = (prefix = 'id'): string => `${prefix}-${(++uidCounter).toString(36)}`;
export const resetUid = (): void => { uidCounter = 0; };
