import {
  FT, NM, angleDiff, bearingTo, dist2d, rangePhrase, spellHeading, spellNumber, wrap360,
  type Alert, type BusMessage, type SimEvent,
} from '@wingmind/shared';
import { msg, type Agent, type EnvelopeLimits } from './core';

// SYS: engine faults, bingo and joker, next-leg weather, and the G and angle-of-
// attack guard (implementation 5.5 combines PROP, FUEL, WX and ENV here).

const LIMITS: EnvelopeLimits = { gMax: 9, gMin: -3, aoaMaxDeg: 26 };

export function bingoFor(posXY: readonly number[], home: readonly number[]): number {
  const d = dist2d(posXY, home);
  return Math.round((2000 + (d / NM) * 9) / 100) * 100;
}

export function createSys(): Agent {
  let said = new Set<string>();
  let lastLimits = -1;
  let overGUntil = 0;
  let aoaUntil = 0;

  const alert = (a: Omit<Alert, 'text' | 'terse' | 'evidence' | 'confidence'> & { evidence?: string[] }): Alert =>
    ({ text: '', terse: '', confidence: 1, evidence: [], ...a });

  return {
    id: 'SYS', tier: 'R', rateHz: 10, budgetMs: 2,
    reads: ['obs.sys'],
    writes: ['alert', 'env.limits'],
    reset() { said = new Set(); lastLimits = -1; overGUntil = 0; aoaUntil = 0; },
    step(s, inbox) {
      const out: BusMessage<unknown>[] = [];
      const own = s.own;
      for (const m of inbox) {
        const e = m.payload as SimEvent;
        if (e.type !== 'engine_fault') continue;
        const side = String(e.data.side ?? 'left');
        const kind = String(e.data.kind ?? '');
        if (kind === 'fire') {
          out.push(msg('alert', alert({
            id: `al-fire-${side}`, level: 'WARNING', cls: 'engine_fire', dedupKey: `fire:${side}`, ttlMs: 60_000,
            slots: { side }, evidence: [m.id], eventWallMs: e.wallMs,
          }), { priority: 0, ttlMs: 5000 }));
        } else {
          const fault = kind === 'oil_pressure' ? 'oil pressure' : kind === 'compressor_stall' ? 'compressor stall' : kind;
          const action = kind === 'flameout' ? 'Relight window below thirty thousand' : 'Reduce throttle';
          out.push(msg('alert', alert({
            id: `al-eng-${side}-${kind}`, level: 'CAUTION', cls: 'engine_fault', dedupKey: `eng:${side}:${kind}`, ttlMs: 60_000,
            slots: { side, fault, action }, evidence: [m.id],
          }), { priority: 2, ttlMs: 5000 }));
        }
      }
      // telemetry monitoring catches what no event announced
      for (const eng of own.engines) {
        if (eng.oilPsi < 20 && eng.mode !== 'shutdown' && eng.mode !== 'flamedout' && !said.has(`oil:${eng.side}`)) {
          said.add(`oil:${eng.side}`);
          out.push(msg('alert', alert({
            id: `al-oil-${eng.side}`, level: 'CAUTION', cls: 'engine_fault', dedupKey: `eng:${eng.side}:oil_pressure`, ttlMs: 60_000,
            slots: { side: eng.side, fault: 'oil pressure', action: 'Reduce throttle' }, evidence: [`${eng.side}-oil`],
          }), { priority: 2, ttlMs: 5000 }));
        }
      }
      // fuel
      const home = s.world.scenario.theater.homePlate;
      const bingo = bingoFor(own.pos, home);
      if (own.fuelLb <= bingo && !said.has('bingo')) {
        said.add('bingo');
        const brg = bearingTo(own.pos, home);
        out.push(msg('alert', alert({
          id: 'al-bingo', level: 'CAUTION', cls: 'bingo', dedupKey: 'bingo', ttlMs: 120_000,
          slots: { bearing: spellHeading(brg), range: rangePhrase(dist2d(own.pos, home)) }, evidence: ['fuel'],
        }), { priority: 3, ttlMs: 5000 }));
      } else if (own.fuelLb <= bingo + 2000 && !said.has('joker')) {
        said.add('joker');
        out.push(msg('alert', alert({ id: 'al-joker', level: 'ADVISORY', cls: 'joker', dedupKey: 'joker', ttlMs: 120_000, slots: {}, evidence: ['fuel'] }), { priority: 6, ttlMs: 5000 }));
      }
      // weather on the next leg
      for (const [i, c] of s.world.scenario.weather.cells.entries()) {
        const d = dist2d(own.pos, c.pos) - c.radiusM;
        const brg = bearingTo(own.pos, c.pos);
        if (d > 0 && d < 20 * NM && angleDiff(brg, own.trackDeg) < 30 && own.altFt < c.topFt && !said.has(`wx:${i}`)) {
          said.add(`wx:${i}`);
          const off = Math.asin(Math.min(1, c.radiusM / dist2d(own.pos, c.pos))) * (180 / Math.PI) + 15;
          const toRoute = s.route[s.activeWp];
          const leftH = wrap360(brg - off), rightH = wrap360(brg + off);
          const pref = toRoute ? (angleDiff(leftH, bearingTo(own.pos, toRoute)) < angleDiff(rightH, bearingTo(own.pos, toRoute)) ? leftH : rightH) : rightH;
          out.push(msg('alert', alert({
            id: `al-wx-${i}`, level: 'ADVISORY', cls: 'weather', dedupKey: `wx:${i}`, ttlMs: 120_000,
            slots: { hazard: 'Thunderstorm', range: rangePhrase(d), heading: spellHeading(pref) }, evidence: [`cell-${i}`],
          }), { priority: 6, ttlMs: 5000 }));
        }
      }
      // envelope guard
      if (own.g > LIMITS.gMax && s.tMs > overGUntil) {
        overGUntil = s.tMs + 3000;
        out.push(msg('alert', alert({ id: `al-overg-${s.tick}`, level: 'WARNING', cls: 'over_g', dedupKey: 'overg', ttlMs: 3000, slots: {}, evidence: ['g'], eventWallMs: s.wallMs }), { priority: 0, ttlMs: 3000 }));
      }
      if (own.aoaDeg > LIMITS.aoaMaxDeg - 2 && s.tMs > aoaUntil) {
        aoaUntil = s.tMs + 3000;
        out.push(msg('alert', alert({ id: `al-aoa-${s.tick}`, level: 'CAUTION', cls: 'aoa', dedupKey: 'aoa', ttlMs: 3000, slots: {}, evidence: ['aoa'] }), { priority: 1, ttlMs: 3000 }));
      }
      if (s.tMs - lastLimits > 1000) {
        lastLimits = s.tMs;
        out.push(msg('env.limits', LIMITS, { priority: 6, ttlMs: 2000 }));
      }
      void FT; void spellNumber;
      return out;
    },
  };
}
