import {
  FT, NM, bearingTo, clockPhrase, dist2d, relBearing,
  type Alert, type BoardSummary, type BusMessage, type CompactContext, type Directive, type Intent, type Level, type MeshEdge,
  type RwrEmitter, type Scenario, type SimSnapshot, type SpeakItem, type Vec3, type Verbosity,
} from '@wingmind/shared';
import { Terrain } from '@wingmind/sim-core';
import { createAir } from './air';
import { Blackboard } from './blackboard';
import { Bus } from './bus';
import type { Agent, Settings, Snapshot, StaticWorld } from './core';
import { createEw } from './ew';
import { createFuse } from './fuse';
import { createGbad } from './gbad';
import { createMaws } from './maws';
import { createNav } from './nav';
import { createNlu } from './nlu';
import { createOrch } from './orch';
import { createPia, type LogEntry } from './pia';
import { Recorder } from './recorder';
import { Scheduler } from './scheduler';
import { createSig } from './sig';
import { bingoFor, createSys } from './sys';
import { createTap } from './tap';

// The agent runtime: the same object runs inside agents.worker in the browser
// and in-process in the headless scenario tests, so both exercise one code path.

export interface RuntimeOutput {
  speak: SpeakItem[];
  logs: LogEntry[];
  directives: Directive[];
  ui: Intent[];
}

export const AGENT_IDS = ['FUSE', 'MAWS', 'NAV', 'EW', 'SYS', 'AIR', 'GBAD', 'TAP', 'SIG', 'ORCH', 'NLU', 'PIA'] as const;

export class AgentRuntime {
  readonly bus = new Bus();
  readonly board: Blackboard;
  readonly scheduler: Scheduler;
  readonly agents: Agent[];
  readonly world: StaticWorld;
  readonly recorder: Recorder;
  settings: Settings;
  sessionId = 'local';
  private last: SimSnapshot | null = null;
  private prevRwr = new Map<string, string>();
  private out: RuntimeOutput = { speak: [], logs: [], directives: [], ui: [] };
  private appliedRates = '';
  lastAnswers: { q: string; a: string }[] = [];

  constructor(readonly scenario: Scenario, terrain?: Terrain, opts: { verbosity?: Verbosity } = {}) {
    const t = terrain ?? new Terrain(scenario.theater.terrain);
    this.world = {
      terrain: t,
      scenario,
      intelSites: scenario.red
        .filter(r => r.intel && r.pos && (r.type === 'sam_long' || r.type === 'sam_short'))
        .map(r => ({ id: r.id, type: r.type as 'sam_long' | 'sam_short', pos: [r.pos![0], r.pos![1], t.height(r.pos![0], r.pos![1]) + 8] as Vec3 })),
    };
    this.settings = { verbosity: opts.verbosity ?? 'standard', gcasAuto: scenario.settings.gcasAuto, quietAdvisories: false };
    this.board = new Blackboard(scenario.route.map(p => [...p] as Vec3));
    this.agents = [
      createFuse(), createMaws(), createNav(), createEw(), createSys(),
      createAir(), createGbad(), createTap(), createSig(), createOrch(),
      createNlu(s => this.buildContext(s)), createPia(),
    ];
    this.scheduler = new Scheduler(this.agents, this.bus, this.board);
    this.recorder = new Recorder(scenario.id);
    this.bus.onMessage = m => this.route(m);
  }

  private route(m: BusMessage<unknown>): void {
    switch (m.topic) {
      case 'speak': this.out.speak.push(m.payload as SpeakItem); this.recorder.speak(m.payload as SpeakItem); break;
      case 'alert.log': this.out.logs.push(m.payload as LogEntry); break;
      case 'directive': this.out.directives.push(m.payload as Directive); this.recorder.directive(m.payload as Directive); break;
      case 'intent.ui':
      case 'intent.sys': this.out.ui.push(m.payload as Intent); break;
    }
  }

  private take(): RuntimeOutput {
    const o = this.out;
    this.out = { speak: [], logs: [], directives: [], ui: [] };
    return o;
  }

  snapshotFor(): Snapshot {
    const sim = this.last!;
    const b = this.board.current;
    return {
      tick: sim.tick, tMs: sim.tMs, wallMs: sim.wallMs, version: b.version,
      own: sim.own, rwr: sim.rwr, tracks: b.tracks, threats: b.ranked, detection: b.detection, gbadRings: b.gbadRings,
      directives: b.directives, limits: b.limits, phase: b.phase, beam: b.beam, route: b.route, activeWp: b.activeWp,
      world: this.world, settings: this.settings, ew: b.ew, gcasAuto: sim.gcasAuto,
    };
  }

