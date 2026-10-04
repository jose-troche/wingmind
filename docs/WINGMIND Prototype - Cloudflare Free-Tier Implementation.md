# WINGMIND Prototype — Cloudflare Free-Tier Implementation

Oct 4, 2026 · @Jose

## 1. Prototype scope

The prototype is Phase 0 of the WINGMIND specification: one aircraft, four threat types and twelve agents running in the browser, with Cloudflare's free tier supplying hosting, LLM inference and storage. It passes Gate 0 when the low-altitude missile-launch sequence (spec section 5.7) runs end to end with first audio under 150 ms at the 95th percentile.

**In scope**

- **Flight:** six-degree-of-freedom model with table aerodynamics, two engines, three fuel tanks, ISA atmosphere with layered wind and cloud layers.
- **Threats:** an enemy two-ship of fighters with radar missiles, one long-range SAM site, one short-range IR site, and a five-drone swarm.
- **Agents (12):** ORCH, FUSE, MAWS, AIR (fighters and drones), GBAD (long and short range), TAP, SIG, EW, NAV (ground collision, obstacles, routing), SYS (engines, fuel, weather and envelope combined), PIA and NLU. BRIEF runs as an edge function.
- **Console:** HUD, situation display, warning receiver scope, engine and fuel pages, master lights, Agent Ops panel and five concept visuals.
- **Language:** templated spoken alerts, a 30-phrase command grammar, and LLM answers to free-form questions.
- **Scenarios:** ladder scenarios 1, 2, 3 and 5 from spec section 13.

**Out of scope until Phase 1:** replay scrubber (sorties are recorded, not yet replayable), instructor mode, real elevation data (terrain is procedural), weather cross-section, HOTAS beyond the browser Gamepad API, mobile layouts, multiplayer.

**Success criteria**

1. Gate 0 passes on a recent laptop in Chrome.
2. The console holds 60 fps with all twelve agents running.
3. The deployment costs nothing at the target load in section 3.
4. A new contributor can clone, run locally and deploy with three commands.

## 2. Architecture on Cloudflare

The simulation and every reflex and tactical agent run in the browser; the edge does only what a browser cannot: host the language model, enforce the free-tier budget and store results.

**Why the sim cannot run on the edge.** A 60 Hz server tick is 216,000 requests per player-hour. The Workers free plan allows 100,000 requests per day and 10 ms of CPU per request, so one player would exhaust the day in under 30 minutes. A network round trip would also blow the 150 ms alert budget. The browser has the CPU, so it gets the work, the same pattern as a thin-Worker, heavy-browser design.

| Component | Cloudflare product | Responsibility |
| --- | --- | --- |
| Web app, terrain tiles, scenario JSON, pre-synthesized voice clips | Workers Static Assets | Served free and unmetered; scenarios ship as static files, so no catalog database is needed |
| `/api/*` routes | Worker (Hono router) | LLM intent and summary calls, speech-to-text fallback, sortie save, budget checks |
| Language model | Workers AI binding | `@cf/meta/llama-3.1-8b-instruct-fast` in JSON mode for intents and summaries; `@cf/openai/whisper-large-v3-turbo` for speech-to-text fallback; `@cf/myshell-ai/melotts` once at build time for voice clips |
| Daily budget ledger | Durable Object `BudgetDO` (SQLite, one instance) | Counts neurons spent today, enforces a ceiling, flips to grammar-only mode near the cap |
| Per-sortie session | Durable Object `SessionDO` (SQLite, one per sortie) | Per-session rate limit, short conversation memory for follow-up questions, optional read-only observer WebSocket |
| Sortie records | D1 | Sortie metadata, metrics, debrief text, personal bests |
| Replays | R2 | Gzipped replay files with a 30-day lifecycle rule |

**Deliberately not used:** Workers KV. Its free plan allows 1,000 writes per day, too tight for counters, and static assets already cover the read-only catalog.

**Inference tiers.** Free-form language goes through a tier router so the free pool lasts. Tier 0 is the browser's on-device model (Chrome built-in AI) when present. Tier 1 is the Workers AI free pool. Tiers 2 and 3 (OAuth-linked provider, bring-your-own-key) are stubbed for Phase 1. The command grammar sits in front of all tiers and needs none of them.

## 3. Free-tier budget

Workers AI is the only binding limit: at about 87 neurons per 20-minute sortie, the 10,000-neuron daily allocation covers roughly 90 LLM-assisted sorties a day after a safety margin, and every other product has at least 30 times that headroom. Limits below are from Cloudflare's [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) (updated Oct 2, 2026) and [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/) (updated Oct 1, 2026) pages; free limits reset daily at 00:00 UTC.

### 3.1 Neurons per sortie

Assumed sortie: 20 minutes, 8 utterances that miss the grammar, 4 status summaries, 1 debrief. Rates are Llama 3.1 8B fast: 4,119 neurons per million input tokens and 34,868 per million output tokens.

| LLM call | Input tokens | Output tokens | Neurons per call | Calls per sortie | Neurons per sortie |
| --- | --- | --- | --- | --- | --- |
| Free-form command or question | 700 | 60 | 5.0 | 8 | 40 |
| Status summary | 900 | 80 | 6.5 | 4 | 26 |
| Debrief narrative | 2,500 | 300 | 20.8 | 1 | 21 |
| **Total** |  |  |  |  | **87** |

With a 9,000-neuron ceiling and the conservative per-call reservations in section 7.1 (101 neurons per sortie), that is about 90 sorties a day. Pilots on Chrome with on-device AI (Tier 0) cost nothing. Speech-to-text fallback for browsers without built-in recognition adds about 2.3 neurons per 3-second utterance (Whisper large-v3 turbo at 46.63 neurons per audio minute).

**Open question:** the pricing table lists `llama-3.1-8b-instruct-fp8-fast` while the JSON Mode list names `llama-3.1-8b-instruct-fast`. Confirm in week 1 that they are the same model and rate.

### 3.2 Every other limit

| Resource | Free limit | Use per sortie | Daily capacity |
| --- | --- | --- | --- |
| Static asset requests | Free and unlimited | About 40 files on first load | Unlimited |
| Worker requests | 100,000 per day | About 20 | About 5,000 sorties |
| Worker CPU | 10 ms per request | Under 3 ms target; waiting on the model is I/O, not CPU | Per-request cap, not pooled |
| Workers AI | 10,000 neurons per day | About 87 | About 90 sorties (binding) |
| Durable Object requests | 100,000 per day | About 30 | About 3,300 sorties |
| Durable Object duration | 13,000 GB-s per day | Under 1 GB-s | Over 10,000 sorties |
| D1 rows written | 100,000 per day | About 3 | About 30,000 sorties |
| D1 rows read | 5 million per day | About 50 | About 100,000 sorties |
| R2 writes (Class A) | 1 million per month | 1 | About 33,000 per day |
| R2 storage | 10 GB-month | 2 MB target per replay, kept 30 days | About 5,000 stored replays |
| Workers Logs | 200,000 events per day | About 25 | About 8,000 sorties |

