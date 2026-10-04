import {
  AIRFRAME, DEG, FT, KT, LB, NM, Rng, bearingTo, bearingVec, clamp, dist2d, norm, qFromEuler, scale, sub, unit, wrap360,
  type Controls, type Directive, type Emcon, type EngineFault, type InjectEvent, type OwnState, type RenderEntity,
  type RenderFrame, type RwrEmitter, type Scenario, type SimEvent, type SimEventType, type SimSnapshot,
  type SortieOutcome, type Vec3,
} from '@wingmind/shared';
import { Weather, casFromTas, isa, tasFromCas } from './atmosphere';
import { Engine, throttleForThrust } from './engines';
import { Decoy, DroneSwarm, Fighter, Missile, SamSite, type Emission, type LaunchRequest, type OwnView } from './entities';
import { FlightModel, bankForHeading, nzForAltitude, rollRateForBank } from './flight';
import { FuelSystem } from './fuel';
import { SensorSuite, type SensorTarget } from './sensors';
import { Terrain } from './terrain';

export const SIM_HZ = 120;
export const FRAME_HZ = 60;

export type Clock = () => number;
export const wallClock: Clock = () => performance.timeOrigin + performance.now();

interface VirtualEmitter { id: string; pos: Vec3; missileId: string; type: Emission['type'] }

/**
 * The simulation core: owns ground truth, steps at 120 Hz in two sub-steps per
 * 60 Hz frame, and exposes the world only through sensor snapshots (to agents)
 * and render frames (to the console and recorder).
 */
export class World {
  readonly terrain: Terrain;
  readonly weather: Weather;
  readonly fm: FlightModel;
  readonly engines: [Engine, Engine];
  readonly fuel: FuelSystem;
  readonly sensors: SensorSuite;
  tick = 0;
  tMs = 0;
  version = 0;
  controls: Controls = { pitch: 0, roll: 0, throttle: null };
  throttle: number;
  ap: { heading?: number; altFt?: number; kcas?: number; flyup: boolean; bankMax: number } = { flyup: false, bankMax: 60 };
  emcon: Emcon = 0;
  cm: { chaff: number; flares: number; decoys: number };
  gcasAuto: boolean;
  missiles: Missile[] = [];
  sams: SamSite[] = [];
  fighters: Fighter[] = [];
  swarms: DroneSwarm[] = [];
  decoys: Decoy[] = [];
  virtual: VirtualEmitter[] = [];
  outcome: SortieOutcome | null = null;
  activeWp = 0;
  gMax = 1;
  private pendingEvents: SimEvent[] = [];
  private frameObs: SimSnapshot['obs'] = [];
  private rwrForce = false;
  private rng: Rng;
  private seq = 0;
  private firedTriggers = new Set<number>();
  private lastOwn: OwnState;
  readonly events: SimEvent[] = [];        // full log for metrics
  private aeroAlpha = 0;
  private atInt = 0.5;
  private aeroG = 1;
  private aeroMach = 0.7;
  private emptyLb: number;

  constructor(readonly scenario: Scenario, readonly seed: number, terrain?: Terrain, readonly clock: Clock = wallClock) {
    this.rng = new Rng(seed);
    this.terrain = terrain ?? new Terrain(scenario.theater.terrain);
    this.weather = new Weather(scenario.weather, seed);
    const o = scenario.own;
    const altM = o.altFt * FT;
    const groundM = this.terrain.height(o.pos[0], o.pos[1]);
    const startAlt = Math.max(altM, groundM + 150);
    const air = isa(startAlt, scenario.weather.isaDeltaC);
    const tas = tasFromCas(o.kcas * KT, air);
    this.emptyLb = (AIRFRAME.emptyMassKg + AIRFRAME.storesKg) / LB;
    this.fuel = new FuelSystem(o.fuelLb);
    this.fm = new FlightModel([o.pos[0], o.pos[1], startAlt], o.headingDeg, tas, this.massKg());
    this.fm.isaDeltaC = scenario.weather.isaDeltaC;
    // start trimmed: dry throttle that balances drag, engines already spooled to it
    this.throttle = throttleForThrust(this.fm.trimDragN / 2, tas / air.a, air);
    this.atInt = this.throttle;
    this.engines = [new Engine('left', this.throttle), new Engine('right', this.throttle)];
    this.cm = { ...o.cm };
    this.gcasAuto = scenario.settings.gcasAuto;
    this.ap = { heading: o.headingDeg, altFt: startAlt / FT, kcas: o.kcas, flyup: false, bankMax: 60 };
    const dl = scenario.friendly.find(f => f.type === 'awacs');
    this.sensors = new SensorSuite(seed, scenario.settings.falseAlarmPerMin, dl ? dl.latencyS : null);
    for (const r of scenario.red) this.spawnRed(r);
    this.lastOwn = this.ownState();
  }

