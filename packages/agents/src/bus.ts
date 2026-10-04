import type { Advice, BusMessage, MeshEdge } from '@wingmind/shared';

// Typed event bus (spec 5.3). Agents never call each other: they publish to
// topics they declared in `writes` (anything else throws, enforcing the
// single-writer rule) and drain the topics in their `reads`. Delivery is in-tick:
// a message published earlier in a tick reaches agents that run later in it.

export class ContractError extends Error {}

export const topicMatches = (pattern: string, topic: string): boolean =>
  pattern === '*' || pattern === topic || (pattern.endsWith('.*') && (topic === pattern.slice(0, -2) || topic.startsWith(pattern.slice(0, -1))));

interface Stored { seq: number; m: BusMessage<unknown>; expiresAt: number }

export class Bus {
  tick = 0;
  version = 0;
  nowMs = 0;
  private seq = 0;
  private idSeq = 0;
  private log: Stored[] = [];
  private pending: BusMessage<unknown>[] = [];
  private cursors = new Map<string, number>();
  private pairs = new Map<string, MeshEdge>();
  readonly trace: BusMessage<unknown>[] = [];
  traceLimit = 0;
  /** Observer for every stored message (the runtime uses it to route outputs). */
  onMessage: ((m: BusMessage<unknown>) => void) | null = null;

  begin(tick: number, version: number, nowMs: number): void {
    this.tick = tick;
    this.version = version;
    this.nowMs = nowMs;
    // keep two seconds of history (longest TTL that matters for late readers)
    const cutoff = nowMs - 2000;
    if (this.log.length > 0 && this.log[0]!.m.tick < tick - 240) this.log = this.log.filter(s => s.expiresAt > cutoff);
  }

  private stamp(m: BusMessage<unknown>, source: string): BusMessage<unknown> {
    const out = { ...m, id: m.id || `${source.toLowerCase()}-${(++this.idSeq).toString(36)}`, source, tick: this.tick, snapshotVersion: this.version };
    if (out.topic === 'advice') {
      const a = out.payload as Advice;
      out.payload = { ...a, id: a.id || out.id, source, expiresAt: this.nowMs + a.ttlMs };
    }
    return out;
  }

  private store(m: BusMessage<unknown>): void {
    this.log.push({ seq: ++this.seq, m, expiresAt: this.nowMs + m.ttlMs });
    this.pending.push(m);
    this.onMessage?.(m);
    if (this.traceLimit > 0) {
      this.trace.push(m);
      if (this.trace.length > this.traceLimit) this.trace.splice(0, this.trace.length - this.traceLimit);
    }
  }

  /** Publish on behalf of an agent; throws on a topic outside its `writes`. */
  publish(m: BusMessage<unknown>, writes: readonly string[], source: string): BusMessage<unknown> {
    if (!writes.some(w => topicMatches(w, m.topic))) {
      throw new ContractError(`${source} may not publish to ${m.topic}`);
    }
    const s = this.stamp(m, source);
    this.store(s);
    return s;
  }

  /** System messages (sensor adapter, sim events, overruns) bypass agent contracts. */
  publishSys<T>(topic: string, payload: T, opts: { source?: string; priority?: number; ttlMs?: number; evidence?: string[]; id?: string } = {}): BusMessage<T> {
    const m: BusMessage<T> = {
      id: opts.id ?? '', topic, source: opts.source ?? 'BUS', tick: this.tick, snapshotVersion: this.version,
      priority: opts.priority ?? 5, ttlMs: opts.ttlMs ?? 1000, confidence: 1, evidence: opts.evidence ?? [], payload,
    };
    const s = this.stamp(m as BusMessage<unknown>, m.source);
    this.store(s);
    return s as BusMessage<T>;
  }

  private matching(agentId: string, reads: readonly string[]): Stored[] {
    const after = this.cursors.get(agentId) ?? 0;
    const out: Stored[] = [];
    for (let i = this.log.length - 1; i >= 0; i--) {
      const s = this.log[i]!;
      if (s.seq <= after) break;
      if (s.expiresAt < this.nowMs || s.m.source === agentId) continue;
      if (reads.some(r => topicMatches(r, s.m.topic))) out.push(s);
    }
    return out.reverse();
  }

  /** Unread messages for an agent, ordered by priority then arrival; advances its cursor. */
  drain(agentId: string, reads: readonly string[]): BusMessage<unknown>[] {
    const found = this.matching(agentId, reads);
    this.cursors.set(agentId, this.seq);
    for (const s of found) {
      const key = `${s.m.source}>${agentId}`;
      const e = this.pairs.get(key);
      if (e) { e.count++; e.priority = Math.min(e.priority, s.m.priority); }
      else this.pairs.set(key, { from: s.m.source, to: agentId, count: 1, priority: s.m.priority });
    }
    return found.map(s => s.m).sort((a, b) => a.priority - b.priority);
  }

  /** True when an agent has an unread priority-0 message (reflex wake). */
  hasUrgent(agentId: string, reads: readonly string[]): boolean {
    return this.matching(agentId, reads).some(s => s.m.priority === 0);
  }

  hasAny(agentId: string, reads: readonly string[]): boolean {
    return this.matching(agentId, reads).length > 0;
  }

  /** Messages published since the last flush (input to the blackboard commit). */
  flush(): BusMessage<unknown>[] {
    const out = this.pending;
    this.pending = [];
    return out;
  }

  /** Per-pair message counts since the last call, for the agent mesh visualizer. */
  takePairs(): MeshEdge[] {
    const out = [...this.pairs.values()];
    this.pairs.clear();
    return out;
  }

  reset(): void {
    this.log = [];
    this.pending = [];
    this.cursors.clear();
    this.pairs.clear();
    this.seq = 0;
  }
}
