import {
  AIRFRAME, DEG, G0, RAD, clamp, cross, dot, eulerFromQ, interp1, norm, qFromEuler, qMul, qNorm,
  qRot, qRotInv, scale, sub, wrap180, type Quat, type Vec3,
} from '@wingmind/shared';
import aero from './data/aero.json';
import { isa, type AirData } from './atmosphere';

// Six-degree-of-freedom rigid body with quaternion attitude and RK4 integration
// (spec 3.1, implementation 5.6). Body frame is FLU (x forward, y left, z up),
// world frame is ENU. A fly-by-wire law turns stick into a G command and a roll
// rate; the pitch loop is a PI on G with a flight-path feedforward.

export interface BodyState { pos: Vec3; vel: Vec3; q: Quat; w: Vec3 }  // w = body rates (p, q, r) rad/s, FLU
export interface FlightCommand { nzCmd: number; rollRateCmd: number; thrustN: number; speedbrake: boolean }
export interface AeroOut { alphaDeg: number; betaDeg: number; mach: number; nz: number; tas: number; air: AirData; accel: Vec3 }

export class FlightModel {
  s: BodyState;
  massKg: number;
  private gInt = 0;
  private lastPathRate: Vec3 = [0, 0, 0];
  last: AeroOut;
  wind: Vec3 = [0, 0, 0];
  isaDeltaC = 0;
  /** Drag at the initial 1 g trim, so the sim can start with balanced thrust. */
  readonly trimDragN: number;

  constructor(pos: Vec3, headingDeg: number, tas: number, massKg: number) {
    this.massKg = massKg;
    const air = isa(pos[2]);
    // trim: angle of attack for 1 g at this speed
    const qbar = 0.5 * air.rho * tas * tas;
    const cl = (massKg * G0) / (qbar * AIRFRAME.wingAreaM2);
    const alpha = cl / interp1(aero.mach, aero.clAlphaPerDeg, tas / air.a);
    const mach = tas / air.a;
    this.trimDragN = qbar * AIRFRAME.wingAreaM2 * (interp1(aero.mach, aero.cd0, mach) + interp1(aero.mach, aero.k, mach) * cl * cl);
    const q = qFromEuler(headingDeg, alpha, 0);
    const fwd = qRot(qFromEuler(headingDeg, 0, 0), [1, 0, 0]);
    this.s = { pos: [...pos], vel: scale(fwd, tas), q, w: [0, 0, 0] };
    this.last = { alphaDeg: alpha, betaDeg: 0, mach: tas / air.a, nz: 1, tas, air, accel: [0, 0, 0] };
  }

  get euler() {
    return eulerFromQ(this.s.q);
  }

  /** Aerodynamic + thrust + gravity acceleration for a state (world frame). */
  private forces(st: BodyState, thrustN: number, speedbrake: boolean): AeroOut {
    const air = isa(st.pos[2], this.isaDeltaC);
    const vAir = sub(st.vel, this.wind);
    const tas = Math.max(norm(vAir), 1);
    const vb = qRotInv(st.q, vAir);
    const alpha = Math.atan2(-vb[2], vb[0]);
    const beta = Math.asin(clamp(vb[1] / tas, -1, 1));
    const mach = tas / air.a;
    const qbar = 0.5 * air.rho * tas * tas;
    const S = AIRFRAME.wingAreaM2;
    const alphaDeg = alpha * RAD;
    const clMax = interp1(aero.mach, aero.clMax, mach);
    let cl = interp1(aero.mach, aero.clAlphaPerDeg, mach) * alphaDeg;
    if (Math.abs(alphaDeg) > 28) cl = Math.sign(cl) * clMax * Math.max(0.5, 1 - (Math.abs(alphaDeg) - 28) / 30);
    cl = clamp(cl, -clMax * 0.6, clMax);
    const cd = interp1(aero.mach, aero.cd0, mach) + interp1(aero.mach, aero.k, mach) * cl * cl + (speedbrake ? aero.speedbrakeCd : 0);
    const lift = qbar * S * cl;
    const drag = qbar * S * cd;
    const side = qbar * S * aero.cyBeta * beta;
    const vbHat: Vec3 = [vb[0] / tas, vb[1] / tas, vb[2] / tas];
    const liftDir: Vec3 = [Math.sin(alpha), 0, Math.cos(alpha)];
    const fb: Vec3 = [
      liftDir[0] * lift - vbHat[0] * drag + thrustN,
      side - vbHat[1] * drag,
      liftDir[2] * lift - vbHat[2] * drag,
    ];
    const nz = fb[2] / (this.massKg * G0);
    const fw = qRot(st.q, fb);
    const accel: Vec3 = [fw[0] / this.massKg, fw[1] / this.massKg, fw[2] / this.massKg - G0];
    return { alphaDeg, betaDeg: beta * RAD, mach, nz, tas, air, accel };
  }

