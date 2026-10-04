import type { CompactContext } from '@wingmind/shared';
import { renderContext } from './intent';

export const SUMMARY_SYSTEM = `You are the briefing agent in a fighter simulator. Give the pilot a spoken situation summary
of at most two short sentences: the top threat first, then fuel. Use only numbers from the context.
Reply as JSON {"say": "..."}.`;

export const SUMMARY_SCHEMA = {
  type: 'object',
  properties: { say: { type: 'string' } },
  required: ['say'],
} as const;

export const renderSummary = (ctx: CompactContext): string => renderContext('status', ctx);

export const DEBRIEF_SYSTEM = `You write a short debrief for a flight-simulator sortie: three sentences on what happened,
then "Try next time:" followed by exactly three short tips. Use only numbers from the metrics. Plain text, under 120 words.`;

export interface DebriefInput {
  scenarioId: string; outcome: string; durationS: number;
  metrics: Record<string, number | string | null>;
}

export const renderDebrief = (d: DebriefInput): string =>
  `Scenario ${d.scenarioId}. Outcome: ${d.outcome}. Duration ${Math.round(d.durationS / 60)} minutes.\nMetrics: ${JSON.stringify(d.metrics)}`;

/** Template debrief used when the model is mocked, unavailable or over budget. */
export function templateDebrief(d: DebriefInput): string {
  const m = d.metrics;
  const outcome = d.outcome === 'survived' ? 'You survived the sortie' : d.outcome === 'shot_down' ? 'You were shot down' : d.outcome === 'crashed' ? 'The aircraft hit the ground' : 'The sortie was ended early';
  const tips: string[] = [];
  if (Number(m.detectedMin ?? 0) > 1) tips.push('Keep the low-signature sector toward search radars to cut detected minutes.');
  if (Number(m.reactionP50Ms ?? 0) > 2500) tips.push('Act on the first missile call: break, then dispense.');
  if (Number(m.envelopeMin ?? 0) > 1) tips.push('Ask for a route around threat rings before you enter them.');
  if (Number(m.fuelAtEndLb ?? 99999) < 4000) tips.push('Turn for home at joker, not bingo.');
  while (tips.length < 3) tips.push(['Use terrain to mask from ground radars.', 'Say "status" for a one-line picture.', 'Try instructional mode to hear why each call is made.'][tips.length]!);
  return `${outcome} after ${Math.round(d.durationS / 60)} minutes in ${d.scenarioId}. ` +
    `Alerts spoken: ${m.alerts ?? 0}; missiles defeated: ${m.missilesDefeated ?? 0}; minutes inside threat envelopes: ${m.envelopeMin ?? 0}. ` +
    `Fuel at the end: ${m.fuelAtEndLb ?? 'unknown'} pounds. Try next time: ${tips.slice(0, 3).map((t, i) => `${i + 1}) ${t}`).join(' ')}`;
}
