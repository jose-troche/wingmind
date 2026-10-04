# WINGMIND

A browser fighter simulator where twelve cooperating software agents act as the pilot's digital wingman. They fuse the sensors into one track picture, rank every threat and speak short alerts ("Missile, left eight, six miles. Break right, chaff."), and they take spoken commands back.

This repository is **Phase 0**, the Cloudflare free-tier prototype described in [`docs/`](docs/):

- One generic fighter with a six-degree-of-freedom flight model, two engines and three fuel tanks.
- Four threat types: an enemy two-ship, a long-range SAM, a short-range IR site and a five-drone swarm.
- Twelve agents running in a browser worker.
- A cockpit console with five concept visuals.
- Ladder scenarios 1, 2, 3 and 5.

All aircraft, sensor and weapon numbers are generic and illustrative. Nothing here describes a real system.

- Specification: [docs/WINGMIND - Multi-Agent Fighter Simulator System Specification.md](docs/WINGMIND%20-%20Multi-Agent%20Fighter%20Simulator%20System%20Specification.md)
- Implementation plan: [docs/WINGMIND Prototype - Cloudflare Free-Tier Implementation.md](docs/WINGMIND%20Prototype%20-%20Cloudflare%20Free-Tier%20Implementation.md)

## How it works

```text
 main thread (React shell, Three.js, SVG/Canvas instruments, Web Audio, voice)
      ▲  render ring (SharedArrayBuffer)          ▲ speak / directives / board summary (10 Hz)
      │                                           │
 sim.worker ── agent ring + MessagePort ──► agents.worker
 (World: 120 Hz physics, sensors,            (AgentRuntime: bus, blackboard, scheduler,
  red forces, weapons; ground truth)           FUSE MAWS NAV EW SYS AIR GBAD TAP SIG ORCH NLU PIA)
      ▲ directives (pilot, GCAS, auto programs)   │
      └───────────────────────────────────────────┘
                                │ only what a browser cannot do
                                ▼
 Cloudflare Worker (Hono) ── Workers AI (Llama 3.1 8B JSON mode, Whisper), BudgetDO, SessionDO, D1, R2
```

The work is split by what each place does best:

- **The simulation and every reflex and tactical agent run in the browser.** A 60 Hz server tick would exhaust the free plan's request quota in under 30 minutes, and the round trip would break the 150 ms alert budget.
- **The edge only hosts the language model**, enforces the neuron budget and stores sortie results.

Three mechanisms carry the design:

- **Agents never call each other.** They publish typed messages to a bus and read only the topics they declared; the bus throws on any write outside an agent's contract. ORCH alone turns advice into directives, using the safety hierarchy first and utility second. PIA alone decides what the pilot hears.
- **Agents see sensors, not truth.** The sim publishes noisy radar, IRST, DAS, RWR and datalink observations; the agents can be wrong, as a real crew can.
- **The missile chain fits in one sim frame.**
  1. A plume plus a guidance emitter wakes MAWS.
  2. NAV checks both beam turns against the terrain.
  3. EW proposes chaff.
  4. ORCH issues one directive, with SIG's nose-on advice suppressed and the turn capped at 9 G.
  5. PIA speaks.

  All five steps happen inside the tick that saw the plume.
- **Language is grammar first.** About 30 command patterns run locally, so "chaff" fires on an interim transcript. Leftovers go to Chrome's on-device model (Tier 0) or Workers AI (Tier 1), and every model answer passes a schema, range and number guardrail before it is spoken.

## Repository layout

| Path | What it is |
| --- | --- |
| `packages/shared` | Spec section 12 types, math, geometry, seeded RNG, illustrative threat profiles, the SharedArrayBuffer snapshot ring |
| `packages/sim-core` | ISA atmosphere, layered wind and clouds, procedural terrain, flight model, engines, fuel, sensors, entities, `World` |
| `packages/agents` | Bus, blackboard, scheduler, arbiter, the 12 agents, `AgentRuntime`, recorder |
| `packages/nl` | Normalizer, grammar, alert templates, validation and number guardrail |
| `apps/web` | Vite + React 19 console, sim and agent workers, Three.js scene, D3 visuals, audio engine, voice |
| `apps/web/public` | Scenario JSON, concept cards, `_headers` (cross-origin isolation), voice clip pack |
| `apps/edge` | Cloudflare Worker: Hono routes, `BudgetDO`, `SessionDO`, D1 migration, prompts |
| `tools` | `gen-voice.ts` (MeloTTS clips), `gen-terrain.ts` (terrain previews), `gen-fixtures.ts` |
| `tests/scenarios` | Headless ladder runs with attentive and inattentive pilot bots |
| `tests/e2e` | Playwright UI tests and the Gate 0 latency run |

