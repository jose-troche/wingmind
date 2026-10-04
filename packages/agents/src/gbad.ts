import {
  FT, THREAT_LETHALITY, WEAPONS, angleDiff, bearingTo, bearingVec, dist2d, weaponEnvelope,
  type BusMessage, type GbadRing, type RwrEmitter, type Threat, type Vec3,
} from '@wingmind/shared';
import type { Terrain } from '@wingmind/sim-core';
import { msg, type Agent } from './core';

// GBAD: a fixed ring cut by line of sight on 64 radials (implementation 5.5).
// Sites come from the intel file or from warning-receiver bearings; a ridge
// between the site and the own ship carves a safe corridor out of the ring.

const RADIALS = 64;

/** Ring radius per radial for a target at `altM`: the first range at which terrain masks it. */
export function maskedRing(terrain: Terrain, site: Vec3, rMaxM: number, altM: number, radials = RADIALS, stepM = 250): number[] {
  const out: number[] = [];
  for (let k = 0; k < radials; k++) {
    const [dx, dy] = bearingVec((k * 360) / radials);
    let maxSlope = -Infinity;
    let radius = rMaxM;
    for (let d = stepM; d <= rMaxM; d += stepM) {
      const h = terrain.height(site[0] + dx * d, site[1] + dy * d);
      const visibleAbove = site[2] + Math.max(maxSlope, -1) * d;
      if (d > stepM * 2 && altM < Math.max(visibleAbove, h + 30)) { radius = d; break; }
      maxSlope = Math.max(maxSlope, (h - site[2]) / d);
    }
    out.push(radius);
  }
  return out;
}

interface Site { id: string; type: 'sam_long' | 'sam_short'; pos: Vec3; known: boolean; emitterId?: string; lastRwr?: RwrEmitter; lastSeenMs: number }

export function createGbad(): Agent {
  let sites: Site[] | null = null;
  const ringCache = new Map<string, { altBucket: number; radii: number[] }>();
  let popup = 0;

  return {
    id: 'GBAD', tier: 'T', rateHz: 5, budgetMs: 5,
    reads: ['obs.rwr'],
    writes: ['threat.ground', 'gbad.rings'],
    reset() { sites = null; ringCache.clear(); popup = 0; },
    step(s) {
      const out: BusMessage<unknown>[] = [];
      const own = s.own;
      sites ??= s.world.intelSites.map(i => ({ id: i.id, type: i.type, pos: i.pos, known: true, lastSeenMs: -1 }));
      // associate SAM emitters with sites, or create pop-up sites along the bearing
      for (const e of s.rwr.filter(x => x.type === 'sam_long')) {
        let site = sites.find(x => x.emitterId === e.emitterId);
        if (!site) site = sites.find(x => !x.emitterId && x.type === 'sam_long' && angleDiff(bearingTo(own.pos, x.pos), e.bearingDeg) < 10);
        if (!site) {
          const est = 25_000 / Math.sqrt(Math.max(e.strength, 0.02));
          const [dx, dy] = bearingVec(e.bearingDeg);
          const x = own.pos[0] + dx * Math.min(est, 60_000), y = own.pos[1] + dy * Math.min(est, 60_000);
          site = { id: `popup-${++popup}`, type: 'sam_long', pos: [x, y, s.world.terrain.height(x, y) + 8], known: false, lastSeenMs: s.tMs };
          sites.push(site);
        }
        site.emitterId = e.emitterId;
        site.lastRwr = e;
        site.lastSeenMs = s.tMs;
      }
      const rings: GbadRing[] = [];
      const altBucket = Math.round(own.pos[2] / 100);
      for (const site of sites) {
        const weapon = site.type === 'sam_long' ? WEAPONS.sam_radar! : WEAPONS.sam_ir!;
        const env = weaponEnvelope(weapon, own.altFt);
        let cached = ringCache.get(site.id);
        if (!cached || cached.altBucket !== altBucket) {
          cached = { altBucket, radii: env.rMaxM > 0 ? maskedRing(s.world.terrain, site.pos, env.rMaxM, own.pos[2]) : new Array(RADIALS).fill(0) };
          ringCache.set(site.id, cached);
        }
        rings.push({ siteId: site.id, pos: [site.pos[0], site.pos[1]], radii: cached.radii, type: site.type, known: site.known });
        const range = dist2d(own.pos, site.pos);
        const brgFromSite = bearingTo(site.pos, own.pos);
        const k = Math.round(brgFromSite / (360 / RADIALS)) % RADIALS;
        const inside = range < (cached.radii[k] ?? 0);
        const fresh = site.lastRwr && s.tMs - site.lastSeenMs < 3000;
        const mode = fresh ? site.lastRwr!.mode : null;
        // only report sites that are within twice their reach
        if (range > env.rMaxM * 2 + 20_000) continue;
        const ownSpeed = Math.max(own.tasKt * 0.5144, 100);
        const tAct = inside ? (mode === 'guidance' ? 2 : mode === 'track' ? 6 : 15) : Math.max(5, (range - (cached.radii[k] ?? 0)) / ownSpeed);
        const threat: Threat = {
          id: `gnd-${site.id}`, trackId: site.id, class: site.type === 'sam_long' ? 'sam' : 'shorad',
          lethality: THREAT_LETHALITY[site.type === 'sam_long' ? 'sam' : 'shorad']!,
          pEngage: inside ? (mode === 'guidance' || mode === 'track' ? 1 : site.type === 'sam_short' ? 0.7 : 0.5) : 0.05,
          tActS: tAct, confidence: site.known ? 0.9 : 0.7, score: 0, level: 'ADVISORY',
          ...(mode ? { intent: mode } : {}),
          envelope: { rMaxM: env.rMaxM, rNoEscapeM: env.rNoEscapeM },
          bearingDeg: bearingTo(own.pos, site.pos), rangeM: range, altFt: site.pos[2] / FT, source: 'GBAD',
        };
        out.push(msg('threat.ground', threat, { priority: mode === 'guidance' ? 1 : 4, ttlMs: 1500, evidence: [site.id, ...(site.lastRwr ? [site.lastRwr.id] : [])] }));
      }
      out.push(msg('gbad.rings', rings, { priority: 6, ttlMs: 1500 }));
      return out;
    },
  };
}