Durable Objects on the free plan must use the SQLite storage backend, and incoming WebSocket messages are billed at a 20:1 ratio, so the observer socket uses the Hibernation API to avoid duration charges.

### 3.3 Budget guardrails

1. `BudgetDO` keeps a daily neuron ledger with a 9,000 ceiling. At 7,200, status summaries switch to templates; at 9,000, every LLM route returns 429 and the console says "Voice queries offline" while the grammar keeps working.
2. `SessionDO` caps each sortie at 300 neurons and one LLM call per 5 s, matching the spec.
3. Every call sets `max_tokens`: 120 for intents, 160 for summaries, 400 for debriefs.
4. Prompts carry a compact context: own-state summary and top five threats only.
5. A repeated status request within 10 s returns the cached answer from `SessionDO`.

## 4. Repository layout and tech stack

One TypeScript monorepo, one Worker that serves both the static app and the API, and pure-TS simulation and agent packages that run unchanged in browser workers and in headless Node tests.

**Language policy: TypeScript is the preferred language for all code.** That covers the web app, the browser workers, the Worker and Durable Objects, the shared packages, build tools in `tools/`, unit and Playwright tests, and config files that accept code (`vite.config.ts`, `playwright.config.ts`, `vitest.config.ts`). Plain JavaScript files are not allowed (`allowJs: false`), and every package extends one strict base config. The only non-TypeScript files are those a platform requires: SQL for D1 migrations, `wrangler.jsonc`, GitHub Actions YAML, and shell one-liners in docs.

```jsonc
// tsconfig.base.json (every package extends this)
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "allowJs": false,
    "isolatedModules": true,
    "verbatimModuleSyntax": true,
    "skipLibCheck": true
  }
}
```

The Worker package adds `@cloudflare/workers-types` and generates its `Env` type with `wrangler types`, so bindings such as `AI`, `BUDGET` and `DB` are typed from `wrangler.jsonc` instead of written by hand. `pnpm typecheck` runs `tsc --noEmit` across all packages and is part of the deploy workflow.

```text
wingmind/
├─ apps/
│  ├─ web/                    # Vite single-page console
│  │  ├─ src/
│  │  │  ├─ console/          # layout, HUD, displays, Agent Ops
│  │  │  ├─ visuals/          # concept visuals (D3)
│  │  │  ├─ audio/            # alert engine, earcons, clip stitcher
│  │  │  ├─ voice/            # push-to-talk, speech adapters, tier router
│  │  │  └─ workers/          # sim.worker.ts, agents.worker.ts
│  │  └─ public/              # scenarios/*.json, terrain/*.bin, voice/*.ogg, _headers
│  └─ edge/                   # the Cloudflare Worker
│     ├─ src/index.ts         # Hono routes
│     ├─ src/budget-do.ts
│     ├─ src/session-do.ts
│     ├─ src/prompts/         # system prompts and JSON schemas
│     ├─ migrations/0001_init.sql
│     └─ wrangler.jsonc
├─ packages/
│  ├─ shared/                 # types from spec section 12
│  ├─ sim-core/               # flight model, atmosphere, engines, fuel, sensors, entities
│  ├─ agents/                 # bus, blackboard, arbiter, the 12 agents
│  └─ nl/                     # alert templates, normalizer, grammar, intent schema
├─ tools/                     # gen-voice.ts (MeloTTS clips), gen-terrain.ts
├─ tests/e2e/                 # Playwright
├─ docs/                      # spec.md, implementation.md
└─ CLAUDE.md                  # conventions for Claude Code sessions
```

| Layer | Choice | Why |
| --- | --- | --- |
| Language and build | TypeScript, pnpm workspaces, Vite | One type system from flight model to Worker |
| UI shell | React 19 for panels and layout | Familiar; instruments bypass it (next row) |
| Instruments | SVG and Canvas written directly in a `requestAnimationFrame` loop | No React re-render at 30–60 Hz |
| 3D | Three.js on WebGL2 | Mature, small, procedural terrain chunks |
| Analytic visuals | D3 | Polar plots, envelopes, heat maps |
| Worker messaging | `SharedArrayBuffer` ring buffer for state, `postMessage` for events | Zero-copy snapshots between sim and agents |
| Edge router | Hono on Workers | Tiny, typed, fast cold start |
| Edge state | Durable Objects (SQLite), D1, R2 | All available on the free plan |
| Tests | Vitest, `@cloudflare/vitest-pool-workers`, Playwright | Unit, edge and end-to-end in one runner family |

`SharedArrayBuffer` needs cross-origin isolation, so `public/_headers` sets `Cross-Origin-Opener-Policy: same-origin` and `Cross-Origin-Embedder-Policy: require-corp`. If isolation fails, the app falls back to transferable `postMessage` snapshots at the same rate.

## 5. Client implementation

Three threads do all the real work: the sim worker owns physics, the agent worker owns the mesh, and the main thread only draws, plays audio and reads input.

### 5.1 Threads and timing

- **sim.worker** integrates at 120 Hz and writes a snapshot every second step (60 Hz) into a three-slot `SharedArrayBuffer` ring, then calls `Atomics.notify`.
- **agents.worker** blocks on `Atomics.wait`, so it wakes the instant a snapshot lands instead of on an imprecise timer. It runs every due agent in tier order and posts alerts to the main thread and directives back to the sim worker.
- **Main thread** renders the scene at display rate and instruments at 30 Hz, and plays audio the moment an alert arrives.

This wake-on-write chain is what makes the 150 ms budget comfortable: the agent sees an event within one sim frame (about 17 ms) of it happening.

### 5.2 Agent scheduler