  private massKg(): number {
    return AIRFRAME.emptyMassKg + AIRFRAME.storesKg + this.fuel.totalLb * LB;
  }

  private spawnRed(r: Scenario['red'][number]): void {
    switch (r.type) {
      case 'sam_long':
      case 'sam_short':
        if (r.pos) this.sams.push(new SamSite(r.id, r.type, r.pos, this.terrain, r));
        break;
      case 'fighter_gen4': {
        const cap = r.cap ?? [60_000, 0, 25_000];
        for (let i = 0; i < (r.count ?? 1); i++) {
          this.fighters.push(new Fighter(`${r.id}-${i + 1}`, cap, i, r.skill ?? 0.5, this.rng.fork(i + 10), r.active !== false));
        }
        break;
      }
      case 'drone_swarm':
        this.swarms.push(new DroneSwarm(r.id, r, this.terrain, this.rng.fork(77)));
        break;
    }
  }


  private event(type: SimEventType, data: Record<string, unknown>): SimEvent {
    const e: SimEvent = { id: `ev${++this.seq}`, type, tick: this.tick, wallMs: this.clock(), data };
    this.pendingEvents.push(e);
    this.events.push(e);
    return e;
  }

  // ---------- inputs ----------

  setControls(c: Partial<Controls>): void {
    this.controls = { ...this.controls, ...c };
    if (Math.abs(this.controls.pitch) > 0.1 && !this.ap.flyup) delete this.ap.altFt;
    if (Math.abs(this.controls.roll) > 0.1 && !this.ap.flyup) delete this.ap.heading;
    if (c.throttle !== undefined && c.throttle !== null) {
      delete this.ap.kcas;
      this.throttle = clamp(c.throttle, 0, 1);
    }
  }

