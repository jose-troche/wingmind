import { clamp, interp1, lerp, type EngineFault, type EngineMode, type EngineState } from '@wingmind/shared';
import table from './data/engine.json';
import type { AirData } from './atmosphere';

const LBF = 4.44822;

export interface EngineTransition { side: 'left' | 'right'; from: EngineMode; to: EngineMode }

/**
 * One afterburning turbofan: spools follow first-order lags toward throttle demand,
 * thrust and flow come from tables, and an explicit state machine (spec section 8)
 * reports every transition so SYS can explain it.
 */
export class Engine {
  state: EngineState;
  private n2Frac = 0.85;           // 0 = idle, 1 = military
  private abFrac = 0;              // 0..1 across five stages
  private relightT = 0;

  constructor(side: 'left' | 'right', throttle: number) {
    this.n2Frac = throttleToCore(throttle);
    this.state = {
      side, mode: 'military', abStage: 0, n1: 0, n2: 0, titC: 0, oilPsi: 48, oilC: 85,
      nozzlePct: 30, fuelFlowPph: 0, thrustPct: 0, thrustN: 0, vibration: 0.4, fault: null,
    };
    this.updateOutputs(throttle, { mach: 0.7, air: null });
  }

  injectFault(kind: EngineFault): void {
    this.state.fault = kind;
  }

  /** Advance dt seconds; returns a transition when the mode changes. */
  step(dt: number, throttle: number, mach: number, air: AirData, aoaDeg: number): EngineTransition | null {
    const s = this.state;
    const before = s.mode;
    const dead = s.mode === 'flamedout' || s.mode === 'shutdown' || s.mode === 'fire' || s.mode === 'off';

    if (s.fault === 'fire' && s.mode !== 'fire' && s.mode !== 'shutdown') s.mode = 'fire';
    else if (s.fault === 'flameout' && !dead && s.mode !== 'relighting') s.mode = 'flamedout';
    else if (s.fault === 'compressor_stall' && s.mode !== 'stalled' && !dead) s.mode = 'stalled';
    if (aoaDeg > 32 && !dead && s.mode !== 'stalled') { s.mode = 'stalled'; s.fault = 'compressor_stall'; }

    if (s.mode === 'fire' && throttle < 0.02) s.mode = 'shutdown';
    if (s.mode === 'stalled') {
      // a stall clears when throttle is reduced and the inlet is clean
      if (throttle < 0.5 && aoaDeg < 20) { s.fault = null; s.mode = 'idle'; }
    }
    if (s.mode === 'flamedout' && throttle < 0.3 && air.pPa > 30_000) {
      s.mode = 'relighting';
      this.relightT = 0;
    }
    if (s.mode === 'relighting') {
      this.relightT += dt;
      if (this.relightT > 6) { s.fault = null; s.mode = 'idle'; }
    }

    const running = s.mode !== 'flamedout' && s.mode !== 'shutdown' && s.mode !== 'fire' && s.mode !== 'off';
    const stalled = s.mode === 'stalled';
    const coreDemand = running ? (stalled ? 0.3 : throttleToCore(throttle)) : s.mode === 'relighting' ? 0.1 : -0.6;
    const tau = coreDemand > this.n2Frac ? table.spoolTauS : table.spoolTauS * 0.7;
    this.n2Frac += (coreDemand - this.n2Frac) * (1 - Math.exp(-dt / tau));
    const abDemand = running && !stalled ? throttleToAb(throttle) : 0;
    this.abFrac += (abDemand - this.abFrac) * (1 - Math.exp(-dt / 0.6));

    if (running && !stalled) {
      if (this.abFrac > 0.02) s.mode = 'afterburner';
      else if (this.n2Frac > 0.92) s.mode = 'military';
      else s.mode = 'idle';
    }
    this.updateOutputs(throttle, { mach, air });
    return s.mode !== before ? { side: s.side, from: before, to: s.mode } : null;
  }

  private updateOutputs(throttle: number, env: { mach: number; air: AirData | null }): void {
    const s = this.state;
    const core = clamp(this.n2Frac, -0.6, 1);
    const running = s.mode !== 'flamedout' && s.mode !== 'shutdown' && s.mode !== 'fire' && s.mode !== 'off';
    const windmill = clamp(0.25 + env.mach * 0.2, 0, 0.45);
    const coreRel = running ? clamp(core, 0, 1) : 0;
    s.n2 = running ? lerp(table.n2Idle, table.n2Mil, coreRel) : 100 * windmill * (0.6 + 0.4 * clamp(core + 0.6, 0, 1));
    s.n1 = running ? lerp(table.n1Idle, table.n1Mil, coreRel) : s.n2 * 0.6;
    s.abStage = this.abFrac > 0.02 ? Math.min(5, 1 + Math.floor(this.abFrac * 5 - 1e-9)) : 0;
    const sigmaLapse = env.air ? Math.pow(env.air.sigma, table.lapseExp) : 1;
    const mil = interp1(table.mach, table.milThrustN, env.mach) * sigmaLapse;
    const ab = interp1(table.mach, table.abThrustN, env.mach) * sigmaLapse;
    const dry = running ? mil * lerp(table.idleFrac, 1, coreRel ** 1.6) : 0;
    s.thrustN = dry + (running ? (ab - mil) * this.abFrac : 0);
    s.thrustPct = (s.thrustN / Math.max(mil, 1)) * 100;
    const dryFlow = running ? Math.max(table.idleFlowPph, (dry / LBF) * table.tsfcDry) : 0;
    const abFlow = running ? (((ab - mil) * this.abFrac) / LBF) * table.tsfcAb : 0;
    s.fuelFlowPph = dryFlow + abFlow;
    s.titC = running ? lerp(table.titIdleC, table.titMilC, coreRel) + (table.titAbC - table.titMilC) * this.abFrac : 120 + 200 * windmill;
    if (s.mode === 'fire') s.titC = 1150;
    s.nozzlePct = running ? (this.abFrac > 0.02 ? 45 + 55 * this.abFrac : lerp(80, 20, coreRel)) : 100;
    s.oilPsi = s.fault === 'oil_pressure' ? 12 : running ? lerp(28, 55, coreRel) : 5;
    s.oilC = running ? lerp(70, 105, coreRel) : 40;
    s.vibration = s.mode === 'stalled' ? 2.8 : running ? 0.3 + 0.5 * coreRel : 0.1;
    void throttle;
  }
}

/** Steady-state dry throttle that makes `thrustN` per engine (used to trim at scenario start). */
export function throttleForThrust(thrustN: number, mach: number, air: AirData): number {
  const mil = interp1(table.mach, table.milThrustN, mach) * Math.pow(air.sigma, table.lapseExp);
  const frac = clamp((thrustN / Math.max(mil, 1) - table.idleFrac) / (1 - table.idleFrac), 0, 1);
  return clamp(Math.pow(frac, 1 / 1.6) * table.milThrottle, 0.02, table.milThrottle);
}

/** Throttle 0..0.85 maps idle..military; above that the afterburner lights in five stages. */
export const throttleToCore = (t: number): number => clamp(t / table.milThrottle, 0, 1);
export const throttleToAb = (t: number): number => clamp((t - table.milThrottle - 0.01) / (1 - table.milThrottle - 0.01), 0, 1);
export const MIL_THROTTLE = table.milThrottle;
