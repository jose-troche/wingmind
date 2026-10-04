import { fillTemplate, possiblePrefix, templates } from '@wingmind/nl';
import type { Alert, AlertLogStatus, BusMessage, Directive, Intent, Level, SpeakItem, Verbosity } from '@wingmind/shared';
import { msg, type Agent, type Snapshot } from './core';

// PIA: the single voice (spec 9.4, implementation 6.1). It de-duplicates by key,
// fills templates with the action ORCH decided in the same tick, repeats
// warnings until acknowledged, holds advisories under high workload and hands
// each phrase to the audio engine, which preempts at clip boundaries.

export interface LogEntry { alertId: string; level: Level; text: string; status: AlertLogStatus; tMs: number; cls: string }

interface Repeat { item: SpeakItem; count: number; nextMs: number; threatId?: string; untilMs: number }

/** "Break right, chaff" / "Flares, break left" from the directives tied to a missile threat. */
export function missileAction(cls: string, dirs: Directive[]): string {
  const head = dirs.find(d => d.axis === 'heading' && d.value && (d.value as Record<string, unknown>).mode === 'break');
  const cm = dirs.find(d => d.axis === 'countermeasures' && d.value);
  const side = head ? String((head.value as Record<string, unknown>).side) : null;
  const kind = cm ? String((cm.value as Record<string, unknown>).kind) : cls === 'radar_missile' ? 'chaff' : 'flare';
  const cmWord = kind === 'flare' ? 'flares' : 'chaff';
  const brk = side ? `break ${side}` : 'beam it';
  if (cls === 'ir_missile') return `${cmWord[0]!.toUpperCase()}${cmWord.slice(1)}, ${brk}`;
  return `${brk[0]!.toUpperCase()}${brk.slice(1)}, ${cmWord}`;
}

