import type { LogEntry } from '@wingmind/agents';
import type {
  BoardSummary, Controls, Directive, InjectEvent, Intent, MeshEdge, RenderFrame, Scenario, SimEvent, SimSnapshot,
  SortieOutcome, SpeakItem, Verbosity,
} from '@wingmind/shared';

// Messages between the three threads (implementation 5.1). Snapshots travel in
// SharedArrayBuffer rings when the page is cross-origin isolated; otherwise the
// same objects go by postMessage at the same rate.

export interface SimInit {
  type: 'init';
  scenario: Scenario;
  seed: number;
  agentRing: SharedArrayBuffer | null;
  renderRing: SharedArrayBuffer | null;
  port: MessagePort;
  paused: boolean;
}

export type ToSim =
  | SimInit
  | { type: 'controls'; c: Partial<Controls> }
  | { type: 'inject'; ev: InjectEvent }
  | { type: 'pause' }
  | { type: 'resume' }
  | { type: 'step'; frames: number; reqId: number }
  | { type: 'finish'; outcome: SortieOutcome };

export type FromSim =
  | { type: 'ready'; heights: Int16Array }
  | { type: 'frame'; frame: RenderFrame }
  | { type: 'stepped'; reqId: number; lastSeq: number }
  | { type: 'events'; events: SimEvent[]; truth: { missilesAlive: number; falseAlarmObs: string[] } }
  | { type: 'outcome'; outcome: SortieOutcome };

export interface AgentsInit {
  type: 'init';
  scenario: Scenario;
  agentRing: SharedArrayBuffer | null;
  port: MessagePort;
  sessionId: string;
  verbosity: Verbosity;
}

export type ToAgents =
  | AgentsInit
  | { type: 'intent'; intent: Intent }
  | { type: 'say'; text: string; question?: string }
  | { type: 'session'; sessionId: string }
  | { type: 'export' };

export type FromAgents =
  | { type: 'ready' }
  | { type: 'out'; seq: number; speak: SpeakItem[]; logs: LogEntry[]; directives: Directive[]; ui: Intent[] }
  | { type: 'summary'; board: BoardSummary; mesh: MeshEdge[] }
  | { type: 'replay'; data: unknown };

/** Over the sim <-> agents MessagePort. */
export type SimToAgents =
  | { type: 'terrain'; heights: Int16Array }
  | { type: 'frame'; seq: number; snap: SimSnapshot | null; ack: boolean }
  | { type: 'mode'; realtime: boolean };

export type AgentsToSim =
  | { type: 'directives'; list: Directive[] }
  | { type: 'ack'; seq: number };

/** The slice of a dedicated worker's global scope the workers use (keeps the DOM lib only). */
export interface WorkerScope<In> {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<In>) => void) | null;
}

export const AGENT_RING_BYTES = 192 * 1024;
export const RENDER_RING_BYTES = 128 * 1024;
