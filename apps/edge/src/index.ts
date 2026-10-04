import { Hono } from 'hono';
import type { CompactContext } from '@wingmind/shared';
import { INTENT_SCHEMA, INTENT_SYSTEM, renderContext } from './prompts/intent';
import { DEBRIEF_SYSTEM, SUMMARY_SCHEMA, SUMMARY_SYSTEM, renderDebrief, renderSummary, templateDebrief, type DebriefInput } from './prompts/summary';
import { mockIntent, mockSummary } from './mock';
import { verifyTurnstile } from './turnstile';
import { INTENT_MODEL, RESERVE, STT_MODEL, aiContent, hashIp, mockAi, runAi, type Env } from './env';
export { BudgetDO } from './budget-do';
export { SessionDO } from './session-do';

// One Worker serves the console's static assets and these routes (implementation
// 7.1). Every model call is metered before it happens: SessionDO checks the
// sortie cap and call gap, then BudgetDO the daily ceiling and per-IP cap.

interface IntentReq { utter: string; ctx: CompactContext; session: string }

const app = new Hono<{ Bindings: Env }>();

const sessionStub = (env: Env, id: string) => env.SESSION.get(env.SESSION.idFromName(id));
const budgetStub = (env: Env) => env.BUDGET.get(env.BUDGET.idFromName('global'));
const ip = (h: (n: string) => string | undefined) => h('CF-Connecting-IP') ?? h('X-Forwarded-For') ?? 'local';
const validSession = (s: unknown): s is string => typeof s === 'string' && /^[\w-]{8,64}$/.test(s);

app.get('/api/health', c => c.json({ ok: true }));

app.post('/api/session', async c => {
  const body = await c.req.json<{ turnstileToken?: string; scenarioId?: string }>().catch(() => ({} as { turnstileToken?: string; scenarioId?: string }));
  if (c.env.TURNSTILE_SECRET) {
    const ok = await verifyTurnstile(c.env.TURNSTILE_SECRET, body.turnstileToken ?? '', ip(n => c.req.header(n)));
    if (!ok) return c.json({ error: 'turnstile' }, 403);
  }
  const sessionId = crypto.randomUUID();
  await sessionStub(c.env, sessionId).start(String(body.scenarioId ?? 'unknown').slice(0, 40));
  return c.json({ sessionId });
});

app.post('/api/nl/intent', async c => {
  const { utter, ctx, session } = await c.req.json<IntentReq>();
  if (!utter || typeof utter !== 'string' || utter.length > 300) return c.json({ error: 'bad_utterance' }, 400);
  if (!validSession(session) || !ctx || typeof ctx !== 'object') return c.json({ error: 'bad_request' }, 400);

  const stub = sessionStub(c.env, session);
  const gate = await stub.reserve('intent', await hashIp(ip(n => c.req.header(n))));
  if (!gate.ok) return c.json({ error: gate.reason }, gate.reason === 'no_session' ? 404 : 429);
  c.header('X-Neurons-Remaining', String(gate.remaining));

  let result: unknown;
  if (mockAi(c.env)) {
    result = mockIntent(utter, ctx);
  } else {
    const history = await stub.history();
    const out = await runAi(c.env, INTENT_MODEL, {
      messages: [
        { role: 'system', content: INTENT_SYSTEM },
        { role: 'user', content: renderContext(utter, ctx, history) },   // own state + top 5 threats only
      ],
      response_format: { type: 'json_schema', json_schema: INTENT_SCHEMA },
      max_tokens: 120,
      temperature: 0,
    });
    result = aiContent(out);
  }
  if (result && typeof result === 'object' && (result as { intent?: string }).intent === 'query.answer') {
    await stub.remember(utter, String((result as { answer?: string }).answer ?? ''));
  }
  return c.json(result ?? { intent: 'clarify', confidence: 0 });
});

app.post('/api/nl/summary', async c => {
  const { ctx, session } = await c.req.json<{ ctx: CompactContext; session: string }>();
  if (!validSession(session) || !ctx) return c.json({ error: 'bad_request' }, 400);
  const status = await budgetStub(c.env).status();
  // near the cap, status summaries switch to templates (guardrail 1)
  if (status.mode !== 'full' || mockAi(c.env)) return c.json({ say: mockSummary(ctx), source: 'template' });
  const stub = sessionStub(c.env, session);
  const cached = await stub.cachedSummary();
  if (cached) return c.json({ say: cached, source: 'cache' });
  const gate = await stub.reserve('summary', await hashIp(ip(n => c.req.header(n))));
  if (!gate.ok) return c.json({ error: gate.reason }, gate.reason === 'no_session' ? 404 : 429);
  const out = await runAi(c.env, INTENT_MODEL, {
    messages: [{ role: 'system', content: SUMMARY_SYSTEM }, { role: 'user', content: renderSummary(ctx) }],
    response_format: { type: 'json_schema', json_schema: SUMMARY_SCHEMA },
    max_tokens: 160,
    temperature: 0.2,
  });
  const content = aiContent(out);
  const say = typeof content === 'object' && content && 'say' in content ? String((content as { say: unknown }).say) : String(content ?? '');
  await stub.cacheSummary(say);
  c.header('X-Neurons-Remaining', String(gate.remaining));
  return c.json({ say, source: 'llm' });
});

