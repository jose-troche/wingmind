import { SnapshotRing, hasWaitAsync, type SortieOutcome } from '@wingmind/shared';
import { FRAME_HZ, Terrain, World } from '@wingmind/sim-core';
import type { AgentsToSim, FromSim, SimToAgents, ToSim, WorkerScope } from './protocol';

// sim.worker: owns physics. Integrates at 120 Hz and publishes a snapshot every
// second step (60 Hz) into the agent ring, then notifies (implementation 5.1).
// When paused, the console steps it frame by frame and each frame waits for the
// agents' ack, so test runs are deterministic.

const scope = self as unknown as WorkerScope<ToSim>;
const post = (m: FromSim, transfer: Transferable[] = []) => scope.postMessage(m, transfer);
const FRAME_MS = 1000 / FRAME_HZ;

let world: World | null = null;
let agentRing: SnapshotRing | null = null;
let renderRing: SnapshotRing | null = null;
let port: MessagePort | null = null;
let paused = true;
let timer: ReturnType<typeof setTimeout> | null = null;
let lastWall = 0;
let acc = 0;
let lastOutcome: SortieOutcome | null = null;
const acks = new Map<number, () => void>();
const doorbellAlways = !hasWaitAsync();
let stepping: Promise<void> = Promise.resolve();

function publishRender(): void {
  if (!world) return;
  const frame = world.render(paused);
  if (!renderRing || !renderRing.write(frame)) post({ type: 'frame', frame });
}

function publishFrame(ack: boolean): number {
  const w = world!;
  const snap = w.snapshot();
  const inRing = agentRing ? agentRing.write(snap) : false;
  if (!inRing || ack || doorbellAlways) {
    port!.postMessage({ type: 'frame', seq: snap.version, snap: inRing ? null : snap, ack } satisfies SimToAgents);
  }
  if (snap.events.length) {
    const t = w.truth();
    post({ type: 'events', events: snap.events, truth: { missilesAlive: t.missilesAlive.length, falseAlarmObs: t.falseAlarmObs } });
  }
  publishRender();
  if (w.outcome && w.outcome !== lastOutcome) {
    lastOutcome = w.outcome;
    post({ type: 'outcome', outcome: w.outcome });
  }
  return snap.version;
}

function loop(): void {
  timer = null;
  if (paused || !world) return;
  const now = performance.now();
  acc += now - lastWall;
  lastWall = now;
  let n = 0;
  while (acc >= FRAME_MS && n < 4) {
    world.stepFrame();
    publishFrame(false);
    acc -= FRAME_MS;
    n++;
  }
  if (n === 4) acc = 0;                       // far behind: drop time rather than spiral
  timer = setTimeout(loop, 2);
}

function setPaused(p: boolean): void {
  paused = p;
  port?.postMessage({ type: 'mode', realtime: !p } satisfies SimToAgents);
  if (!p) {
    lastWall = performance.now();
    acc = 0;
    if (!timer) timer = setTimeout(loop, 0);
  } else if (timer) {
    clearTimeout(timer);
    timer = null;
  }
  publishRender();
}

async function step(frames: number): Promise<number> {
  let last = world?.version ?? 0;
  for (let i = 0; i < frames && world; i++) {
    world.stepFrame();
    const seq = world.version;
    const acked = new Promise<void>(res => acks.set(seq, res));
    last = publishFrame(true);
    await acked;
  }
  return last;
}

scope.onmessage = (e: MessageEvent<ToSim>) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      const terrain = new Terrain(m.scenario.theater.terrain);
      world = new World(m.scenario, m.seed, terrain);
      agentRing = m.agentRing ? new SnapshotRing(m.agentRing) : null;
      renderRing = m.renderRing ? new SnapshotRing(m.renderRing) : null;
      port = m.port;
      port.onmessage = (ev: MessageEvent<AgentsToSim>) => {
        const a = ev.data;
        if (a.type === 'ack') {
          acks.get(a.seq)?.();
          acks.delete(a.seq);
        } else if (a.type === 'directives' && world) {
          for (const d of a.list) world.applyDirective(d);
          if (paused) publishRender();
        }
      };
      const forAgents = terrain.heights.slice();
      port.postMessage({ type: 'terrain', heights: forAgents } satisfies SimToAgents, [forAgents.buffer]);
      const forMain = terrain.heights.slice();
      post({ type: 'ready', heights: forMain }, [forMain.buffer]);
      // first frame, always rung through, so agents and console have a picture
      // (and pilot intents have a snapshot to act on) before anything moves
      publishFrame(true);
      setPaused(m.paused);
      break;
    }
    case 'controls':
      world?.setControls(m.c);
      break;
    case 'inject':
      world?.inject(m.ev);
      if (paused) publishRender();
      break;
    case 'pause':
      setPaused(true);
      break;
    case 'resume':
      setPaused(false);
      break;
    case 'step':
      if (!paused) setPaused(true);
      stepping = stepping.then(async () => {
        const lastSeq = await step(m.frames);
        post({ type: 'stepped', reqId: m.reqId, lastSeq });
      });
      break;
    case 'finish':
      world?.finish(m.outcome);
      setPaused(true);
      break;
  }
};
