import { DEG, bearingTo, norm, sub, type BusMessage, type DasObs, type DatalinkObs, type IrstObs, type RadarObs, type Track, type TrackKind, type Vec3 } from '@wingmind/shared';
import { msg, type Agent } from './core';

// FUSE: nearest-neighbor gating and an alpha-beta filter (implementation 5.5).
// Only FUSE writes the track table.

interface Internal extends Track { lastUpdateMs: number; rcsDbsm: number | null; updates: number }

const polarToEnu = (own: Vec3, rangeM: number, brgDeg: number, elevDeg: number): Vec3 => {
  const h = rangeM * Math.cos(elevDeg * DEG);
  return [own[0] + h * Math.sin(brgDeg * DEG), own[1] + h * Math.cos(brgDeg * DEG), own[2] + rangeM * Math.sin(elevDeg * DEG)];
};

export function createFuse(): Agent {
  let tracks = new Map<string, Internal>();
  let seq = 0;

  const classify = (t: Internal): TrackKind => {
    const speed = norm(t.vel);
    if (speed > 500) return 'missile';
    if (speed < 90 && (t.rcsDbsm === null || t.rcsDbsm < -8)) return 'drone';
    if (t.updates < 2) return 'unknown';
    return 'air';
  };

  const associate = (pos: Vec3, gateM: number): Internal | null => {
    let best: Internal | null = null;
    let bestD = gateM;
    for (const t of tracks.values()) {
      const d = norm(sub(t.pos, pos));
      if (d < bestD) { bestD = d; best = t; }
    }
    return best;
  };

  const update = (pos: Vec3, nowMs: number, tick: number, source: string, gateM: number, alpha: number, beta: number, rcs: number | null, vel?: Vec3): void => {
    const t = associate(pos, gateM);
    if (!t) {
      const id = `T${String(++seq).padStart(2, '0')}`;
      tracks.set(id, {
        id, kind: 'unknown', identity: 'unknown', pos, vel: vel ?? [0, 0, 0], cov: [], quality: 0.3,
        sources: [source], lastSeenTick: tick, lastUpdateMs: nowMs, rcsDbsm: rcs, updates: 1,
      });
      return;
    }
    const dt = Math.max((nowMs - t.lastUpdateMs) / 1000, 1 / 60);
    const pred: Vec3 = [t.pos[0] + t.vel[0] * dt, t.pos[1] + t.vel[1] * dt, t.pos[2] + t.vel[2] * dt];
    const r: Vec3 = [pos[0] - pred[0], pos[1] - pred[1], pos[2] - pred[2]];
    t.pos = [pred[0] + alpha * r[0], pred[1] + alpha * r[1], pred[2] + alpha * r[2]];
    t.vel = vel ?? [t.vel[0] + (beta / dt) * r[0], t.vel[1] + (beta / dt) * r[1], t.vel[2] + (beta / dt) * r[2]];
    t.quality = Math.min(1, t.quality + 0.12);
    t.lastSeenTick = tick;
    t.lastUpdateMs = nowMs;
    t.updates++;
    if (rcs !== null) t.rcsDbsm = t.rcsDbsm === null ? rcs : t.rcsDbsm * 0.8 + rcs * 0.2;
    if (!t.sources.includes(source)) t.sources = [...t.sources, source];
  };

  return {
    id: 'FUSE', tier: 'R', rateHz: 20, budgetMs: 2,
    reads: ['obs.radar', 'obs.irst', 'obs.das', 'obs.datalink'],
    writes: ['track.table'],
    reset() { tracks = new Map(); seq = 0; },
    step(s, inbox) {
      const own = s.own.pos;
      for (const m of inbox) {
        const o = m.payload as RadarObs | DasObs | IrstObs | DatalinkObs;
        switch (o.sensor) {
          case 'radar':
            update(polarToEnu(own, o.rangeM, o.bearingDeg, o.elevDeg), s.tMs, s.tick, 'radar', Math.max(600, o.rangeM * 0.02), 0.5, 0.2, o.rcsDbsm);
            break;
          case 'das':
            if (o.kind === 'plume') break;                       // a launch flash is MAWS's business
            update(polarToEnu(own, o.rangeM, o.bearingDeg, o.elevDeg), s.tMs, s.tick, 'das', Math.max(800, o.rangeM * 0.06), 0.35, 0.1, null);
            break;
          case 'irst': {
            // bearing-only: refresh the track nearest in bearing
            for (const t of tracks.values()) {
              if (Math.abs(((bearingTo(own, t.pos) - o.bearingDeg + 540) % 360) - 180) < 2) {
                t.quality = Math.min(1, t.quality + 0.05);
                t.lastSeenTick = s.tick;
                if (!t.sources.includes('irst')) t.sources = [...t.sources, 'irst'];
                break;
              }
            }
            break;
          }
          case 'datalink':
            update(o.pos, s.tMs, s.tick, 'datalink', 1500, 0.4, 0.2, null, o.vel);
            for (const t of tracks.values()) if (t.lastSeenTick === s.tick && t.sources.includes('datalink')) t.identity = o.identity;
            break;
        }
      }
      // decay and drop
      const out: Track[] = [];
      for (const [id, t] of tracks) {
        const ageS = (s.tMs - t.lastUpdateMs) / 1000;
        const maxAge = t.kind === 'missile' ? 2.5 : 8;
        if (ageS > maxAge) { tracks.delete(id); continue; }
        t.quality = Math.max(0.05, t.quality - 0.02 * ageS);
        t.kind = classify(t);
        if (t.identity === 'unknown' && t.updates > 3) t.identity = 'hostile';   // no friendly IFF in prototype scenarios
        const sig = Math.max(20, 400 * (1 - t.quality));
        out.push({
          id: t.id, kind: t.kind, identity: t.identity, pos: t.pos, vel: t.vel,
          cov: [sig * sig, 0, 0, 0, 0, 0, 0, sig * sig, 0, 0, 0, 0, 0, 0, sig * sig, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 100, 0, 0, 0, 0, 0, 0, 100],
          quality: t.quality, sources: t.sources, lastSeenTick: t.lastSeenTick,
        });
      }
      return [msg('track.table', out, { priority: 4, ttlMs: 500 })] as BusMessage<unknown>[];
    },
  };
}