## Quick start

Requires Node 22+ and pnpm (the version pinned in `packageManager`).

```bash
pnpm install
pnpm dev        # Vite on :5173 plus wrangler dev for /api on :8787 with local D1 and Durable Objects
```

Open http://localhost:5173, pick a scenario and press **Start sortie**.

| Input | Action |
| --- | --- |
| Hold <kbd>Space</kbd> (or the panel button) | Push to talk |
| Arrow keys | Fly |
| <kbd>=</kbd> / <kbd>-</kbd> | Throttle |
| <kbd>C</kbd> / <kbd>F</kbd> | Chaff / flares |
| <kbd>E</kbd> | Cycle emissions control |
| <kbd>K</kbd> | Acknowledge ("copy") |
| <kbd>P</kbd> | Pause |

The **Controls** button remaps keys. A gamepad works through the Gamepad API.

Commands to try: "heading two seven zero", "angels twenty", "speed four fifty", "radar silent", "status", "time to bingo", "route around the SAM" then "accept", "explain that", "terse mode".

Typed commands in the voice panel go through the same pipeline.

`wrangler dev` binds Workers AI to the real service, which spends the daily allocation. Run `MOCK_AI=1 pnpm dev`, or `pnpm --filter edge exec wrangler dev --env e2e`, to use the canned responder instead.

## Deploying to Cloudflare (free plan)

### One-time setup

```bash
npx wrangler login
npx wrangler d1 create wingmind                  # paste the database_id into apps/edge/wrangler.jsonc
npx wrangler d1 migrations apply wingmind --remote
```

Optional extras:

- **Replays (R2).** R2 must be enabled once in the Cloudflare dashboard (*R2 > Enable*). Then run `npx wrangler r2 bucket create wingmind-replays`, uncomment the `r2_buckets` block in `wrangler.jsonc`, and add a 30-day expiration lifecycle rule. Without the binding, the Worker saves sorties and debriefs but skips replay upload.
- **Turnstile.** Run `npx wrangler secret put TURNSTILE_SECRET` and build the web app with a site key. This is off by default; see *Deviations*.
- **Voice clips.** Run `pnpm gen:voice` once (needs `ffmpeg`). It renders about 180 MeloTTS fragments for well under 100 neurons and writes `apps/web/public/voice/clips.{bin,json}`. Until then, alerts fall back to browser speech synthesis. Captions are always on.

### Every deploy

```bash
pnpm deploy     # build the web app, apply D1 migrations, wrangler deploy
```

The Worker deploys as `wingmind` on your `workers.dev` subdomain, for example `https://wingmind.<subdomain>.workers.dev`.

### Continuous deployment

`.github/workflows/deploy.yml` runs typecheck, unit, edge and scenario tests on every push and pull request. It deploys `main`, and uploads a preview version for pull requests, when the repository has the `CF_API_TOKEN` and `CF_ACCOUNT_ID` secrets. The token needs Workers, D1 and Workers AI edit rights. Without them, the workflow still tests and skips the deploy step.

## Free-tier budget

Workers AI is the only binding limit:

- An LLM-assisted 20-minute sortie costs about 87 neurons: 8 free-form utterances, 4 summaries and 1 debrief.
- The 9,000-neuron daily ceiling covers about 90 such sorties a day.
- Every other product has at least 30 times that headroom.

| Guardrail | Where |
| --- | --- |
| Daily ledger with a 9,000-neuron ceiling. At 7,200, summaries switch to templates; at 9,000, LLM routes return 429 and the console shows "LLM offline (grammar only)". | `BudgetDO`, `GET /api/budget` |
| 120 neurons per IP per hour, 300 per sortie, one LLM call per 5 s | `BudgetDO`, `SessionDO` |
| `max_tokens` on every call: 120 intents, 160 summaries, 400 debriefs | `apps/edge/src/index.ts` |
| Compact prompt context: own state and top five threats only | `prompts/intent.ts` |
| A repeated status request within 10 s returns the cached answer | `SessionDO` |
| Chrome's on-device model (Tier 0) costs nothing; the grammar needs no model at all | `apps/web/src/voice` |

Static assets, including the app, scenarios and voice clips, never touch the request quota. Durable Objects use the SQLite backend, which the free plan requires. The observer WebSocket uses the Hibernation API.

## Testing

