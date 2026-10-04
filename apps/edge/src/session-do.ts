import { DurableObject } from 'cloudflare:workers';
import type { Reservation } from './budget-do';
import { RESERVE, type Env } from './env';

// Per-sortie session (implementation 7.4): the 300-neuron sortie cap and one LLM
// call per 5 s, the last three question-and-answer pairs, a 10 s summary cache,
// and a read-only observer WebSocket on the Hibernation API.

export type ReserveKind = 'intent' | 'summary' | 'debrief' | 'stt';

export class SessionDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS qa (id INTEGER PRIMARY KEY AUTOINCREMENT, q TEXT NOT NULL, a TEXT NOT NULL, t INTEGER NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS cache (k TEXT PRIMARY KEY, v TEXT NOT NULL, t INTEGER NOT NULL)`);
  }

  private get(k: string): string | null {
    return (this.ctx.storage.sql.exec(`SELECT v FROM meta WHERE k = ?`, k).toArray()[0]?.v as string | undefined) ?? null;
  }

  private set(k: string, v: string | number): void {
    this.ctx.storage.sql.exec(`INSERT INTO meta VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v`, k, String(v));
  }

  start(scenarioId: string): { ok: true } {
    this.set('started', Date.now());
    this.set('scenario', scenarioId);
    this.set('neurons', 0);
    this.set('lastCall', 0);
    return { ok: true };
  }

  started(): boolean {
    return this.get('started') !== null;
  }

  async reserve(kind: ReserveKind, ipHash: string, seconds = 0): Promise<Reservation> {
    if (!this.started()) return { ok: false, remaining: 0, reason: 'no_session' };
    const cost = kind === 'stt' ? Math.max(1, Math.ceil(seconds)) * RESERVE.sttPerSecond : RESERVE[kind];
    const spent = Number(this.get('neurons') ?? 0);
    const cap = Number(this.env.SESSION_NEURON_CAP);
    if (spent + cost > cap) return { ok: false, remaining: 0, reason: 'session_cap' };
    const now = Date.now();
    const last = Number(this.get('lastCall') ?? 0);
    if (kind !== 'stt' && kind !== 'debrief' && now - last < 5000) return { ok: false, remaining: 0, reason: 'rate_limited' };
    const budget = this.env.BUDGET.get(this.env.BUDGET.idFromName('global'));
    const r = await budget.reserve(cost, ipHash);
    if (!r.ok) return r;
    this.set('neurons', spent + cost);
    if (kind !== 'stt') this.set('lastCall', now);
    return r;
  }

  remember(q: string, a: string): void {
    this.ctx.storage.sql.exec(`INSERT INTO qa (q, a, t) VALUES (?, ?, ?)`, q.slice(0, 300), a.slice(0, 300), Date.now());
    this.ctx.storage.sql.exec(`DELETE FROM qa WHERE id NOT IN (SELECT id FROM qa ORDER BY id DESC LIMIT 3)`);
  }

  history(): { q: string; a: string }[] {
    return this.ctx.storage.sql.exec(`SELECT q, a FROM qa ORDER BY id ASC`).toArray().map(r => ({ q: String(r.q), a: String(r.a) }));
  }

  cachedSummary(): string | null {
    const row = this.ctx.storage.sql.exec(`SELECT v, t FROM cache WHERE k = 'summary'`).toArray()[0];
    if (!row || Date.now() - Number(row.t) > 10_000) return null;
    return String(row.v);
  }

  cacheSummary(text: string): void {
    this.ctx.storage.sql.exec(`INSERT INTO cache VALUES ('summary', ?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v, t = excluded.t`, text, Date.now());
  }

  spent(): number {
    return Number(this.get('neurons') ?? 0);
  }

  /** Sortie over: wipe everything an hour later so session objects never accumulate storage. */
  async end(): Promise<void> {
    this.set('ended', Date.now());
    await this.ctx.storage.setAlarm(Date.now() + 3600_000);
  }

  override async alarm(): Promise<void> {
    for (const ws of this.ctx.getWebSockets()) ws.close(1000, 'session over');
    await this.ctx.storage.deleteAll();
  }

  override async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('expected websocket', { status: 426 });
    if (!this.started()) return new Response('no session', { status: 404 });
    const role = new URL(request.url).searchParams.get('role') === 'pilot' ? 'pilot' : 'observer';
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, [role]);
    return new Response(null, { status: 101, webSocket: client });
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // only the pilot's socket may publish; observers are read-only
    if (!this.ctx.getTags(ws).includes('pilot')) return;
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    if (text.length > 4096) return;
    for (const o of this.ctx.getWebSockets('observer')) {
      try { o.send(text); } catch { /* observer went away */ }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number): Promise<void> {
    try { ws.close(code, 'closing'); } catch { /* already closed */ }
  }
}
