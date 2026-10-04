import {
  DEG, NM, RAD, Rng, bearingTo, detectionRangeM, norm, sub, wrap180,
  type DasObs, type DatalinkObs, type IrstObs, type Observation, type RadarObs, type RwrEmitter, type Vec3,
} from '@wingmind/shared';
import type { Weather } from './atmosphere';
import type { Emission } from './entities';
import type { Terrain } from './terrain';

// Generic, parametric sensor models (spec 3.5). They are the only path from
// ground truth to the agents: every report carries noise, latency or gaps.

export interface SensorTarget {
  id: string; kind: 'fighter' | 'drone' | 'missile';
  pos: Vec3; vel: Vec3; rcsM2: number; ir: number; motorBurning?: boolean; launchAgeS?: number;
}

export interface OwnSensorView { pos: Vec3; vel: Vec3; headingDeg: number; emcon: 0 | 1 | 2 | 3 }

const OWN_RADAR_R0 = 150_000;   // detection range against 1 m^2
const RATES = { radar: 10, irst: 10, das: 30, rwr: 10, datalink: 1 };

export class SensorSuite {
  private rng: Rng;
  private last = { radar: -1, irst: -1, das: -1, rwr: -1, datalink: -1 };
  private obsSeq = 0;
  private dlQueue: { dueS: number; obs: DatalinkObs }[] = [];
  rwr: RwrEmitter[] = [];
  private prevModes = new Map<string, string>();
  falseAlarms: string[] = [];

  constructor(seed: number, private falseAlarmPerMin: number, private datalinkLatencyS: number | null) {
    this.rng = new Rng(seed ^ 0x5e45);
  }

  private due(kind: keyof typeof RATES, tS: number): boolean {
    const period = 1 / RATES[kind];
    if (tS - this.last[kind] + 1e-9 < period) return false;
    this.last[kind] = tS;
    return true;
  }

  private id(prefix: string): string {
    return `${prefix}${++this.obsSeq}`;
  }

