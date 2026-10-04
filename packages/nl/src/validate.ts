import { spellNumber, type CompactContext, type Intent, type IntentName } from '@wingmind/shared';
import { extractNumbers } from './normalize';

// Never trust model output (implementation 6.4/6.5, spec 10.5): schema, ranges,
// safety rules and the number guardrail all run in deterministic code.

export const INTENT_ENUM: IntentName[] = [
  'nav.setHeading', 'nav.setAltitude', 'nav.setSpeed', 'nav.replan', 'nav.direct', 'ew.dispense', 'ew.setMode',
  'sig.setEmcon', 'ui.show', 'pia.verbosity', 'query.answer', 'clarify',
];

export type IntentResult =
  | { kind: 'intent'; intent: Intent; say?: string }
  | { kind: 'answer'; say: string; guarded: boolean }
  | { kind: 'unable'; say: string }
  | { kind: 'clarify'; say: string };

export const SAY_AGAIN = 'Say again.';
export const OFFLINE = 'Unable, voice queries offline.';

/** Every number the context makes available, plus the roundings a speaker would use. */
export function contextNumbers(ctx: CompactContext): number[] {
  const raw: number[] = [];
  const walk = (v: unknown): void => {
    if (typeof v === 'number' && Number.isFinite(v)) raw.push(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
    else if (typeof v === 'string') extractNumbers(v).forEach(x => raw.push(x));
  };
  walk({ ...ctx, sessionId: '' });
  const out = new Set<number>();
  for (const x of raw) {
    const a = Math.abs(x);
    out.add(Math.round(a));
    out.add(Math.round(a * 10) / 10);
    out.add(Math.round(a / 10) * 10);
    out.add(Math.round(a / 100) * 100);
    out.add(Math.round(a / 1000));          // angels, "eighteen thousand"
    out.add(Math.round(a / 1000) * 1000);
    out.add(Math.floor(a));
  }
  // clock hours and threat counts come from the context's clock words and list length
  for (let h = 1; h <= 12; h++) out.add(h);
  out.add(ctx.threats.length);
  return [...out];
}

/** True when every number in `text` appears in the context (allowing rounding). */
export function numbersGrounded(text: string, ctx: CompactContext): boolean {
  const allowed = contextNumbers(ctx);
  for (const x of extractNumbers(text)) {
    const ok = allowed.some(a => Math.abs(a - x) <= Math.max(0.5, Math.abs(x) * 0.02));
    if (!ok) return false;
  }
  return true;
}

/** Template answers for questions the context can answer directly. */
export function templateAnswer(question: string, ctx: CompactContext): string | null {
  const q = question.toLowerCase();
  if (/bingo|fuel|gas|range left/.test(q)) return fuelAnswer(ctx);
  if (/status|situation|picture|sitrep/.test(q)) return statusTemplate(ctx);
  if (/home|base|rtb/.test(q)) return `Home plate ${spellNumber(Math.round(ctx.home.bearingDeg))} degrees, ${spellNumber(Math.round(ctx.home.rangeNm))} miles.`;
  return null;
}

export function fuelAnswer(ctx: CompactContext): string {
  const fuel = Math.round(ctx.own.fuelLb / 100) * 100;
  const mins = Math.max(0, Math.round(ctx.own.minutesToBingo));
  return mins > 0
    ? `Fuel ${fuel} pounds, bingo in ${mins} minutes.`
    : `Fuel ${fuel} pounds, at bingo.`;
}

export function statusTemplate(ctx: CompactContext): string {
  const top = ctx.threats[0];
  const own = `Heading ${Math.round(ctx.own.headingDeg)}, angels ${Math.round(ctx.own.altFt / 1000)}, fuel ${Math.round(ctx.own.fuelLb / 100) * 100}.`;
  if (!top) return `${own} No threats.`;
  const more = ctx.threats.length > 1 ? ` ${ctx.threats.length - 1} more.` : '';
  return `${own} Top threat ${top.cls.replace('_', ' ')}, ${top.clock}, ${Math.round(top.rangeNm)} miles.${more}`;
}

interface SafetyLimits { minAltFtAgl: number; terrainFt: number }

/**
 * Validate a model's JSON proposal against the schema, value ranges, safety
 * rules and the number guardrail. Output is always something safe to speak.
 */
export function validate(raw: unknown, ctx: CompactContext, question = '', limits: Partial<SafetyLimits> = {}): IntentResult {
  if (!raw || typeof raw !== 'object') return { kind: 'clarify', say: SAY_AGAIN };
  const r = raw as Record<string, unknown>;
  const name = r.intent;
  if (typeof name !== 'string' || !INTENT_ENUM.includes(name as IntentName)) return { kind: 'clarify', say: SAY_AGAIN };
  const confidence = typeof r.confidence === 'number' ? r.confidence : 0;
  if (confidence < 0.7) return { kind: 'clarify', say: SAY_AGAIN };
  const params = r.params && typeof r.params === 'object' ? (r.params as Record<string, unknown>) : {};
  const answer = typeof r.answer === 'string' ? r.answer.slice(0, 200) : undefined;
  const readback = typeof r.readback === 'string' ? r.readback.slice(0, 80) : undefined;

  if (name === 'clarify') return { kind: 'clarify', say: answer && numbersGrounded(answer, ctx) ? answer : SAY_AGAIN };

  if (name === 'query.answer') {
    if (answer && numbersGrounded(answer, ctx)) return { kind: 'answer', say: answer, guarded: false };
    const t = templateAnswer(question || answer || '', ctx);
    return { kind: 'answer', say: t ?? SAY_AGAIN, guarded: true };
  }

  // command intents: same range and safety checks as grammar intents
  const checked = checkIntentParams(name as IntentName, params, ctx, limits);
  if (typeof checked === 'string') return { kind: 'unable', say: checked };
  const safeReadback = readback && numbersGrounded(readback, { ...ctx, threats: [...ctx.threats], lastAnswers: [{ q: '', a: JSON.stringify(params) }] }) ? readback : undefined;
  const intent: Intent = {
    intent: name as IntentName,
    params: checked,
    confidence,
    source: 'llm',
    ...(safeReadback ? { readback: safeReadback } : {}),
  };
  return { kind: 'intent', intent };
}

/** Range and safety checks shared by grammar and model intents. Returns cleaned params or a refusal. */
export function checkIntentParams(name: IntentName, p: Record<string, unknown>, ctx: CompactContext, limits: Partial<SafetyLimits> = {}): Record<string, unknown> | string {
  const num = (k: string): number | null => (typeof p[k] === 'number' && Number.isFinite(p[k]) ? (p[k] as number) : null);
  switch (name) {
    case 'nav.setHeading': {
      const h = num('heading_deg');
      if (h === null || h < 0 || h > 360) return SAY_AGAIN;
      return { heading_deg: Math.round(h) % 360, turn: p.turn === 'left' || p.turn === 'right' ? p.turn : 'shortest' };
    }
    case 'nav.setAltitude': {
      const a = num('alt_ft');
      if (a === null || a < 0 || a > 50_000) return SAY_AGAIN;
      const terrainFt = limits.terrainFt ?? Math.max(0, ctx.own.altFt - ctx.own.aglFt);
      const minAgl = limits.minAltFtAgl ?? 500;
      if (a < terrainFt + minAgl) return 'Unable, terrain.';
      return { alt_ft: Math.round(a) };
    }
    case 'nav.setSpeed': {
      const s = num('kcas');
      if (s === null || s < 150 || s > 800) return SAY_AGAIN;
      return { kcas: Math.round(s) };
    }
    case 'sig.setEmcon': {
      const l = num('level');
      if (l === null || l < 0 || l > 3) return SAY_AGAIN;
      return { level: Math.round(l) };
    }
    case 'ew.dispense':
      return { kind: p.kind === 'flare' || p.kind === 'both' || p.kind === 'program' ? p.kind : 'chaff' };
    case 'nav.direct': {
      const w = num('waypoint');
      if (w === null || w < 1 || w > 20) return SAY_AGAIN;
      return { waypoint: Math.round(w) };
    }
    default:
      return p;
  }
}

/** JSON schema the edge passes to Workers AI JSON mode. */
export const INTENT_SCHEMA = {
  type: 'object',
  properties: {
    intent: { type: 'string', enum: INTENT_ENUM },
    params: { type: 'object' },
    answer: { type: 'string' },
    readback: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['intent', 'confidence'],
} as const;
