import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { FT, type Scenario } from '@wingmind/shared';
import { Engine, FuelSystem, Terrain, World, casFromTas, isa, tasFromCas } from '../src';

const load = (id: string): Scenario =>
  JSON.parse(readFileSync(new URL(`../../../apps/web/public/scenarios/${id}.json`, import.meta.url), 'utf8')) as Scenario;

let fakeT = 0;
const clock = () => fakeT;

describe('atmosphere', () => {
  it('matches ISA sea level and the tropopause', () => {
    const sl = isa(0);
    expect(sl.tK).toBeCloseTo(288.15, 2);
    expect(sl.rho).toBeCloseTo(1.225, 3);
    expect(sl.a).toBeCloseTo(340.3, 0);
    const tp = isa(11_000);
    expect(tp.tK).toBeCloseTo(216.65, 1);
    expect(tp.pPa).toBeCloseTo(22_632, -2);
  });
  it('round-trips calibrated and true airspeed', () => {
    const air = isa(6000);
    const tas = tasFromCas(200, air);
    expect(tas).toBeGreaterThan(200);
    expect(casFromTas(tas, air)).toBeCloseTo(200, 0);
  });
});

describe('terrain', () => {
  it('is deterministic from the seed and answers line-of-sight queries', () => {
    const spec = load('low-level-02').theater.terrain;
    const a = new Terrain(spec), b = new Terrain(spec);
    expect(a.height(1234, 5678)).toBe(b.height(1234, 5678));
    // the west ridge masks the valley floor from beyond it
    expect(a.los([-9000, 10_000, 200], [0, 10_000, 250])).toBe(false);
    expect(a.los([0, 0, 3000], [0, 20_000, 3000])).toBe(true);
  });
});

describe('flight model', () => {
  it('trimmed level flight holds altitude within 50 ft for 60 s', () => {
    fakeT = 0;
    const sc = load('fam-01');
    const w = new World({ ...sc, weather: { ...sc.weather, gustKt: 0, wind: [] }, triggers: [] }, 1, undefined, clock);
    const alt0 = w.ownState().altFt;
    let maxDev = 0;
    for (let i = 0; i < 60 * 60; i++) {
      w.stepFrame();
      if (i > 120) maxDev = Math.max(maxDev, Math.abs(w.ownState().altFt - alt0));
    }
    expect(maxDev).toBeLessThan(50);
    expect(w.outcome).toBeNull();
  });

  it('turns to a commanded heading with the autopilot', () => {
    fakeT = 0;
    const w = new World(load('fam-01'), 2, undefined, clock);
    w.applyDirective({ id: 'd', axis: 'heading', value: { headingDeg: 270 }, source: 'pilot', supersedes: [], why: [] });
    for (let i = 0; i < 600; i++) w.stepFrame();
    const h = w.ownState().headingDeg;
    expect(h).toBeGreaterThan(265);
    expect(h).toBeLessThan(280);
  });

  it('respects the G limit in a full aft-stick pull', () => {
    fakeT = 0;
    const w = new World(load('bvr-05'), 3, undefined, clock);
    w.setControls({ pitch: 1, roll: 0 });
    let gMax = 0;
    for (let i = 0; i < 180; i++) { w.stepFrame(); gMax = Math.max(gMax, w.ownState().g); }
    // lift-limited at this altitude and speed, but never beyond the 9 G law
    expect(gMax).toBeGreaterThan(4);
    expect(gMax).toBeLessThan(9.6);
  });
});

describe('engines and fuel', () => {
  it('burn matches the table flow', () => {
    const fuel = new FuelSystem(10_000);
    const flowPph = 7200;
    for (let i = 0; i < 600; i++) fuel.step(1, flowPph);               // 10 minutes
    expect(fuel.totalLb).toBeCloseTo(10_000 - flowPph / 6, 0);
  });

  it('spools to military and lights the afterburner in stages', () => {
    const e = new Engine('left', 0.3);
    const air = isa(3000);
    for (let i = 0; i < 600; i++) e.step(1 / 60, 0.85, 0.6, air, 3);
    expect(e.state.mode).toBe('military');
    expect(e.state.n2).toBeGreaterThan(95);
    const milFlow = e.state.fuelFlowPph;
    for (let i = 0; i < 300; i++) e.step(1 / 60, 1, 0.6, air, 3);
    expect(e.state.mode).toBe('afterburner');
    expect(e.state.abStage).toBe(5);
    expect(e.state.fuelFlowPph).toBeGreaterThan(2.5 * milFlow);
  });

  it('reports a fire and shuts down at throttle off', () => {
    const e = new Engine('right', 0.6);
    const air = isa(3000);
    e.injectFault('fire');
    const t1 = e.step(1 / 60, 0.6, 0.6, air, 3);
    expect(t1?.to).toBe('fire');
    const t2 = e.step(1 / 60, 0, 0.6, air, 3);
    expect(t2?.to).toBe('shutdown');
  });
});

describe('weapons', () => {
  it('an injected missile flies at the own ship and chaff can defeat it', () => {
    fakeT = 0;
    const w = new World(load('fam-01'), 4, undefined, clock);
    w.inject({ type: 'missile_launch', guidance: 'radar', bearingRelDeg: 90, rangeNm: 5 });
    expect(w.missiles).toHaveLength(1);
    const m = w.missiles[0]!;
    const r0 = Math.hypot(m.pos[0] - w.fm.s.pos[0], m.pos[1] - w.fm.s.pos[1]);
    for (let i = 0; i < 120; i++) w.stepFrame();
    const r1 = Math.hypot(m.pos[0] - w.fm.s.pos[0], m.pos[1] - w.fm.s.pos[1]);
    expect(r1).toBeLessThan(r0);
    for (let i = 0; i < 20; i++) w.dispense('chaff');
    expect(m.locked).toBe(false);
    expect(w.cm.chaff).toBe(40);
  });

  it('keeps own altitude in feet consistent with position', () => {
    fakeT = 0;
    const w = new World(load('sam-belt-01'), 5, undefined, clock);
    const o = w.ownState();
    expect(o.altFt).toBeCloseTo(o.pos[2] / FT, 3);
  });
});
