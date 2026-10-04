import {
  DEG, FT, G0, NM, angleDiff, bearingTo, clamp, clockPhrase, dist2d, rangePhrase, relBearing, spellNumber, wrap180, wrap360,
  type Alert, type BusMessage, type GbadRing, type Intent, type Threat, type Vec3,
} from '@wingmind/shared';
import type { Terrain } from '@wingmind/sim-core';
import { SAFETY } from './arbiter';
import { advise, msg, type Agent, type BeamEval, type Snapshot } from './core';

// NAV: ground-collision projection, obstacle calls, beam-turn terrain checks and
// an A* planner on a 1 km grid (implementation 5.5, spec 7.5).

const GCAS_BUFFER_M = 150 * FT;

/**
 * Minimum terrain clearance along a recovery: roll wings level at 180 deg/s,
 * then pull at `pullG`, starting after `delayS` of the current flight path.
 */
export function recoveryClearance(terrain: Terrain, pos: Vec3, vel: Vec3, rollDeg: number, delayS: number, pullG = 5): number {
  let [x, y, z] = pos;
  let vx = vel[0], vy = vel[1], vz = vel[2];
  const speed = Math.max(Math.hypot(vx, vy, vz), 50);
  let gamma = Math.asin(clamp(vz / speed, -1, 1));
  let roll = Math.abs(rollDeg);
  const hdg = Math.atan2(vx, vy);
  let t = 0;
  let minClear = Infinity;
  const dt = 0.1;
  while (t < delayS + 9) {
    if (t >= delayS) {
      if (roll > 1) roll = Math.max(0, roll - 180 * dt);
      else gamma = Math.min(gamma + ((pullG - Math.cos(gamma)) * G0 / speed) * dt, 30 * DEG);
    } else if (roll > 60) {
      // banked past 60 degrees with no pull: the nose drops
      gamma -= (G0 * Math.cos(gamma) * (1 - Math.cos(roll * DEG)) / speed) * dt;
    }
    x += Math.sin(hdg) * Math.cos(gamma) * speed * dt;
    y += Math.cos(hdg) * Math.cos(gamma) * speed * dt;
    z += Math.sin(gamma) * speed * dt;
    const clear = z - terrain.height(x, y);
    if (clear < minClear) minClear = clear;
    if (t > delayS && gamma > 10 * DEG && clear > 300) break;
    t += dt;
  }
  void vx; void vy; void vz;
  return minClear;
}

/** Highest terrain (m) along a turn to `targetHdg` at `g`, then straight, for `durationS`. */
export function turnPathMaxTerrain(terrain: Terrain, pos: Vec3, speed: number, hdgDeg: number, targetHdg: number, side: 'left' | 'right', g: number, durationS: number): number {
  const rate = (G0 * Math.sqrt(Math.max(g * g - 1, 0.1))) / Math.max(speed, 50);    // rad/s
  let h = hdgDeg * DEG;
  const target = targetHdg * DEG;
  let x = pos[0], y = pos[1];
  let maxH = -Infinity;
  const dt = 0.25;
  let remaining = Math.abs(wrap180(targetHdg - hdgDeg)) * DEG;
  if (side === 'left' && wrap180(targetHdg - hdgDeg) > 0) remaining = 2 * Math.PI - remaining;
  if (side === 'right' && wrap180(targetHdg - hdgDeg) < 0) remaining = 2 * Math.PI - remaining;
  for (let t = 0; t < durationS; t += dt) {
    if (remaining > 0) {
      const step = Math.min(remaining, rate * dt);
      h += side === 'right' ? step : -step;
      remaining -= step;
    } else h = target;
    x += Math.sin(h) * speed * dt;
    y += Math.cos(h) * speed * dt;
    maxH = Math.max(maxH, terrain.height(x, y));
  }
  return maxH;
}