  /** Observations produced this frame plus the current warning-receiver picture. */
  step(tick: number, tS: number, own: OwnSensorView, targets: SensorTarget[], emissions: Emission[], terrain: Terrain, weather: Weather, forceRwr = false): { obs: Observation[]; rwrChanged: RwrEmitter[] } {
    const obs: Observation[] = [];
    const rng = this.rng;

    if (own.emcon <= 1 && this.due('radar', tS)) {
      const r0 = OWN_RADAR_R0 * (own.emcon === 1 ? 0.7 : 1);
      for (const t of targets) {
        const rel = sub(t.pos, own.pos);
        const range = norm(rel);
        const brg = bearingTo(own.pos, t.pos);
        if (Math.abs(wrap180(brg - own.headingDeg)) > 60) continue;
        if (range > detectionRangeM(r0, t.rcsM2)) continue;
        if (!terrain.los(own.pos, t.pos, 0)) continue;
        // look-down clutter penalty for low, slow targets
        const agl = t.pos[2] - terrain.height(t.pos[0], t.pos[1]);
        if (agl < 300 && norm(t.vel) < 80 && rng.chance(0.35)) continue;
        const relV = sub(t.vel, own.vel);
        const closure = -(rel[0] * relV[0] + rel[1] * relV[1] + rel[2] * relV[2]) / Math.max(range, 1);
        const o: RadarObs = {
          id: this.id('r'), sensor: 'radar', tick,
          rangeM: range * (1 + rng.gauss() * 0.003) + rng.gauss() * 30,
          bearingDeg: brg + rng.gauss() * 0.3,
          elevDeg: Math.atan2(rel[2], Math.hypot(rel[0], rel[1])) * RAD + rng.gauss() * 0.3,
          closureMps: closure + rng.gauss() * 3,
          rcsDbsm: 10 * Math.log10(t.rcsM2) + rng.gauss() * 2,
        };
        obs.push(o);
      }
    }

    if (this.due('irst', tS)) {
      for (const t of targets) {
        const rel = sub(t.pos, own.pos);
        const range = norm(rel);
        const brg = bearingTo(own.pos, t.pos);
        if (Math.abs(wrap180(brg - own.headingDeg)) > 90) continue;
        const trans = weather.cloudTransmission(own.pos[2], t.pos[2]);
        const rMax = 60_000 * Math.sqrt(t.ir) * trans;
        if (range > rMax || !terrain.los(own.pos, t.pos, 0)) continue;
        const o: IrstObs = {
          id: this.id('i'), sensor: 'irst', tick,
          bearingDeg: brg + rng.gauss() * 0.1,
          elevDeg: Math.atan2(rel[2], Math.hypot(rel[0], rel[1])) * RAD + rng.gauss() * 0.1,
          intensity: t.ir * trans / Math.max(range / 10_000, 0.1) ** 2,
        };
        obs.push(o);
      }
    }

    if (this.due('das', tS)) {
      for (const t of targets) {
        const rel = sub(t.pos, own.pos);
        const range = norm(rel);
        const relV = sub(t.vel, own.vel);
        const closure = -(rel[0] * relV[0] + rel[1] * relV[1] + rel[2] * relV[2]) / Math.max(range, 1);
        let kind: DasObs['kind'] | null = null;
        if (t.kind === 'missile') {
          if ((t.launchAgeS ?? 99) < 1.0 && range < 35_000) kind = 'plume';
          else if (range < (t.motorBurning ? 20_000 : 10_000)) kind = 'missile';
        } else if (range < 15_000) kind = 'aircraft';
        if (!kind || !terrain.los(own.pos, t.pos, 0)) continue;
        const o: DasObs = {
          id: this.id('d'), sensor: 'das', tick, kind,
          bearingDeg: bearingTo(own.pos, t.pos) + rng.gauss() * 0.5,
          elevDeg: Math.atan2(rel[2], Math.hypot(rel[0], rel[1])) * RAD + rng.gauss() * 0.5,
          rangeM: range * (1 + rng.gauss() * 0.02),
          closureMps: closure + rng.gauss() * 5,
        };
        obs.push(o);
      }
      // configurable false-alarm rate (fog of war, spec 6.5)
      const pFrame = this.falseAlarmPerMin / 60 / RATES.das;
      if (pFrame > 0 && rng.chance(pFrame)) {
        const o: DasObs = {
          id: this.id('d'), sensor: 'das', tick, kind: 'plume',
          bearingDeg: rng.range(0, 360), elevDeg: rng.range(-20, 5), rangeM: rng.range(4, 12) * NM, closureMps: rng.range(0, 300),
        };
        this.falseAlarms.push(o.id);
        obs.push(o);
      }
    }

    let rwrChanged: RwrEmitter[] = [];
    if (forceRwr || this.due('rwr', tS)) {
      const next: RwrEmitter[] = [];
      for (const e of emissions) {
        const range = norm(sub(e.pos, own.pos));
        if (range > e.rangeM) continue;
        const prev = this.prevModes.get(e.emitterId);
        next.push({
          id: `rwr-${e.emitterId}-${e.mode}`,
          emitterId: e.emitterId,
          bearingDeg: bearingTo(own.pos, e.pos) + rng.gauss() * 3,
          type: e.type,
          mode: e.mode,
          strength: Math.min(1, (e.rangeM / Math.max(range, 1000)) ** 2 / 50),
          ...(e.mode === 'guidance' && prev !== 'guidance' ? { newGuidance: true } : {}),
        });
      }
      rwrChanged = next.filter(e => this.prevModes.get(e.emitterId) !== e.mode);
      this.prevModes = new Map(next.map(e => [e.emitterId, e.mode]));
      this.rwr = next;
    }

    if (this.datalinkLatencyS !== null && this.due('datalink', tS)) {
      for (const t of targets) {
        if (t.kind === 'missile') continue;
        this.dlQueue.push({
          dueS: tS + this.datalinkLatencyS + rng.range(0, 1),
          obs: {
            id: this.id('l'), sensor: 'datalink', tick,
            pos: [t.pos[0] + rng.gauss() * 150, t.pos[1] + rng.gauss() * 150, t.pos[2] + rng.gauss() * 50],
            vel: [...t.vel], identity: 'hostile', ageS: this.datalinkLatencyS,
          },
        });
      }
    }
    if (this.dlQueue.length) {
      const ready = this.dlQueue.filter(q => q.dueS <= tS);
      this.dlQueue = this.dlQueue.filter(q => q.dueS > tS);
      for (const r of ready) obs.push({ ...r.obs, tick });
    }
    void DEG;
    return { obs, rwrChanged };
  }
}