```typescript
// packages/agents/src/scheduler.ts
const tierOrder = { R: 0, T: 1, D: 2 } as const;

export class Scheduler {
  private last = new Map<string, number>();
  constructor(private agents: Agent[], private bus: Bus, private board: Blackboard) {
    agents.sort((a, b) => tierOrder[a.tier] - tierOrder[b.tier]);
  }

  tick(nowMs: number, snap: Snapshot) {
    for (const a of this.agents) {
      if (a.tier === 'D') continue;                        // deliberative work is async, see section 6
      if (nowMs < (this.last.get(a.id) ?? -Infinity) + 1000 / a.rateHz) continue;
      const t0 = performance.now();
      const out = a.step(snap, this.bus.drain(a.reads)) as BusMessage<unknown>[];
      const spent = performance.now() - t0;
      if (spent > a.budgetMs) this.bus.publishSys('sys.overrun', { agent: a.id, spent });
      for (const m of out) this.bus.publish(m, a.writes);  // throws on a topic outside `writes`
      this.last.set(a.id, nowMs);
    }
    this.board.commit(this.bus.flush());                   // next immutable snapshot version
  }
}
```

### 5.3 A reflex agent: MAWS

```typescript
// packages/agents/src/maws.ts
export const maws: Agent = {
  id: 'MAWS', tier: 'R', rateHz: 50, budgetMs: 1,
  reads: ['obs.das', 'obs.rwr'], writes: ['threat.missile', 'alert'],
  step(s, inbox) {
    const out: BusMessage<unknown>[] = [];
    for (const m of inbox) {
      if (m.topic !== 'obs.das' || m.payload.kind !== 'plume') continue;
      const brg = m.payload.bearingDeg;
      const guide = s.rwr.find(e => e.mode === 'guidance' && angleDiff(e.bearingDeg, brg) < 15);
      const trk = nearestFastCloser(s.tracks, brg);           // small, fast, closing
      const tti = trk ? trk.rangeM / Math.max(trk.closureMps, 1) : 10;
      const threat = {
        id: `msl-${m.id}`, class: guide ? 'radar_missile' : 'ir_missile',
        bearingDeg: brg, rangeM: trk?.rangeM, tActS: tti,
        confidence: guide ? 0.95 : 0.75, lethality: 1, pEngage: 1,
      };
      out.push(msg('threat.missile', threat, { priority: 0, evidence: [m.id, guide?.id, trk?.id] }));
      out.push(msg('alert', alertFor(threat, s.own), { priority: 0 }));
    }
    return out;
  },
};
```

### 5.4 The arbiter inside ORCH

```typescript
// packages/agents/src/arbiter.ts
export function arbitrate(advice: Advice[], env: EnvelopeLimits, now: number): Directive[] {
  const live = advice.filter(a => a.expiresAt > now);
  return Object.entries(groupBy(live, a => a.axis)).map(([axis, list]) => {
    list.sort((a, b) => a.safetyRank - b.safetyRank || b.utility - a.utility);
    const [win, ...rest] = list;
    return clampToEnvelope({
      id: uid(), axis: axis as Axis, value: win.value, source: win.source,
      supersedes: rest.map(r => r.id),
      why: [`${win.source} won (rank ${win.safetyRank})`, ...rest.map(r => `${r.source} suppressed`)],
    }, env);                                                // no directive may exceed G or AoA limits
  });
}
```

### 5.5 Prototype simplifications per agent

| Agent | Prototype version | Full version (Phase 1) |
| --- | --- | --- |
| FUSE | Nearest-neighbor gating, alpha-beta filter | Kalman filter, probabilistic association |
| MAWS | Plume plus guidance-emitter correlation (above) | Adds false-alarm learning per scenario |
| AIR | Rules for four intent states; envelope table by altitude only | Seven states, hidden-Markov classifier, aspect and closure |
| GBAD | Fixed ring cut by line-of-sight on 64 radials | Full altitude dome and emitter sequence |
| TAP | Full scoring model from spec 6.4 | Same |
| SIG | 36-bin aspect table; ring radius scales with the fourth root of signature | Elevation bins, IR and emissions maps |
| EW | Manual and semi-auto dispense | Auto mode, jammer model |
| NAV | Ground-collision projection, obstacle calls, A\* on a 1 km grid | Terrain following, mid-air avoidance |
| SYS | Engine faults, bingo and joker, next-leg weather, G and AoA guard | Split into PROP, FUEL, WX, ENV |
| ORCH | Arbiter plus phase rate plan | Adds deliberative re-plan proposals |
| PIA, NLU | Section 6 | Same, plus workload model |

### 5.6 Flight model and terrain

- Aerodynamic and engine tables are JSON static assets with illustrative generic-fighter values; the integrator is RK4 and the control law is a pitch-rate PI loop on commanded G.
- `tools/gen-terrain.ts` builds a procedural 64 km square at 64 m spacing (Int16 heights, about 2 MB raw before compression) with ridges and valleys sized for the masking scenario.

## 6. Natural-language layer

Spoken alerts are stitched from pre-recorded clips in the browser, spoken commands hit a local grammar first, and only leftovers travel to an LLM, whose output is validated before anything is spoken or executed.

### 6.1 Alert engine (PIA)

- **Templates** live in `packages/nl/templates.ts`, one standard and one terse variant per alert class, with slots for clock position, range, altitude and action.
- **Voice clips.** `tools/gen-voice.ts` runs once in CI and renders about 180 fragments (numbers, clock positions, threat nouns, actions) with MeloTTS on Workers AI. At 18.63 neurons per audio minute, the whole library costs well under 100 neurons once. Clips ship as MP3 static assets.
- **Playback.** All clips are decoded into `AudioBuffer`s at load, then scheduled back-to-back through Web Audio with 30 ms gaps. `speechSynthesis` is the fallback for any phrase without clips.
- **Spatial cue.** The earcon plays through an HRTF `PannerNode` placed at the threat's relative bearing; the voice stays centered for clarity.
- **Queue rules** follow spec section 9.4: de-duplicate by key, coalesce swarms, and let a WARNING cut current speech at the next clip boundary.

```typescript
// packages/nl/templates.ts (excerpt)
export const templates: Record<AlertClass, { std: string; terse: string }> = {
  radar_missile: { std: 'Missile, {clock}, {range}. {action}.', terse: 'Missile, {clock}, {action}.' },
  ir_missile:    { std: 'Missile, {clock}, close. {action}.',  terse: 'Missile, {clock}, {action}.' },
  sam_track:     { std: 'SAM tracking, {clock}, {range}. {action}.', terse: 'SAM, {clock}.' },
  pull_up:       { std: 'Pull up. Pull up.', terse: 'Pull up.' },
  bingo:         { std: 'Bingo fuel. Home plate {bearing}, {range}.', terse: 'Bingo.' },
};
```

### 6.2 Speech input

1. Push-to-talk on Space or a mapped gamepad button.
2. Browser `SpeechRecognition` where available, with interim results switched on.
3. Otherwise `MediaRecorder` captures the clip and posts it to `/api/stt` (Whisper large-v3 turbo, about 2.3 neurons per 3 s).
4. **Early fire:** the grammar runs on every interim transcript, so one-word defensive commands ("chaff", "flares") execute on the first confident match without waiting for end of speech.

