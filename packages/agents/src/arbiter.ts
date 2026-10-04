import { groupBy, uid, type Advice, type Axis, type Directive } from '@wingmind/shared';
import type { EnvelopeLimits } from './core';

// The arbiter inside ORCH (implementation 5.4, spec 5.4/5.5). Advice on each
// control axis resolves to one directive: safety rank first, then utility.
// Advice on different axes merges (chaff from EW and a turn from NAV both run).

export const SAFETY = {
  groundCollision: 1,
  midAir: 2,
  pilot: 2.5,          // pilot commands outrank everything but collision avoidance (spec 10.1 step 7)
  missile: 3,
  envelope: 4,
  engine: 5,
  threat: 6,
  fuel: 7,
  weather: 8,
  navigation: 9,
} as const;

export function clampToEnvelope(d: Directive, env: EnvelopeLimits): Directive {
  const v = d.value as Record<string, unknown> | null;
  if (!v || typeof v !== 'object') return d;
  if (d.axis === 'heading' || d.axis === 'altitude') {
    const req = typeof v.gCap === 'number' ? v.gCap : (d.axis === 'heading' && v.mode === 'break' ? 9.5 : undefined);
    if (req !== undefined && req > env.gMax) {
      return { ...d, value: { ...v, gCap: env.gMax }, why: [...d.why, `ENV capped the turn at ${env.gMax} G`] };
    }
    if (req !== undefined) return { ...d, value: { ...v, gCap: req } };
  }
  return d;
}

export function arbitrate(advice: Advice[], env: EnvelopeLimits, now: number): Directive[] {
  const live = advice.filter(a => a.expiresAt > now);
  return Object.entries(groupBy(live, a => a.axis)).map(([axis, list]) => {
    list.sort((a, b) => a.safetyRank - b.safetyRank || b.utility - a.utility);
    const [win, ...rest] = list as [Advice, ...Advice[]];
    const suppressed = rest.filter(r => r.source !== win.source);
    return clampToEnvelope({
      id: uid('dir'), axis: axis as Axis, value: win.value, source: win.source,
      supersedes: rest.map(r => r.id),
      why: [`${win.source} won (rank ${win.safetyRank})`, ...dedupe(suppressed.map(r => `${r.source} suppressed`))],
      evidence: win.evidence,
      ...(win.threatId ? { threatId: win.threatId } : {}),
    }, env);                                                // no directive may exceed G or AoA limits
  });
}

const dedupe = (xs: string[]): string[] => [...new Set(xs)];
