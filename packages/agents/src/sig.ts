import {
  RADARS, angleDiff, bearingTo, bearingVec, detectionRangeM, dist2d, ownRcsM2, relBearing, spellNumber, wrap180, wrap360,
  type Alert, type BusMessage, type DetectionRing, type EmitterType, type Vec2,
} from '@wingmind/shared';
import { SAFETY } from './arbiter';
import { advise, msg, type Agent, type Snapshot } from './core';

// SIG: 36-bin aspect table; each detection ring's radius scales with the fourth
// root of the signature that radar sees (implementation 5.5, spec 7.1-7.3).

const R0: Record<EmitterType, number> = {
  sam_long: RADARS.sam_long!.r0M, fighter: RADARS.fighter_gen4!.r0M, ew_radar: RADARS.ew_radar!.r0M, sam_short: 20_000, unknown: 110_000,
};

interface KnownRadar { emitterId: string; type: EmitterType; pos: Vec2; mode: string | null; estimated: boolean }

export function knownRadars(s: Snapshot): KnownRadar[] {
  const out: KnownRadar[] = [];
  for (const r of s.gbadRings) {
    if (r.type !== 'sam_long') continue;
    const e = s.rwr.find(x => x.type === 'sam_long' && angleDiff(x.bearingDeg, bearingTo(s.own.pos, r.pos)) < 10);
    out.push({ emitterId: r.siteId, type: 'sam_long', pos: r.pos, mode: e?.mode ?? null, estimated: !r.known });
  }
  for (const e of s.rwr) {
    if (e.type === 'sam_long' && out.some(o => o.type === 'sam_long' && angleDiff(bearingTo(s.own.pos, o.pos), e.bearingDeg) < 10)) continue;
    // fighters: use the fused track on that bearing; otherwise an estimated range from signal strength
    const trk = e.type === 'fighter' ? s.tracks.find(t => t.kind === 'air' && angleDiff(bearingTo(s.own.pos, t.pos), e.bearingDeg) < 8) : undefined;
    if (trk) { out.push({ emitterId: e.emitterId, type: e.type, pos: [trk.pos[0], trk.pos[1]], mode: e.mode, estimated: false }); continue; }
    const est = Math.min(80_000, 20_000 / Math.sqrt(Math.max(e.strength, 0.01)));
    const [dx, dy] = bearingVec(e.bearingDeg);
    out.push({ emitterId: e.emitterId, type: e.type, pos: [s.own.pos[0] + dx * est, s.own.pos[1] + dy * est], mode: e.mode, estimated: true });
  }
  return out;
}

export function createSig(): Agent {
  let lastDetectionCall = -Infinity;

  return {
    id: 'SIG', tier: 'T', rateHz: 5, budgetMs: 3,
    reads: ['obs.rwr'],
    writes: ['sig.detection', 'advice', 'alert'],
    reset() { lastDetectionCall = -Infinity; },
    step(s) {
      const out: BusMessage<unknown>[] = [];
      const own = s.own;
      const rings: DetectionRing[] = [];
      let worst: (DetectionRing & { mode: string | null }) | null = null;
      for (const r of knownRadars(s)) {
        const brgToRadar = bearingTo(own.pos, r.pos);
        const aspect = wrap360(brgToRadar - own.headingDeg);
        const radius = detectionRangeM(R0[r.type], ownRcsM2(aspect));
        const range = dist2d(own.pos, r.pos);
        const radarZ = s.world.terrain.height(r.pos[0], r.pos[1]) + 10;
        // a radar the warning receiver hears right now has line of sight by definition
        const los = r.mode !== null || s.world.terrain.los([r.pos[0], r.pos[1], radarZ], own.pos, 0);
        const inRing = range < radius;
        const pDetect = !los ? 0.05 : inRing ? (r.mode === 'track' || r.mode === 'guidance' ? 0.98 : 0.85) : Math.max(0.02, 0.85 * Math.exp(-(((range - radius) / (radius * 0.25)) ** 2)));
        const ring: DetectionRing = { emitterId: r.emitterId, pos: r.pos, radiusM: radius, pDetect, aspectDeg: aspect, type: r.type };
        rings.push(ring);
        if (!worst || pDetect > worst.pDetect) worst = { ...ring, mode: r.mode };
      }
      out.push(msg('sig.detection', rings, { priority: 5, ttlMs: 1000 }));

      // aspect management: put the most dangerous radar on the nose (lowest signature)
      if (worst && worst.pDetect > 0.5) {
        const brg = bearingTo(own.pos, worst.pos);
        out.push(advise({
          axis: 'heading', value: { mode: 'nose', headingDeg: brg, emitterId: worst.emitterId },
          utility: worst.pDetect, safetyRank: SAFETY.threat, source: 'SIG', evidence: [worst.emitterId], ttlMs: 1500,
        }, 3));
        if (own.emcon < 2 && (worst.mode === 'track' || worst.mode === 'guidance')) {
          out.push(advise({ axis: 'emitters', value: { emcon: 2 }, utility: 0.5, safetyRank: SAFETY.threat, source: 'SIG', evidence: [worst.emitterId], ttlMs: 2000 }, 5));
        }
        if (worst.mode === 'search' && s.tMs - lastDetectionCall > 60_000) {
          // only call it when a modest turn would get us outside the ring
          const turn = Math.round(wrap180(brg - own.headingDeg) / 10) * 10;
          if (Math.abs(turn) >= 10 && Math.abs(turn) <= 60) {
            lastDetectionCall = s.tMs;
            const al: Alert = {
              id: `al-det-${s.tick}`, level: 'ADVISORY', cls: 'detection', text: '', terse: '', dedupKey: `det:${worst.emitterId}`,
              ttlMs: 60_000, evidence: [worst.emitterId], confidence: worst.pDetect, bearingDeg: relBearing(brg, own.headingDeg),
              slots: { action: `Come ${turn > 0 ? 'right' : 'left'} ${spellNumber(Math.abs(turn))} to reduce signature` },
            };
            out.push(msg('alert', al, { priority: 6, ttlMs: 3000 }));
          }
        }
      }
      // throttle discipline near IR threats
      const irNear = s.threats.some(t => (t.class === 'shorad' || t.class === 'ir_missile') && (t.rangeM ?? Infinity) < 10_000);
      if (irNear && own.throttle > 0.86) {
        out.push(advise({ axis: 'throttle', value: { throttle: 0.84 }, utility: 0.6, safetyRank: SAFETY.threat, source: 'SIG', evidence: ['ir'], ttlMs: 2000 }, 4));
      }
      return out;
    },
  };
}
