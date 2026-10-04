import {
  DEG, FT, G0, NM, RADARS, Rng, WEAPONS, add, bearingTo, clamp, detectionRangeM, dist2d, norm, ownRcsM2,
  scale, sub, unit, weaponEnvelope, wrap360, type EmitterMode, type ScenarioRed, type Vec3, type WeaponProfile,
} from '@wingmind/shared';
import type { Terrain } from './terrain';

// Red-force entities (spec 3.7 and 13.2). Each one sees the own ship only through
// its own sensor model: a radar detection range from the aspect-dependent signature,
// cut by terrain line of sight. None reads blue agent state.

export interface OwnView { pos: Vec3; vel: Vec3; headingDeg: number; throttle: number; mach: number }

export interface Emission { emitterId: string; pos: Vec3; type: 'fighter' | 'sam_long' | 'sam_short' | 'ew_radar' | 'unknown'; mode: EmitterMode; rangeM: number }

export interface LaunchRequest { from: Vec3; vel: Vec3; weapon: string; launcherId: string; guidance: 'radar' | 'ir' }

/** Can a radar at `site` see the own ship? Uses own signature at the aspect the radar sees. */
export function radarSees(terrain: Terrain, site: Vec3, r0M: number, own: OwnView, fovDeg = 360, boresightDeg = 0): boolean {
  const range = norm(sub(own.pos, site));
  const aspect = bearingTo(own.pos, site) - own.headingDeg;
  const rDet = detectionRangeM(r0M, ownRcsM2(aspect));
  if (range > rDet) return false;
  if (fovDeg < 360) {
    const off = Math.abs(((bearingTo(site, own.pos) - boresightDeg + 540) % 360) - 180);
    if (off > fovDeg) return false;
  }
  return terrain.los(site, own.pos, 5);
}

export class Missile {
  readonly kind = 'missile';
  pos: Vec3; vel: Vec3; t = 0; alive = true; locked = true; hit = false;
  readonly w: WeaponProfile;
  launchWallMs: number;
  constructor(
    readonly id: string, from: Vec3, vel: Vec3, readonly weapon: string, readonly launcherId: string,
    readonly guidance: 'radar' | 'ir', wallMs: number,
  ) {
    this.pos = [...from];
    this.vel = [...vel];
    this.w = WEAPONS[weapon]!;
    this.launchWallMs = wallMs;
  }

  get motorBurning(): boolean {
    return this.t < this.w.boostS + this.w.sustainS;
  }

  /** Proportional navigation toward the target; returns 'hit', 'miss' or null. */
  step(dt: number, target: OwnView, terrain: Terrain, rho: number): 'hit' | 'miss' | null {
    if (!this.alive) return null;
    this.t += dt;
    const w = this.w;
    const speed = Math.max(norm(this.vel), 1);
    const fwd = unit(this.vel);
    const accelMotor = this.t < w.boostS ? w.boostAccel : this.t < w.boostS + w.sustainS ? w.sustainAccel : 0;
    const dragAccel = (0.5 * rho * speed * speed * 0.35 * 0.03) / 150;   // generic body, 150 kg
    let lat: Vec3 = [0, 0, 0];
    const rel = sub(target.pos, this.pos);
    const range = norm(rel);
    if (this.locked) {
      const off = Math.acos(clamp((rel[0] * fwd[0] + rel[1] * fwd[1] + rel[2] * fwd[2]) / Math.max(range, 1), -1, 1)) / DEG;
      if (off > w.gimbalDeg) this.locked = false;
    }
    if (this.locked) {
      const relV = sub(target.vel, this.vel);
      const r2 = Math.max(range * range, 1);
      // LOS rotation rate omega = (r x v) / r^2 ; a = N * Vc * (omega x r_hat)
      const omega: Vec3 = [
        (rel[1] * relV[2] - rel[2] * relV[1]) / r2,
        (rel[2] * relV[0] - rel[0] * relV[2]) / r2,
        (rel[0] * relV[1] - rel[1] * relV[0]) / r2,
      ];
      const closing = -(rel[0] * relV[0] + rel[1] * relV[1] + rel[2] * relV[2]) / Math.max(range, 1);
      const rHat = unit(rel);
      const a: Vec3 = [
        omega[1] * rHat[2] - omega[2] * rHat[1],
        omega[2] * rHat[0] - omega[0] * rHat[2],
        omega[0] * rHat[1] - omega[1] * rHat[0],
      ];
      lat = scale(a, w.navConst * Math.max(closing, 50));
      lat[2] += G0;                                                          // gravity compensation
      const maxA = w.maxG * G0 * clamp(speed / 600, 0.25, 1);
      const la = norm(lat);
      if (la > maxA) lat = scale(lat, maxA / la);
    }
    const acc = add(add(scale(fwd, accelMotor - dragAccel), lat), [0, 0, -G0]);
    const prev = this.pos;
    this.vel = add(this.vel, scale(acc, dt));
    this.pos = add(this.pos, scale(this.vel, dt));
    // closest approach within this step for the proximity fuze
    const after = norm(sub(target.pos, this.pos));
    if (Math.min(range, after) < w.fuzeM && this.locked) {
      this.alive = false;
      this.hit = true;
      return 'hit';
    }
    if (this.t > w.maxTimeS || norm(this.vel) < 200 && this.t > w.boostS + w.sustainS || this.pos[2] < terrain.height(this.pos[0], this.pos[1])) {
      this.alive = false;
      return 'miss';
    }
    // passed the target and opening fast: no re-attack
    if (this.t > 2 && after > range && range < 2000 && !this.hit) {
      this.alive = false;
      return 'miss';
    }
    void prev;
    return null;
  }