export function evaluateBeam(s: Snapshot, threatId: string, threatBrg: number): BeamEval {
  const own = s.own;
  const terrain = s.world.terrain;
  const speed = Math.max(own.tasKt * 0.5144, 100);
  const opts = ([['right', wrap360(threatBrg - 90)], ['left', wrap360(threatBrg + 90)]] as const).map(([_, h]) => {
    const delta = wrap180(h - own.headingDeg);
    const side: 'left' | 'right' = delta >= 0 ? 'right' : 'left';
    const maxT = turnPathMaxTerrain(terrain, own.pos, speed, own.headingDeg, h, side, 6, 10);
    const blocked = maxT + 300 * FT > own.pos[2];
    return { side, headingDeg: h, turn: Math.abs(delta), blocked, maxT };
  });
  // both candidates are 180 degrees apart; prefer unblocked, then the smaller turn
  opts.sort((a, b) => Number(a.blocked) - Number(b.blocked) || (a.blocked && b.blocked ? a.maxT - b.maxT : a.turn - b.turn));
  const best = opts[0]!;
  const other = opts[1]!;
  const blocked = { left: false, right: false };
  for (const o of opts) blocked[o.side] = o.blocked;
  const why = other.blocked && !best.blocked
    ? `NAV: ${other.side} blocked by rising terrain, break ${best.side}`
    : best.blocked ? `NAV: both beams near terrain, break ${best.side} and climb` : `NAV: break ${best.side}, shorter turn`;
  return { threatId, side: best.side, headingDeg: best.headingDeg, blocked, why };
}

// ---------- A* on a 1 km grid ----------

export interface PlanResult { route: Vec3[]; lengthM: number }

export function planRoute(terrain: Terrain, rings: GbadRing[], from: Vec3, to: readonly number[], altFt: number, cellM = 1000): PlanResult | null {
  const [xmin, ymin, xmax, ymax] = terrain.spec.bounds;
  const nx = Math.ceil((xmax - xmin) / cellM), ny = Math.ceil((ymax - ymin) / cellM);
  const idx = (i: number, j: number) => j * nx + i;
  const toCell = (x: number, y: number): [number, number] => [clamp(Math.floor((x - xmin) / cellM), 0, nx - 1), clamp(Math.floor((y - ymin) / cellM), 0, ny - 1)];
  const center = (i: number, j: number): [number, number] => [xmin + (i + 0.5) * cellM, ymin + (j + 0.5) * cellM];
  const ringCost = (x: number, y: number): number => {
    let c = 0;
    for (const r of rings) {
      const d = Math.hypot(x - r.pos[0], y - r.pos[1]);
      const brg = bearingTo(r.pos, [x, y]);
      const k = Math.round(brg / (360 / r.radii.length)) % r.radii.length;
      const rad = r.radii[k] ?? 0;
      if (d < rad) c += 40 * (1 - d / Math.max(rad, 1)) + 20;
    }
    return c;
  };
  const altM = altFt * FT;
  const [si, sj] = toCell(from[0], from[1]);
  const [gi, gj] = toCell(to[0]!, to[1]!);
  const g = new Float32Array(nx * ny).fill(Infinity);
  const came = new Int32Array(nx * ny).fill(-1);
  const open: [number, number][] = [[idx(si, sj), 0]];
  g[idx(si, sj)] = 0;
  const h = (i: number, j: number) => Math.hypot(i - gi, j - gj);
  let iterations = 0;
  while (open.length && iterations++ < 40_000) {
    // small grids: a linear scan for the minimum is fast enough
    let bi = 0;
    for (let k = 1; k < open.length; k++) if (open[k]![1] < open[bi]![1]) bi = k;
    const [cur] = open.splice(bi, 1)[0]!;
    const ci = cur % nx, cj = Math.floor(cur / nx);
    if (ci === gi && cj === gj) break;
    for (let di = -1; di <= 1; di++) for (let dj = -1; dj <= 1; dj++) {
      if (!di && !dj) continue;
      const ni = ci + di, nj = cj + dj;
      if (ni < 0 || nj < 0 || ni >= nx || nj >= ny) continue;
      const [x, y] = center(ni, nj);
      if (terrain.height(x, y) + 150 > altM) continue;            // terrain blocks this cell at the planned altitude
      const step = Math.hypot(di, dj);
      const cost = g[cur]! + step * (1 + ringCost(x, y));
      const n = idx(ni, nj);
      if (cost < g[n]!) {
        g[n] = cost;
        came[n] = cur;
        open.push([n, cost + h(ni, nj)]);
      }
    }
  }
  const goal = idx(gi, gj);
  if (came[goal] === -1 && goal !== idx(si, sj)) return null;
  const cells: number[] = [];
  for (let c = goal; c !== -1; c = came[c]!) cells.push(c);
  cells.reverse();
  // thin the path: keep turning points only
  const pts: Vec3[] = [];
  let lastDir = '';
  cells.forEach((c, k) => {
    const [x, y] = center(c % nx, Math.floor(c / nx));
    const next = cells[k + 1];
    const dir = next === undefined ? 'end' : `${(next % nx) - (c % nx)},${Math.floor(next / nx) - Math.floor(c / nx)}`;
    if (k > 0 && (dir !== lastDir || next === undefined)) pts.push([x, y, altFt]);
    lastDir = dir;
  });
  pts.push([to[0]!, to[1]!, altFt]);
  let len = 0;
  let prev: readonly number[] = from;
  for (const p of pts) { len += dist2d(prev, p); prev = p; }
  return { route: pts, lengthM: len };
}