  inject(ev: InjectEvent): void {
    switch (ev.type) {
      case 'missile_launch': {
        const own = this.fm.s;
        const hdg = this.fm.euler.headingDeg;
        const brg = wrap360(hdg + ev.bearingRelDeg);
        const v = bearingVec(brg);
        const r = ev.rangeNm * NM;
        // launch from an altitude with line of sight to the own ship over any ridge in between
        let zMin = this.terrain.height(own.pos[0] + v[0] * r, own.pos[1] + v[1] * r) + 50;
        for (let k = 1; k <= 64; k++) {
          const d = (r * k) / 65;
          const h = this.terrain.height(own.pos[0] + v[0] * d, own.pos[1] + v[1] * d) + 120;
          if (h > own.pos[2]) zMin = Math.max(zMin, own.pos[2] + ((h - own.pos[2]) * r) / d);
        }
        const from: Vec3 = [own.pos[0] + v[0] * r, own.pos[1] + v[1] * r, Math.max(own.pos[2] + Math.tan((ev.elevDeg ?? 0) * DEG) * r, zMin)];
        const dir = unit(sub(own.pos, from));
        const launcherId = `inj-${this.seq + 1}`;
        const m = this.launch({ from, vel: scale(dir, 450), weapon: ev.guidance === 'radar' ? 'aam_radar' : 'sam_ir', launcherId, guidance: ev.guidance });
        if (ev.guidance === 'radar') {
          this.virtual.push({ id: launcherId, pos: from, missileId: m.id, type: 'unknown' });
          this.rwrForce = true;
        }
        break;
      }
      case 'force_alert':
        this.event('force_alert', { level: ev.level, text: ev.text });
        break;
      case 'set_throttle':
        this.setControls({ throttle: ev.value });
        break;
      case 'engine_fault':
        this.faultEngine(ev.side, ev.kind);
        break;
      case 'set_altitude':
        this.ap.altFt = ev.altFt;
        break;
      case 'set_heading':
        this.ap.heading = ev.headingDeg;
        break;
      case 'teleport': {
        const s = this.fm.s;
        if (ev.pos) { s.pos[0] = ev.pos[0]; s.pos[1] = ev.pos[1]; }
        if (ev.altFt !== undefined) {
          s.pos[2] = Math.max(ev.altFt * FT, this.terrain.height(s.pos[0], s.pos[1]) + 100);
          s.vel[2] = 0;
          this.ap.altFt = s.pos[2] / FT;
        }
        if (ev.headingDeg !== undefined) {
          const e = this.fm.euler;
          const speed = Math.hypot(s.vel[0], s.vel[1]);
          s.q = qFromEuler(ev.headingDeg, e.pitchDeg, 0);
          s.vel = [Math.sin(ev.headingDeg * DEG) * speed, Math.cos(ev.headingDeg * DEG) * speed, s.vel[2]];
          this.ap.heading = ev.headingDeg;
        }
        this.lastOwn = this.ownState();
        break;
      }
    }
  }

  private faultEngine(side: 'left' | 'right', kind: EngineFault): void {
    const e = side === 'left' ? this.engines[0] : this.engines[1];
    e.injectFault(kind);
    this.event('engine_fault', { side, kind });
  }

  private launch(req: LaunchRequest): Missile {
    const id = `m${++this.seq}`;
    const m = new Missile(id, req.from, req.vel, req.weapon, req.launcherId, req.guidance, this.clock());
    this.missiles.push(m);
    this.event('missile_launch', { missileId: id, launcherId: req.launcherId, guidance: req.guidance, bearingDeg: bearingTo(this.fm.s.pos, req.from), rangeM: norm(sub(req.from, this.fm.s.pos)) });
    return m;
  }

  /** Apply an arbitrated directive. Agent advice only moves the sim when it is the pilot's, GCAS, or an auto program. */
  applyDirective(d: Directive): void {
    const v = (d.value ?? {}) as Record<string, unknown>;
    const pilot = d.source === 'pilot';
    switch (d.axis) {
      case 'heading':
        if (pilot && typeof v.headingDeg === 'number' && !this.ap.flyup) {
          this.ap.heading = wrap360(v.headingDeg);
          this.ap.bankMax = typeof v.bankDeg === 'number' ? v.bankDeg : 60;
          if (this.ap.altFt === undefined) this.ap.altFt = this.fm.s.pos[2] / FT;
        }
        break;
      case 'altitude':
        if (v.flyup === true && (d.execute || pilot)) {
          if (this.gcasAuto && !this.ap.flyup) {
            this.ap.flyup = true;
            this.event('gcas_flyup', { start: true });
          }
        } else if (pilot && typeof v.altFt === 'number' && !this.ap.flyup) {
          this.ap.altFt = v.altFt;
          if (this.ap.heading === undefined) this.ap.heading = this.fm.euler.headingDeg;
        }
        break;
      case 'speed':
        if (pilot && typeof v.kcas === 'number') this.ap.kcas = clamp(v.kcas, 150, 800);
        break;
      case 'throttle':
        if (pilot && typeof v.throttle === 'number') this.setControls({ throttle: v.throttle });
        break;
      case 'countermeasures':
        if ((pilot || d.execute) && (v.kind === 'chaff' || v.kind === 'flare')) this.dispense(v.kind, typeof v.count === 'number' ? v.count : 1);
        break;
      case 'emitters':
        if ((pilot || d.execute) && typeof v.emcon === 'number') {
          this.emcon = clamp(Math.round(v.emcon), 0, 3) as Emcon;
        }
        break;
      case 'route':
        if (pilot && typeof v.activeWp === 'number') this.activeWp = v.activeWp;
        break;
    }
    if (d.axis === 'altitude' && v.gcasAuto !== undefined && pilot) this.gcasAuto = Boolean(v.gcasAuto);
  }

