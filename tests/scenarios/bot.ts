import { readFileSync } from 'node:fs';
import { AgentRuntime } from '@wingmind/agents';
import type { Directive, Intent, Scenario, SimEvent, SortieOutcome, SpeakItem } from '@wingmind/shared';
import { World } from '@wingmind/sim-core';

// Headless scenario harness (implementation 10.1): the real World and the real
// AgentRuntime in one process, as fast as the CPU allows, with a scripted pilot.
// The attentive bot follows break cues and dispenses on missile calls; the
// inattentive bot flies the autopilot and ignores everything.

export type BotMode = 'attentive' | 'inattentive';

export interface RunResult {
  outcome: SortieOutcome | null;
  speak: SpeakItem[];
  directives: Directive[];
  events: SimEvent[];
  falseAlarmObs: number;
  launches: number;
  missileWarnings: number;
  minAglFt: number;
  seconds: number;
}

export const loadScenario = (id: string): Scenario =>
  JSON.parse(readFileSync(new URL(`../../apps/web/public/scenarios/${id}.json`, import.meta.url), 'utf8')) as Scenario;

export function runScenario(id: string, seed: number, mode: BotMode, seconds: number, tweak?: (s: Scenario) => Scenario): RunResult {
  let t = 0;
  const base = loadScenario(id);
  const sc = tweak ? tweak(base) : base;
  const world = new World(sc, seed, undefined, () => t);
  const rt = new AgentRuntime(sc, world.terrain);
  const speak: SpeakItem[] = [];
  const directives: Directive[] = [];
  let minAglFt = Infinity;
  let lastBreakHeading: number | null = null;
  const dispensedFor = new Set<string>();

  const apply = (ds: Directive[]) => { for (const d of ds) { directives.push(d); world.applyDirective(d); } };
  const pilot = (intent: Intent) => { const out = rt.onIntent(intent); speak.push(...out.speak); apply(out.directives); };

  const frames = Math.round(seconds * 60);
  for (let i = 0; i < frames; i++) {
    world.stepFrame();
    t += 1000 / 60;
    const out = rt.onFrame(world.snapshot());
    speak.push(...out.speak);
    apply(out.directives);
    minAglFt = Math.min(minAglFt, world.ownState().aglFt);
    if (mode === 'attentive') {
      for (const d of out.directives) {
        const v = (d.value ?? {}) as Record<string, unknown>;
        if (d.axis === 'heading' && v.mode === 'break' && typeof v.headingDeg === 'number' && v.headingDeg !== lastBreakHeading) {
          lastBreakHeading = v.headingDeg;
          pilot({ intent: 'nav.setHeading', params: { heading_deg: Math.round(v.headingDeg) }, confidence: 1, source: 'keyboard' });
        }
        if (d.axis === 'countermeasures' && d.source !== 'pilot' && d.threatId && !dispensedFor.has(d.threatId)) {
          dispensedFor.add(d.threatId);
          const kind = v.kind === 'flare' ? 'flare' : 'chaff';
          for (let k = 0; k < 3; k++) pilot({ intent: 'ew.dispense', params: { kind }, confidence: 1, source: 'keyboard' });
        }
        if (d.axis === 'emitters' && d.source !== 'pilot' && typeof v.emcon === 'number') {
          pilot({ intent: 'sig.setEmcon', params: { level: v.emcon }, confidence: 1, source: 'keyboard' });
        }
      }
      // keep dispensing every 2 s while a missile warning is active
      if (i % 120 === 0 && rt.board.current.ranked.some(th => th.class === 'radar_missile' || th.class === 'ir_missile')) {
        const ir = rt.board.current.ranked.some(th => th.class === 'ir_missile');
        pilot({ intent: 'ew.dispense', params: { kind: ir ? 'flare' : 'chaff' }, confidence: 1, source: 'keyboard' });
      }
    }
    if (world.outcome) break;
  }
  const truth = world.truth();
  return {
    outcome: world.outcome,
    speak,
    directives,
    events: world.events,
    falseAlarmObs: truth.falseAlarmObs.length,
    launches: world.events.filter(e => e.type === 'missile_launch').length,
    missileWarnings: speak.filter(s => (s.cls === 'radar_missile' || s.cls === 'ir_missile') && s.repeat === 0).length,
    minAglFt,
    seconds: t / 1000,
  };
}
