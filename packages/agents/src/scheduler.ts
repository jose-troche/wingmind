import type { BusMessage } from '@wingmind/shared';
import type { Blackboard } from './blackboard';
import type { Bus } from './bus';
import type { Agent, Snapshot } from './core';

// Agent scheduler (implementation 5.2). Reflex then tactical agents run in tier
// order at their rates; any agent with an unread priority-0 message wakes in the
// same tick (that is what keeps the missile chain inside one sim frame). Sink
// agents (PIA, NLU) run last so they see the tick's directives.

const tierOrder = { R: 0, T: 1, D: 2 } as const;

export interface AgentStat { lastMs: number; avgMs: number; runs: number; overruns: number; streak: number }

const now = (): number => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export class Scheduler {
  private last = new Map<string, number>();
  readonly stats = new Map<string, AgentStat>();
  readonly rates = new Map<string, number>();
  private ordered: Agent[];

  constructor(readonly agents: Agent[], private bus: Bus, private board: Blackboard) {
    const main = agents.filter(a => a.stage !== 'sink').sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);
    const sinks = agents.filter(a => a.stage === 'sink');
    this.ordered = [...main, ...sinks];
    for (const a of agents) {
      this.rates.set(a.id, a.rateHz);
      this.stats.set(a.id, { lastMs: 0, avgMs: 0, runs: 0, overruns: 0, streak: 0 });
    }
  }

  /** Apply ORCH's phase rate plan (agents absent from the plan keep their declared rate). */
  applyRatePlan(plan: Record<string, number>): void {
    for (const a of this.agents) this.rates.set(a.id, plan[a.id] ?? a.rateHz);
  }

  private run(a: Agent, nowMs: number, snapFor: () => Snapshot): void {
    const inbox = this.bus.drain(a.id, a.reads);
    const t0 = now();
    const out = a.step(snapFor(), inbox);
    if (out instanceof Promise) {
      // deliberative work never blocks a tick; results are published when they land
      void out.then(ms => { for (const m of ms) this.bus.publish(m, a.writes, a.id); });
      this.last.set(a.id, nowMs);
      return;
    }
    const spent = now() - t0;
    const st = this.stats.get(a.id)!;
    st.lastMs = spent;
    st.avgMs = st.runs === 0 ? spent : st.avgMs * 0.95 + spent * 0.05;
    st.runs++;
    if (spent > a.budgetMs) {
      st.overruns++;
      st.streak++;
      this.bus.publishSys('sys.overrun', { agent: a.id, spent }, { source: 'BUS', priority: 9 });
      // three overruns in a row demote the agent to half rate (contract rule, spec 12)
      if (st.streak >= 3 && a.tier === 'T') {
        this.rates.set(a.id, Math.max(0.5, (this.rates.get(a.id) ?? a.rateHz) / 2));
        st.streak = 0;
      }
    } else st.streak = 0;
    for (const m of out as BusMessage<unknown>[]) this.bus.publish(m, a.writes, a.id);
    this.last.set(a.id, nowMs);
  }

  /** One scheduler tick over a snapshot factory (rebuilt after each agent so in-tick board reads stay fresh). */
  tick(nowMs: number, snapFor: () => Snapshot): void {
    for (const a of this.ordered) {
      if (a.tier === 'D') continue;                        // deliberative work is async
      const rate = this.rates.get(a.id) ?? a.rateHz;
      const due = rate > 0 && nowMs + 1e-6 >= (this.last.get(a.id) ?? -Infinity) + 1000 / rate;
      const urgent = !due && this.bus.hasUrgent(a.id, a.reads);
      const sinkWork = !due && !urgent && a.stage === 'sink' && this.bus.hasAny(a.id, a.reads);
      if (!due && !urgent && !sinkWork) continue;
      this.run(a, nowMs, snapFor);
    }
    this.board.commit(this.bus.flush());                   // next immutable snapshot version
  }

  /** Event path: run named agents now, in the given order, regardless of rate (pilot intents). */
  runNow(ids: string[], nowMs: number, snapFor: () => Snapshot): void {
    for (const id of ids) {
      const a = this.agents.find(x => x.id === id);
      if (!a) continue;
      this.run(a, nowMs, snapFor);
      this.board.commit(this.bus.flush());
    }
  }

  reset(): void {
    this.last.clear();
    for (const a of this.agents) a.reset?.();
  }
}
