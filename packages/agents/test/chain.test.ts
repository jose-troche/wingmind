import { describe, expect, it } from 'vitest';
import type { Directive, SpeakItem } from '@wingmind/shared';
import { World } from '@wingmind/sim-core';
import { AgentRuntime } from '../src';
import { loadScenario } from './helpers';

// The worked example of spec 5.7, end to end in-process: plume and guidance
// emitter, MAWS warning, NAV beam check against rising terrain, ORCH directive
// with SIG suppressed and ENV's G cap, PIA's spoken alert.

function setup(id: string, seed = 42) {
  let t = 0;
  const sc = loadScenario(id);
  const world = new World(sc, seed, undefined, () => t);
  const rt = new AgentRuntime(sc, world.terrain);
  const speak: SpeakItem[] = [];
  const directives: Directive[] = [];
  const frame = (n: number) => {
    for (let i = 0; i < n; i++) {
      world.stepFrame();
      t += 1000 / 60;
      const out = rt.onFrame(world.snapshot());
      speak.push(...out.speak);
      directives.push(...out.directives);
      for (const d of out.directives) world.applyDirective(d);
    }
  };
  frame(1);
  return { world, rt, speak, directives, frame };
}

describe('missile launch at low altitude (spec 5.7)', () => {
  it('speaks the warning with a terrain-aware break within six frames', () => {
    const { world, speak, directives, frame } = setup('low-level-02');
    world.inject({ type: 'missile_launch', guidance: 'radar', bearingRelDeg: -120, rangeNm: 6 });
    frame(6);
    const warn = speak.find(s => s.cls === 'radar_missile');
    expect(warn?.text).toBe('Missile, left eight, six miles. Break right, chaff.');
    expect(warn?.level).toBe('WARNING');
    const heading = directives.find(d => d.axis === 'heading' && (d.value as Record<string, unknown>)?.mode === 'break');
    expect(heading?.why[0]).toContain('MAWS');
    expect(heading?.why.join(' ')).toContain('SIG suppressed');
    expect(heading?.why.join(' ')).toContain('left blocked');
    expect(heading?.why.join(' ')).toContain('ENV capped');
    expect(directives.some(d => d.axis === 'countermeasures' && (d.value as Record<string, unknown>)?.kind === 'chaff')).toBe(true);
  });

  it('calls an IR missile with flares first', () => {
    const { world, speak, frame } = setup('sam-belt-01');
    world.inject({ type: 'missile_launch', guidance: 'ir', bearingRelDeg: 110, rangeNm: 1.5 });
    frame(6);
    const warn = speak.find(s => s.cls === 'ir_missile');
    expect(warn?.text).toMatch(/^Missile, right four, close\. Flares, break (left|right)\.$/);
  });

  it('a pilot dispense command reaches the sim without a frame', () => {
    const { world, rt } = setup('fam-01');
    const out = rt.onIntent({ intent: 'ew.dispense', params: { kind: 'chaff' }, confidence: 1, source: 'grammar' });
    for (const d of out.directives) world.applyDirective(d);
    expect(world.cm.chaff).toBe(59);
  });

  it('reads back grammar commands through PIA', () => {
    const { rt } = setup('fam-01');
    const out = rt.onIntent({ intent: 'nav.setHeading', params: { heading_deg: 270 }, confidence: 1, source: 'grammar', readback: 'Heading two seven zero' });
    expect(out.speak.map(s => s.text)).toContain('Heading two seven zero');
    expect(out.directives.find(d => d.axis === 'heading')?.source).toBe('pilot');
  });

  it('refuses a descent below terrain clearance', () => {
    const { rt } = setup('low-level-02');
    const out = rt.onIntent({ intent: 'nav.setAltitude', params: { alt_ft: 200 }, confidence: 1, source: 'grammar' });
    expect(out.speak.map(s => s.text)).toContain('Unable, terrain.');
    expect(out.directives).toHaveLength(0);
  });

  it('de-duplicates a repeated advisory and stops warning repeats on "copy"', () => {
    const { world, rt, speak, frame } = setup('fam-01');
    world.inject({ type: 'force_alert', level: 'ADVISORY', text: 'Weather ahead, twenty miles.' });
    frame(2);
    world.inject({ type: 'force_alert', level: 'ADVISORY', text: 'Weather ahead, twenty miles.' });
    frame(2);
    expect(speak.filter(s => s.text === 'Weather ahead, twenty miles.')).toHaveLength(1);
    world.inject({ type: 'force_alert', level: 'WARNING', text: 'Test warning.' });
    frame(2);
    rt.onIntent({ intent: 'pia.ack', params: {}, confidence: 1, source: 'grammar' });
    frame(60 * 10);
    expect(speak.filter(s => s.text === 'Test warning.')).toHaveLength(1);
  });
});