  /** Feed one sim frame through the mesh. */
  onFrame(snap: SimSnapshot): RuntimeOutput {
    this.last = snap;
    this.settings.gcasAuto = snap.gcasAuto;
    const bus = this.bus;
    bus.begin(snap.tick, snap.version, snap.tMs);
    for (const o of snap.obs) {
      const urgent = o.sensor === 'das' && o.kind === 'plume';
      bus.publishSys(`obs.${o.sensor}`, o, { source: 'SENS', priority: urgent ? 0 : 5, ttlMs: 500, id: o.id });
    }
    const now = new Map<string, string>();
    for (const e of snap.rwr) {
      now.set(e.emitterId, e.mode);
      if (this.prevRwr.get(e.emitterId) !== e.mode) {
        bus.publishSys<RwrEmitter>('obs.rwr', e, { source: 'SENS', priority: e.mode === 'guidance' ? 0 : 4, ttlMs: 1500, id: `${e.id}-${snap.tick}` });
      }
    }
    this.prevRwr = now;
    for (const e of snap.events) {
      if (e.type === 'force_alert') {
        const level = e.data.level as Level;
        const text = String(e.data.text);
        const a: Alert = {
          id: `force-${e.id}`, level, cls: 'advisory', text, terse: text, dedupKey: `force:${text}`, ttlMs: 10_000,
          evidence: [e.id], confidence: 1, eventWallMs: e.wallMs,
        };
        bus.publishSys('alert', a, { source: 'SIM', priority: level === 'WARNING' ? 0 : level === 'CAUTION' ? 2 : 6, ttlMs: 3000 });
      } else if (e.type === 'engine_fault' || e.type === 'engine_transition' || e.type === 'trigger' || e.type === 'gcas_flyup') {
        bus.publishSys('obs.sys', e, { source: 'SIM', priority: e.type === 'engine_fault' ? 1 : 6, ttlMs: 2000 });
      }
    }
    const rates = JSON.stringify(this.board.current.rates);
    if (rates !== this.appliedRates) { this.scheduler.applyRatePlan(this.board.current.rates); this.appliedRates = rates; }
    this.scheduler.tick(snap.tMs, () => this.snapshotFor());
    this.recorder.frame(snap);
    return this.take();
  }

  /** A validated pilot intent from the voice pipeline or keyboard: processed immediately, even when paused. */
  onIntent(intent: Intent): RuntimeOutput {
    if (!this.last) return this.take();
    this.bus.begin(this.last.tick, this.last.version, this.last.tMs);
    this.bus.publishSys('intent.pilot', intent, { source: 'pilot', priority: 0, ttlMs: 3000 });
    this.scheduler.runNow(['NLU', 'ORCH', 'NAV', 'EW', 'PIA'], this.last.tMs, () => this.snapshotFor());
    return this.take();
  }

  /** Speak a phrase through PIA (answers, "unable" messages). */
  onSay(text: string, question = ''): RuntimeOutput {
    if (!this.last) return this.take();
    if (question) this.lastAnswers = [...this.lastAnswers.slice(-2), { q: question, a: text }];
    this.bus.begin(this.last.tick, this.last.version, this.last.tMs);
    this.bus.publishSys('say', { text }, { source: 'pilot', priority: 1, ttlMs: 3000 });
    this.scheduler.runNow(['NLU', 'PIA'], this.last.tMs, () => this.snapshotFor());
    return this.take();
  }

  buildContext(s: Snapshot = this.snapshotFor()): CompactContext {
    const own = s.own;
    const flow = own.engines.reduce((a, e) => a + e.fuelFlowPph, 0);
    const bingo = bingoFor(own.pos, s.world.scenario.theater.homePlate);
    const wp = s.route[s.activeWp];
    const home = s.world.scenario.theater.homePlate;
    return {
      sessionId: this.sessionId,
      own: {
        headingDeg: Math.round(own.headingDeg), altFt: Math.round(own.altFt), aglFt: Math.round(own.aglFt), kcas: Math.round(own.kcas),
        mach: Math.round(own.mach * 100) / 100, fuelLb: Math.round(own.fuelLb), bingoLb: bingo,
        minutesToBingo: flow > 0 ? Math.max(0, Math.round(((own.fuelLb - bingo) / flow) * 60)) : 0,
        emcon: own.emcon, chaff: own.cm.chaff, flares: own.cm.flares,
      },
      threats: s.threats.slice(0, 5).map(t => {
        const rel = relBearing(t.bearingDeg ?? 0, own.headingDeg);
        return {
          id: t.id, cls: t.class, clock: clockPhrase(rel), bearingDeg: Math.round(t.bearingDeg ?? 0),
          rangeNm: Math.round(((t.rangeM ?? 0) / NM) * 10) / 10, level: t.level, ...(t.intent ? { intent: t.intent } : {}),
        };
      }),
      route: wp ? { nextWp: s.activeWp + 1, bearingDeg: Math.round(bearingTo(own.pos, wp)), distNm: Math.round(dist2d(own.pos, wp) / NM) } : null,
      home: { bearingDeg: Math.round(bearingTo(own.pos, home)), rangeNm: Math.round(dist2d(own.pos, home) / NM) },
      lastAnswers: this.lastAnswers,
    };
  }

  summary(): BoardSummary {
    const b = this.board.current;
    const stats: BoardSummary['agentStats'] = {};
    for (const [id, st] of this.scheduler.stats) stats[id] = { lastMs: st.lastMs, avgMs: st.avgMs, runs: st.runs, overruns: st.overruns };
    const rates: Record<string, number> = {};
    for (const [id, r] of this.scheduler.rates) rates[id] = r;
    return {
      version: b.version, tick: this.last?.tick ?? 0, phase: b.phase, tracks: b.tracks, ranked: b.ranked, detection: b.detection,
      gbadRings: b.gbadRings, route: b.route, activeWp: b.activeWp, proposedRoute: b.proposedRoute?.route ?? null,
      beam: b.beam ? { side: b.beam.side, headingDeg: b.beam.headingDeg } : null,
      directives: b.directives, rates, agentStats: stats, ew: b.ew, cue: b.cue,
      context: this.last ? this.buildContext() : null,
    };
  }

  meshEdges(): MeshEdge[] {
    return this.bus.takePairs();
  }

  setVerbosity(v: Verbosity): void {
    this.settings.verbosity = v;
  }

  reset(): void {
    this.bus.reset();
    this.scheduler.reset();
    this.prevRwr.clear();
    this.last = null;
    void FT;
  }
}
