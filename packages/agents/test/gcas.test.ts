import { describe, expect, it } from 'vitest';
import { DEG, FT, Rng, qFromEuler, type TerrainSpec } from '@wingmind/shared';
import { FlightModel, Terrain, rollRateForBank } from '@wingmind/sim-core';
import { recoveryClearance } from '../src';

// Ground-collision projection never misses on 1,000 random terrain dives
// (implementation 10.1): fly the real 6-DOF model in a dive, start the
// automatic recovery the moment NAV's projection crosses its trigger, and check
// the aircraft never touches the ground.

const BUFFER_M = 150 * FT;

describe('ground collision projection', () => {
  const spec: TerrainSpec = {
    id: 'gcas', seed: 9, bounds: [-30000, -30000, 30000, 30000], spacingM: 128, baseM: 400, roughnessM: 300,
    features: [{ type: 'hill', at: [0, 8000], heightM: 900, radiusM: 4000 }, { type: 'ridge', from: [-20000, 15000], to: [20000, 15000], heightM: 700, widthM: 2500 }],
  };
  const terrain = new Terrain(spec);

  it('never misses on 1,000 random dives', { timeout: 120_000 }, () => {
    const rng = new Rng(1234);
    let impacts = 0;
    for (let run = 0; run < 1000; run++) {
      const x = rng.range(-15000, 15000), y = rng.range(-15000, 0);
      const heading = rng.range(0, 360);
      const dive = rng.range(5, 40);
      const bank = rng.range(-70, 70);
      const tas = rng.range(150, 300);
      const ground = terrain.height(x, y);
      const fm = new FlightModel([x, y, ground + rng.range(1200, 3500) * FT + 300], heading, tas, 20_000);
      fm.s.q = qFromEuler(heading, -dive + 2, bank);
      fm.s.vel = [Math.sin(heading * DEG) * Math.cos(dive * DEG) * tas, Math.cos(heading * DEG) * Math.cos(dive * DEG) * tas, -Math.sin(dive * DEG) * tas];
      let recovering = false;
      let minAgl = Infinity;
      for (let i = 0; i < 120 * 30; i++) {
        if (i % 2 === 0 && !recovering) {
          const e = fm.euler;
          if (recoveryClearance(terrain, fm.s.pos, fm.s.vel, e.rollDeg, 0) < BUFFER_M + 20) recovering = true;
        }
        const e = fm.euler;
        const cmd = recovering
          ? { nzCmd: Math.abs(e.rollDeg) < 45 ? 6 : 1, rollRateCmd: rollRateForBank(e.rollDeg, 0), thrustN: 160_000, speedbrake: false }
          : { nzCmd: 1, rollRateCmd: 0, thrustN: 60_000, speedbrake: false };
        fm.step(1 / 120, cmd);
        const agl = fm.s.pos[2] - terrain.height(fm.s.pos[0], fm.s.pos[1]);
        minAgl = Math.min(minAgl, agl);
        if (agl <= 0) { impacts++; break; }
        if (recovering && fm.s.vel[2] > 30 && agl > 300) break;
      }
      expect.soft(minAgl, `run ${run}`).toBeGreaterThan(0);
    }
    expect(impacts).toBe(0);
  });
});
