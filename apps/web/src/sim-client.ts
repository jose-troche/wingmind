import type { LogEntry, ReplayFile } from '@wingmind/agents';
import {
  SnapshotRing, type BoardSummary, type Controls, type Directive, type InjectEvent, type Intent, type MeshEdge,
  type RenderFrame, type Scenario, type SimEvent, type SortieOutcome, type SpeakItem, type Verbosity,
} from '@wingmind/shared';
import { Terrain } from '@wingmind/sim-core';
import { AGENT_RING_BYTES, RENDER_RING_BYTES, type FromAgents, type FromSim, type ToAgents, type ToSim } from './workers/protocol';

// Main-thread side of the three-thread design: spawns the sim and agent workers,
// wires their MessageChannel, and reads the render ring from requestAnimationFrame.

export interface ClientEvents {
  speak(items: SpeakItem[]): void;
  logs(entries: LogEntry[]): void;
  directives(list: Directive[]): void;
  ui(intents: Intent[]): void;
  board(b: BoardSummary): void;
  outcome(o: SortieOutcome): void;
  simEvents(e: SimEvent[], truth: { missilesAlive: number; falseAlarmObs: string[] }): void;
}

export class SimClient {
  private sim: Worker | null = null;
  private agents: Worker | null = null;
  private renderRing: SnapshotRing | null = null;
  private renderSeq = 0;
  private latestFrame: RenderFrame | null = null;
  private stepReq = 0;
  private stepWaiters = new Map<number, (lastSeq: number) => void>();
  private agentSeq = 0;
  private seqWaiters: { seq: number; res: () => void }[] = [];
  private replayWaiter: ((r: ReplayFile | null) => void) | null = null;
  scenario: Scenario | null = null;
  terrain: Terrain | null = null;
  board: BoardSummary | null = null;
  // edges pile up between renders: summaries arrive at 10 Hz and a slow frame
  // must not drop the one that carried the missile chain
  private meshEdges: MeshEdge[] = [];
  paused = false;
  readonly isolated: boolean;

  constructor(private on: ClientEvents) {
    this.isolated = typeof crossOriginIsolated !== 'undefined' && crossOriginIsolated && typeof SharedArrayBuffer !== 'undefined';
  }

  /** Latest render frame (from the ring when isolated, else the last posted one). */
  frame(): RenderFrame | null {
    if (this.renderRing) {
      const r = this.renderRing.readLatest<RenderFrame>(this.renderSeq);
      if (r) { this.renderSeq = r.seq; this.latestFrame = r.value; }
    }
    return this.latestFrame;
  }

  async load(scenario: Scenario, seed: number, opts: { paused: boolean; sessionId: string; verbosity: Verbosity }): Promise<void> {
    this.dispose();
    this.scenario = scenario;
    this.paused = opts.paused;
    this.latestFrame = null;
    this.renderSeq = 0;
    this.agentSeq = 0;
    this.board = null;
    const agentRing = this.isolated ? new SnapshotRing(AGENT_RING_BYTES) : null;
    this.renderRing = this.isolated ? new SnapshotRing(RENDER_RING_BYTES) : null;
    const channel = new MessageChannel();
    const sim = new Worker(new URL('./workers/sim.worker.ts', import.meta.url), { type: 'module', name: 'sim' });
    const agents = new Worker(new URL('./workers/agents.worker.ts', import.meta.url), { type: 'module', name: 'agents' });
    this.sim = sim;
    this.agents = agents;

    let simReady!: () => void;
    let agentsReady!: () => void;
    const ready = Promise.all([new Promise<void>(r => (simReady = r)), new Promise<void>(r => (agentsReady = r))]);

    sim.onmessage = (e: MessageEvent<FromSim>) => {
      const m = e.data;
      switch (m.type) {
        case 'ready':
          this.terrain = new Terrain(scenario.theater.terrain, m.heights);
          simReady();
          break;
        case 'frame':
          this.latestFrame = m.frame;
          break;
        case 'stepped':
          this.stepWaiters.get(m.reqId)?.(m.lastSeq);
          this.stepWaiters.delete(m.reqId);
          break;
        case 'events':
          this.on.simEvents(m.events, m.truth);
          break;
        case 'outcome':
          this.on.outcome(m.outcome);
          break;
      }
    };
    agents.onmessage = (e: MessageEvent<FromAgents>) => {
      const m = e.data;
      switch (m.type) {
        case 'ready':
          agentsReady();
          break;
        case 'out':
          if (m.directives.length) this.on.directives(m.directives);
          if (m.speak.length) this.on.speak(m.speak);
          if (m.logs.length) this.on.logs(m.logs);
          if (m.ui.length) this.on.ui(m.ui);
          if (m.seq > this.agentSeq) this.agentSeq = m.seq;
          this.seqWaiters = this.seqWaiters.filter(w => (w.seq <= this.agentSeq ? (w.res(), false) : true));
          break;
        case 'summary':
          this.board = m.board;
          this.meshEdges.push(...m.mesh);
          this.on.board(m.board);
          break;
        case 'replay':
          this.replayWaiter?.(m.data as ReplayFile | null);
          this.replayWaiter = null;
          break;
      }
    };
    agents.postMessage({ type: 'init', scenario, agentRing: agentRing?.sab ?? null, port: channel.port2, sessionId: opts.sessionId, verbosity: opts.verbosity } satisfies ToAgents, [channel.port2]);
    sim.postMessage({ type: 'init', scenario, seed, agentRing: agentRing?.sab ?? null, renderRing: this.renderRing?.sab ?? null, port: channel.port1, paused: opts.paused } satisfies ToSim, [channel.port1]);
    await ready;
  }

  private toSim(m: ToSim): void {
    this.sim?.postMessage(m);
  }

  private toAgents(m: ToAgents): void {
    this.agents?.postMessage(m);
  }

  controls(c: Partial<Controls>): void { this.toSim({ type: 'controls', c }); }
  inject(ev: InjectEvent): void { this.toSim({ type: 'inject', ev }); }
  pause(): void { this.paused = true; this.toSim({ type: 'pause' }); }
  resume(): void { this.paused = false; this.toSim({ type: 'resume' }); }
  finish(outcome: SortieOutcome): void { this.toSim({ type: 'finish', outcome }); }
  intent(intent: Intent): void { this.toAgents({ type: 'intent', intent }); }
  say(text: string, question?: string): void { this.toAgents({ type: 'say', text, ...(question ? { question } : {}) }); }
  setSession(sessionId: string): void { this.toAgents({ type: 'session', sessionId }); }

  /** Step N frames; resolves once the sim has run them and the agents have flushed the last one. */
  step(frames: number): Promise<void> {
    this.paused = true;
    const reqId = ++this.stepReq;
    return new Promise<void>(res => {
      this.stepWaiters.set(reqId, lastSeq => {
        if (this.agentSeq >= lastSeq) res();
        else this.seqWaiters.push({ seq: lastSeq, res });
      });
      this.toSim({ type: 'step', frames, reqId });
    });
  }

  takeMeshEdges(): MeshEdge[] {
    return this.meshEdges.splice(0);
  }

  exportReplay(): Promise<ReplayFile | null> {
    return new Promise(res => {
      this.replayWaiter = res;
      this.toAgents({ type: 'export' });
      setTimeout(() => { if (this.replayWaiter === res) { this.replayWaiter = null; res(null); } }, 2000);
    });
  }

  dispose(): void {
    this.sim?.terminate();
    this.agents?.terminate();
    this.sim = null;
    this.agents = null;
    this.stepWaiters.clear();
    this.seqWaiters = [];
  }
}