### 6.3 Normalizer and grammar

The normalizer lowercases, turns spoken digits into numbers ("two seven zero" to 270, "niner" to 9), strips filler words and maps synonyms ("bogey" to bandit). The grammar is an ordered list of about 30 patterns.

```typescript
// packages/nl/grammar.ts (excerpt)
export const rules: Rule[] = [
  { re: /^(?:heading|turn (?:to )?)(\d{3})$/,
    intent: m => ({ intent: 'nav.setHeading', params: { heading_deg: +m[1] } }),
    readback: m => `Heading ${spellDigits(m[1])}` },
  { re: /^(?:climb|descend)(?: and maintain)? angels (\d{1,2})$/,
    intent: m => ({ intent: 'nav.setAltitude', params: { alt_ft: +m[1] * 1000 } }),
    readback: m => `Angels ${spellNumber(+m[1])}` },
  { re: /^(chaff|flares?)$/, confirm: false,
    intent: m => ({ intent: 'ew.dispense', params: { kind: m[1].startsWith('flare') ? 'flare' : 'chaff' } }) },
  { re: /^radar (?:silent|off|quiet)$/,
    intent: () => ({ intent: 'sig.setEmcon', params: { level: 3 } }), readback: () => 'Radar silent' },
];
```

### 6.4 Tier router

```typescript
// apps/web/src/voice/interpret.ts
export async function interpret(utter: string, ctx: CompactContext): Promise<IntentResult> {
  const fast = matchGrammar(normalize(utter));
  if (fast) return fast;                                         // most commands stop here
  if (await onDevice.available()) return validate(await onDevice.intent(utter, ctx), ctx); // Tier 0
  const r = await fetch('/api/nl/intent', {                      // Tier 1: Workers AI
    method: 'POST', body: JSON.stringify({ utter, ctx, session: ctx.sessionId }),
  });
  if (r.status === 429) return { kind: 'unable', say: 'Unable, voice queries offline.' };
  return validate(await r.json(), ctx);                          // never trust model output
}
```

### 6.5 Edge prompt and schema

```typescript
// apps/edge/src/prompts/intent.ts
export const INTENT_SYSTEM = `You turn a fighter pilot's spoken request into ONE JSON intent for a flight simulator.
Use only intents in the schema. Resolve "that contact" or "the SAM" from the context.
For a question, use intent "query.answer" and write a spoken answer under 20 words in "answer",
using only numbers that appear in the context. If the request is unclear, use intent "clarify". Never invent values.`;

export const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: ['nav.setHeading', 'nav.setAltitude', 'nav.setSpeed', 'nav.replan',
      'nav.direct', 'ew.dispense', 'ew.setMode', 'sig.setEmcon', 'ui.show', 'pia.verbosity',
      'query.answer', 'clarify'] },
    params: { type: 'object' },
    answer: { type: 'string' },
    readback: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['intent', 'confidence'],
};
```

**Number guardrail.** `validate()` extracts every number from `answer` and `readback` and checks it against the compact context (allowing rounding). Any mismatch replaces the answer with the matching template or "Say again". Intents then pass the same range and safety checks as grammar intents (spec 10.5).

## 7. Edge implementation

One Worker serves the app and eight API routes; two SQLite-backed Durable Objects meter every model call before it happens, and D1 plus R2 keep what a sortie leaves behind.

### 7.1 Routes

| Route | Purpose | Bindings | Neurons reserved |
| --- | --- | --- | --- |
| `POST /api/session` | Start a sortie after a Turnstile check; returns a session id | `SESSION` | 0 |
| `POST /api/nl/intent` | Free-form command or question | `AI`, `SESSION`, `BUDGET` | 6 |
| `POST /api/nl/summary` | Status summary | `AI`, `SESSION`, `BUDGET` | 7 |
| `POST /api/stt` | Speech-to-text fallback, clips up to 8 s | `AI`, `SESSION`, `BUDGET` | 1 per second of audio |
| `POST /api/sortie` | Save metrics, upload replay, generate debrief | `DB`, `REPLAYS`, `AI`, `BUDGET` | 25 |
| `GET /api/sortie/:id` | Read a debrief | `DB` | 0 |
| `GET /api/budget` | Neurons left today, for the console's LLM status light | `BUDGET` | 0 |
| `GET /api/session/:id/observe` | Optional read-only observer WebSocket | `SESSION` | 0 |

Each route reserves a fixed, conservative neuron amount up front instead of settling afterwards, which keeps every LLM call to two Durable Object requests (about 30 per sortie).

### 7.2 Worker entry

```typescript
// apps/edge/src/index.ts
import { Hono } from 'hono';
import { INTENT_SYSTEM, INTENT_SCHEMA, renderContext } from './prompts/intent';
export { BudgetDO } from './budget-do';
export { SessionDO } from './session-do';

const app = new Hono<{ Bindings: Env }>();

app.post('/api/nl/intent', async c => {
  const { utter, ctx, session } = await c.req.json<IntentReq>();
  if (!utter || utter.length > 300) return c.json({ error: 'bad_utterance' }, 400);

  const stub = c.env.SESSION.get(c.env.SESSION.idFromName(session));
  const gate = await stub.reserve('intent', c.req.header('CF-Connecting-IP') ?? '');
  if (!gate.ok) return c.json({ error: gate.reason }, 429);

  const out = await c.env.AI.run('@cf/meta/llama-3.1-8b-instruct-fast', {
    messages: [
      { role: 'system', content: INTENT_SYSTEM },
      { role: 'user', content: renderContext(utter, ctx) },   // own state + top 5 threats only
    ],
    response_format: { type: 'json_schema', json_schema: INTENT_SCHEMA },
    max_tokens: 120,
    temperature: 0,
  });
  c.header('X-Neurons-Remaining', String(gate.remaining));
  return c.json(out.response);
});

export default app;
```

### 7.3 Budget ledger

