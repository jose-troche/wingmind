import { wrap180, wrap360, type Advice, type BusMessage, type Directive, type Intent, type Phase } from '@wingmind/shared';
import { SAFETY, arbitrate, clampToEnvelope } from './arbiter';
import { msg, type Agent, type BeamEval, type EnvelopeLimits, type Snapshot } from './core';

// ORCH: arbiter plus the phase rate plan (implementation 5.5, spec 5.4-5.6).
// It alone turns advice into directives, and pilot intents into pilot-sourced
// advice that outranks everything except collision avoidance.

export const RATE_PLANS: Record<Phase, Record<string, number>> = {
  cruise: { MAWS: 20, TAP: 10, NAV: 20, SYS: 10 },
  combat: { MAWS: 50, SYS: 50, TAP: 20, NAV: 20 },
  lowlevel: { MAWS: 50, NAV: 50, TAP: 10, SYS: 20 },
};

function pilotAdvice(it: Intent, s: Snapshot): Omit<Advice, 'id' | 'expiresAt'>[] {
  const base = { utility: 1, safetyRank: SAFETY.pilot, source: 'pilot', evidence: [`intent:${it.intent}`], ttlMs: 2000 };
  const p = it.params;
  const seq = `${s.tick}-${Math.random().toString(36).slice(2, 7)}`;
  switch (it.intent) {
    case 'nav.setHeading':
      return [{ ...base, axis: 'heading', value: { headingDeg: p.heading_deg, turn: p.turn ?? 'shortest', mode: 'pilot', seq } }];
    case 'nav.setAltitude':
      return [{ ...base, axis: 'altitude', value: { altFt: p.alt_ft, seq } }];
    case 'nav.holdAltitude':
      return [{ ...base, axis: 'altitude', value: { altFt: Math.round(s.own.altFt / 100) * 100, seq } }];
    case 'nav.setSpeed':
      return [{ ...base, axis: 'speed', value: { kcas: p.kcas, seq } }];
    case 'sig.setEmcon':
      return [{ ...base, axis: 'emitters', value: { emcon: p.level, seq } }];
    case 'ew.dispense': {
      const kind = p.kind;
      if (kind === 'both') return [{ ...base, axis: 'countermeasures', value: { kind: 'both', count: 1, seq } }];
      if (kind === 'program') {
        const prog = s.ew.program;
        return [{ ...base, axis: 'countermeasures', value: { kind: 'program', program: prog, count: prog >= 2 ? 2 : 1, seq } }];
      }
      return [{ ...base, axis: 'countermeasures', value: { kind: kind === 'flare' ? 'flare' : 'chaff', count: 1, seq } }];
    }
    case 'prot.gcas':
      return [{ ...base, axis: 'altitude', value: { gcasAuto: p.auto, seq } }];
    default:
      return [];
  }
}

const sameValue = (a: Directive | undefined, b: Directive): boolean =>
  !!a && a.source === b.source && JSON.stringify(a.value) === JSON.stringify(b.value);

