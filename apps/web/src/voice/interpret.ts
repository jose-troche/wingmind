import { INTENT_SCHEMA, OFFLINE, matchGrammar, normalize, statusTemplate, validate, type IntentResult } from '@wingmind/nl';
import type { CompactContext } from '@wingmind/shared';
import { onDevice } from './ondevice';

// Tier router (implementation 6.4). The grammar sits in front of every tier and
// needs none of them; only leftovers go to the on-device model (Tier 0) or the
// Workers AI free pool (Tier 1). Model output is never trusted: validate() runs
// the schema, range and number checks before anything is spoken or executed.

export const ONDEVICE_SYSTEM = `You turn a fighter pilot's spoken request into ONE JSON intent for a flight simulator.
For a question use intent "query.answer" with a spoken answer under 20 words, using only numbers from the context.
If unclear use intent "clarify". Never invent values.`;

export interface InterpretOpts { interim?: boolean; fetchImpl?: typeof fetch }

export async function interpret(utter: string, ctx: CompactContext, opts: InterpretOpts = {}): Promise<IntentResult | null> {
  const norm = normalize(utter);
  const fast = matchGrammar(norm, { interim: opts.interim ?? false, normalized: true });
  if (fast) return { kind: 'intent', intent: fast };                   // most commands stop here
  if (opts.interim) return null;                                      // only defensive words fire early
  if (!norm) return null;
  if (await onDevice.available()) {                                   // Tier 0
    const out = await onDevice.intent(utter, ctx, ONDEVICE_SYSTEM, INTENT_SCHEMA);
    if (out) return validate(out, ctx, utter);
  }
  const f = opts.fetchImpl ?? fetch;
  try {
    const r = await f('/api/nl/intent', {                             // Tier 1: Workers AI
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ utter, ctx, session: ctx.sessionId }),
    });
    if (r.status === 429 || r.status === 404 || r.status >= 500) return { kind: 'unable', say: OFFLINE };
    if (!r.ok) return { kind: 'clarify', say: 'Say again.' };
    return validate(await r.json(), ctx, utter);                      // never trust model output
  } catch {
    return { kind: 'unable', say: OFFLINE };
  }
}

/** "Status" goes to the summary route when it is cheap, else the local template. */
export async function statusSummary(ctx: CompactContext, fetchSummary: (c: CompactContext) => Promise<{ status: number; say?: string }>, grounded: (t: string) => boolean): Promise<string> {
  const r = await fetchSummary(ctx);
  if (r.status === 200 && r.say && grounded(r.say)) return r.say;
  return statusTemplate(ctx);
}
