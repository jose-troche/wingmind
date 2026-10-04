import type { CompactContext } from '@wingmind/shared';
export { INTENT_SCHEMA } from '@wingmind/nl';

export const INTENT_SYSTEM = `You turn a fighter pilot's spoken request into ONE JSON intent for a flight simulator.
Use only intents in the schema. Resolve "that contact" or "the SAM" from the context.
For a question, use intent "query.answer" and write a spoken answer under 20 words in "answer",
using only numbers that appear in the context. If the request is unclear, use intent "clarify". Never invent values.
Params: nav.setHeading {heading_deg}, nav.setAltitude {alt_ft}, nav.setSpeed {kcas}, nav.direct {waypoint},
ew.dispense {kind: chaff|flare}, ew.setMode {mode: manual|semi|auto}, sig.setEmcon {level 0-3}, ui.show {page},
pia.verbosity {level: terse|standard|instructional}. Set confidence between 0 and 1.`;

/** Compact context: own-state summary and top five threats only (implementation 3.3). */
export function renderContext(utter: string, ctx: CompactContext, history: { q: string; a: string }[] = []): string {
  const o = ctx.own;
  const lines = [
    `Own: heading ${o.headingDeg}, altitude ${o.altFt} ft (${o.aglFt} ft above ground), ${o.kcas} knots, mach ${o.mach}.`,
    `Fuel ${o.fuelLb} lb, bingo ${o.bingoLb} lb, ${o.minutesToBingo} minutes to bingo. Chaff ${o.chaff}, flares ${o.flares}, emcon ${o.emcon}.`,
    ctx.threats.length
      ? `Threats (highest first): ${ctx.threats.slice(0, 5).map((t, i) => `${i + 1}) ${t.id} ${t.cls} at ${t.clock}, bearing ${t.bearingDeg}, ${t.rangeNm} nm, ${t.level}${t.intent ? `, ${t.intent}` : ''}`).join('; ')}.`
      : 'Threats: none.',
    ctx.route ? `Next waypoint ${ctx.route.nextWp}: bearing ${ctx.route.bearingDeg}, ${ctx.route.distNm} nm.` : 'No route.',
    `Home plate: bearing ${ctx.home.bearingDeg}, ${ctx.home.rangeNm} nm.`,
  ];
  if (history.length) lines.push(`Earlier: ${history.map(h => `Q "${h.q}" A "${h.a}"`).join(' | ')}`);
  lines.push(`Pilot said: "${utter.replace(/"/g, "'")}"`);
  return lines.join('\n');
}
