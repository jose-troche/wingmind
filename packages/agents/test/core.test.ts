import { describe, expect, it } from 'vitest';
import { Rng, type Advice, type Axis } from '@wingmind/shared';
import { Blackboard, Bus, ContractError, SAFETY, arbitrate, msg, threatScore, levelFor } from '../src';

describe('bus contracts', () => {
  it('rejects a write outside an agent contract', () => {
    const bus = new Bus();
    bus.begin(1, 1, 16);
    expect(() => bus.publish(msg('track.table', []), ['threat.missile'], 'MAWS')).toThrow(ContractError);
    expect(() => bus.publish(msg('threat.missile', {}), ['threat.missile'], 'MAWS')).not.toThrow();
  });

  it('supports topic wildcards in reads and writes', () => {
    const bus = new Bus();
    bus.begin(1, 1, 16);
    bus.publish(msg('intent.nav', { a: 1 }), ['intent.*'], 'NLU');
    bus.publish(msg('intent.ew', { a: 2 }), ['intent.*'], 'NLU');
    expect(bus.drain('ORCH', ['intent.*'])).toHaveLength(2);
    expect(bus.drain('ORCH', ['intent.*'])).toHaveLength(0);           // cursor advanced
  });

  it('delivers in-tick, by priority, and never back to the sender', () => {
    const bus = new Bus();
    bus.begin(1, 1, 16);
    bus.publish(msg('alert', { n: 'low' }, { priority: 6 }), ['alert'], 'TAP');
    bus.publish(msg('alert', { n: 'high' }, { priority: 0 }), ['alert'], 'MAWS');
    expect(bus.hasUrgent('PIA', ['alert'])).toBe(true);
    const got = bus.drain('PIA', ['alert']).map(m => (m.payload as { n: string }).n);
    expect(got).toEqual(['high', 'low']);
    expect(bus.drain('MAWS', ['alert'])).toHaveLength(1);              // only TAP's
  });

  it('counts per-pair traffic for the mesh visual', () => {
    const bus = new Bus();
    bus.begin(1, 1, 16);
    bus.publish(msg('alert', {}, { priority: 0 }), ['alert'], 'MAWS');
    bus.drain('PIA', ['alert']);
    expect(bus.takePairs()).toEqual([{ from: 'MAWS', to: 'PIA', count: 1, priority: 0 }]);
  });
});

describe('blackboard', () => {
  it('commits only the owner of a key and produces frozen versions', () => {
    const board = new Blackboard([]);
    const bus = new Bus();
    bus.begin(1, 1, 16);
    bus.publishSys('track.table', [{ id: 'X' }], { source: 'MAWS' });          // wrong owner
    bus.publish(msg('track.table', [{ id: 'T01' }]), ['track.table'], 'FUSE');
    const s = board.commit(bus.flush());
    expect(s.version).toBe(1);
    expect(s.tracks).toEqual([{ id: 'T01' }]);
    expect(Object.isFrozen(s)).toBe(true);
  });
});

describe('arbiter', () => {
  const axes: Axis[] = ['heading', 'altitude', 'speed', 'throttle', 'emitters', 'countermeasures'];
  const sources = ['NAV', 'MAWS', 'SIG', 'EW', 'SYS', 'pilot'];

  it('never lets lower-ranked advice beat higher-ranked advice on the same axis (property test)', () => {
    const rng = new Rng(7);
    for (let trial = 0; trial < 2000; trial++) {
      const advice: Advice[] = [];
      const n = 1 + Math.floor(rng.next() * 8);
      for (let i = 0; i < n; i++) {
        advice.push({
          id: `a${i}`, axis: axes[Math.floor(rng.next() * axes.length)]!, value: { v: i }, utility: rng.next(),
          safetyRank: 1 + Math.floor(rng.next() * 9), source: sources[Math.floor(rng.next() * sources.length)]!,
          evidence: ['e'], ttlMs: 1000, expiresAt: rng.next() < 0.9 ? 5000 : 10,
        });
      }
      const out = arbitrate(advice, { gMax: 9, gMin: -3, aoaMaxDeg: 26 }, 100);
      for (const d of out) {
        const live = advice.filter(a => a.axis === d.axis && a.expiresAt > 100);
        const best = Math.min(...live.map(a => a.safetyRank));
        const winner = live.find(a => (a.value as { v: number }).v === (d.value as { v: number }).v)!;
        expect(winner.safetyRank).toBe(best);
        expect(d.supersedes).toHaveLength(live.length - 1);
      }
      // one directive per axis with live advice
      expect(new Set(out.map(d => d.axis)).size).toBe(out.length);
    }
  });

  it('suppresses SIG behind MAWS and caps a break at the G limit', () => {
    const now = 0;
    const out = arbitrate([
      { id: 's', axis: 'heading', value: { mode: 'nose', headingDeg: 240 }, utility: 0.9, safetyRank: SAFETY.threat, source: 'SIG', evidence: [], ttlMs: 1000, expiresAt: 1000 },
      { id: 'm', axis: 'heading', value: { mode: 'break', headingDeg: 30, gCap: 9.5 }, utility: 1, safetyRank: SAFETY.missile, source: 'MAWS', evidence: [], ttlMs: 1000, expiresAt: 1000 },
    ], { gMax: 9, gMin: -3, aoaMaxDeg: 26 }, now);
    expect(out).toHaveLength(1);
    expect(out[0]!.why[0]).toContain('MAWS');
    expect(out[0]!.why.join(' ')).toContain('SIG suppressed');
    expect((out[0]!.value as { gCap: number }).gCap).toBe(9);
    expect(out[0]!.why.join(' ')).toContain('ENV capped');
  });

  it('pilot commands outrank agent advice except collision avoidance', () => {
    const base = { utility: 1, evidence: [], ttlMs: 1000, expiresAt: 1000 };
    const out = arbitrate([
      { ...base, id: 'p', axis: 'altitude', value: { altFt: 500 }, safetyRank: SAFETY.pilot, source: 'pilot' },
      { ...base, id: 'g', axis: 'altitude', value: { flyup: true }, safetyRank: SAFETY.groundCollision, source: 'NAV' },
      { ...base, id: 'h', axis: 'heading', value: { headingDeg: 90 }, safetyRank: SAFETY.pilot, source: 'pilot' },
      { ...base, id: 'm', axis: 'heading', value: { mode: 'beam' }, safetyRank: SAFETY.missile, source: 'MAWS' },
    ], { gMax: 9, gMin: -3, aoaMaxDeg: 26 }, 0);
    expect(out.find(d => d.axis === 'altitude')!.source).toBe('NAV');
    expect(out.find(d => d.axis === 'heading')!.source).toBe('pilot');
  });
});

describe('threat scoring', () => {
  it('follows L x P x min(1, 10/t) x C with hysteresis', () => {
    expect(threatScore({ lethality: 1, pEngage: 1, tActS: 5, confidence: 1 })).toBe(1);
    expect(threatScore({ lethality: 0.9, pEngage: 0.5, tActS: 20, confidence: 0.8 })).toBeCloseTo(0.18, 5);
    expect(levelFor(0.85, undefined)).toBe('WARNING');
    expect(levelFor(0.75, 'WARNING')).toBe('WARNING');
    expect(levelFor(0.75, 'CAUTION')).toBe('CAUTION');
    expect(levelFor(0.35, 'CAUTION')).toBe('CAUTION');
    expect(levelFor(0.25, 'CAUTION')).toBe('ADVISORY');
  });
});