  /** A decoy dispensed by the target may break lock. Beam geometry helps the decoy. */
  decoy(kind: 'chaff' | 'flare', target: OwnView, rng: Rng): boolean {
    if (!this.alive || !this.locked) return false;
    if ((kind === 'chaff') !== (this.guidance === 'radar')) return false;
    const toMissile = bearingTo(target.pos, this.pos);
    const aspect = Math.abs(((toMissile - target.headingDeg + 540) % 360) - 180);
    const beam = 1 - Math.abs(aspect - 90) / 90;                  // 1 when the missile is on the beam
    const p = this.w.cmSusceptibility * (0.6 + 1.4 * beam);
    if (rng.chance(p)) {
      this.locked = false;
      return true;
    }
    return false;
  }
}

export class SamSite {
  state: 'silent' | 'search' | 'track' | 'engage' | 'reload' = 'search';
  missiles: number;
  private cooldown = 0;
  private trackT = 0;
  readonly pos: Vec3;
  constructor(readonly id: string, readonly kind: 'sam_long' | 'sam_short', pos2: readonly number[], terrain: Terrain, readonly cfg: ScenarioRed) {
    this.pos = [pos2[0]!, pos2[1]!, terrain.height(pos2[0]!, pos2[1]!) + 8];
    this.missiles = kind === 'sam_long' ? 4 : 6;
    if (cfg.emcon === 'silent_until_cued' || cfg.active === false || kind === 'sam_short') this.state = 'silent';
  }

  activate(): void {
    if (this.state === 'silent' && this.kind === 'sam_long') this.state = 'search';
  }

  step(dt: number, own: OwnView, terrain: Terrain, cued: boolean): LaunchRequest | null {
    this.cooldown = Math.max(0, this.cooldown - dt);
    if (this.kind === 'sam_short') return this.stepShort(own, terrain);
    if (this.state === 'silent') {
      if (cued) this.state = 'search';
      else return null;
    }
    const r0 = RADARS.sam_long!.r0M;
    const sees = radarSees(terrain, this.pos, r0, own);
    const range = norm(sub(own.pos, this.pos));
    if (!sees) {
      this.trackT = 0;
      if (this.state === 'track' || this.state === 'engage') this.state = 'search';
      return null;
    }
    if (this.state === 'search') this.state = 'track';
    if (this.state === 'track' || this.state === 'engage' || this.state === 'reload') {
      this.trackT += dt;
      if (this.state === 'reload' && this.cooldown === 0) this.state = 'track';
      const env = weaponEnvelope(WEAPONS.sam_radar!, own.pos[2] / FT);
      if (this.state === 'track' && this.trackT > 6 && range < env.rMaxM * 0.85 && this.missiles > 0 && this.cooldown === 0) {
        this.missiles--;
        this.state = 'engage';
        this.cooldown = 25;
        const dir = unit(sub(add(own.pos, scale(own.vel, 8)), this.pos));
        return { from: add(this.pos, [0, 0, 20]), vel: scale(dir, 120), weapon: 'sam_radar', launcherId: this.id, guidance: 'radar' };
      }
    }
    return null;
  }

