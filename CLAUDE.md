# WINGMIND: conventions for Claude Code sessions

Read the two design documents before changing behavior:

- `docs/WINGMIND - Multi-Agent Fighter Simulator System Specification.md` (the spec)
- `docs/WINGMIND Prototype - Cloudflare Free-Tier Implementation.md` (this prototype, Phase 0)

## Layout

- `packages/shared`: types from spec section 12, math, geometry, seeded RNG, illustrative threat profiles, the SharedArrayBuffer snapshot ring.
- `packages/sim-core`: ISA atmosphere and weather, procedural terrain, 6-DOF flight model (RK4, quaternion, FBW G law), engines, fuel, sensors, red-force entities, `World`.
- `packages/agents`: bus, blackboard, scheduler, arbiter and the 12 agents; `AgentRuntime` is the single entry point used by the browser worker and the headless tests.
- `packages/nl`: normalizer, grammar (about 30 rules), alert templates, validation and the number guardrail.
- `apps/web`: Vite + React console; `src/workers/sim.worker.ts` and `src/workers/agents.worker.ts`; instruments draw from one rAF loop, never through React state.
- `apps/edge`: the Cloudflare Worker (Hono), `BudgetDO`, `SessionDO`, D1 migration, prompts.
- `tests/scenarios`: headless ladder runs with pilot bots. `tests/e2e`: Playwright.

## Rules

- TypeScript only (`allowJs: false`); every package extends `tsconfig.base.json` (strict, `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`). Never assign `undefined` to an optional property; use a conditional spread.
- Contract rules (spec 12): an agent publishes only to topics in its `writes` (the bus throws otherwise); every Advice and Alert names evidence; a reflex agent's `step` is synchronous and inside `budgetMs`.
- Agents see sensors, never ground truth. Only `World` touches truth; agents get `SimSnapshot` observations.
- Time-critical alerts are templates, never LLM output. LLM output always passes `validate()` before it is spoken or executed.
- Generic, parametric, illustrative numbers only (spec section 1 non-goals). No real aircraft, sensor, EW or weapon data.
- Every UI element a test touches carries a `data-testid`; test hooks live behind `__TEST_HOOKS__` (`VITE_TEST_HOOKS=1`).
- Free tier: no Workers KV; every model call reserves neurons in `SessionDO` then `BudgetDO` first; set `max_tokens` on every call.

## Commands

```bash
pnpm install
pnpm dev                 # Vite :5173 + wrangler dev :8787
pnpm typecheck && pnpm test && pnpm test:scenarios
pnpm test:e2e            # Playwright (builds with test hooks, runs wrangler dev --env e2e)
pnpm deploy
```