```typescript
// apps/edge/src/budget-do.ts
import { DurableObject } from 'cloudflare:workers';

export class BudgetDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ledger (day TEXT PRIMARY KEY, neurons REAL NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS ip_hour (k TEXT PRIMARY KEY, neurons REAL NOT NULL)`);
  }

  reserve(n: number, ipHash: string): { ok: boolean; remaining: number; reason?: string } {
    const ceiling = Number(this.env.NEURON_CEILING);       // 9000
    const day = new Date().toISOString().slice(0, 10);       // UTC day, matches the 00:00 UTC reset
    const used = (this.ctx.storage.sql.exec(`SELECT neurons FROM ledger WHERE day = ?`, day)
      .toArray()[0]?.neurons as number) ?? 0;
    if (used + n > ceiling) return { ok: false, remaining: ceiling - used, reason: 'daily_budget' };

    const k = `${ipHash}:${new Date().toISOString().slice(0, 13)}`;   // per IP per hour
    const ipUsed = (this.ctx.storage.sql.exec(`SELECT neurons FROM ip_hour WHERE k = ?`, k)
      .toArray()[0]?.neurons as number) ?? 0;
    if (ipUsed + n > 120) return { ok: false, remaining: ceiling - used, reason: 'ip_hourly' };

    this.ctx.storage.sql.exec(`INSERT INTO ledger VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET neurons = neurons + ?`, day, n, n);
    this.ctx.storage.sql.exec(`INSERT INTO ip_hour VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET neurons = neurons + ?`, k, n, n);
    return { ok: true, remaining: ceiling - used - n };
  }
}
```

A Durable Object handles one call at a time, so the ledger needs no locks. A daily alarm deletes `ip_hour` rows older than a day.

### 7.4 Session object

- `reserve(kind, ip)` enforces the 300-neuron sortie cap and the 5 s minimum gap, then calls `BUDGET.reserve` over RPC.
- Keeps the last three question-and-answer pairs so "and the second one?" resolves, plus a 10 s status-summary cache.
- Observer mode accepts WebSockets with `ctx.acceptWebSocket()` (Hibernation API). The pilot's client pushes a compact state frame at 2 Hz, about 120 billed requests per observed 20-minute sortie at the 20:1 message ratio.
- On sortie end it sets an alarm for one hour later that calls `ctx.storage.deleteAll()`, so session objects never accumulate storage.

### 7.5 D1 schema

```sql
-- apps/edge/migrations/0001_init.sql
CREATE TABLE sorties (
  id          TEXT PRIMARY KEY,
  player      TEXT NOT NULL,              -- anonymous id kept in the browser, no accounts
  created_at  INTEGER NOT NULL,
  scenario_id TEXT NOT NULL,
  duration_s  INTEGER NOT NULL,
  outcome     TEXT NOT NULL CHECK (outcome IN ('survived', 'shot_down', 'crashed', 'aborted')),
  metrics     TEXT NOT NULL,              -- JSON: envelope minutes, detected minutes, reaction p50, false alarms, fuel at landing
  debrief     TEXT,
  replay_key  TEXT                        -- R2 object key
);
CREATE INDEX idx_sorties_player ON sorties(player, created_at DESC);

