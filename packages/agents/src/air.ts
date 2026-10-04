import {
  FT, THREAT_LETHALITY, WEAPONS, angleDiff, bearingTo, dist2d, norm, sub, weaponEnvelope,
  type BusMessage, type Threat, type Track,
} from '@wingmind/shared';
import { msg, type Agent } from './core';

// AIR: rules for four intent states and an envelope table by altitude
// (implementation 5.5). Drones are clustered into swarms here too (UAS is
// folded into AIR in the prototype).

export type AirIntent = 'unaware' | 'committing' | 'launching' | 'disengaging';

export function inferIntent(t: Track, own: readonly number[], rwrGuidance: boolean, rwrTrack: boolean): AirIntent {
  const toOwn = bearingTo(t.pos, own);
  const heading = bearingTo([0, 0], t.vel);
  const hot = angleDiff(toOwn, heading) < 35;
  const rel = sub(own as [number, number, number], t.pos);
  const closing = (rel[0] * t.vel[0] + rel[1] * t.vel[1]) > 0;
  if (rwrGuidance) return 'launching';
  if ((hot && closing) || rwrTrack) return 'committing';
  if (!closing && angleDiff(toOwn, heading) > 100) return 'disengaging';
  return 'unaware';
}

export function createAir(): Agent {
  return {
    id: 'AIR', tier: 'T', rateHz: 10, budgetMs: 3,
    reads: ['obs.rwr'],
    writes: ['threat.air'],
    step(s) {
      const out: BusMessage<unknown>[] = [];
      const own = s.own.pos;
      const air = s.tracks.filter(t => t.kind === 'air' && t.identity !== 'friend');
      for (const t of air) {
        const brg = bearingTo(own, t.pos);
        const emitters = s.rwr.filter(e => e.type === 'fighter' && angleDiff(e.bearingDeg, brg) < 10);
        const intent = inferIntent(t, own, emitters.some(e => e.mode === 'guidance'), emitters.some(e => e.mode === 'track'));
        const range = norm(sub(t.pos, own));
        const env = weaponEnvelope(WEAPONS.aam_radar!, t.pos[2] / FT);
        const rel = sub(own, t.pos);
        const closure = Math.max(1, (rel[0] * t.vel[0] + rel[1] * t.vel[1] + rel[2] * t.vel[2]) / Math.max(range, 1) - (rel[0] * s.own.vel[0] + rel[1] * s.own.vel[1] + rel[2] * s.own.vel[2]) / Math.max(range, 1));
        const inside = range < env.rMaxM;
        const tAct = inside ? (intent === 'launching' ? 1 : 3) : (range - env.rMaxM) / closure;
        const threat: Threat = {
          id: `air-${t.id}`, trackId: t.id, class: 'fighter', lethality: THREAT_LETHALITY.fighter!,
          pEngage: inside ? (intent === 'unaware' ? 0.4 : 0.9) : intent === 'disengaging' ? 0.05 : 0.25,
          tActS: Math.max(0.5, tAct), confidence: t.quality, score: 0, level: 'ADVISORY', intent,
          envelope: { rMaxM: env.rMaxM, rNoEscapeM: env.rNoEscapeM },
          bearingDeg: brg, rangeM: range, altFt: t.pos[2] / FT, source: 'AIR',
        };
        out.push(msg('threat.air', threat, { priority: intent === 'launching' ? 1 : 4, ttlMs: 1000, evidence: [t.id, ...emitters.map(e => e.id)], confidence: t.quality }));
      }
      // drones: single-linkage clustering at 3 km
      const drones = s.tracks.filter(t => t.kind === 'drone');
      const groups: Track[][] = [];
      for (const d of drones) {
        const g = groups.find(gr => gr.some(o => dist2d(o.pos, d.pos) < 3000));
        if (g) g.push(d); else groups.push([d]);
      }
      for (const g of groups) {
        const lead = [...g].sort((a, b) => a.id.localeCompare(b.id))[0]!;
        const cx = g.reduce((a, t) => a + t.pos[0], 0) / g.length;
        const cy = g.reduce((a, t) => a + t.pos[1], 0) / g.length;
        const cz = g.reduce((a, t) => a + t.pos[2], 0) / g.length;
        const range = dist2d(own, [cx, cy]);
        const swarm = g.length >= 3;
        const threat: Threat = {
          id: `uas-${lead.id}`, trackId: lead.id, class: swarm ? 'swarm' : 'drone',
          lethality: THREAT_LETHALITY[swarm ? 'swarm' : 'drone']!, pEngage: range < 8000 ? 0.6 : 0.2,
          tActS: Math.max(1, (range - 3000) / 150), confidence: Math.max(...g.map(t => t.quality)), score: 0, level: 'ADVISORY',
          bearingDeg: bearingTo(own, [cx, cy]), rangeM: range, altFt: cz / FT, count: g.length, source: 'AIR',
        };
        out.push(msg('threat.air', threat, { priority: 4, ttlMs: 1000, evidence: g.map(t => t.id) }));
      }
      return out;
    },
  };
}
