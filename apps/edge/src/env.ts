import type { BudgetDO } from './budget-do';
import type { SessionDO } from './session-do';

// Bindings declared in wrangler.jsonc. `pnpm --filter edge types` regenerates the
// full runtime declarations with `wrangler types`; this interface pins the parts
// the code relies on, with AI and REPLAYS optional because the e2e environment
// and an account without R2 leave them unbound.
export interface Env {
  ASSETS: Fetcher;
  AI?: Ai;
  DB: D1Database;
  REPLAYS?: R2Bucket;
  BUDGET: DurableObjectNamespace<BudgetDO>;
  SESSION: DurableObjectNamespace<SessionDO>;
  NEURON_CEILING: string;
  SESSION_NEURON_CAP: string;
  MOCK_AI?: string;
  TURNSTILE_SECRET?: string;
}

export const INTENT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fast';
export const STT_MODEL = '@cf/openai/whisper-large-v3-turbo';

/** Neurons reserved up front per call (implementation 7.1). */
export const RESERVE = { intent: 6, summary: 7, debrief: 25, sttPerSecond: 1 } as const;

export const mockAi = (env: Env): boolean => env.MOCK_AI === '1' || !env.AI;

/** Run a Workers AI model with a loose signature (model names outrun the generated overloads). */
export async function runAi(env: Env, model: string, input: Record<string, unknown>): Promise<unknown> {
  const ai = env.AI as unknown as { run(model: string, input: Record<string, unknown>): Promise<unknown> };
  return ai.run(model, input);
}

/** Text or parsed JSON out of either response shape Workers AI returns. */
export function aiContent(out: unknown): unknown {
  if (!out || typeof out !== 'object') return out;
  const o = out as Record<string, unknown>;
  let content: unknown = o.response;
  if (content === undefined && Array.isArray(o.choices)) {
    const c = o.choices[0] as { message?: { content?: unknown } } | undefined;
    content = c?.message?.content;
  }
  if (typeof content === 'string') {
    try { return JSON.parse(content); } catch { return content; }
  }
  return content;
}

export async function hashIp(ip: string): Promise<string> {
  const day = new Date().toISOString().slice(0, 10);
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`${day}:${ip}`));
  return [...new Uint8Array(buf)].slice(0, 8).map(b => b.toString(16).padStart(2, '0')).join('');
}
