import { statusTemplate } from '@wingmind/nl';
import type { CompactContext } from '@wingmind/shared';

// Canned responder for MOCK_AI=1 (implementation 9.2): routine UI work and every
// automated test run without spending a neuron.

export function mockIntent(utter: string, ctx: CompactContext): Record<string, unknown> {
  const u = utter.toLowerCase();
  const top = ctx.threats[0];
  if (/contact|bandit|threat|sam|that/.test(u)) {
    return top
      ? { intent: 'query.answer', answer: `Top threat is a ${top.cls.replace('_', ' ')} at ${top.clock}, ${Math.round(top.rangeNm)} miles.`, confidence: 0.9 }
      : { intent: 'query.answer', answer: 'No threats on the picture.', confidence: 0.9 };
  }
  if (/fuel|bingo/.test(u)) {
    return { intent: 'query.answer', answer: `Fuel ${Math.round(ctx.own.fuelLb / 100) * 100} pounds, bingo in ${ctx.own.minutesToBingo} minutes.`, confidence: 0.9 };
  }
  if (/where|home/.test(u)) {
    return { intent: 'query.answer', answer: `Home plate bearing ${ctx.home.bearingDeg}, ${ctx.home.rangeNm} miles.`, confidence: 0.9 };
  }
  return { intent: 'clarify', confidence: 0.8 };
}

export const mockSummary = (ctx: CompactContext): string => statusTemplate(ctx);