  dispense(kind: 'chaff' | 'flare', count = 1): number {
    let n = 0;
    for (let i = 0; i < count; i++) {
      if (kind === 'chaff' && this.cm.chaff > 0) this.cm.chaff--;
      else if (kind === 'flare' && this.cm.flares > 0) this.cm.flares--;
      else break;
      n++;
      const own = this.fm.s;
      const d = new Decoy(`cm${++this.seq}`, kind, [...own.pos], scale(own.vel, 0.6));
      this.decoys.push(d);
      const ownView = this.ownView();
      for (const m of this.missiles) m.decoy(kind, ownView, this.rng);
    }
    if (n > 0) this.event('cm_dispensed', { kind, count: n, chaff: this.cm.chaff, flares: this.cm.flares });
    return n;
  }

  // ---------- stepping ----------

  private ownView(): OwnView {
    return { pos: this.fm.s.pos, vel: this.fm.s.vel, headingDeg: this.fm.euler.headingDeg, throttle: this.throttle, mach: this.aeroMach };
  }

  /** Autothrottle: PI on calibrated airspeed, dry power only. */
  private stepAutothrottle(dt: number): void {
    if (this.ap.kcas === undefined) { this.atInt = this.throttle; return; }
    const kcas = casFromTas(this.fm.last.tas, this.fm.last.air) / KT;
    const err = this.ap.kcas - kcas;
    this.atInt = clamp(this.atInt + err * 0.003 * dt, 0.02, 0.84);
    this.throttle = clamp(this.atInt + err * 0.02, 0.02, 0.84);
  }

  /** Advance one 60 Hz frame (two 120 Hz sub-steps). */
  stepFrame(): void {
    if (this.outcome && this.outcome !== 'survived') return;
    this.frameObs = [];
    const dt = 1 / SIM_HZ;
    for (let sub = 0; sub < SIM_HZ / FRAME_HZ; sub++) this.substep(dt);
    this.tick++;
    this.tMs = (this.tick * 1000) / FRAME_HZ;
    // sensors run at frame rate with their own internal rates
    const own = this.ownView();
    const targets = this.sensorTargets();
    const emissions = this.emissions();
    const r = this.sensors.step(this.tick, this.tMs / 1000, { ...own, emcon: this.emcon }, targets, emissions, this.terrain, this.weather, this.rwrForce);
    this.rwrForce = false;
    this.frameObs.push(...r.obs);
    this.checkTriggers();
    this.version++;
    this.lastOwn = this.ownState();
  }