export function createPia(): Agent {
  let dedup = new Map<string, number>();
  let repeats = new Map<string, Repeat>();
  let held: Alert[] = [];
  let delayed: { a: Alert; atMs: number }[] = [];
  let verbosity: Verbosity = 'standard';
  let quiet = false;
  let last: SpeakItem | null = null;
  let seq = 0;
  let suppressedLogged = new Set<string>();

  const workloadHigh = (s: Snapshot): boolean => s.own.g > 5 || [...repeats.values()].filter(r => r.item.level === 'WARNING').length >= 2;

  return {
    id: 'PIA', tier: 'R', rateHz: 10, budgetMs: 1, stage: 'sink',
    reads: ['alert', 'directive', 'intent.pia', 'threat.cleared'],
    writes: ['speak', 'alert.log'],
    reset() {
      dedup = new Map(); repeats = new Map(); held = []; delayed = []; verbosity = 'standard'; quiet = false; last = null; seq = 0; suppressedLogged = new Set();
    },
    step(s, inbox) {
      const out: BusMessage<unknown>[] = [];
      const log = (a: Alert, text: string, status: AlertLogStatus) =>
        out.push(msg('alert.log', { alertId: a.id, level: a.level, text, status, tMs: s.tMs, cls: a.cls } satisfies LogEntry, { priority: 7, ttlMs: 1000 }));
      const tickDirectives: Directive[] = [...s.directives];
      for (const m of inbox) if (m.topic === 'directive' && m.payload) {
        const d = m.payload as Directive;
        const i = tickDirectives.findIndex(x => x.axis === d.axis);
        if (i >= 0) tickDirectives.splice(i, 1);
        if (d.value !== null) tickDirectives.push(d);
      }

      const speak = (a: Alert, text: string, repeat = 0) => {
        const item: SpeakItem = {
          id: `sp${++seq}`, alertId: a.id, level: a.level, text, cls: a.cls, dedupKey: a.dedupKey, repeat,
          ...(a.bearingDeg !== undefined ? { bearingDeg: a.bearingDeg } : {}),
          ...(a.eventWallMs !== undefined && repeat === 0 ? { eventWallMs: a.eventWallMs } : {}),
        };
        out.push(msg('speak', item, { priority: a.level === 'WARNING' ? 0 : 3, ttlMs: 2000 }));
        if (a.cls !== 'readback' && a.cls !== 'status') last = item;
        return item;
      };

      const compose = (a: Alert, terse: boolean): string => {
        if (a.text) return a.text;
        const slots = { ...(a.slots ?? {}) };
        if (a.cls === 'radar_missile' || a.cls === 'ir_missile') {
          slots.action = missileAction(a.cls, tickDirectives.filter(d => !a.threatId || d.threatId === a.threatId || d.axis === 'countermeasures'));
        }
        let text = fillTemplate(a.cls, slots, terse ? 'terse' : 'std');
        if (a.cls === 'radar_missile' || a.cls === 'ir_missile') text = possiblePrefix(text, a.confidence);
        const why = templates[a.cls].why;
        if (verbosity === 'instructional' && why && !terse) text = `${text} ${why}`;
        return text;
      };

      const handle = (a: Alert) => {
        const terse = verbosity === 'terse' || workloadHigh(s);
        // fog of war: below 0.5 the contact is displayed, not spoken
        if (a.confidence < 0.5) { log(a, compose(a, terse), 'held'); return; }
        const until = dedup.get(a.dedupKey);
        if (until !== undefined && until > s.tMs) {
          if (!suppressedLogged.has(a.dedupKey)) { suppressedLogged.add(a.dedupKey); log(a, compose(a, terse), 'suppressed'); }
          return;
        }
        dedup.set(a.dedupKey, s.tMs + a.ttlMs);
        suppressedLogged.delete(a.dedupKey);
        if (a.level === 'ADVISORY' && (quiet || workloadHigh(s))) { held.push(a); log(a, compose(a, terse), 'held'); return; }
        if (a.level === 'CAUTION' && workloadHigh(s) && !delayed.some(d => d.a.id === a.id)) { delayed.push({ a, atMs: s.tMs + 2000 }); return; }
        const text = compose(a, terse);
        const item = speak(a, text);
        if (a.level === 'WARNING') {
          repeats.set(a.dedupKey, { item, count: 1, nextMs: s.tMs + 4000, untilMs: s.tMs + a.ttlMs, ...(a.threatId ? { threatId: a.threatId } : {}) });
        } else if (a.level === 'CAUTION' && a.cls !== 'readback') {
          repeats.set(a.dedupKey, { item, count: 1, nextMs: s.tMs + 30_000, untilMs: s.tMs + 31_000, ...(a.threatId ? { threatId: a.threatId } : {}) });
        }
      };

      for (const m of inbox) {
        if (m.topic === 'alert') handle(m.payload as Alert);
        else if (m.topic === 'threat.cleared') {
          const id = (m.payload as { threatId: string }).threatId;
          for (const [k, r] of repeats) if (r.threatId === id) repeats.delete(k);
        } else if (m.topic === 'intent.pia') {
          const it = m.payload as Intent;
          switch (it.intent) {
            case 'pia.ack':
              repeats.clear();
              break;
            case 'pia.sayAgain':
              if (last) {
                const { eventWallMs: _e, ...rest } = last;
                out.push(msg('speak', { ...rest, id: `sp${++seq}`, repeat: last.repeat + 1 } satisfies SpeakItem, { priority: 3 }));
              }
              break;
            case 'pia.verbosity':
              if (it.params.level === 'terse' || it.params.level === 'standard' || it.params.level === 'instructional') verbosity = it.params.level;
              break;
            case 'pia.quietAdvisories':
              quiet = Boolean(it.params.quiet);
              break;
          }
        }
      }
      // repeats: warnings up to three times, cautions once more after 30 s
      for (const [k, r] of repeats) {
        if (r.untilMs < s.tMs || (r.item.level === 'WARNING' && r.count >= 3) || (r.item.level === 'CAUTION' && r.count >= 2)) { repeats.delete(k); continue; }
        if (s.tMs >= r.nextMs) {
          r.count++;
          r.nextMs = s.tMs + (r.item.level === 'WARNING' ? 4000 : 30_000);
          const { eventWallMs: _drop, ...rest } = r.item;
          out.push(msg('speak', { ...rest, id: `sp${++seq}`, repeat: r.count - 1 } satisfies SpeakItem, { priority: r.item.level === 'WARNING' ? 0 : 3, ttlMs: 2000 }));
        }
      }
      // release delayed cautions and held advisories when workload allows
      if (!workloadHigh(s)) {
        const due = delayed.filter(d => d.atMs <= s.tMs);
        delayed = delayed.filter(d => d.atMs > s.tMs);
        for (const d of due) speak(d.a, compose(d.a, verbosity === 'terse'));
        if (!quiet && held.length) {
          const h = held.shift()!;
          speak(h, compose(h, verbosity === 'terse'));
        }
      }
      return out;
    },
  };
}
