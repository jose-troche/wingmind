import { capitalize, spellDigits, spellNumber, type Intent, type IntentName } from '@wingmind/shared';
import { normalize } from './normalize';

// The command grammar (implementation 6.3): an ordered list of about thirty
// patterns over the normalized transcript. Rules with `confirm: false` are the
// one-word defensive commands that may fire early on an interim transcript.

export interface Rule {
  id: string;
  re: RegExp;
  intent: (m: RegExpMatchArray) => { intent: IntentName; params: Record<string, unknown>; requires_confirmation?: boolean };
  readback?: (m: RegExpMatchArray) => string;
  confirm?: boolean;
}

const n = (s: string | undefined): number => Number(s ?? 0);
const hdg = (s: string | undefined): string => spellDigits(String(n(s) % 360 || 360).padStart(3, '0'));

const SHOW_TARGETS = 'engine|fuel|tsd|situation|rwr|warning|systems|threat rings|polar|masking|mesh|trace';

export const rules: Rule[] = [
  { id: 'heading', re: /^(?:heading|turn(?: to)?|fly heading|come(?: to)?) (\d{1,3})$/,
    intent: m => ({ intent: 'nav.setHeading', params: { heading_deg: n(m[1]) % 360, turn: 'shortest' } }),
    readback: m => `Heading ${hdg(m[1])}` },
  { id: 'turn-dir', re: /^turn (left|right)(?: heading)? (\d{1,3})$/,
    intent: m => ({ intent: 'nav.setHeading', params: { heading_deg: n(m[2]) % 360, turn: m[1] } }),
    readback: m => `${capitalize(m[1]!)} ${hdg(m[2])}` },
  { id: 'angels', re: /^(?:climb|descend)(?: and maintain)?(?: to)? angels (\d{1,2})$/,
    intent: m => ({ intent: 'nav.setAltitude', params: { alt_ft: n(m[1]) * 1000 } }),
    readback: m => `Angels ${spellNumber(n(m[1]))}` },
  { id: 'angels-bare', re: /^angels (\d{1,2})$/,
    intent: m => ({ intent: 'nav.setAltitude', params: { alt_ft: n(m[1]) * 1000 } }),
    readback: m => `Angels ${spellNumber(n(m[1]))}` },
  { id: 'altitude', re: /^(?:climb|descend)(?: and maintain)?(?: to)? (\d{3,5})$/,
    intent: m => ({ intent: 'nav.setAltitude', params: { alt_ft: n(m[1]) } }),
    readback: m => `${capitalize(spellNumber(n(m[1])))} feet` },
  { id: 'speed', re: /^(?:set )?speed (\d{3})$/,
    intent: m => ({ intent: 'nav.setSpeed', params: { kcas: n(m[1]) } }),
    readback: m => `Speed ${spellNumber(n(m[1]))}` },
  { id: 'hold-alt', re: /^hold (?:altitude|this altitude)$/,
    intent: () => ({ intent: 'nav.holdAltitude', params: {} }), readback: () => 'Hold altitude' },
  { id: 'chaff', re: /^(chaff|flares?)$/, confirm: false,
    intent: m => ({ intent: 'ew.dispense', params: { kind: m[1]!.startsWith('flare') ? 'flare' : 'chaff' } }) },
  { id: 'chaff-flares', re: /^(?:chaff (?:and )?flares?|flares? (?:and )?chaff)$/, confirm: false,
    intent: () => ({ intent: 'ew.dispense', params: { kind: 'both' } }) },
  { id: 'dispense', re: /^dispense$/, confirm: false,
    intent: () => ({ intent: 'ew.dispense', params: { kind: 'program' } }) },
  { id: 'program', re: /^program (\d)$/,
    intent: m => ({ intent: 'ew.program', params: { program: n(m[1]) } }), readback: m => `Program ${spellNumber(n(m[1]))}` },
  { id: 'cm-mode', re: /^countermeasures (auto|semi(?: auto)?|manual)$/,
    intent: m => ({ intent: 'ew.setMode', params: { mode: m[1]!.startsWith('semi') ? 'semi' : m[1] } }),
    readback: m => `Countermeasures ${m[1]!.startsWith('semi') ? 'semi auto' : m[1]}` },
  { id: 'radar-silent', re: /^radar (?:silent|off|quiet|standby)$/,
    intent: () => ({ intent: 'sig.setEmcon', params: { level: 3 } }), readback: () => 'Radar silent' },
  { id: 'radar-on', re: /^radar (?:on|active|hot)$/,
    intent: () => ({ intent: 'sig.setEmcon', params: { level: 0 } }), readback: () => 'Radar on' },
  { id: 'emcon', re: /^emcon ([0-3])$/,
    intent: m => ({ intent: 'sig.setEmcon', params: { level: n(m[1]) } }), readback: m => `Emcon ${spellNumber(n(m[1]))}` },
  { id: 'replan', re: /^(?:route around (?:the )?sam|avoid (?:the )?sam|replan|new route|reroute)$/,
    intent: () => ({ intent: 'nav.replan', params: { avoid: 'sam' } }) },
  { id: 'direct', re: /^direct (?:waypoint |steer point |to waypoint )?(\d{1,2})$/,
    intent: m => ({ intent: 'nav.direct', params: { waypoint: n(m[1]) } }), readback: m => `Direct waypoint ${spellNumber(n(m[1]))}` },
  { id: 'home', re: /^(?:take me home|rtb|return to base|home plate|go home)$/,
    intent: () => ({ intent: 'nav.home', params: {} }), readback: () => 'Home plate' },
  { id: 'accept', re: /^(?:accept|accepted|approve)$/, intent: () => ({ intent: 'nav.accept', params: {} }) },
  { id: 'reject', re: /^(?:reject|cancel|negative|disregard)$/, intent: () => ({ intent: 'nav.reject', params: {} }) },
  { id: 'status', re: /^(?:status|sitrep|situation report|picture)$/, intent: () => ({ intent: 'query.status', params: {} }) },
  { id: 'fuel', re: /^(?:fuel|fuel state|fuel status|state)$/, intent: () => ({ intent: 'query.fuel', params: {} }) },
  { id: 'bingo', re: /^time to bingo$/, intent: () => ({ intent: 'query.bingo', params: {} }) },
  { id: 'checklist', re: /^(?:(left|right) )?engine (fire|failure|flameout) checklist$/,
    intent: m => ({ intent: 'sys.checklist', params: { checklist: `engine_${m[2]}`, side: m[1] ?? 'left' } }),
    readback: m => `${capitalize(`engine ${m[2]} checklist`)}` },
  { id: 'show', re: new RegExp(`^(?:show|display)(?: me)? (?:the )?(${SHOW_TARGETS})(?: page| display)?$`),
    intent: m => ({ intent: 'ui.show', params: { page: m[1] } }) },
  { id: 'reset-caution', re: /^reset (?:master )?caution$/,
    intent: () => ({ intent: 'sys.resetCaution', params: {} }), readback: () => 'Master caution reset' },
  { id: 'zoom', re: /^zoom (\d{1,3})$/, intent: m => ({ intent: 'ui.zoom', params: { rangeNm: n(m[1]) } }) },
  { id: 'explain', re: /^explain(?: that| this)?$/, intent: () => ({ intent: 'ui.explain', params: {} }) },
  { id: 'copy', re: /^(?:copy|acknowledge|ack)$/, confirm: false, intent: () => ({ intent: 'pia.ack', params: {} }) },
  { id: 'say-again', re: /^say again$/, intent: () => ({ intent: 'pia.sayAgain', params: {} }) },
  { id: 'quiet', re: /^(?:quiet|mute) advisories$/, intent: () => ({ intent: 'pia.quietAdvisories', params: { quiet: true } }), readback: () => 'Advisories quiet' },
  { id: 'verbosity', re: /^(?:(terse|standard|instructional) mode|verbosity (terse|standard|instructional))$/,
    intent: m => ({ intent: 'pia.verbosity', params: { level: m[1] ?? m[2] } }), readback: m => `${capitalize(m[1] ?? m[2] ?? 'standard')} mode` },
  { id: 'gcas', re: /^ground collision (?:auto(?:matic)? )?(off|on)$/,
    intent: m => ({ intent: 'prot.gcas', params: { auto: m[1] === 'on' }, requires_confirmation: m[1] === 'off' }),
    readback: m => `Ground collision auto ${m[1]}` },
  { id: 'confirm', re: /^(?:confirm|confirmed|affirm|affirmative)$/, intent: () => ({ intent: 'confirm', params: {} }) },
];

/**
 * Match a transcript against the grammar. On an interim transcript only the
 * no-confirmation defensive rules may fire (early fire, implementation 6.2).
 */
export function matchGrammar(utterOrNormalized: string, opts: { interim?: boolean; normalized?: boolean } = {}): Intent | null {
  const s = opts.normalized ? utterOrNormalized : normalize(utterOrNormalized);
  for (const r of rules) {
    if (opts.interim && r.confirm !== false) continue;
    const m = s.match(r.re);
    if (!m) continue;
    const base = r.intent(m);
    const intent: Intent = {
      intent: base.intent,
      params: base.params,
      confidence: 1,
      source: 'grammar',
      ...(base.requires_confirmation ? { requires_confirmation: true } : {}),
      ...(r.readback ? { readback: r.readback(m) } : {}),
    };
    return intent;
  }
  return null;
}

export const GRAMMAR_RULE_COUNT = rules.length;
