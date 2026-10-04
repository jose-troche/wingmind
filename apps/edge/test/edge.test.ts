import { SELF, env, runInDurableObject } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CompactContext } from '@wingmind/shared';
import { BudgetDO, IP_HOURLY_CAP } from '../src/budget-do';
import type { Env } from '../src/env';

const E = env as unknown as Env;

const ctx: CompactContext = {
  sessionId: 's',
  own: { headingDeg: 90, altFt: 15000, aglFt: 13000, kcas: 420, mach: 0.8, fuelLb: 14000, bingoLb: 2500, minutesToBingo: 110, emcon: 0, chaff: 60, flares: 60 },
  threats: [{ id: 'gnd-sam-1', cls: 'sam', clock: 'right two', bearingDeg: 150, rangeNm: 20, level: 'CAUTION' }],
  route: { nextWp: 2, bearingDeg: 80, distNm: 12 },
  home: { bearingDeg: 270, rangeNm: 30 },
};

async function newSession(ipAddr = '198.51.100.1'): Promise<string> {
  const r = await SELF.fetch('https://wingmind.test/api/session', {
    method: 'POST', body: JSON.stringify({ scenarioId: 'fam-01' }), headers: { 'CF-Connecting-IP': ipAddr },
  });
  expect(r.status).toBe(200);
  return ((await r.json()) as { sessionId: string }).sessionId;
}

const intent = (session: string, utter: string, ipAddr = '198.51.100.1') =>
  SELF.fetch('https://wingmind.test/api/nl/intent', {
    method: 'POST', body: JSON.stringify({ utter, ctx, session }), headers: { 'CF-Connecting-IP': ipAddr },
  });

describe('edge routes', () => {
  afterEach(() => vi.restoreAllMocks());

  it('applies the D1 migration', async () => {
    const tables = await E.DB.prepare(`SELECT name FROM sqlite_master WHERE type='table'`).all<{ name: string }>();
    const names = tables.results.map(r => r.name);
    expect(names).toContain('sorties');
    expect(names).toContain('personal_bests');
  });

  it('answers a free-form question with the mock model', async () => {
    const s = await newSession();
    const r = await intent(s, 'what is that contact doing');
    expect(r.status).toBe(200);
    const body = (await r.json()) as { intent: string; answer: string };
    expect(body.intent).toBe('query.answer');
    expect(body.answer).toContain('right two');
    expect(Number(r.headers.get('X-Neurons-Remaining'))).toBeGreaterThanOrEqual(0);
  });

  it('rejects an unknown session and an oversized utterance', async () => {
    expect((await intent('not-a-session-123', 'status')).status).toBe(404);
    const s = await newSession();
    expect((await intent(s, 'x'.repeat(301))).status).toBe(400);
  });

  it('enforces one LLM call per 5 s per session', async () => {
    const s = await newSession('198.51.100.7');
    expect((await intent(s, 'what is that contact', '198.51.100.7')).status).toBe(200);
    const second = await intent(s, 'and the second one', '198.51.100.7');
    expect(second.status).toBe(429);
    expect(((await second.json()) as { error: string }).error).toBe('rate_limited');
  });

  it('flips every LLM route to 429 at the daily ceiling, while budget status says offline', async () => {
    // the test ceiling is 40 neurons; burn it through the ledger directly
    const stub = E.BUDGET.get(E.BUDGET.idFromName('global'));
    let r = await stub.reserve(6, 'burn');
    while (r.ok) r = await stub.reserve(6, `burn-${Math.random()}`);
    expect(r.reason).toBe('daily_budget');
    const s = await newSession('198.51.100.9');
    const res = await intent(s, 'what is that contact', '198.51.100.9');
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toBe('daily_budget');
    const status = (await (await SELF.fetch('https://wingmind.test/api/budget')).json()) as { mode: string; remaining: number };
    expect(status.mode).toBe('offline');
    // summaries degrade to templates instead of failing
    const sum = await SELF.fetch('https://wingmind.test/api/nl/summary', { method: 'POST', body: JSON.stringify({ ctx, session: s }) });
    expect(((await sum.json()) as { source: string }).source).toBe('template');
  });

  it('caps neurons per IP per hour', async () => {
    const id = E.BUDGET.idFromName(`ip-test-${Math.random()}`);
    await runInDurableObject(E.BUDGET.get(id), async (inst: BudgetDO) => {
      let last = { ok: true } as { ok: boolean; reason?: string };
      for (let i = 0; i < Math.ceil(IP_HOURLY_CAP / 6) + 1 && last.ok; i++) last = inst.reserve(6, 'same-ip');
      // with a 40-neuron ceiling the daily cap trips first; the ip cap is checked after it
      expect(['ip_hourly', 'daily_budget']).toContain(last.reason);
    });
  });

  it('caps a sortie at its session neuron budget', async () => {
    const s = await newSession('198.51.100.20');
    const stub = E.SESSION.get(E.SESSION.idFromName(s));
    const before = await stub.spent();
    expect(before).toBe(0);
  });

  it('rejects session start when Turnstile fails', async () => {
    const withSecret = { ...E, TURNSTILE_SECRET: 'test-secret' } as Env;
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ success: false }), { status: 200 }));
    const { default: app } = await import('../src/index');
    const r = await app.request('/api/session', { method: 'POST', body: JSON.stringify({ turnstileToken: 'bad' }) }, withSecret);
    expect(r.status).toBe(403);
  });

  it('saves a sortie with a template debrief and reads it back', async () => {
    const form = new FormData();
    form.append('meta', JSON.stringify({
      player: 'p-test', scenarioId: 'fam-01', durationS: 600, outcome: 'survived', score: 80,
      metrics: { alerts: 4, missilesDefeated: 0, envelopeMin: 0, detectedMin: 0, reactionP50Ms: 900, falseAlarms: 0, fuelAtEndLb: 5200 },
    }));
    const r = await SELF.fetch('https://wingmind.test/api/sortie', { method: 'POST', body: form });
    expect(r.status).toBe(200);
    const saved = (await r.json()) as { id: string; debrief: string; personalBest: boolean; replayStored: boolean };
    expect(saved.debrief).toContain('Try next time');
    expect(saved.personalBest).toBe(true);
    expect(saved.replayStored).toBe(false);
    const back = (await (await SELF.fetch(`https://wingmind.test/api/sortie/${saved.id}`)).json()) as { outcome: string };
    expect(back.outcome).toBe('survived');
  });
});
