import type { BusMessage, DetectionRing, Directive, GbadRing, Phase, Threat, Track, Vec3 } from '@wingmind/shared';
import type { BeamEval, EnvelopeLimits, EwState } from './core';

// Versioned world model (spec 5.2). Each key has exactly one owner, enforced
// by the bus contracts on the topic that feeds it. A commit produces a new
// frozen state; readers keep whatever version they were handed, so no locks.

export interface BoardState {
  version: number;
  tracks: Track[];
  ranked: Threat[];
  detection: DetectionRing[];
  gbadRings: GbadRing[];
  directives: Directive[];
  limits: EnvelopeLimits;
  phase: Phase;
  rates: Record<string, number>;
  beam: BeamEval | null;
  route: Vec3[];
  activeWp: number;
  proposedRoute: { route: Vec3[]; addedMin: number; fuelOk: boolean } | null;
  ew: EwState;
  cue: { kind: 'break' | 'pullup' | 'steer' | null; headingDeg?: number; side?: 'left' | 'right' };
}

/** topic -> key, and the single agent allowed to write it. */
export const KEY_OWNERS: Record<string, { key: keyof BoardState; owner: string }> = {
  'track.table': { key: 'tracks', owner: 'FUSE' },
  'threat.ranked': { key: 'ranked', owner: 'TAP' },
  'sig.detection': { key: 'detection', owner: 'SIG' },
  'gbad.rings': { key: 'gbadRings', owner: 'GBAD' },
  'env.limits': { key: 'limits', owner: 'SYS' },
  'orch.phase': { key: 'phase', owner: 'ORCH' },
  'orch.rates': { key: 'rates', owner: 'ORCH' },
  'orch.cue': { key: 'cue', owner: 'ORCH' },
  'nav.beam': { key: 'beam', owner: 'NAV' },
  'ew.state': { key: 'ew', owner: 'EW' },
};

export class Blackboard {
  private state: BoardState;

  constructor(route: Vec3[]) {
    this.state = Object.freeze<BoardState>({
      version: 0, tracks: [], ranked: [], detection: [], gbadRings: [], directives: [],
      limits: { gMax: 9, gMin: -3, aoaMaxDeg: 26 }, phase: 'cruise', rates: {}, beam: null,
      route, activeWp: 0, proposedRoute: null, ew: { mode: 'semi', program: 1 }, cue: { kind: null },
    });
  }

  get current(): BoardState {
    return this.state;
  }

  /** Fold a tick's messages into the next immutable version. */
  commit(messages: BusMessage<unknown>[]): BoardState {
    if (messages.length === 0) return this.state;
    const next: BoardState = { ...this.state, version: this.state.version + 1 };
    let directives: Directive[] | null = null;
    for (const m of messages) {
      const own = KEY_OWNERS[m.topic];
      if (own) {
        if (m.source !== own.owner) continue;          // defensive: the bus already enforces this
        (next as unknown as Record<string, unknown>)[own.key] = m.payload;
        continue;
      }
      if (m.topic === 'directive' && m.source === 'ORCH') {
        const d = m.payload as Directive;
        directives ??= [...next.directives];
        directives = directives.filter(x => x.axis !== d.axis);
        if (d.value !== null) directives.push(d);
      } else if (m.topic === 'nav.route' && m.source === 'NAV') {
        const r = m.payload as { route: Vec3[]; activeWp: number; proposed: BoardState['proposedRoute'] };
        next.route = r.route;
        next.activeWp = r.activeWp;
        next.proposedRoute = r.proposed;
      }
    }
    if (directives) next.directives = directives;
    this.state = Object.freeze(next);
    return this.state;
  }
}
