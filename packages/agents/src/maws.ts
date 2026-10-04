import { angleDiff, bearingTo, clockPhrase, norm, rangePhrase, relBearing, sub, type Alert, type BusMessage, type DasObs, type RwrEmitter, type Threat, type Track } from '@wingmind/shared';
import { SAFETY } from './arbiter';
import { advise, msg, type Agent } from './core';

// MAWS: plume plus guidance-emitter correlation (implementation 5.3). A plume
// with a guidance-mode emitter on the same bearing is a radar missile; a plume
// alone is an IR missile. It publishes the threat, a WARNING and beam advice in
// the same tick it sees the plume.

interface Active { threat: Threat; bearingDeg: number; rangeM: number; closure: number; lastSeenMs: number; openingSinceMs: number | null; guided: boolean; createdMs: number; plumeRangeM: number }

function nearestFastCloser(tracks: Track[], own: readonly number[], brg: number): (Track & { rangeM: number }) | null {
  let best: (Track & { rangeM: number }) | null = null;
  for (const t of tracks) {
    if (t.kind !== 'missile') continue;
    if (angleDiff(bearingTo(own, t.pos), brg) > 15) continue;
    const rangeM = norm(sub(t.pos, own as [number, number, number]));
    if (!best || rangeM < best.rangeM) best = { ...t, rangeM };
  }
  return best;
}