  private stepShort(own: OwnView, terrain: Terrain): LaunchRequest | null {
    if (this.cfg.active === false || this.missiles <= 0 || this.cooldown > 0) return null;
    const range = norm(sub(own.pos, this.pos));
    const env = weaponEnvelope(WEAPONS.sam_ir!, own.pos[2] / FT);
    if (range > env.rMaxM * 0.9 || !terrain.los(this.pos, own.pos, 3)) return null;
    this.missiles--;
    this.cooldown = 12;
    const dir = unit(sub(own.pos, this.pos));
    return { from: add(this.pos, [0, 0, 5]), vel: scale(dir, 80), weapon: 'sam_ir', launcherId: this.id, guidance: 'ir' };
  }

  emission(): Emission | null {
    if (this.kind === 'sam_short' || this.state === 'silent') return null;
    const mode: EmitterMode = this.state === 'search' ? 'search' : this.state === 'engage' ? 'guidance' : 'track';
    return { emitterId: this.id, pos: this.pos, type: 'sam_long', mode, rangeM: RADARS.sam_long!.r0M * 1.6 };
  }
}

export class Fighter {
  pos: Vec3; vel: Vec3; headingDeg: number; alive = true;
  state: 'patrol' | 'commit' | 'launch' | 'crank' | 'disengage' = 'patrol';
  missiles = 4;
  private t = 0;
  private cooldown = 0;
  private reaction = 0;
  private guiding: string | null = null;
  constructor(readonly id: string, cap: Vec3, offset: number, readonly skill: number, private rng: Rng, active: boolean) {
    this.pos = [cap[0] + offset * 1500, cap[1] + offset * 800, cap[2] * FT];
    this.headingDeg = 270;
    this.vel = [-230, 0, 0];
    if (!active) this.state = 'patrol';
  }

  commit(): void {
    if (this.state === 'patrol') this.state = 'commit';
  }

  step(dt: number, own: OwnView, terrain: Terrain, liveMissiles: Missile[], cap: Vec3): LaunchRequest | null {
    if (!this.alive) return null;
    this.t += dt;
    this.cooldown = Math.max(0, this.cooldown - dt);
    const range = norm(sub(own.pos, this.pos));
    const sees = radarSees(terrain, this.pos, RADARS.fighter_gen4!.r0M, own, RADARS.fighter_gen4!.fovDeg, this.headingDeg);
    if (sees && this.state === 'patrol') {
      this.reaction += dt;
      if (this.reaction > 4 - this.skill * 3) this.state = 'commit';
    }
    const myMissile = liveMissiles.find(m => m.launcherId === this.id && m.alive);
    this.guiding = myMissile ? myMissile.id : null;
    let desiredHdg = this.headingDeg;
    let speed = 240;
    let alt = this.pos[2];
    let launch: LaunchRequest | null = null;
    switch (this.state) {
      case 'patrol': {
        // racetrack around the CAP point
        const toCap = bearingTo(this.pos, cap);
        const d = dist2d(this.pos, cap);
        desiredHdg = d > 15_000 ? toCap : wrap360(toCap + 90);
        alt = cap[2] * FT;
        break;
      }
      case 'commit':
      case 'launch': {
        desiredHdg = bearingTo(this.pos, own.pos);
        speed = 300;
        alt = Math.max(own.pos[2] + 1500, 6000);
        const env = weaponEnvelope(WEAPONS.aam_radar!, this.pos[2] / FT);
        const launchFrac = 0.55 + 0.3 * this.skill;
        if (sees && range < env.rMaxM * launchFrac && this.missiles > 0 && this.cooldown === 0 && !myMissile) {
          this.missiles--;
          this.cooldown = 30;
          this.state = 'crank';
          const dir = unit(sub(own.pos, this.pos));
          launch = { from: add(this.pos, scale(dir, 15)), vel: add(this.vel, scale(dir, 40)), weapon: 'aam_radar', launcherId: this.id, guidance: 'radar' };
        }
        break;
      }
      case 'crank': {
        // support the missile while turning 50 degrees off
        desiredHdg = wrap360(bearingTo(this.pos, own.pos) + 50);
        if (!myMissile && this.cooldown < 20) this.state = this.missiles > 0 ? 'commit' : 'disengage';
        break;
      }
      case 'disengage':
        desiredHdg = wrap360(bearingTo(this.pos, own.pos) + 180);
        speed = 320;
        break;
    }
    if (this.t > 900 && this.state !== 'disengage') this.state = 'disengage';
    const err = ((desiredHdg - this.headingDeg + 540) % 360) - 180;
    this.headingDeg = wrap360(this.headingDeg + clamp(err, -12 * dt, 12 * dt));
    const ground = terrain.height(this.pos[0], this.pos[1]) + 300;
    const climb = clamp((Math.max(alt, ground) - this.pos[2]) * 0.2, -60, 60);
    const h = this.headingDeg * DEG;
    this.vel = [Math.sin(h) * speed, Math.cos(h) * speed, climb];
    this.pos = add(this.pos, scale(this.vel, dt));
    void this.rng;
    return launch;
  }