app.post('/api/stt', async c => {
  const session = c.req.query('session') ?? '';
  const seconds = Math.min(8, Math.max(0.5, Number(c.req.query('seconds') ?? '3')));
  if (!validSession(session)) return c.json({ error: 'bad_request' }, 400);
  const audio = new Uint8Array(await c.req.arrayBuffer());
  if (audio.byteLength === 0 || audio.byteLength > 512 * 1024) return c.json({ error: 'bad_audio' }, 400);
  const gate = await sessionStub(c.env, session).reserve('stt', await hashIp(ip(n => c.req.header(n))), seconds);
  if (!gate.ok) return c.json({ error: gate.reason }, gate.reason === 'no_session' ? 404 : 429);
  if (mockAi(c.env)) return c.json({ text: 'chaff' });
  let bin = '';
  for (let i = 0; i < audio.length; i += 0x8000) bin += String.fromCharCode(...audio.subarray(i, i + 0x8000));
  const out = (await runAi(c.env, STT_MODEL, { audio: btoa(bin), language: 'en' })) as { text?: string };
  return c.json({ text: String(out.text ?? '').trim() });
});

app.post('/api/sortie', async c => {
  const form = await c.req.formData();
  const metaRaw = form.get('meta');
  if (typeof metaRaw !== 'string' || metaRaw.length > 20_000) return c.json({ error: 'bad_request' }, 400);
  const meta = JSON.parse(metaRaw) as {
    sessionId?: string; player: string; scenarioId: string; durationS: number; outcome: string; score: number;
    metrics: Record<string, number | string | null>;
  };
  const outcomes = ['survived', 'shot_down', 'crashed', 'aborted'];
  if (!meta.player || !meta.scenarioId || !outcomes.includes(meta.outcome)) return c.json({ error: 'bad_request' }, 400);
  const id = crypto.randomUUID();

  // replay upload, only when the R2 binding exists (30-day lifecycle rule on the bucket)
  let replayKey: string | null = null;
  const replay = form.get('replay') as unknown;
  if (c.env.REPLAYS && replay && typeof replay === 'object' && 'arrayBuffer' in replay) {
    const blob = replay as Blob;
    if (blob.size < 4 * 1024 * 1024) {
      replayKey = `replays/${meta.player.slice(0, 40)}/${id}.json.gz`;
      await c.env.REPLAYS.put(replayKey, await blob.arrayBuffer(), { httpMetadata: { contentType: 'application/json', contentEncoding: 'gzip' } });
    }
  }

  const input: DebriefInput = { scenarioId: meta.scenarioId, outcome: meta.outcome, durationS: meta.durationS, metrics: meta.metrics };
  let debrief = templateDebrief(input);
  if (!mockAi(c.env)) {
    const r = await budgetStub(c.env).reserve(RESERVE.debrief, await hashIp(ip(n => c.req.header(n))));
    if (r.ok) {
      const out = await runAi(c.env, INTENT_MODEL, {
        messages: [{ role: 'system', content: DEBRIEF_SYSTEM }, { role: 'user', content: renderDebrief(input) }],
        max_tokens: 400,
        temperature: 0.3,
      });
      const text = aiContent(out);
      if (typeof text === 'string' && text.length > 20) debrief = text.slice(0, 2000);
    }
  }

  await c.env.DB.prepare(
    `INSERT INTO sorties (id, player, created_at, scenario_id, duration_s, outcome, metrics, debrief, replay_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, meta.player.slice(0, 64), Date.now(), meta.scenarioId.slice(0, 40), Math.round(meta.durationS), meta.outcome, JSON.stringify(meta.metrics), debrief, replayKey).run();

  const best = await c.env.DB.prepare(`SELECT score FROM personal_bests WHERE player = ? AND scenario_id = ?`).bind(meta.player, meta.scenarioId).first<{ score: number }>();
  const personalBest = !best || meta.score > best.score;
  if (personalBest) {
    await c.env.DB.prepare(
      `INSERT INTO personal_bests (player, scenario_id, score, sortie_id) VALUES (?, ?, ?, ?)
       ON CONFLICT(player, scenario_id) DO UPDATE SET score = excluded.score, sortie_id = excluded.sortie_id`,
    ).bind(meta.player, meta.scenarioId, meta.score, id).run();
  }
  if (meta.sessionId && validSession(meta.sessionId)) await sessionStub(c.env, meta.sessionId).end();
  return c.json({ id, debrief, personalBest, replayStored: replayKey !== null });
});

app.get('/api/sortie/:id', async c => {
  const row = await c.env.DB.prepare(`SELECT id, scenario_id, duration_s, outcome, metrics, debrief, created_at FROM sorties WHERE id = ?`)
    .bind(c.req.param('id')).first<Record<string, unknown>>();
  if (!row) return c.json({ error: 'not_found' }, 404);
  return c.json({ ...row, metrics: JSON.parse(String(row.metrics)) });
});

app.get('/api/budget', async c => c.json(await budgetStub(c.env).status()));

app.get('/api/session/:id/observe', async c => {
  const id = c.req.param('id');
  if (!validSession(id)) return c.json({ error: 'bad_request' }, 400);
  return sessionStub(c.env, id).fetch(c.req.raw);
});

app.all('/api/*', c => c.json({ error: 'not_found' }, 404));

export default app;
