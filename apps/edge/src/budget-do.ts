import { DurableObject } from 'cloudflare:workers';
import { RESERVE, type Env } from './env';

// Daily neuron ledger (implementation 7.3, 3.3). A Durable Object handles one
// call at a time, so the ledger needs no locks. A daily alarm drops ip_hour rows
// older than a day.

export interface Reservation { ok: boolean; remaining: number; reason?: string }
export interface BudgetStatus { day: string; used: number; ceiling: number; remaining: number; mode: 'full' | 'templates' | 'offline' }

export const IP_HOURLY_CAP = 120;

export class BudgetDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ledger (day TEXT PRIMARY KEY, neurons REAL NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ip_hour (k TEXT PRIMARY KEY, neurons REAL NOT NULL)`);
  }

  private ceiling(): number {
    return Number(this.env.NEURON_CEILING);
  }

  private used(day: string): number {
    return (this.ctx.storage.sql.exec(`SELECT neurons FROM ledger WHERE day = ?`, day).toArray()[0]?.neurons as number | undefined) ?? 0;
  }

  reserve(n: number, ipHash: string): Reservation {
    const ceiling = this.ceiling();                             // 9000
    const day = new Date().toISOString().slice(0, 10);          // UTC day, matches the 00:00 UTC reset
    const used = this.used(day);
    if (used + n > ceiling) return { ok: false, remaining: Math.max(0, ceiling - used), reason: 'daily_budget' };

    const k = `${ipHash}:${new Date().toISOString().slice(0, 13)}`;   // per IP per hour
    const ipUsed = (this.ctx.storage.sql.exec(`SELECT neurons FROM ip_hour WHERE k = ?`, k).toArray()[0]?.neurons as number | undefined) ?? 0;
    if (ipUsed + n > IP_HOURLY_CAP) return { ok: false, remaining: ceiling - used, reason: 'ip_hourly' };

    this.ctx.storage.sql.exec(`INSERT INTO ledger VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET neurons = neurons + ?`, day, n, n);
    this.ctx.storage.sql.exec(`INSERT INTO ip_hour VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET neurons = neurons + ?`, k, n, n);
    void this.ensureAlarm();
    return { ok: true, remaining: ceiling - used - n };
  }

  status(): BudgetStatus {
    const day = new Date().toISOString().slice(0, 10);
    const used = this.used(day);
    const ceiling = this.ceiling();
    // offline once not even an intent call fits; templates from 7,200 of 9,000
    const mode = ceiling - used < RESERVE.intent ? 'offline' : used >= ceiling * 0.8 ? 'templates' : 'full';
    return { day, used, ceiling, remaining: Math.max(0, ceiling - used), mode };
  }

  private async ensureAlarm(): Promise<void> {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 24 * 3600_000);
  }

  override async alarm(): Promise<void> {
    const cutoff = new Date(Date.now() - 24 * 3600_000).toISOString().slice(0, 13);
    this.ctx.storage.sql.exec(`DELETE FROM ip_hour WHERE substr(k, instr(k, ':') + 1) < ?`, cutoff);
    const keepDay = new Date(Date.now() - 7 * 24 * 3600_000).toISOString().slice(0, 10);
    this.ctx.storage.sql.exec(`DELETE FROM ledger WHERE day < ?`, keepDay);
    await this.ctx.storage.setAlarm(Date.now() + 24 * 3600_000);
  }
}