  emission(own: OwnView, terrain: Terrain): Emission | null {
    if (!this.alive) return null;
    const mode: EmitterMode = this.guiding ? 'guidance' : this.state === 'commit' || this.state === 'launch' ? 'track' : 'search';
    // fighter radar is directional: only illuminates own ship inside its scan cone
    const off = Math.abs(((bearingTo(this.pos, own.pos) - this.headingDeg + 540) % 360) - 180);
    if (off > (mode === 'search' ? 60 : 70)) return null;
    if (!terrain.los(this.pos, own.pos, 0)) return null;
    return { emitterId: this.id, pos: this.pos, type: 'fighter', mode, rangeM: RADARS.fighter_gen4!.r0M * 1.5 };
  }
}

export class Drone {
  pos: Vec3; vel: Vec3; alive = true;
  constructor(readonly id: string, pos: Vec3, vel: Vec3) {
    this.pos = pos;
    this.vel = vel;
  }
}

/** Five drones flocking toward a shared target (separation, alignment, cohesion). */
export class DroneSwarm {
  drones: Drone[] = [];
  launched: boolean;
  constructor(readonly id: string, readonly cfg: ScenarioRed, terrain: Terrain, rng: Rng) {
    const n = cfg.count ?? 5;
    const p = cfg.pos ?? [0, 0];
    const altM = (cfg.altFt ?? 1500) * FT;
    for (let i = 0; i < n; i++) {
      const x = p[0] + rng.range(-400, 400), y = p[1] + rng.range(-400, 400);
      this.drones.push(new Drone(`${id}-${i + 1}`, [x, y, Math.max(altM, terrain.height(x, y) + 150)], [0, 0, 0]));
    }
    this.launched = cfg.active !== false;
  }

  step(dt: number, terrain: Terrain): void {
    if (!this.launched) return;
    const target = this.cfg.target ?? [0, 0];
    const altM = (this.cfg.altFt ?? 1500) * FT;
    const live = this.drones.filter(d => d.alive);
    const c: Vec3 = [0, 0, 0];
    for (const d of live) { c[0] += d.pos[0] / live.length; c[1] += d.pos[1] / live.length; c[2] += d.pos[2] / live.length; }
    for (const d of live) {
      const toT = unit([target[0] - d.pos[0], target[1] - d.pos[1], 0]);
      const coh = scale(sub(c, d.pos), 0.002);
      let sep: Vec3 = [0, 0, 0];
      for (const o of live) {
        if (o === d) continue;
        const r = sub(d.pos, o.pos);
        const dd = norm(r);
        if (dd < 250) sep = add(sep, scale(r, (250 - dd) / Math.max(dd, 1) * 0.02));
      }
      const desired = add(add(scale(toT, 45), coh), sep);
      const floor = terrain.height(d.pos[0], d.pos[1]) + 150;
      desired[2] = clamp((Math.max(altM, floor) - d.pos[2]) * 0.3, -10, 10);
      d.vel = add(scale(d.vel, 0.95), scale(desired, 0.05));
      d.pos = add(d.pos, scale(d.vel, dt));
      if (dist2d(d.pos, target) < 300) d.alive = false;    // reached its target point
    }
  }
}

export class Decoy {
  t = 0;
  constructor(readonly id: string, readonly kind: 'chaff' | 'flare', public pos: Vec3, public vel: Vec3) {}
  step(dt: number): boolean {
    this.t += dt;
    this.vel = scale(this.vel, 0.97);
    this.vel[2] -= (this.kind === 'flare' ? 4 : 1) * dt;
    this.pos = add(this.pos, scale(this.vel, dt));
    return this.t < (this.kind === 'flare' ? 5 : 8);
  }
}

export const nmToM = (nm: number): number => nm * NM;