  private substep(dt: number): void {
    const fm = this.fm;
    const e = fm.euler;
    const vsFpm = (fm.s.vel[2] / FT) * 60;
    const altFt = fm.s.pos[2] / FT;
    const tas = fm.last.tas;
    // ----- control: stick, autopilot or GCAS fly-up -----
    let nzCmd: number;
    let rollRate: number;
    if (this.ap.flyup) {
      rollRate = rollRateForBank(e.rollDeg, 0);
      nzCmd = Math.abs(e.rollDeg) < 45 ? 6 : 1;
      const clear = this.aglM() > 300 && fm.s.vel[2] > 20;
      if (clear) {
        this.ap.flyup = false;
        this.ap.altFt = Math.max(altFt, (this.terrain.height(fm.s.pos[0], fm.s.pos[1]) + 500) / FT);
        this.ap.heading = e.headingDeg;
        this.event('gcas_flyup', { start: false });
      }
    } else {
      if (this.ap.heading !== undefined) {
        const bank = bankForHeading(e.headingDeg, this.ap.heading, this.ap.bankMax, tas);
        rollRate = rollRateForBank(e.rollDeg, bank);
      } else {
        rollRate = this.controls.roll * AIRFRAME.rollRateMaxDps * DEG;
      }
      if (this.ap.altFt !== undefined) {
        nzCmd = nzForAltitude(altFt, this.ap.altFt, vsFpm, e.rollDeg, tas);
      } else {
        const p = this.controls.pitch;
        nzCmd = p >= 0 ? 1 + p * (AIRFRAME.gMax - 1) : 1 + p * (1 - AIRFRAME.gMin);
      }
    }
    this.stepAutothrottle(dt);
    // ----- engines and fuel -----
    const air = fm.last.air;
    let flow = 0;
    let thrust = 0;
    for (const eng of this.engines) {
      const tr = eng.step(dt, this.throttle, fm.last.mach, air, fm.last.alphaDeg);
      if (tr) this.event('engine_transition', { side: tr.side, from: tr.from, to: tr.to });
      flow += eng.state.fuelFlowPph;
      thrust += eng.state.thrustN;
    }
    if (!this.fuel.step(dt, flow)) {
      for (const eng of this.engines) if (eng.state.fault !== 'flameout' && eng.state.mode !== 'flamedout') { eng.injectFault('flameout'); this.event('engine_fault', { side: eng.state.side, kind: 'flameout' }); }
    }
    fm.massKg = this.massKg();
    // ----- weather and flight -----
    fm.wind = this.weather.step(dt, fm.s.pos[2], this.aglM());
    const out = fm.step(dt, { nzCmd, rollRateCmd: rollRate, thrustN: thrust, speedbrake: false });
    this.aeroAlpha = out.alphaDeg;
    this.aeroG = out.nz;
    this.aeroMach = out.mach;
    this.gMax = Math.max(this.gMax, out.nz);
    // ----- collisions -----
    const ground = this.terrain.height(fm.s.pos[0], fm.s.pos[1]);
    if (fm.s.pos[2] <= ground + 2) this.end('crashed', { cause: 'terrain' });
    for (const t of this.scenario.theater.towers) {
      if (dist2d(fm.s.pos, t.pos) < 25 && fm.s.pos[2] < this.terrain.height(t.pos[0], t.pos[1]) + t.heightFt * FT) this.end('crashed', { cause: 'tower' });
    }
    // ----- red forces and weapons -----
    const own = this.ownView();
    const live = this.missiles.filter(m => m.alive);
    for (const s of this.sams) {
      const cued = dist2d(own.pos, s.pos) < 45_000;
      const req = s.step(dt, own, this.terrain, cued);
      if (req) this.launch(req);
    }
    for (const f of this.fighters) {
      const req = f.step(dt, own, this.terrain, live, this.fighterCap(f.id));
      if (req) this.launch(req);
    }
    for (const sw of this.swarms) sw.step(dt, this.terrain);
    const rho = air.rho;
    for (const m of this.missiles) {
      if (!m.alive) continue;
      const r = m.step(dt, own, this.terrain, rho);
      if (r === 'hit') {
        this.event('missile_hit', { missileId: m.id });
        this.end('shot_down', { missileId: m.id });
      } else if (r === 'miss') {
        this.event('missile_miss', { missileId: m.id });
      }
    }
    this.virtual = this.virtual.filter(v => this.missiles.some(m => m.id === v.missileId && m.alive));
    this.decoys = this.decoys.filter(d => d.step(dt));
    // ----- waypoint sequencing -----
    const wp = this.scenario.route[this.activeWp];
    if (wp && dist2d(fm.s.pos, wp) < 2500) {
      this.event('waypoint', { reached: this.activeWp });
      this.activeWp = Math.min(this.activeWp + 1, this.scenario.route.length);
    }
  }

  private fighterCap(id: string): Vec3 {
    const r = this.scenario.red.find(x => id.startsWith(`${x.id}-`));
    return r?.cap ?? [60_000, 0, 25_000];
  }