  /** Commanded body rates from the fly-by-wire law (held constant across the RK4 step). */
  private controlLaw(cmd: FlightCommand, dt: number): Vec3 {
    const { alphaDeg, nz, tas, betaDeg } = this.last;
    const e = this.euler;
    // G limits and an angle-of-attack limiter
    let nzCmd = clamp(cmd.nzCmd, AIRFRAME.gMin, AIRFRAME.gMax);
    const alphaMargin = AIRFRAME.aoaMaxDeg - alphaDeg;
    if (alphaMargin < 4 && nzCmd > nz) nzCmd = nz + Math.max(alphaMargin, -2) * 0.4;
    const gErr = nzCmd - nz;
    this.gInt = clamp(this.gInt + gErr * dt, -2, 2);
    const gravityNz = Math.cos(e.pitchDeg * DEG) * Math.cos(e.rollDeg * DEG);
    const pitchUp = (G0 * (nzCmd - gravityNz)) / Math.max(tas, 60) + 0.06 * gErr + 0.05 * this.gInt;
    const rollRate = clamp(cmd.rollRateCmd, -AIRFRAME.rollRateMaxDps * DEG, AIRFRAME.rollRateMaxDps * DEG);
    // coordinated yaw: follow the flight path's rotation about body z, damp sideslip
    const pathBody = qRotInv(this.s.q, this.lastPathRate);
    const yaw = pathBody[2] + 1.5 * betaDeg * DEG;
    // FLU: pitch-up is a negative rotation about +y (left)
    return [rollRate, -clamp(pitchUp, -0.6, 0.6), yaw];
  }

  step(dt: number, cmd: FlightCommand): AeroOut {
    const wCmd = this.controlLaw(cmd, dt);
    const tauP = 0.08, tauQ = 0.12, tauR = 0.15;
    const deriv = (st: BodyState): { dPos: Vec3; dVel: Vec3; dQ: Quat; dW: Vec3 } => {
      const f = this.forces(st, cmd.thrustN, cmd.speedbrake);
      const half = qMul(st.q, [0, st.w[0], st.w[1], st.w[2]]);
      return {
        dPos: st.vel,
        dVel: f.accel,
        dQ: [half[0] * 0.5, half[1] * 0.5, half[2] * 0.5, half[3] * 0.5],
        dW: [(wCmd[0] - st.w[0]) / tauP, (wCmd[1] - st.w[1]) / tauQ, (wCmd[2] - st.w[2]) / tauR],
      };
    };
    const addS = (st: BodyState, d: ReturnType<typeof deriv>, h: number): BodyState => ({
      pos: [st.pos[0] + d.dPos[0] * h, st.pos[1] + d.dPos[1] * h, st.pos[2] + d.dPos[2] * h],
      vel: [st.vel[0] + d.dVel[0] * h, st.vel[1] + d.dVel[1] * h, st.vel[2] + d.dVel[2] * h],
      q: [st.q[0] + d.dQ[0] * h, st.q[1] + d.dQ[1] * h, st.q[2] + d.dQ[2] * h, st.q[3] + d.dQ[3] * h],
      w: [st.w[0] + d.dW[0] * h, st.w[1] + d.dW[1] * h, st.w[2] + d.dW[2] * h],
    });
    const s0 = this.s;
    const k1 = deriv(s0);
    const k2 = deriv(addS(s0, k1, dt / 2));
    const k3 = deriv(addS(s0, k2, dt / 2));
    const k4 = deriv(addS(s0, k3, dt));
    const comb = <T extends number[]>(a: T, b: T, c: T, d: T): T => a.map((_, i) => (a[i]! + 2 * b[i]! + 2 * c[i]! + d[i]!) / 6) as T;
    const dPos = comb(k1.dPos, k2.dPos, k3.dPos, k4.dPos);
    const dVel = comb(k1.dVel, k2.dVel, k3.dVel, k4.dVel);
    const dQ = comb(k1.dQ, k2.dQ, k3.dQ, k4.dQ);
    const dW = comb(k1.dW, k2.dW, k3.dW, k4.dW);
    this.s = addS(s0, { dPos, dVel, dQ, dW }, dt);
    this.s.q = qNorm(this.s.q);
    this.last = this.forces(this.s, cmd.thrustN, cmd.speedbrake);
    // flight-path rotation rate for yaw coordination: (v x a) / |v|^2
    const v = sub(this.s.vel, this.wind);
    const v2 = Math.max(dot(v, v), 1);
    this.lastPathRate = scale(cross(v, this.last.accel), 1 / v2);
    return this.last;
  }
}

// ---------- autopilot and protection laws ----------

export interface ApTargets { heading?: number; altFt?: number; kcas?: number }

/** Bank-angle command to capture a heading. Positive bank is right wing down. */
export function bankForHeading(currentDeg: number, targetDeg: number, maxBankDeg: number, tas: number): number {
  // turn-rate loop (about a 2 s time constant) converted to the coordinated bank
  // for that rate, so the capture time does not grow with airspeed
  const err = wrap180(targetDeg - currentDeg);
  const rateDps = clamp(err * 0.5, -12, 12);
  return clamp(Math.atan((rateDps * DEG * Math.max(tas, 50)) / G0) / DEG, -maxBankDeg, maxBankDeg);
}

/** Roll-rate command (rad/s) to capture a bank angle. */
export const rollRateForBank = (rollDeg: number, bankCmdDeg: number): number =>
  clamp((bankCmdDeg - rollDeg) * 2.5, -180, 180) * DEG;

/** G command for altitude hold: vertical-speed loop with bank compensation. */
export function nzForAltitude(altFt: number, targetFt: number, vsFpm: number, rollDeg: number, tas: number): number {
  const vsCmd = clamp((targetFt - altFt) * 4, -8000, 8000);           // fpm
  const vsErr = (vsCmd - vsFpm) * 0.00508;                            // m/s
  const bank = clamp(Math.abs(rollDeg), 0, 75) * DEG;
  void tas;
  return clamp((1 + (0.45 * vsErr) / G0) / Math.cos(bank), -1.5, 6.5);
}