export function createMaws(): Agent {
  let active = new Map<string, Active>();
  // guidance cues wait half a second for a plume before becoming a "possible launch"
  let pendingGuidance = new Map<string, { e: RwrEmitter; sinceMs: number; obsId: string }>();

  const alertFor = (a: Active, heading: number, wallMs: number): Alert => {
    const rel = relBearing(a.bearingDeg, heading);
    const cls = a.guided ? 'radar_missile' : 'ir_missile';
    return {
      id: `al-${a.threat.id}`, level: 'WARNING', cls, text: '', terse: '',
      bearingDeg: rel, threatId: a.threat.id, dedupKey: `msl:${a.threat.id}`, ttlMs: 20_000,
      evidence: [a.threat.trackId], confidence: a.threat.confidence,
      slots: { clock: clockPhrase(rel), range: rangePhrase(a.rangeM) },
      eventWallMs: wallMs,
    };
  };

  return {
    id: 'MAWS', tier: 'R', rateHz: 50, budgetMs: 1,
    reads: ['obs.das', 'obs.rwr'],
    writes: ['threat.missile', 'threat.cleared', 'alert', 'advice'],
    reset() { active = new Map(); pendingGuidance = new Map(); },
    step(s, inbox) {
      const out: BusMessage<unknown>[] = [];
      const own = s.own.pos;
      for (const m of inbox) {
        if (m.topic === 'obs.rwr') {
          const e = m.payload as RwrEmitter;
          if (e.mode === 'guidance' && e.newGuidance) pendingGuidance.set(e.emitterId, { e, sinceMs: s.tMs, obsId: m.id });
          continue;
        }
        const o = m.payload as DasObs;
        if (o.kind === 'plume') {
          const brg = o.bearingDeg;
          for (const [k, p] of pendingGuidance) if (angleDiff(p.e.bearingDeg, brg) < 15) pendingGuidance.delete(k);
          // the same plume seen again: close in bearing and in range (two launchers
          // on one bearing but kilometres apart are two missiles)
          const same = [...active.values()].find(a => s.tMs - a.createdMs < 2500 && angleDiff(a.bearingDeg, brg) < 8
            && Math.abs(a.plumeRangeM - o.rangeM) < Math.max(800, 0.06 * o.rangeM));
          if (same) { same.plumeRangeM = o.rangeM; continue; }
          const guide = s.rwr.find(e => e.mode === 'guidance' && angleDiff(e.bearingDeg, brg) < 15);
          const trk = nearestFastCloser(s.tracks, own, brg);           // small, fast, closing
          const rangeM = trk?.rangeM ?? o.rangeM;
          const closure = Math.max(o.closureMps, 1);
          const tti = rangeM / Math.max(closure + 600, 1);              // the motor is still accelerating
          const confidence = guide ? 0.95 : o.closureMps > 100 ? 0.85 : 0.6;
          const id = `msl-${o.id}`;
          const threat: Threat = {
            id, trackId: trk?.id ?? o.id, class: guide ? 'radar_missile' : 'ir_missile',
            bearingDeg: brg, rangeM, tActS: tti, confidence, lethality: 1, pEngage: 1, score: 0, level: 'WARNING', source: 'MAWS',
          };
          const a: Active = { threat, bearingDeg: brg, rangeM, closure, lastSeenMs: s.tMs, openingSinceMs: null, guided: Boolean(guide), createdMs: s.tMs, plumeRangeM: o.rangeM };
          active.set(id, a);
          const evidence = [m.id, guide?.id, trk?.id];
          out.push(msg('threat.missile', threat, { priority: 0, ttlMs: 3000, evidence, confidence }));
          out.push(msg('alert', alertFor(a, s.own.headingDeg, s.wallMs), { priority: 0, ttlMs: 20_000, evidence }));
          out.push(advise({
            axis: 'heading', value: { mode: 'beam', threatBearingDeg: brg }, utility: 1, safetyRank: SAFETY.missile,
            source: 'MAWS', evidence: evidence.filter((x): x is string => !!x), ttlMs: 8000, threatId: id,
          }, 0));
        } else if (o.kind === 'missile') {
          // follow the missile in flight
          let best: Active | null = null;
          for (const a of active.values()) if (angleDiff(a.bearingDeg, o.bearingDeg) < 20 && (!best || angleDiff(a.bearingDeg, o.bearingDeg) < angleDiff(best.bearingDeg, o.bearingDeg))) best = a;
          if (!best) continue;
          best.bearingDeg = o.bearingDeg;
          best.rangeM = o.rangeM;
          best.closure = o.closureMps;
          best.lastSeenMs = s.tMs;
          best.threat = { ...best.threat, bearingDeg: o.bearingDeg, rangeM: o.rangeM, tActS: o.rangeM / Math.max(o.closureMps, 1) };
          if (o.closureMps < -30) best.openingSinceMs ??= s.tMs;
          else best.openingSinceMs = null;
        }
      }
      // a guidance emitter with no plume after half a second: possible launch beyond DAS range
      for (const [k, p] of pendingGuidance) {
        if (s.tMs - p.sinceMs < 500) continue;
        pendingGuidance.delete(k);
        const e = p.e;
        if ([...active.values()].some(a => angleDiff(a.bearingDeg, e.bearingDeg) < 15)) continue;
        if (!s.rwr.some(x => x.emitterId === e.emitterId && x.mode === 'guidance')) continue;
        const id = `msl-${e.id}-${s.tick}`;
        const threat: Threat = {
          id, trackId: e.id, class: 'radar_missile', bearingDeg: e.bearingDeg, tActS: 20,
          confidence: 0.65, lethality: 1, pEngage: 1, score: 0, level: 'WARNING', source: 'MAWS',
        };
        const a: Active = { threat, bearingDeg: e.bearingDeg, rangeM: 25_000, closure: 800, lastSeenMs: s.tMs, openingSinceMs: null, guided: true, createdMs: s.tMs, plumeRangeM: -1e9 };
        active.set(id, a);
        out.push(msg('threat.missile', threat, { priority: 0, ttlMs: 3000, evidence: [p.obsId], confidence: 0.65 }));
        out.push(msg('alert', alertFor(a, s.own.headingDeg, s.wallMs), { priority: 0, ttlMs: 20_000, evidence: [p.obsId] }));
        out.push(advise({
          axis: 'heading', value: { mode: 'beam', threatBearingDeg: e.bearingDeg }, utility: 0.8, safetyRank: SAFETY.missile,
          source: 'MAWS', evidence: [p.obsId], ttlMs: 8000, threatId: id,
        }, 0));
      }
      // defeat: track opening for a second, or contact lost
      for (const [id, a] of active) {
        const opening = a.openingSinceMs !== null && s.tMs - a.openingSinceMs > 1000;
        const lost = s.tMs - a.lastSeenMs > (a.rangeM > 18_000 ? 30_000 : 3000);
        if (!opening && !lost) {
          out.push(msg('threat.missile', a.threat, { priority: 1, ttlMs: 500, confidence: a.threat.confidence }));
          continue;
        }
        active.delete(id);
        out.push(msg('threat.cleared', { threatId: id, reason: opening ? 'defeated' : 'lost' }, { priority: 1, ttlMs: 2000 }));
        if (a.threat.confidence >= 0.5) {
          const al: Alert = {
            id: `al-def-${id}`, level: 'CAUTION', cls: 'missile_defeated', text: '', terse: '', dedupKey: `def:${id}`, ttlMs: 5000,
            evidence: [a.threat.trackId], confidence: 0.9, threatId: id, slots: {},
          };
          out.push(msg('alert', al, { priority: 1, ttlMs: 5000 }));
        }
      }
      return out;
    },
  };
}