CREATE TABLE personal_bests (
  player      TEXT NOT NULL,
  scenario_id TEXT NOT NULL,
  score       REAL NOT NULL,
  sortie_id   TEXT NOT NULL,
  PRIMARY KEY (player, scenario_id)
);
```

### 7.6 Wrangler configuration

```jsonc
// apps/edge/wrangler.jsonc
{
  "name": "wingmind",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",
  "assets": {
    "directory": "../web/dist",
    "binding": "ASSETS",
    "not_found_handling": "single-page-application",
    "run_worker_first": ["/api/*"]
  },
  "ai": { "binding": "AI" },
  "d1_databases": [{ "binding": "DB", "database_name": "wingmind", "database_id": "<from wrangler d1 create>" }],
  "r2_buckets": [{ "binding": "REPLAYS", "bucket_name": "wingmind-replays" }],
  "durable_objects": {
    "bindings": [
      { "name": "BUDGET", "class_name": "BudgetDO" },
      { "name": "SESSION", "class_name": "SessionDO" }
    ]
  },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["BudgetDO", "SessionDO"] }],
  "observability": { "enabled": true, "head_sampling_rate": 0.2 },
  "vars": { "NEURON_CEILING": "9000", "SESSION_NEURON_CAP": "300" }
}
```

`new_sqlite_classes` is required: the free plan only offers SQLite-backed Durable Objects. Static files bypass the Worker entirely, so they never touch the request quota.

## 8. Console implementation

The prototype console ships the core cockpit displays plus five of the fifteen concept visuals from spec section 11.2, all drawn from one `requestAnimationFrame` loop that reads the latest snapshot directly, never through React state.

### 8.1 Components

| Component | File | Drawn with | Refresh | Data source |
| --- | --- | --- | --- | --- |
| Out-the-window scene | `console/Scene.ts` | Three.js | Display rate | Sim snapshot |
| HUD | `console/Hud.ts` | SVG | 60 Hz | Sim snapshot, directives (cues) |
| Situation display | `console/Tsd.ts` | Canvas 2D | 30 Hz | Fused tracks, threat rings, detection rings, route |
| Warning receiver scope | `console/Rwr.ts` | Canvas 2D | 30 Hz | Emitter observations, MAWS alerts |
| Engine and fuel pages | `console/Engine.ts`, `console/Fuel.ts` | SVG | 10 Hz | Sim snapshot, SYS alerts |
| Master lights, alert log, captions | `console/Alerts.tsx` | React | On event | PIA |
| Voice panel | `voice/PushToTalk.tsx` | React | On event | NLU |
| Agent mesh visualizer | `visuals/Mesh.ts` | Canvas 2D | 10 Hz | Bus trace |
| Decision trace | `visuals/Trace.tsx` | React | On event | Directive `why` and evidence |
| Signature polar plot | `visuals/Polar.ts` | D3 | 10 Hz | SIG aspect table, enemy radar bearings |
| Detection rings | inside `Tsd.ts` | Canvas 2D | 30 Hz | SIG detection map |
| Terrain masking profile | `visuals/Masking.ts` | D3 | 5 Hz | 128 terrain samples along the radar-to-own-ship line |

### 8.2 How the concept visuals get their data

- **Bus trace.** The agent worker counts messages per agent pair and keeps the highest priority seen, then posts that summary to the main thread at 10 Hz. The mesh visualizer pulses each edge by count and colors it by priority; it never sees full messages.
- **Decision trace** renders the newest directive's `why` list and links each evidence id back to its track or observation on the situation display.
- **Polar plot** draws the 36-bin signature table as a radial line, with one needle per known enemy radar at the aspect that radar sees.
- **Masking profile** samples the terrain along the sight line and colors the line green while line-of-sight is blocked and red once it is clear.
- **Explain mode** loads one short concept card per visual from `public/concepts/*.md`; "Explain that" opens the card tied to the last alert class.

### 8.3 Frame budget

| Work | Budget per 16.7 ms frame |
| --- | --- |
| 3D scene | 8 ms |
| Instruments and situation display | 3 ms |
| Concept visuals | 2 ms |
| Audio scheduling and input | 1 ms |
| Headroom for GC and the browser | 2.7 ms |

If the frame budget is missed for 2 s, the console lowers scene resolution first, then drops instrument refresh to 20 Hz. Agents and audio are never throttled, because they live in other threads.

### 8.4 Input and accessibility

- Keyboard and Gamepad API for stick, throttle and push-to-talk, with a remap screen; mouse for display buttons.
- The `AudioContext` is created on the "Start sortie" click to satisfy browser autoplay rules.
- Every spoken alert also appears on the HUD caption line; the palette is colorblind-safe, and symbols carry shape as well as color.

## 9. Build, deploy and CI

After a one-time setup, day-to-day work is three commands, and every push to `main` deploys automatically through GitHub Actions.

### 9.1 One-time setup

```bash
npx wrangler login
npx wrangler d1 create wingmind                  # paste the id into wrangler.jsonc
npx wrangler r2 bucket create wingmind-replays
npx wrangler d1 migrations apply wingmind --remote
npx wrangler secret put TURNSTILE_SECRET         # from the Turnstile widget in the dashboard
```

Then add a 30-day expiration lifecycle rule to the replay bucket (dashboard, or `wrangler r2 bucket lifecycle`), and create a Cloudflare API token with Workers, D1 and R2 edit rights for CI.

### 9.2 Daily commands

```bash
pnpm install
pnpm dev        # Vite on :5173 plus wrangler dev for /api with local D1, R2 and Durable Objects
pnpm deploy     # build the web app, apply migrations, wrangler deploy
```

The Workers AI binding calls the real service even in local development, so it draws on the daily allocation. Set `MOCK_AI=1` to swap in a canned responder for routine UI work.

### 9.3 Continuous deployment

```yaml
# .github/workflows/deploy.yml
name: deploy
on:
  push: { branches: [main] }
  pull_request:
jobs:
  ship:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm typecheck && pnpm test && pnpm test:scenarios
      - run: pnpm --filter web build
      - name: Preview on pull requests
        if: github.event_name == 'pull_request'
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
          workingDirectory: apps/edge
          command: versions upload
      - name: Deploy main
        if: github.ref == 'refs/heads/main'
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CF_API_TOKEN }}
          workingDirectory: apps/edge
          preCommands: npx wrangler d1 migrations apply wingmind --remote
          command: deploy
```

- Pull requests get a preview version URL without touching production.
- `tools/gen-voice.ts` runs only when `packages/nl/templates.ts` changes (a path filter in a separate workflow), and the generated clips are committed, so normal builds spend no neurons.
- `docs/spec.md` and `docs/implementation.md` live beside the code, and `CLAUDE.md` points Claude Code at them plus the contract rules from spec section 12.

## 10. Testing and Gate 0 verification

Gate 0 is decided by an automated Playwright run that injects the spec's missile-launch sequence 50 times and measures event-to-audio latency, backed by four layers of faster tests that run on every commit.

### 10.1 Test layers

| Layer | Runner | What it checks |
| --- | --- | --- |
| Sim core | Vitest (Node) | Trimmed level flight holds altitude within 50 ft for 60 s; fuel burn matches table flow; ground-collision projection never misses on 1,000 random terrain dives |
| Agents | Vitest with golden snapshots | Each agent's output for recorded snapshots; arbiter never violates the safety hierarchy (property test); the bus rejects writes outside a contract |
| Language | Vitest | 200-utterance grammar set (95% target); normalizer cases; the number guardrail blocks any figure absent from context |
| Edge | `@cloudflare/vitest-pool-workers` | Budget ceiling, per-IP and per-session caps, 429 paths, Turnstile rejection, D1 migration; Workers AI mocked |
| Scenarios | Node, headless, 10x speed | Ladder scenarios 1, 2, 3 and 5 with attentive and inattentive pilot bots; survival, alert and false-alarm assertions |
| End to end | Playwright, Chrome | Load, start sortie, voice command by injected transcript, alert caption and audio start, debrief saved |

### 10.2 Measuring latency

The sim stamps each event with `performance.timeOrigin + performance.now()` at the tick it happens. PIA stamps the moment it calls `AudioBufferSourceNode.start()`, converted from `AudioContext.currentTime` with `getOutputTimestamp()`. Both stamps go to the recorder, and the test reads the difference.

### 10.3 Gate 0 criteria

| Measure | Target | How it is measured |
| --- | --- | --- |
| Missile launch to first audio | 150 ms or less at the 95th percentile | 50 injected launches in the low-level scenario |
| Correct directive | Beam turn away from rising terrain in all 50 runs | Directive log versus terrain at the launch point |
| Frame rate | 60 fps median, never below 30 | Playwright performance trace over a 5-minute sortie |
| Free-tier fit | Zero Workers AI calls in the latency path; 101 neurons or fewer per full sortie | Budget ledger after 10 scripted sorties |
| Graceful degradation | Grammar commands keep working when the budget returns 429 | Edge test plus one end-to-end run with the ceiling set to 0 |

Gate 0 runs on a recent laptop in Chrome. Other browsers are tested for function, not for the latency target, until Phase 1.

### 10.4 Playwright UI tests

Nine Playwright spec files drive the real console in Chromium on your dev machine against `wrangler dev`, with the simulation seeded and steppable through test-only hooks, so every UI assertion is deterministic and no test spends a neuron. They are a local tool first: nothing in the deploy pipeline runs them or waits on them.

**Three things make the console testable**

1. **Test hooks.** Builds with `VITE_TEST_HOOKS=1` expose `window.__sky`: `loadScenario(id, seed)`, `pause()`, `step(frames)`, `inject(event)`, `transcript(text, { interim })` and `metrics()`. Production builds strip the hooks entirely.
2. **Stable selectors.** Every panel and alert element carries a `data-testid` (`hud`, `tsd`, `rwr`, `engine-page`, `fuel-page`, `master-warning`, `caption`, `alert-log`, `agent-mesh`, `decision-trace`, `ptt`, `llm-status`).
3. **No real AI.** The server runs with `MOCK_AI=1`, and individual tests override `/api/nl/*` and `/api/stt` with `page.route()` to return exact payloads, including bad ones.

**Spec files**

| File | What it covers |
| --- | --- |
| `console.spec.ts` | Shell loads with no console errors; every panel renders; LLM status light follows `/api/budget`; laptop width switches displays to tabs |
| `instruments.spec.ts` | HUD, engine and fuel values match the sim after a fixed number of frames; screenshot baselines per instrument |
| `alerts.spec.ts` | Missile caption text and master warning; WARNING preempts an advisory; duplicates suppressed; "copy" stops repeats |
| `voice.spec.ts` | Grammar commands give read-back and a directive; "chaff" fires on an interim transcript; mocked LLM path; number guardrail; 429 degradation |
| `stt-fallback.spec.ts` | Fake microphone file posts to `/api/stt` and the returned transcript flows through the grammar |
| `visuals.spec.ts` | Agent mesh pulses on a missile event; decision trace shows SIG suppressed; polar needle moves with heading; masking line flips color; Explain card opens |
| `debrief.spec.ts` | Ending a sortie saves metrics and shows the debrief |
| `a11y.spec.ts` | Axe scan of the console with canvases excluded; captions present for every spoken alert |
| `gate0.spec.ts` | 50 injected launches; 95th-percentile event-to-audio latency at 150 ms or less |

**Configuration**

```typescript
// tests/e2e/playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  timeout: 60_000,
  fullyParallel: true,
  retries: process.env.CI ? 1 : 0,
  reporter: [['html', { open: 'never' }], ['list']],
  use: {
    baseURL: process.env.BASE_URL ?? 'http://localhost:8787',   // set BASE_URL for the fast loop below
    trace: 'retain-on-failure',
    viewport: { width: 1600, height: 900 },
  },
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' } },
  projects: [
    {
      name: 'chromium',
      use: {
        ...devices['Desktop Chrome'],
        launchOptions: {
          args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--use-file-for-fake-audio-capture=tests/e2e/fixtures/chaff.wav',
            '--autoplay-policy=no-user-gesture-required',
          ],
        },
      },
    },
    { name: 'firefox-smoke', use: { ...devices['Desktop Firefox'] }, testMatch: /console|alerts/ },
  ],
  webServer: {
    command: 'VITE_TEST_HOOKS=1 pnpm --filter web build && pnpm --filter edge exec wrangler dev --port 8787 --var MOCK_AI:1',
    url: 'http://localhost:8787',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
```

**Shared fixture**

```typescript
// tests/e2e/fixtures.ts
import { test as base, expect, Page } from '@playwright/test';

type Sky = {
  start(scenario: string, seed?: number): Promise<void>;
  step(frames: number): Promise<void>;
  inject(event: object): Promise<void>;
  say(text: string, interim?: boolean): Promise<void>;
  metrics(): Promise<{ alertLatencyMs: number[]; directives: { axis: string; value: unknown; why: string[] }[] }>;
};

export const test = base.extend<{ sky: Sky }>({
  sky: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await use({
      start: async (scenario, seed = 42) => {
        await page.goto('/');
        await page.getByRole('button', { name: 'Start sortie' }).click();
        await page.evaluate(([s, n]) => window.__sky.loadScenario(s, n), [scenario, seed] as const);
        await page.evaluate(() => window.__sky.pause());
      },
      step: frames => page.evaluate(f => window.__sky.step(f), frames),
      inject: event => page.evaluate(e => window.__sky.inject(e), event),
      say: (text, interim = false) => page.evaluate(([t, i]) => window.__sky.transcript(t, { interim: i }), [text, interim] as const),
      metrics: () => page.evaluate(() => window.__sky.metrics()),
    });
    expect(errors, 'no uncaught page errors').toEqual([]);
  },
});
export { expect };
```

**Alerts: the missile sequence end to end**

```typescript
// tests/e2e/alerts.spec.ts
import { test, expect } from './fixtures';

test('missile launch raises a warning, a caption and a break-right directive', async ({ page, sky }) => {
  await sky.start('low-level-02');
  await sky.inject({ type: 'missile_launch', guidance: 'radar', bearingRelDeg: -120, rangeNm: 6 });
  await sky.step(6);                                           // 100 ms of sim time

  await expect(page.getByTestId('master-warning')).toHaveAttribute('data-state', 'on');
  await expect(page.getByTestId('caption')).toHaveText(/Missile, left eight, six miles\. Break right, chaff\./);

  const { directives } = await sky.metrics();
  const heading = directives.find(d => d.axis === 'heading');
  expect(heading?.why[0]).toContain('MAWS');
  expect(heading?.why.join(' ')).toContain('SIG suppressed');
});

test('a warning cuts off an advisory mid-sentence', async ({ page, sky }) => {
  await sky.start('sam-belt-01');
  await sky.inject({ type: 'force_alert', level: 'ADVISORY', text: 'Weather ahead, twenty miles.' });
  await sky.step(2);
  await sky.inject({ type: 'missile_launch', guidance: 'ir', bearingRelDeg: 110, rangeNm: 1.5 });
  await sky.step(6);
  await expect(page.getByTestId('caption')).toHaveText(/^Missile, right four/);
  await expect(page.getByTestId('alert-log').getByText('Weather ahead')).toHaveAttribute('data-status', 'requeued');
});
```

**Voice: grammar, LLM path, guardrail and degradation**

```typescript
// tests/e2e/voice.spec.ts
import { test, expect } from './fixtures';

test('grammar command reads back and steers', async ({ page, sky }) => {
  await sky.start('fam-01');
  await sky.say('heading two seven zero');
  await expect(page.getByTestId('caption')).toHaveText('Heading two seven zero');
  await sky.step(600);                                         // 10 s
  await expect(page.getByTestId('hud').getByTestId('heading-readout')).toHaveText(/27\d/);
});

test('chaff fires on an interim transcript, before end of speech', async ({ page, sky }) => {
  await sky.start('fam-01');
  await sky.say('chaff', true);
  await expect(page.getByTestId('cm-chaff-count')).toHaveText('59');
});

test('LLM answer with an invented number is replaced', async ({ page, sky }) => {
  await page.route('**/api/nl/intent', r => r.fulfill({
    json: { intent: 'query.answer', answer: 'Bingo in 47 minutes.', confidence: 0.9 },
  }));
  await sky.start('fam-01');
  await sky.say('how long until bingo');
  await expect(page.getByTestId('caption')).not.toContainText('47');
});

