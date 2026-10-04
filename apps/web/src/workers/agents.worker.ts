import { AgentRuntime, type RuntimeOutput } from '@wingmind/agents';
import { SnapshotRing, hasWaitAsync, type SimSnapshot } from '@wingmind/shared';
import { Terrain } from '@wingmind/sim-core';
import type { AgentsInit, AgentsToSim, FromAgents, SimToAgents, ToAgents, WorkerScope } from './protocol';

// agents.worker: owns the mesh. In real time it blocks on the snapshot ring with
// Atomics.waitAsync, so it wakes the instant a frame lands; in step mode each
// frame arrives with a doorbell and is acknowledged after the agents run.

const scope = self as unknown as WorkerScope<ToAgents>;
const post = (m: FromAgents) => scope.postMessage(m);

let init: AgentsInit | null = null;
let rt: AgentRuntime | null = null;
let ring: SnapshotRing | null = null;
let port: MessagePort | null = null;
let realtime = false;
let lastRingSeq = 0;
let lastSeq = -1;
let summaryTimer: ReturnType<typeof setInterval> | null = null;
const pending: SimToAgents[] = [];

function emit(out: RuntimeOutput, seq: number, force: boolean): void {
  if (out.directives.length) port?.postMessage({ type: 'directives', list: out.directives } satisfies AgentsToSim);
  if (force || out.speak.length || out.logs.length || out.directives.length || out.ui.length) {
    post({ type: 'out', seq, speak: out.speak, logs: out.logs, directives: out.directives, ui: out.ui });
  }
}

function process(snap: SimSnapshot, force: boolean): void {
  if (!rt) return;
  lastSeq = snap.version;
  emit(rt.onFrame(snap), snap.version, force);
}

function drainRing(): void {
  if (!ring) return;
  const cur = ring.seq;
  for (let s = Math.max(lastRingSeq + 1, cur - 2); s <= cur; s++) {
    const snap = ring.readAt<SimSnapshot>(s);
    if (snap && snap.version > lastSeq) process(snap, false);
  }
  lastRingSeq = cur;
}

async function realtimeLoop(): Promise<void> {
  if (!ring || !hasWaitAsync()) return;
  while (realtime) {
    await ring.waitPast(lastRingSeq, 100);
    if (realtime) drainRing();
  }
}

function onPort(m: SimToAgents): void {
  if (!rt && m.type !== 'terrain') { pending.push(m); return; }
  switch (m.type) {
    case 'terrain': {
      const t = new Terrain(init!.scenario.theater.terrain, m.heights);
      rt = new AgentRuntime(init!.scenario, t, { verbosity: init!.verbosity });
      rt.sessionId = init!.sessionId;
      summaryTimer = setInterval(() => {
        if (rt) post({ type: 'summary', board: rt.summary(), mesh: rt.meshEdges() });
      }, 100);
      post({ type: 'ready' });
      for (const p of pending.splice(0)) onPort(p);
      break;
    }
    case 'frame': {
      let snap = m.snap;
      if (!snap && ring) {
        const r = ring.readLatest<SimSnapshot>(lastRingSeq);
        if (r) { snap = r.value; lastRingSeq = r.seq; }
      }
      if (snap && snap.version > lastSeq) process(snap, m.ack);
      else if (m.ack) post({ type: 'out', seq: m.seq, speak: [], logs: [], directives: [], ui: [] });
      if (m.ack) port!.postMessage({ type: 'ack', seq: m.seq } satisfies AgentsToSim);
      break;
    }
    case 'mode':
      realtime = m.realtime;
      if (ring) lastRingSeq = Math.max(lastRingSeq, ring.seq - 1);
      if (realtime) void realtimeLoop();
      break;
  }
}

scope.onmessage = (e: MessageEvent<ToAgents>) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      init = m;
      ring = m.agentRing ? new SnapshotRing(m.agentRing) : null;
      port = m.port;
      port.onmessage = (ev: MessageEvent<SimToAgents>) => onPort(ev.data);
      break;
    case 'intent':
      if (rt) emit(rt.onIntent(m.intent), lastSeq, true);
      break;
    case 'say':
      if (rt) emit(rt.onSay(m.text, m.question ?? ''), lastSeq, true);
      break;
    case 'session':
      if (rt) rt.sessionId = m.sessionId;
      if (init) init = { ...init, sessionId: m.sessionId };
      break;
    case 'export':
      post({ type: 'replay', data: rt?.recorder.export() ?? null });
      break;
  }
};