  private end(outcome: SortieOutcome, data: Record<string, unknown>): void {
    if (this.outcome) return;
    this.outcome = outcome;
    if (outcome === 'crashed') this.event('crash', { outcome, ...data });
  }

  /** Mark the sortie as finished from outside (pilot ends it, or the scenario timer runs out). */
  finish(outcome: SortieOutcome): void {
    if (!this.outcome) this.outcome = outcome;
  }

  private aglM(): number {
    return this.fm.s.pos[2] - this.terrain.height(this.fm.s.pos[0], this.fm.s.pos[1]);
  }

  private checkTriggers(): void {
    const tS = this.tMs / 1000;
    this.scenario.triggers.forEach((tr, i) => {
      if (this.firedTriggers.has(i)) return;
      const timeOk = tr.at.t === undefined || tS >= tr.at.t;
      const nearOk = tr.at.near === undefined || dist2d(this.fm.s.pos, tr.at.near) < (tr.at.r ?? 5000);
      if (!timeOk || !nearOk) return;
      this.firedTriggers.add(i);
      this.event('trigger', { index: i, do: tr.do, target: tr.target });
      switch (tr.do) {
        case 'fault': {
          const side = tr.target === 'engine_right' ? 'right' : 'left';
          this.faultEngine(side, (tr.kind ?? 'oil_pressure') as EngineFault);
          break;
        }
        case 'activate':
          this.sams.find(s => s.id === tr.target)?.activate();
          break;
        case 'launch_swarm': {
          const sw = this.swarms.find(s => s.id === tr.target);
          if (sw) sw.launched = true;
          break;
        }
        case 'commit':
          for (const f of this.fighters) if (f.id.startsWith(`${tr.target}-`)) f.commit();
          break;
      }
    });
  }

  private sensorTargets(): SensorTarget[] {
    const out: SensorTarget[] = [];
    for (const f of this.fighters) if (f.alive) out.push({ id: f.id, kind: 'fighter', pos: f.pos, vel: f.vel, rcsM2: 3, ir: 1.5 });
    for (const sw of this.swarms) for (const d of sw.drones) if (d.alive && sw.launched) out.push({ id: d.id, kind: 'drone', pos: d.pos, vel: d.vel, rcsM2: 0.02, ir: 0.08 });
    for (const m of this.missiles) if (m.alive) out.push({ id: m.id, kind: 'missile', pos: m.pos, vel: m.vel, rcsM2: 0.05, ir: m.motorBurning ? 3 : 0.4, motorBurning: m.motorBurning, launchAgeS: m.t });
    return out;
  }

  private emissions(): Emission[] {
    const own = this.ownView();
    const out: Emission[] = [];
    for (const s of this.sams) {
      const e = s.emission();
      if (e && this.terrain.los(e.pos, own.pos, 0)) out.push(e);
    }
    for (const f of this.fighters) {
      const e = f.emission(own, this.terrain);
      if (e) out.push(e);
    }
    for (const v of this.virtual) out.push({ emitterId: v.id, pos: v.pos, type: v.type, mode: 'guidance', rangeM: 200_000 });
    return out;
  }

  // ---------- outputs ----------

  ownState(): OwnState {
    const fm = this.fm;
    const e = fm.euler;
    const air = fm.last.air;
    const tas = fm.last.tas;
    const ground = this.terrain.height(fm.s.pos[0], fm.s.pos[1]);
    return {
      tick: this.tick,
      pos: [...fm.s.pos],
      vel: [...fm.s.vel],
      att: [...fm.s.q],
      mach: fm.last.mach,
      kcas: casFromTas(tas, air) / KT,
      altFt: fm.s.pos[2] / FT,
      aglFt: (fm.s.pos[2] - ground) / FT,
      aoaDeg: this.aeroAlpha,
      g: this.aeroG,
      fuelLb: this.fuel.totalLb,
      engines: this.engines.map(x => ({ ...x.state })),
      emcon: this.emcon,
      cm: { ...this.cm },
      headingDeg: e.headingDeg,
      pitchDeg: e.pitchDeg,
      rollDeg: e.rollDeg,
      vsFpm: (fm.s.vel[2] / FT) * 60,
      tasKt: tas / KT,
      gMax: this.gMax,
      throttle: this.throttle,
      trackDeg: wrap360(Math.atan2(fm.s.vel[0], fm.s.vel[1]) / DEG),
    };
  }