test('budget exhaustion keeps the grammar alive', async ({ page, sky }) => {
  await page.route('**/api/nl/**', r => r.fulfill({ status: 429, json: { error: 'daily_budget' } }));
  await sky.start('fam-01');
  await sky.say('what is that contact doing');
  await expect(page.getByTestId('caption')).toHaveText('Unable, voice queries offline.');
  await sky.say('radar silent');
  await expect(page.getByTestId('caption')).toHaveText('Radar silent');
});
```

**Screenshot baselines** cover the HUD, engine page, fuel page, warning receiver scope and polar plot, captured from a paused, seeded sim and tagged `@visual`. The 3D scene is masked out because GPU rendering differs between machines. Baselines are generated on your dev machine; Playwright names snapshot files per operating system, so a CI run later keeps its own Linux set without overwriting yours.

```typescript
// tests/e2e/instruments.spec.ts (excerpt)
test('engine page baseline at military power @visual', async ({ page, sky }) => {
  await sky.start('fam-01', 7);
  await sky.inject({ type: 'set_throttle', value: 0.85 });
  await sky.step(300);
  await expect(page.getByTestId('engine-page')).toHaveScreenshot('engine-mil.png');
});
```

**Running on your dev machine**

```bash
pnpm exec playwright install chromium            # once (add firefox for the smoke project)
pnpm test:e2e                                    # every spec, headless; builds and starts wrangler dev itself
pnpm test:e2e:ui                                 # UI mode: pick tests, watch files, step through each action
pnpm test:e2e alerts --headed                    # watch one file run in a real browser window
pnpm test:e2e --grep @gate                       # Gate 0 latency run, a few minutes
pnpm test:e2e --update-snapshots                 # refresh baselines after an intentional UI change
pnpm exec playwright show-report                 # open the last HTML report
pnpm exec playwright codegen localhost:5173      # record a new test by clicking through the console
```

```json
// package.json (root) scripts
{
  "test:e2e": "playwright test -c tests/e2e/playwright.config.ts",
  "test:e2e:ui": "playwright test -c tests/e2e/playwright.config.ts --ui"
}
```

**Fast loop while coding.** Start `VITE_TEST_HOOKS=1 MOCK_AI=1 pnpm dev` once and leave it running, then run `BASE_URL=http://localhost:5173 pnpm test:e2e:ui`. Playwright finds `wrangler dev` already listening on 8787 and skips the build, and the tests hit Vite with hot reload, so a UI edit can be retested in seconds.