export function createOrch(): Agent {
  let pool = new Map<string, Advice>();
  let current = new Map<string, Directive>();
  let beams = new Map<string, BeamEval>();
  let limits: EnvelopeLimits = { gMax: 9, gMin: -3, aoaMaxDeg: 26 };
  let phase: Phase = 'cruise';
  let lastCombatMs = -Infinity;
  let lastPhasePublish = -1;

  return {
    id: 'ORCH', tier: 'T', rateHz: 5, budgetMs: 2,
    reads: ['advice', 'intent.nav', 'intent.ew', 'intent.sig', 'intent.prot', 'nav.beam', 'env.limits', 'threat.missile', 'threat.cleared'],
    writes: ['directive', 'orch.phase', 'orch.rates', 'orch.cue'],
    reset() { pool = new Map(); current = new Map(); beams = new Map(); phase = 'cruise'; lastCombatMs = -Infinity; lastPhasePublish = -1; },
    step(s, inbox) {
      const out: BusMessage<unknown>[] = [];
      for (const m of inbox) {
        switch (m.topic) {
          case 'advice': {
            const a = m.payload as Advice;
            pool.set(a.id, a);
            break;
          }
          case 'nav.beam': {
            const b = m.payload as BeamEval;
            beams.set(b.threatId, b);
            break;
          }
          case 'env.limits':
            limits = m.payload as EnvelopeLimits;
            break;
          case 'threat.missile':
            lastCombatMs = s.tMs;
            break;
          case 'threat.cleared': {
            const id = (m.payload as { threatId: string }).threatId;
            for (const [k, a] of pool) if (a.threatId === id) pool.delete(k);
            beams.delete(id);
            break;
          }
          default: {
            if (!m.topic.startsWith('intent.')) break;
            const it = m.payload as Intent;
            for (const a of pilotAdvice(it, s)) {
              const id = `pilot-${m.id}-${a.axis}`;
              pool.set(id, { ...a, id, expiresAt: s.tMs + a.ttlMs });
            }
          }
        }
      }
      for (const [k, a] of pool) if (a.expiresAt <= s.tMs) pool.delete(k);

      const directives = arbitrate([...pool.values()], limits, s.tMs).map(d => clampToEnvelope(resolve(d, s, beams), limits));
      const axes = new Set(directives.map(d => d.axis));
      for (const d of directives) {
        if (sameValue(current.get(d.axis), d)) continue;
        const executes = d.source === 'pilot' || (d.source === 'NAV' && (d.value as Record<string, unknown>)?.flyup === true) ||
          (d.source === 'EW' && s.ew.mode === 'auto');
        const full: Directive = { ...d, tMs: s.tMs, ...(executes ? { execute: true } : {}) };
        current.set(d.axis, full);
        out.push(msg('directive', full, { priority: d.source === 'pilot' || executes ? 0 : 2, ttlMs: 10_000, evidence: d.evidence ?? [] }));
      }
      for (const [axis, d] of current) {
        if (axes.has(d.axis)) continue;
        current.delete(axis);
        out.push(msg('directive', { ...d, value: null, why: ['expired'] }, { priority: 5, ttlMs: 2000 }));
      }

      // cue for the HUD
      const head = current.get('heading');
      const alt = current.get('altitude');
      const hv = (head?.value ?? {}) as Record<string, unknown>;
      const cue = (alt?.value as Record<string, unknown> | undefined)?.flyup
        ? { kind: 'pullup' as const }
        : head && hv.mode === 'break'
          ? { kind: 'break' as const, headingDeg: Number(hv.headingDeg), side: hv.side as 'left' | 'right' }
          : head && typeof hv.headingDeg === 'number'
            ? { kind: 'steer' as const, headingDeg: hv.headingDeg }
            : { kind: null };
      out.push(msg('orch.cue', cue, { priority: 3, ttlMs: 1000 }));

      // phase-aware rate plan
      const next: Phase = s.tMs - lastCombatMs < 10_000 || s.threats.some(t => t.level === 'WARNING') ? 'combat' : s.own.aglFt < 1000 ? 'lowlevel' : 'cruise';
      if (next !== phase || s.tMs - lastPhasePublish > 2000) {
        phase = next;
        lastPhasePublish = s.tMs;
        out.push(msg('orch.phase', phase, { priority: 6, ttlMs: 3000 }));
        out.push(msg('orch.rates', RATE_PLANS[phase], { priority: 6, ttlMs: 3000 }));
      }
      return out;
    },
  };
}

/** Turn abstract advice (beam, nose-on) into a concrete heading, with NAV's terrain verdict in the why chain. */
function resolve(d: Directive, s: Snapshot, beams: Map<string, BeamEval>): Directive {
  if (d.axis !== 'heading') return d;
  const v = (d.value ?? {}) as Record<string, unknown>;
  if (v.mode === 'beam') {
    const b = (d.threatId ? beams.get(d.threatId) : undefined) ?? s.beam ?? undefined;
    // a missile break asks for maximum performance; ENV then caps it at the G limit
    if (b) {
      return { ...d, value: { ...v, mode: 'break', headingDeg: Math.round(b.headingDeg), side: b.side, gCap: 9.5, bankDeg: 80 }, why: [...d.why, b.why] };
    }
    // no NAV verdict yet: beam the shorter way
    const t = Number(v.threatBearingDeg);
    const right = wrap360(t - 90), left = wrap360(t + 90);
    const h = Math.abs(wrap180(right - s.own.headingDeg)) < Math.abs(wrap180(left - s.own.headingDeg)) ? right : left;
    const side = wrap180(h - s.own.headingDeg) >= 0 ? 'right' : 'left';
    return { ...d, value: { ...v, mode: 'break', headingDeg: Math.round(h), side, gCap: 9.5, bankDeg: 80 } };
  }
  if (typeof v.headingDeg === 'number' && v.side === undefined) {
    const delta = wrap180(v.headingDeg - s.own.headingDeg);
    const side = v.turn === 'left' || v.turn === 'right' ? v.turn : delta >= 0 ? 'right' : 'left';
    return { ...d, value: { ...v, headingDeg: Math.round(v.headingDeg), side } };
  }
  return d;
}