  /** The agent-facing snapshot for the frame just stepped; drains pending events. */
  snapshot(): SimSnapshot {
    const snap: SimSnapshot = {
      version: this.version,
      tick: this.tick,
      tMs: this.tMs,
      wallMs: this.clock(),
      own: this.lastOwn,
      obs: this.frameObs,
      rwr: this.sensors.rwr.map((r: RwrEmitter) => ({ ...r })),
      events: this.pendingEvents,
      gcasAuto: this.gcasAuto,
    };
    this.pendingEvents = [];
    this.frameObs = [];
    return snap;
  }

  render(paused: boolean): RenderFrame {
    const ents: RenderEntity[] = [];
    for (const f of this.fighters) ents.push({ id: f.id, type: 'fighter', pos: [...f.pos], headingDeg: f.headingDeg, alive: f.alive, emitting: f.emission(this.ownView(), this.terrain)?.mode ?? null, side: 'red' });
    for (const m of this.missiles) if (m.alive) ents.push({ id: m.id, type: 'missile', pos: [...m.pos], headingDeg: bearingTo([0, 0], m.vel), alive: true, side: 'red' });
    for (const s of this.sams) ents.push({ id: s.id, type: s.kind === 'sam_long' ? 'sam' : 'shorad', pos: [...s.pos], headingDeg: 0, alive: true, emitting: s.emission()?.mode ?? null, side: 'red' });
    for (const sw of this.swarms) for (const d of sw.drones) if (d.alive && sw.launched) ents.push({ id: d.id, type: 'drone', pos: [...d.pos], headingDeg: bearingTo([0, 0], d.vel), alive: true, side: 'red' });
    for (const d of this.decoys) ents.push({ id: d.id, type: d.kind, pos: [...d.pos], headingDeg: 0, alive: true, side: 'blue' });
    const flow = this.engines.reduce((s, e) => s + e.state.fuelFlowPph, 0);
    const fuel = this.fuel.state(flow, this.emptyLb);
    fuel.bingoLb = this.bingoLb();
    fuel.jokerLb = fuel.bingoLb + 2000;
    return {
      tick: this.tick,
      tMs: this.tMs,
      wallMs: this.clock(),
      paused,
      own: this.lastOwn,
      fuel,
      autopilot: {
        ...(this.ap.heading !== undefined ? { heading: this.ap.heading } : {}),
        ...(this.ap.altFt !== undefined ? { altFt: this.ap.altFt } : {}),
        ...(this.ap.kcas !== undefined ? { kcas: this.ap.kcas } : {}),
        flyup: this.ap.flyup,
      },
      entities: ents,
      outcome: this.outcome,
      stick: { pitch: this.controls.pitch, roll: this.controls.roll },
      rwr: this.sensors.rwr.map(r => ({ ...r })),
      activeWp: this.activeWp,
    };
  }

  /** Fuel needed to reach home plate at cruise plus a 2,000 lb reserve. */
  bingoLb(): number {
    const d = dist2d(this.fm.s.pos, this.scenario.theater.homePlate);
    const lbPerNm = 9;
    return Math.round((2000 + (d / NM) * lbPerNm) / 100) * 100;
  }

  /** Truth helpers for scoring and tests (never sent to agents). */
  truth() {
    return {
      missilesAlive: this.missiles.filter(m => m.alive).map(m => ({ id: m.id, pos: m.pos, guidance: m.guidance, locked: m.locked })),
      falseAlarmObs: [...this.sensors.falseAlarms],
      ownPos: [...this.fm.s.pos] as Vec3,
    };
  }
}
