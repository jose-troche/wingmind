import { checkIntentParams, fuelAnswer, statusTemplate } from '@wingmind/nl';
import { FT, type Alert, type BusMessage, type Intent } from '@wingmind/shared';
import { msg, type Agent, type ContextBuilder } from './core';

// NLU: validated intents from the console's voice pipeline enter the mesh here.
// It applies the command safety rules (spec 10.5), runs two-step confirmation
// for irreversible actions and routes each intent to the topic its owner reads.

const ROUTES: Record<string, string> = {
  nav: 'intent.nav', ew: 'intent.ew', sig: 'intent.sig', pia: 'intent.pia', sys: 'intent.sys', ui: 'intent.ui', prot: 'intent.prot',
};

export function createNlu(buildContext: ContextBuilder): Agent {
  let pendingConfirm: { intent: Intent; untilMs: number } | null = null;
  let seq = 0;

  return {
    id: 'NLU', tier: 'R', rateHz: 0, budgetMs: 2, stage: 'sink',
    reads: ['intent.pilot', 'say'],
    writes: ['intent.nav', 'intent.ew', 'intent.sig', 'intent.pia', 'intent.sys', 'intent.ui', 'intent.prot', 'alert'],
    reset() { pendingConfirm = null; seq = 0; },
    step(s, inbox) {
      const out: BusMessage<unknown>[] = [];
      const readback = (text: string, level: Alert['level'] = 'STATUS') => {
        const a: Alert = {
          id: `rb${++seq}-${s.tick}`, level, cls: 'readback', text, terse: text, dedupKey: `rb:${s.tick}:${seq}`,
          ttlMs: 3000, evidence: ['pilot'], confidence: 1,
        };
        out.push(msg('alert', a, { priority: 1, ttlMs: 3000 }));
      };
      for (const m of inbox) {
        if (m.topic === 'say') {
          const p = m.payload as { text: string };
          readback(p.text);
          continue;
        }
        let it = m.payload as Intent;
        if (it.intent === 'confirm') {
          if (!pendingConfirm || pendingConfirm.untilMs < s.tMs) { readback('Nothing to confirm.'); continue; }
          it = { ...pendingConfirm.intent, requires_confirmation: false };
          pendingConfirm = null;
        } else if (it.requires_confirmation) {
          pendingConfirm = { intent: it, untilMs: s.tMs + 10_000 };
          readback(`${it.readback ?? 'Confirm'}. Say confirm.`);
          continue;
        }
        if (it.confidence < 0.7) { readback('Say again.'); continue; }
        // pilot commands never override active ground-collision avoidance
        const flyup = s.directives.some(d => d.axis === 'altitude' && (d.value as Record<string, unknown> | null)?.flyup === true);
        if (flyup && (it.intent === 'nav.setHeading' || it.intent === 'nav.setAltitude')) { readback('Unable, pull up.'); continue; }
        // same range and safety checks as model intents
        const ctx = buildContext(s);
        const terrainFt = (s.own.pos[2] - s.own.aglFt * FT) / FT;
        const checked = checkIntentParams(it.intent, it.params, ctx, { terrainFt, minAltFtAgl: 500 });
        if (typeof checked === 'string') { readback(checked); continue; }
        it = { ...it, params: checked };
        // questions answer from the blackboard via templates
        if (it.intent === 'query.status') { readback(statusTemplate(ctx)); continue; }
        if (it.intent === 'query.fuel' || it.intent === 'query.bingo') { readback(fuelAnswer(ctx)); continue; }
        if (it.intent === 'query.answer') { if (it.answer) readback(it.answer); continue; }
        const topic = ROUTES[it.intent.split('.')[0]!];
        if (topic) out.push(msg(topic, it, { priority: 0, ttlMs: 3000, evidence: [m.id] }));
        if (it.readback) readback(it.readback);
      }
      return out;
    },
  };
}
