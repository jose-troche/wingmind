import {
  altitudeBand, clockPhrase, rangePhrase, relBearing, spellNumber,
  type Alert, type AlertClass, type BusMessage, type Level, type Threat,
} from '@wingmind/shared';
import { msg, type Agent, type Snapshot } from './core';

// TAP: the full scoring model from spec 6.4.
//   score = L x P_engage x min(1, t_ref / t_act) x C,   t_ref = 10 s
// Bands: >= 0.8 WARNING, 0.4-0.8 CAUTION, < 0.4 ADVISORY, with hysteresis.

export const T_REF_S = 10;

export function threatScore(t: Pick<Threat, 'lethality' | 'pEngage' | 'tActS' | 'confidence'>): number {
  return t.lethality * t.pEngage * Math.min(1, T_REF_S / Math.max(t.tActS, 0.1)) * t.confidence;
}

/** Level with hysteresis: enter WARNING at 0.8 and leave below 0.7 (CAUTION 0.4 / 0.3). */
export function levelFor(score: number, prev: Level | undefined): Level {
  if (prev === 'WARNING' && score >= 0.7) return 'WARNING';
  if (score >= 0.8) return 'WARNING';
  if (prev === 'CAUTION' && score >= 0.3) return 'CAUTION';
  if (score >= 0.4) return 'CAUTION';
  return 'ADVISORY';
}

const rank = { ADVISORY: 0, CAUTION: 1, WARNING: 2, STATUS: -1 } as const;

export function createTap(): Agent {
  let registry = new Map<string, { t: Threat; until: number }>();
  let levels = new Map<string, Level>();
  let intents = new Map<string, string>();
  let announced = new Set<string>();

  const alertFor = (t: Threat, s: Snapshot, level: Level): Alert | null => {
    const rel = relBearing(t.bearingDeg ?? 0, s.own.headingDeg);
    const base = {
      id: `al-${t.id}-${level}-${t.intent ?? ''}`, level, text: '', terse: '', bearingDeg: rel, threatId: t.id,
      ttlMs: 30_000, evidence: [t.trackId], confidence: t.confidence,
    };
    const clock = clockPhrase(rel);
    const range = rangePhrase(t.rangeM ?? 0);
    let cls: AlertClass;
    let slots: Record<string, string>;
    switch (t.class) {
      case 'sam':
      case 'shorad':
        if (t.intent !== 'track' && t.intent !== 'guidance') return null;
        cls = 'sam_track';
        slots = { clock, range, action: s.own.aglFt > 1500 ? 'Descend, mask behind the ridge' : 'Turn cold' };
        break;
      case 'fighter':
        cls = 'bandit';
        slots = { clock, range, alt: altitudeBand(t.altFt ?? 0, s.own.altFt), intent: t.intent ?? 'unaware' };
        break;
      case 'swarm':
        cls = 'swarm';
        slots = { clock: clockPhrase(rel, 'oclock'), range, alt: altitudeBand(t.altFt ?? 0, s.own.altFt), count: spellNumber(t.count ?? 0) };
        break;
      default:
        return null;
    }
    return { ...base, cls, slots, dedupKey: `${t.id}:${level}:${t.intent ?? ''}` };
  };

  return {
    id: 'TAP', tier: 'T', rateHz: 10, budgetMs: 2,
    reads: ['threat.missile', 'threat.air', 'threat.ground', 'threat.cleared'],
    writes: ['threat.ranked', 'alert'],
    reset() { registry = new Map(); levels = new Map(); intents = new Map(); announced = new Set(); },
    step(s, inbox) {
      const out: BusMessage<unknown>[] = [];
      for (const m of inbox) {
        if (m.topic === 'threat.cleared') {
          const id = (m.payload as { threatId: string }).threatId;
          registry.delete(id);
          levels.delete(id);
          continue;
        }
        const t = m.payload as Threat;
        registry.set(t.id, { t, until: s.tMs + Math.max(m.ttlMs * 2, 1000) });
      }
      const ranked: Threat[] = [];
      for (const [id, r] of registry) {
        if (r.until < s.tMs) { registry.delete(id); levels.delete(id); continue; }
        const t = r.t;
        // P_engage combines "inside its envelope" with SIG's "it can detect us"
        const det = s.detection.find(d => d.emitterId === t.trackId || `gnd-${d.emitterId}` === t.id);
        const pEngage = det ? t.pEngage * Math.max(det.pDetect, 0.2) : t.pEngage;
        const score = t.class === 'radar_missile' || t.class === 'ir_missile' ? Math.max(0.85, threatScore({ ...t, pEngage })) : threatScore({ ...t, pEngage });
        const level = t.class === 'radar_missile' || t.class === 'ir_missile' ? 'WARNING' : levelFor(score, levels.get(id));
        const prev = levels.get(id);
        levels.set(id, level);
        ranked.push({ ...t, pEngage, score, level });
        if (t.class === 'radar_missile' || t.class === 'ir_missile') continue;     // MAWS speaks for missiles
        const intentChanged = t.class === 'fighter' && t.intent !== undefined && intents.get(id) !== t.intent;
        if (t.intent !== undefined) intents.set(id, t.intent);
        const rising = prev === undefined ? level !== 'ADVISORY' || !announced.has(id) : rank[level] > rank[prev];
        if (rising || intentChanged) {
          const al = alertFor({ ...t, score, level }, s, level);
          if (al) {
            announced.add(id);
            out.push(msg('alert', al, { priority: level === 'WARNING' ? 1 : level === 'CAUTION' ? 3 : 6, ttlMs: 3000, evidence: al.evidence, confidence: t.confidence }));
          }
        }
      }
      ranked.sort((a, b) => b.score - a.score);
      out.push(msg('threat.ranked', ranked, { priority: 2, ttlMs: 500 }));
      return out;
    },
  };
}