**Optional CI, non-blocking.** When you want it, add a separate workflow. It runs only when triggered by hand from the Actions tab, is marked `continue-on-error`, and `deploy.yml` never references it, so it cannot block a build or a deploy. Screenshot tests are skipped there until Linux baselines exist.

```yaml
# .github/workflows/e2e.yml (separate from deploy.yml; never blocks a deploy)
name: e2e (optional)
on:
  workflow_dispatch:            # run by hand from the Actions tab
  # schedule:                   # uncomment later for a nightly run
  #   - cron: '0 6 * * *'
jobs:
  e2e:
    runs-on: ubuntu-latest
    continue-on-error: true
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec playwright install --with-deps chromium
      - run: pnpm test:e2e --project=chromium --grep-invert @visual
      - uses: actions/upload-artifact@v4
        if: always()
        with: { name: playwright-report, path: playwright-report }
```

The Gate 0 file is tagged `@gate` and slow (50 launches take a few minutes), so skip it during quick runs with the --grep-invert @gate flag and run it alone with `pnpm test:e2e --grep @gate`. To make CI a required check later, add `pull_request` to the workflow triggers, remove `continue-on-error`, and add `needs: e2e` to the deploy job.

## 11. Milestones

The prototype reaches Gate 0 at the end of week 8, with the edge and budget plumbing deployed first so every later feature ships onto a live URL.

&#91;embedded content: Prototype build plan · 6 workstreams over 8 weeks, Gate 0 at the end\]

1. **Weeks 1–2, foundations and edge.** Monorepo, shared types, Worker serving static assets, `BudgetDO` and `SessionDO`, D1 migration, the JSON-mode model check, CI deploying on every push.
2. **Weeks 1–3, flight model and world.** Six-degree-of-freedom model, engines, fuel, atmosphere, procedural terrain, HUD.
3. **Weeks 3–5, agent mesh.** Bus, blackboard and scheduler first, then FUSE, MAWS, TAP and ORCH, then the remaining eight agents.
4. **Weeks 4–6, voice and language.** Templates and clip library, alert queue, grammar, tier router, intent and summary routes.
5. **Weeks 5–7, console and visuals.** Situation display, warning receiver, engine and fuel pages, Agent Ops and the five concept visuals.
6. **Weeks 6–8, scenarios and tests.** Four ladder scenarios, pilot bots, latency harness, Playwright Gate 0 run.

The week-1 model check and the week-5 first missile alert are the two early signals that the plan is on track.

## 12. Risks and mitigations

The biggest risk is the shared neuron pool being drained by abuse or a naming mismatch; every risk below has a fallback that keeps the core simulator fully playable.

| Risk | Effect | Mitigation |
| --- | --- | --- |
| Scripted abuse of the LLM routes | Daily neuron pool gone, voice queries offline for everyone | Turnstile on session start, 120 neurons per IP per hour, 300 per sortie, 9,000 daily ceiling; grammar keeps working |
| JSON-mode model name or rate differs from the pricing table | Intent calls fail or cost more | Week-1 check; fallback is `llama-3.3-70b-instruct-fp8-fast`, on both lists, at about 31 neurons per intent call, or plain JSON output parsed and validated in code |
| Free-plan limits change | Budget math goes stale | Limits live in `vars`; `/api/budget` shows the live ledger; recheck the pricing pages monthly. Workers Paid ($5 per month minimum) is the upgrade path |
| Workers Logs pricing changes on December 1, 2026 | Log costs on a paid plan | Head sampling already at 0.2; review before that date |
| Browser lacks speech recognition | No voice input | Whisper fallback route; keyboard shortcuts for every defensive command |
| Cross-origin isolation blocks a resource | `SharedArrayBuffer` unavailable | Everything is same-origin; transferable `postMessage` fallback at the same rate |
| Autoplay policy blocks audio | Silent alerts | `AudioContext` created on the "Start sortie" click; captions always on |
| Low-end machine misses 150 ms | Gate 0 fails on that hardware | Agents and audio sit in their own threads; the console sheds scene quality first |
| LLM invents numbers | Wrong spoken facts | Number guardrail; templates for every WARNING and CAUTION |
| Realism drifts toward sensitive detail | Content risk | Generic, parametric, illustrative tables only (spec section 1 non-goals); review checklist on any new threat profile |

## 13. Sources

- [Cloudflare Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/): Workers, KV, D1, Durable Objects, R2 and Workers Logs free limits (page updated Oct 2, 2026)
- [Cloudflare Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/): 10,000 neurons per day and per-model neuron rates (page updated Oct 1, 2026)
- [Workers AI JSON Mode](https://developers.cloudflare.com/workers-ai/features/json-mode/): models that support `response_format` with a JSON schema
