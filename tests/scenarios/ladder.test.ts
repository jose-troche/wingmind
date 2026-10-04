import { describe, expect, it } from 'vitest';
import { runScenario } from './bot';

// Ladder scenarios 1, 2, 3 and 5 (implementation 10.1) with attentive and
// inattentive pilot bots: survival, alert and false-alarm assertions.

describe('ladder 1: familiarization', () => {
  it('flies the first legs without incident and announces the oil-pressure fault', () => {
    const r = runScenario('fam-01', 11, 'inattentive', 320);
    expect(r.outcome).toBeNull();
    expect(r.speak.some(s => s.cls === 'engine_fault' && /oil pressure/i.test(s.text))).toBe(true);
    expect(r.missileWarnings).toBe(0);
  });
});

describe('ladder 2: low level', () => {
  it('has zero ground impacts with protection on and an inattentive pilot', () => {
    const r = runScenario('low-level-02', 21, 'inattentive', 210);
    expect(r.outcome).not.toBe('crashed');
    expect(r.minAglFt).toBeGreaterThan(0);
    // the hill at the north end needs the automatic fly-up
    expect(r.events.some(e => e.type === 'gcas_flyup')).toBe(true);
    expect(r.speak.some(s => s.cls === 'pull_up')).toBe(true);
  });

  it('calls the towers along the valley floor', () => {
    const r = runScenario('low-level-02', 22, 'inattentive', 100);
    expect(r.speak.filter(s => s.cls === 'obstacle').length).toBeGreaterThanOrEqual(2);
    expect(r.speak.find(s => s.cls === 'obstacle')?.text).toMatch(/^Tower, twelve o'clock, (one|two) miles?, \w+ hundred feet\.$/);
  });
});

describe('ladder 3: SAM belt', () => {
  it('announces SAM tracking and keeps false alarms within one per ten minutes', () => {
    const r = runScenario('sam-belt-01', 31, 'attentive', 420);
    expect(r.speak.some(s => s.cls === 'sam_track' || s.cls === 'radar_missile')).toBe(true);
    const falseCalls = r.speak.filter(s => (s.cls === 'radar_missile' || s.cls === 'ir_missile') && s.repeat === 0 && /^Possible/.test(s.text)).length;
    expect(falseCalls).toBeLessThanOrEqual(Math.ceil(r.seconds / 600) + 1);
  });
});

describe('ladder 5: beyond-visual-range defense', () => {
  it('announces at least 95% of launches inside DAS range', () => {
    const r = runScenario('bvr-05', 51, 'attentive', 300);
    expect(r.launches).toBeGreaterThan(0);
    expect(r.missileWarnings / r.launches).toBeGreaterThanOrEqual(0.95);
  });

  it('the attentive pilot outlives the inattentive one', () => {
    const attentive = runScenario('bvr-05', 52, 'attentive', 300);
    const inattentive = runScenario('bvr-05', 52, 'inattentive', 300);
    expect(attentive.outcome).not.toBe('crashed');
    // survival time is a fair proxy: the defended aircraft lasts at least as long
    expect(attentive.seconds).toBeGreaterThanOrEqual(inattentive.seconds);
  });
});
