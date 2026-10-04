import { clamp, type FuelState, type TankState } from '@wingmind/shared';

/**
 * Three internal tanks. Engines feed from the forward fuselage tank; wings transfer
 * to the aft tank and the aft tank tops up the feed tank, keeping CG in limits.
 */
export class FuelSystem {
  tanks: TankState[];
  bingoLb = 4000;
  jokerLb = 6000;
  private leakPph = 0;

  constructor(totalLb: number) {
    const caps = { fwd: 5000, aft: 6500, wing: 7500 };
    const fwd = Math.min(caps.fwd, totalLb);
    const aft = Math.min(caps.aft, totalLb - fwd);
    const wing = Math.max(0, Math.min(caps.wing, totalLb - fwd - aft));
    this.tanks = [
      { id: 'fwd', lb: fwd, capacityLb: caps.fwd, armM: 7.2 },
      { id: 'aft', lb: aft, capacityLb: caps.aft, armM: 9.4 },
      { id: 'wing', lb: wing, capacityLb: caps.wing, armM: 8.6 },
    ];
  }

  get totalLb(): number {
    return this.tanks.reduce((s, t) => s + t.lb, 0);
  }

  setLeak(pph: number): void {
    this.leakPph = pph;
  }

  /** Burn `flowPph` for dt seconds; returns false when the feed tank is dry. */
  step(dt: number, flowPph: number): boolean {
    const [fwd, aft, wing] = this.tanks as [TankState, TankState, TankState];
    const burn = ((flowPph + this.leakPph) * dt) / 3600;
    fwd.lb = Math.max(0, fwd.lb - burn);
    // transfer: wing -> aft -> fwd, up to 30,000 lb/h each
    const xfer = (30_000 * dt) / 3600;
    const toFwd = Math.min(xfer, aft.lb, fwd.capacityLb - fwd.lb);
    aft.lb -= toFwd; fwd.lb += toFwd;
    const toAft = Math.min(xfer, wing.lb, aft.capacityLb - aft.lb);
    wing.lb -= toAft; aft.lb += toAft;
    return fwd.lb > 0;
  }

  /** CG in percent mean aerodynamic chord, illustrative mapping of tank moments. */
  cgPctMac(emptyMassLb: number): number {
    const emptyArm = 8.3;
    let m = emptyMassLb, mom = emptyMassLb * emptyArm;
    for (const t of this.tanks) { m += t.lb; mom += t.lb * t.armM; }
    const arm = mom / m;
    return clamp(25 + (arm - 8.3) * 40, 10, 45);
  }

  state(flowPph: number, emptyMassLb: number): FuelState {
    return {
      tanks: this.tanks.map(t => ({ ...t })),
      totalLb: this.totalLb,
      flowPph,
      cgPctMac: this.cgPctMac(emptyMassLb),
      bingoLb: this.bingoLb,
      jokerLb: this.jokerLb,
    };
  }
}