```bash
pnpm typecheck            # tsc --noEmit across every package
pnpm test                 # Vitest: sim-core, agents, nl, plus edge tests in workerd (@cloudflare/vitest-pool-workers)
pnpm test:scenarios       # headless ladder scenarios 1, 2, 3, 5 with pilot bots
pnpm exec playwright install chromium     # once
pnpm test:e2e --update-snapshots          # first run: creates the @visual baselines for your OS
pnpm test:e2e --grep-invert @gate         # everything except the slow Gate 0 run
pnpm test:e2e --grep @gate                # Gate 0: 50 injected launches, p95 latency <= 150 ms
pnpm test:e2e:ui                          # Playwright UI mode
```

| Layer | Covers |
| --- | --- |
| Sim core | ISA, terrain determinism and line of sight, level flight within 50 ft for 60 s, autopilot turns, G limit, fuel burn against table flow, engine state machine, missile and chaff |
| Agents | Bus contracts and wildcards, blackboard single-writer rule, arbiter property test (2,000 random advice sets never violate the safety hierarchy), the spec 5.7 missile chain end to end, read-backs, terrain refusal, dedup and "copy", ground-collision projection on 1,000 random dives |
| Language | 200-utterance grammar set (95% target), normalizer cases, templates, clip planning, number guardrail |
| Edge | D1 migration, mock answers, 404/400/429 paths, the 5 s call gap, daily ceiling and template degradation, per-IP cap, Turnstile rejection, sortie save and read-back |
| Scenarios | Oil-pressure fault call (1), zero ground impacts with an inattentive pilot and tower calls (2), SAM tracking calls and false-alarm rate (3), launch announcement rate and attentive-versus-inattentive survival (5) |
| End to end | 9 Playwright specs: console, instruments (with screenshot baselines), alerts, voice, STT fallback, visuals, debrief, axe accessibility, Gate 0 |

How the Playwright tests stay deterministic:

- Builds made with `VITE_TEST_HOOKS=1` expose `window.__sky`, with `loadScenario`, `pause`, `step`, `inject`, `transcript`, `metrics` and `state`.
- In step mode, each frame waits for the agents' acknowledgement.
- The server runs `wrangler dev --env e2e`, which has no Workers AI binding and `MOCK_AI=1`, so no test spends a neuron.

For a faster loop, start `VITE_TEST_HOOKS=1 pnpm --filter web dev` and the e2e Worker yourself, then run `BASE_URL=http://localhost:5173 pnpm test:e2e:ui`.

## Deviations from the implementation document

| Document | Here | Why |
| --- | --- | --- |
| `tools/gen-terrain.ts` ships `terrain/*.bin` tiles | Terrain is generated at load from each scenario's seed and feature list, identically in all three threads; the sim worker transfers the grid to the others. `gen-terrain.ts` writes previews to `tools/out/`. | Saves about 2 MB per theater against the 5 MB first-load budget, and scenarios stay self-contained |
| Voice clips as individual files | One `clips.bin` of MP3 slices plus a `clips.json` manifest | Two requests instead of about 180; each clip still decodes into its own `AudioBuffer` |
| Turnstile on session start | Supported server-side and enabled by setting `TURNSTILE_SECRET`; off by default | The Turnstile iframe does not load under `Cross-Origin-Embedder-Policy: require-corp`, which `SharedArrayBuffer` needs. Per-IP, per-session and daily caps still apply |
| R2 binding always on | Commented out until R2 is enabled on the account | R2 needs a one-time dashboard opt-in; the Worker checks for the binding |
| Open question: `llama-3.1-8b-instruct-fast` versus `-fp8-fast` | Both names resolve and answer in JSON mode (checked against the API on Oct 4, 2026). The Worker reads both response shapes (`response` and OpenAI-style `choices`) | Week-1 model check |
| `wrangler dev --var MOCK_AI:1` for tests | A separate `env.e2e` in `wrangler.jsonc` with no AI binding | Local tests need no Cloudflare login |
| Gate 0 frame rate over 5 minutes | A 12 s real-time run with a 30 fps floor in headless Chromium (set `GATE_FPS=60` on a laptop GPU) | Headless software GL is not the target hardware |
| `__sky` hooks | Adds `state()`, `end()` and a test-only `teleport` inject | Instrument and visual tests need truth readback and instant geometry changes |

## Out of scope until Phase 1

These follow the implementation document:

- Replay scrubber; sorties are recorded, and replays upload when R2 is bound.
- Instructor mode.
- Real elevation data.
- Weather cross-section.
- HOTAS beyond the Gamepad API.
- Mobile layouts.
- Multiplayer.

## License

No license has been chosen yet; all rights reserved by the author.
