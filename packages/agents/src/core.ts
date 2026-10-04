import type {
  Advice, BusMessage, CompactContext, DetectionRing, Directive, GbadRing, OwnState, Phase, RwrEmitter, Scenario,
  Threat, Tier, Track, Vec3, Verbosity,
} from '@wingmind/shared';
import type { Terrain } from '@wingmind/sim-core';

// The agent contract (spec section 12) plus the snapshot every agent reads.

export interface EnvelopeLimits { gMax: number; gMin: number; aoaMaxDeg: number }

export interface Settings {
  verbosity: Verbosity;
  gcasAuto: boolean;
  quietAdvisories: boolean;
}

/** Static knowledge carried onboard: terrain database, route, home plate, obstacle and intel files. */
export interface StaticWorld {
  terrain: Terrain;
  scenario: Scenario;
  intelSites: { id: string; type: 'sam_long' | 'sam_short'; pos: Vec3 }[];
}

/** What every agent sees on a tick: the sensor snapshot plus the committed blackboard. */
export interface Snapshot {
  tick: number; tMs: number; wallMs: number; version: number;
  own: OwnState;
  rwr: RwrEmitter[];
  tracks: Track[];
  threats: Threat[];
  detection: DetectionRing[];
  gbadRings: GbadRing[];
  directives: Directive[];
  limits: EnvelopeLimits;
  phase: Phase;
  beam: BeamEval | null;
  route: Vec3[];
  activeWp: number;
  world: StaticWorld;
  settings: Settings;
  ew: EwState;
  gcasAuto: boolean;
}

export interface BeamEval { threatId: string; side: 'left' | 'right'; headingDeg: number; blocked: { left: boolean; right: boolean }; why: string }
export interface EwState { mode: 'manual' | 'semi' | 'auto'; program: number }

export interface Agent {
  id: string;
  tier: Tier;
  rateHz: number;
  budgetMs: number;
  reads: string[];
  writes: string[];
  /** 'sink' agents (PIA, NLU) run after every tier so they see the tick's directives. */
  stage?: 'sink';
  step(snapshot: Snapshot, inbox: BusMessage<unknown>[]): BusMessage<unknown>[] | Promise<BusMessage<unknown>[]>;
  reset?(): void;
}

export interface MsgOpts { priority?: number; ttlMs?: number; confidence?: number; evidence?: (string | undefined | null)[] }

/** Build an outbound message; the bus stamps source, tick and version on publish. */
export function msg<T>(topic: string, payload: T, o: MsgOpts = {}): BusMessage<T> {
  return {
    id: '', topic, source: '', tick: 0, snapshotVersion: 0,
    priority: o.priority ?? 5,
    ttlMs: o.ttlMs ?? 1000,
    confidence: o.confidence ?? 1,
    evidence: (o.evidence ?? []).filter((e): e is string => typeof e === 'string' && e.length > 0),
    payload,
  };
}

/** Advice as an outbound message on the `advice` topic. */
export function advise(a: Omit<Advice, 'id' | 'expiresAt'> & { id?: string }, priority = 3): BusMessage<Advice> {
  const full: Advice = { ...a, id: a.id ?? '', expiresAt: 0 };
  return msg('advice', full, { priority, ttlMs: a.ttlMs, evidence: a.evidence });
}

export const payloadOf = <T>(m: BusMessage<unknown>): T => m.payload as T;

export type ContextBuilder = (s: Snapshot) => CompactContext;
