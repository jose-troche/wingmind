import type { Alert, BusMessage, Intent, Threat } from '@wingmind/shared';
import { SAFETY } from './arbiter';
import { advise, msg, type Agent, type EwState } from './core';

// EW: manual and semi-auto dispense (implementation 5.5). Semi-auto proposes a
// program the pilot consents to ("dispense"); auto executes on MAWS warnings.

export function createEw(): Agent {
  let state: EwState = { mode: 'semi', program: 1 };
  let handled = new Set<string>();
  let lastPublish = -1;

  return {
    id: 'EW', tier: 'R', rateHz: 20, budgetMs: 1,
    reads: ['threat.missile', 'threat.cleared', 'intent.ew'],
    writes: ['advice', 'alert', 'ew.state'],
    reset() { state = { mode: 'semi', program: 1 }; handled = new Set(); lastPublish = -1; },
    step(s, inbox) {
      const out: BusMessage<unknown>[] = [];
      let changed = false;
      for (const m of inbox) {
        if (m.topic === 'intent.ew') {
          const it = m.payload as Intent;
          if (it.intent === 'ew.setMode' && (it.params.mode === 'auto' || it.params.mode === 'semi' || it.params.mode === 'manual')) { state = { ...state, mode: it.params.mode }; changed = true; }
          if (it.intent === 'ew.program' && typeof it.params.program === 'number') { state = { ...state, program: it.params.program }; changed = true; }
          continue;
        }
        if (m.topic === 'threat.cleared') continue;
        const t = m.payload as Threat;
        if (handled.has(t.id) || t.confidence < 0.5) continue;
        handled.add(t.id);
        const radar = t.class === 'radar_missile';
        if (state.mode !== 'manual') {
          out.push(advise({
            axis: 'countermeasures', value: { kind: radar ? 'chaff' : 'flare', program: state.program, count: state.program >= 2 ? 2 : 1, seq: t.id },
            utility: 0.9, safetyRank: SAFETY.missile, source: 'EW', evidence: [t.id], ttlMs: 6000, threatId: t.id,
          }, 0));
        }
        if (radar && s.own.emcon < 3) {
          out.push(advise({
            axis: 'emitters', value: { emcon: 3 }, utility: 0.7, safetyRank: SAFETY.missile, source: 'EW',
            evidence: [t.id], ttlMs: 6000, threatId: t.id,
          }, 0));
        }
      }
      // inventory cautions (spec 7.4)
      const inv: [('chaff' | 'flare'), number][] = [['chaff', s.own.cm.chaff], ['flare', s.own.cm.flares]];
      for (const [kind, n] of inv) {
        const state2 = n === 0 ? 'out' : n <= 10 ? 'low' : null;
        if (!state2 || handled.has(`cm:${kind}:${state2}`)) continue;
        handled.add(`cm:${kind}:${state2}`);
        const al: Alert = {
          id: `al-cm-${kind}-${state2}`, level: 'CAUTION', cls: 'cm_low', text: '', terse: '',
          dedupKey: `cm:${kind}:${state2}`, ttlMs: 300_000, evidence: [], confidence: 1,
          slots: { kind: kind === 'chaff' ? 'chaff' : 'flares', state: state2 },
        };
        out.push(msg('alert', al, { priority: 3, ttlMs: 2000 }));
      }
      if (changed || s.tMs - lastPublish > 1000) {
        out.push(msg('ew.state', state, { priority: 8, ttlMs: 2000 }));
        lastPublish = s.tMs;
      }
      return out;
    },
  };
}