export function createNav(): Agent {
  let route: Vec3[] | null = null;
  let activeWp = 0;
  let proposed: { route: Vec3[]; addedMin: number; fuelOk: boolean } | null = null;
  let announcedTowers = new Set<number>();
  let lastRoutePublish = -1;
  let gcasActive = false;

  return {
    id: 'NAV', tier: 'R', rateHz: 20, budgetMs: 2,
    reads: ['threat.missile', 'intent.nav'],
    writes: ['advice', 'alert', 'nav.beam', 'nav.route'],
    reset() { route = null; activeWp = 0; proposed = null; announcedTowers = new Set(); lastRoutePublish = -1; gcasActive = false; },
    step(s, inbox) {
      const out: BusMessage<unknown>[] = [];
      const own = s.own;
      const terrain = s.world.terrain;
      route ??= s.world.scenario.route.map(p => [...p] as Vec3);
      let routeChanged = false;

      // ----- ground collision avoidance (every tick) -----
      const clearNow = recoveryClearance(terrain, own.pos, own.vel, own.rollDeg, 0);
      const clearLate = recoveryClearance(terrain, own.pos, own.vel, own.rollDeg, 2);
      if (clearLate < GCAS_BUFFER_M) {
        const al: Alert = {
          id: `al-pullup-${s.tick}`, level: 'WARNING', cls: 'pull_up', text: '', terse: '', dedupKey: 'pullup', ttlMs: 4000,
          evidence: ['terrain'], confidence: 1, slots: {}, eventWallMs: s.wallMs,
        };
        out.push(msg('alert', al, { priority: 0, ttlMs: 4000 }));
      }
      if (clearNow < GCAS_BUFFER_M + 20 && !gcasActive) {
        gcasActive = true;
        out.push(advise({
          axis: 'altitude', value: { flyup: true }, utility: 1, safetyRank: SAFETY.groundCollision, source: 'NAV',
          evidence: ['terrain'], ttlMs: 4000,
        }, 0));
      } else if (clearNow > GCAS_BUFFER_M * 3) gcasActive = false;

      // ----- obstacles -----
      s.world.scenario.theater.towers.forEach((t, i) => {
        const d = dist2d(own.pos, t.pos);
        const brg = bearingTo(own.pos, t.pos);
        const rel = relBearing(brg, own.headingDeg);
        const topM = terrain.height(t.pos[0], t.pos[1]) + t.heightFt * FT;
        if (d < 2.5 * NM && Math.abs(rel) < 30 && own.pos[2] < topM + 500 * FT && !announcedTowers.has(i)) {
          announcedTowers.add(i);
          const al: Alert = {
            id: `al-tower-${i}`, level: 'CAUTION', cls: 'obstacle', text: '', terse: '', dedupKey: `tower:${i}`, ttlMs: 60_000,
            bearingDeg: rel, evidence: [`tower-${i}`], confidence: 1,
            slots: { obstacle: 'Tower', clockOclock: clockPhrase(rel, 'oclock'), range: rangePhrase(d), height: `${spellNumber(Math.round(t.heightFt / 100) * 100)} feet` },
          };
          out.push(msg('alert', al, { priority: 2, ttlMs: 3000 }));
        }
        if (d > 4 * NM) announcedTowers.delete(i);
      });

      // ----- missile beam evaluation (woken by MAWS in the same tick) -----
      for (const m of inbox) {
        if (m.topic === 'threat.missile' && m.priority === 0) {
          const t = m.payload as Threat;
          if (t.bearingDeg === undefined) continue;
          out.push(msg('nav.beam', evaluateBeam(s, t.id, t.bearingDeg), { priority: 0, ttlMs: 8000, evidence: [m.id] }));
        }
        if (m.topic === 'intent.nav') {
          const it = m.payload as Intent;
          const home = s.world.scenario.theater.homePlate;
          if (it.intent === 'nav.direct' && typeof it.params.waypoint === 'number') {
            activeWp = clamp(it.params.waypoint - 1, 0, route.length - 1);
            routeChanged = true;
          } else if (it.intent === 'nav.home') {
            route = [[home[0], home[1], Math.max(own.altFt, 15_000)]];
            activeWp = 0;
            routeChanged = true;
          } else if (it.intent === 'nav.replan') {
            const goal = route[route.length - 1] ?? [home[0], home[1], own.altFt];
            const direct = dist2d(own.pos, goal);
            const plan = planRoute(terrain, s.gbadRings, own.pos, goal, Math.max(own.altFt, 3000));
            if (plan) {
              const speedMps = Math.max(own.tasKt * 0.5144, 150);
              const addedMin = Math.max(0, Math.round((plan.lengthM - direct) / speedMps / 60));
              const extraFuel = (addedMin / 60) * own.engines.reduce((a, e) => a + e.fuelFlowPph, 0);
              const fuelOk = own.fuelLb - extraFuel > 4000;
              proposed = { route: plan.route, addedMin, fuelOk };
              const al: Alert = {
                id: `al-route-${s.tick}`, level: 'STATUS', cls: 'readback', dedupKey: `route:${s.tick}`, ttlMs: 10_000,
                text: `New route avoids the SAM, adds ${spellNumber(addedMin)} minutes, fuel is ${fuelOk ? 'fine' : 'tight'}. Accept?`,
                terse: 'New route. Accept?', evidence: ['gbad.rings'], confidence: 1,
              };
              out.push(msg('alert', al, { priority: 2, ttlMs: 5000 }));
              routeChanged = true;
            } else {
              const al: Alert = { id: `al-noroute-${s.tick}`, level: 'STATUS', cls: 'readback', dedupKey: `noroute:${s.tick}`, ttlMs: 5000, text: 'Unable, no route.', terse: 'Unable.', evidence: [], confidence: 1 };
              out.push(msg('alert', al, { priority: 2, ttlMs: 5000 }));
            }
          } else if (it.intent === 'nav.accept' && proposed) {
            route = proposed.route;
            activeWp = 0;
            proposed = null;
            routeChanged = true;
            const al: Alert = { id: `al-acc-${s.tick}`, level: 'STATUS', cls: 'readback', dedupKey: `acc:${s.tick}`, ttlMs: 5000, text: 'Route accepted.', terse: 'Accepted.', evidence: [], confidence: 1 };
            out.push(msg('alert', al, { priority: 2, ttlMs: 5000 }));
          } else if (it.intent === 'nav.reject' && proposed) {
            proposed = null;
            routeChanged = true;
            const al: Alert = { id: `al-rej-${s.tick}`, level: 'STATUS', cls: 'readback', dedupKey: `rej:${s.tick}`, ttlMs: 5000, text: 'Route cancelled.', terse: 'Cancelled.', evidence: [], confidence: 1 };
            out.push(msg('alert', al, { priority: 2, ttlMs: 5000 }));
          }
        }
      }

      // ----- waypoint sequencing and steering cue -----
      const wp = route[activeWp];
      if (wp && dist2d(own.pos, wp) < 2500 && activeWp < route.length - 1) { activeWp++; routeChanged = true; }
      const target = route[activeWp];
      if (target) {
        const brg = bearingTo(own.pos, target);
        if (angleDiff(brg, own.headingDeg) > 3) {
          out.push(advise({
            axis: 'heading', value: { mode: 'steer', headingDeg: brg, waypoint: activeWp + 1 }, utility: 0.3,
            safetyRank: SAFETY.navigation, source: 'NAV', evidence: [`wp-${activeWp + 1}`], ttlMs: 1500,
          }, 8));
        }
      }
      if (routeChanged || s.tMs - lastRoutePublish > 1000) {
        out.push(msg('nav.route', { route, activeWp, proposed }, { priority: 7, ttlMs: 2000 }));
        lastRoutePublish = s.tMs;
      }
      return out;
    },
  };
}
