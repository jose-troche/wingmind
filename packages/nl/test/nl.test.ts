import { describe, expect, it } from 'vitest';
import type { CompactContext, IntentName } from '@wingmind/shared';
import { GRAMMAR_RULE_COUNT, extractNumbers, fillTemplate, matchGrammar, normalize, numbersGrounded, phraseToClips, possiblePrefix, validate } from '../src';

const ctx: CompactContext = {
  sessionId: 's',
  own: { headingDeg: 300, altFt: 15000, aglFt: 13500, kcas: 420, mach: 0.82, fuelLb: 13900, bingoLb: 2500, minutesToBingo: 112, emcon: 0, chaff: 60, flares: 60 },
  threats: [{ id: 'gnd-sam-1', cls: 'sam', clock: 'right two', bearingDeg: 360, rangeNm: 21.4, level: 'CAUTION', intent: 'track' }],
  route: { nextWp: 1, bearingDeg: 300, distNm: 18 },
  home: { bearingDeg: 120, rangeNm: 3 },
};

describe('normalizer', () => {
  it.each([
    ['Heading two seven zero', 'heading 270'],
    ['uh, climb angels twenty five please', 'climb angels 25'],
    ['speed four hundred', 'speed 400'],
    ['descend to one five thousand', 'descend to 15000'],
    ['heading niner zero', 'heading 90'],
    ['Bogey at two o\'clock', "bandit at 2 o'clock"],
    ['direct way point three', 'direct waypoint 3'],
    ['one hundred twenty', '120'],
    ['Radar-off', 'radar off'],
    ['speed three fifty', 'speed 350'],
  ])('%s -> %s', (input, expected) => {
    expect(normalize(input)).toBe(expected);
  });

  it('extracts spelled and digit numbers', () => {
    expect(extractNumbers('Bingo in 47 minutes, fuel six thousand')).toEqual([47, 6000]);
  });
});

// A 200-utterance grammar set (implementation 10.1, 95% target).
function utteranceSet(): { u: string; intent: IntentName | null }[] {
  const out: { u: string; intent: IntentName | null }[] = [];
  const d = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];
  const spell = (n: number) => String(n).padStart(3, '0').split('').map(c => d[+c]).join(' ');
  for (let h = 0; h < 360; h += 9) out.push({ u: `heading ${spell(h)}`, intent: 'nav.setHeading' });           // 40
  for (let h = 5; h < 360; h += 36) out.push({ u: `turn left heading ${spell(h)}`, intent: 'nav.setHeading' }); // 10
  for (let h = 15; h < 360; h += 36) out.push({ u: `uh turn to ${spell(h)}`, intent: 'nav.setHeading' });      // 10
  const tens = ['', '', 'twenty', 'thirty', 'forty'];
  const ones = ['', ' one', ' two', ' three', ' four', ' five', ' six', ' seven', ' eight', ' nine'];
  for (let a = 5; a <= 45; a += 2) {
    const w = a < 10 ? d[a]! : a < 20 ? ['ten', 'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'][a - 10]! : `${tens[Math.floor(a / 10)]}${ones[a % 10]}`;
    out.push({ u: `climb angels ${w}`, intent: 'nav.setAltitude' });
    out.push({ u: `descend and maintain angels ${w}`, intent: 'nav.setAltitude' });
  }                                                                                                         // 42
  for (const s of ['three hundred', 'three fifty', 'four hundred', 'four fifty', 'five hundred', 'five twenty', 'six hundred', 'three two zero', 'four eight zero', 'five five zero']) {
    out.push({ u: `speed ${s}`, intent: 'nav.setSpeed' });
  }                                                                                                         // 10
  for (let h = 3; h < 360; h += 18) out.push({ u: `fly heading ${spell(h)}`, intent: 'nav.setHeading' });    // 20
  for (let h = 7; h < 360; h += 36) out.push({ u: `come to ${spell(h)}`, intent: 'nav.setHeading' });        // 10
  for (let a = 10; a < 30; a += 2) {
    const w = a < 20 ? ['ten', 'twelve', 'fourteen', 'sixteen', 'eighteen'][(a - 10) / 2]! : a === 20 ? 'twenty' : `twenty ${d[a - 20]}`;
    out.push({ u: `angels ${w}`, intent: 'nav.setAltitude' });                                              // 10
  }
  const fixed: [string, IntentName | null][] = [
    ['chaff', 'ew.dispense'], ['flares', 'ew.dispense'], ['flare', 'ew.dispense'], ['chaff and flares', 'ew.dispense'], ['dispense', 'ew.dispense'],
    ['program two', 'ew.program'], ['program one', 'ew.program'], ['countermeasures auto', 'ew.setMode'], ['countermeasures semi auto', 'ew.setMode'], ['countermeasures manual', 'ew.setMode'],
    ['radar silent', 'sig.setEmcon'], ['radar off', 'sig.setEmcon'], ['radar quiet', 'sig.setEmcon'], ['go silent', 'sig.setEmcon'], ['radar on', 'sig.setEmcon'],
    ['emcon two', 'sig.setEmcon'], ['emcon three', 'sig.setEmcon'], ['route around the sam', 'nav.replan'], ['avoid the sam', 'nav.replan'], ['replan', 'nav.replan'],
    ['direct waypoint three', 'nav.direct'], ['direct waypoint one', 'nav.direct'], ['direct two', 'nav.direct'], ['take me home', 'nav.home'], ['rtb', 'nav.home'],
    ['accept', 'nav.accept'], ['cancel', 'nav.reject'], ['status', 'query.status'], ['sitrep', 'query.status'], ['fuel state', 'query.fuel'],
    ['fuel', 'query.fuel'], ['time to bingo', 'query.bingo'], ['engine fire checklist', 'sys.checklist'], ['left engine fire checklist', 'sys.checklist'], ['show engine page', 'ui.show'],
    ['show fuel page', 'ui.show'], ['show threat rings', 'ui.show'], ['show systems', 'ui.show'], ['reset master caution', 'sys.resetCaution'], ['zoom forty', 'ui.zoom'],
    ['zoom twenty', 'ui.zoom'], ['explain that', 'ui.explain'], ['copy', 'pia.ack'], ['roger', 'pia.ack'], ['say again', 'pia.sayAgain'],
    ['quiet advisories', 'pia.quietAdvisories'], ['terse mode', 'pia.verbosity'], ['instructional mode', 'pia.verbosity'], ['standard mode', 'pia.verbosity'], ['ground collision auto off', 'prot.gcas'],
    ['hold altitude', 'nav.holdAltitude'], ['angels twenty', 'nav.setAltitude'], ['climb to one five thousand', 'nav.setAltitude'], ['confirm', 'confirm'], ['what is that contact doing', null],
    ['how long until bingo', null], ['can the sam see me', null], ['tell me a joke', null],
  ];
  for (const [u, intent] of fixed) out.push({ u, intent });
  return out;
}

describe('grammar', () => {
  it(`has about thirty rules (${GRAMMAR_RULE_COUNT})`, () => {
    expect(GRAMMAR_RULE_COUNT).toBeGreaterThanOrEqual(30);
  });

  it('matches the 200-utterance set at 95% or better', () => {
    const set = utteranceSet();
    expect(set.length).toBeGreaterThanOrEqual(200);
    let ok = 0;
    const misses: string[] = [];
    for (const { u, intent } of set) {
      const got = matchGrammar(u)?.intent ?? null;
      if (got === intent) ok++; else misses.push(`${u} -> ${got} (want ${intent})`);
    }
    expect(ok / set.length, misses.join('\n')).toBeGreaterThanOrEqual(0.95);
  });

  it('reads back in standard form', () => {
    expect(matchGrammar('heading two seven zero')?.readback).toBe('Heading two seven zero');
    expect(matchGrammar('climb angels twenty five')?.readback).toBe('Angels twenty five');
    expect(matchGrammar('radar silent')?.readback).toBe('Radar silent');
    expect(matchGrammar('heading two seven zero')?.params).toEqual({ heading_deg: 270, turn: 'shortest' });
  });

  it('fires only defensive one-word commands on interim transcripts', () => {
    expect(matchGrammar('chaff', { interim: true })?.intent).toBe('ew.dispense');
    expect(matchGrammar('heading two seven zero', { interim: true })).toBeNull();
  });

  it('marks irreversible commands for two-step confirmation', () => {
    expect(matchGrammar('ground collision auto off')?.requires_confirmation).toBe(true);
  });
});

describe('templates', () => {
  it('fills the radar-missile template', () => {
    expect(fillTemplate('radar_missile', { clock: 'left eight', range: 'six miles', action: 'Break right, chaff' })).toBe('Missile, left eight, six miles. Break right, chaff.');
    expect(fillTemplate('radar_missile', { clock: 'left eight', range: 'six miles' })).toBe('Missile, left eight, six miles.');
    expect(fillTemplate('pull_up', {})).toBe('Pull up. Pull up.');
    expect(fillTemplate('bingo', { bearing: 'two four zero', range: 'one hundred twenty miles' })).toBe('Bingo fuel. Home plate two four zero, one hundred twenty miles.');
    expect(fillTemplate('engine_fire', { side: 'left' })).toBe('Fire, left engine. Throttle off, fire switch.');
  });
  it('adds "possible" for medium confidence', () => {
    expect(possiblePrefix('Missile, right four, close. Flares, break left.', 0.7)).toBe('Possible launch, right four, close. Flares, break left.');
    expect(possiblePrefix('Missile, right four.', 0.9)).toBe('Missile, right four.');
  });
  it('plans clip playback or reports a gap', () => {
    const keys = new Set(['missile', 'left', 'eight', 'six', 'miles', 'break right', 'chaff']);
    expect(phraseToClips('Missile, left eight, six miles. Break right, chaff.', keys)?.map(c => c.key)).toEqual(['missile', 'left', 'eight', 'six', 'miles', 'break right', 'chaff']);
    expect(phraseToClips('Missile, nose.', keys)).toBeNull();
  });
});

describe('number guardrail', () => {
  it('blocks any figure absent from the context', () => {
    expect(numbersGrounded('Bingo in 47 minutes.', ctx)).toBe(false);
    expect(numbersGrounded('Bingo in 112 minutes.', ctx)).toBe(true);
    expect(numbersGrounded('SAM at right two, 21 miles.', ctx)).toBe(true);
    expect(numbersGrounded('Fuel fourteen thousand.', ctx)).toBe(true);
  });

  it('replaces an invented answer with the template', () => {
    const r = validate({ intent: 'query.answer', answer: 'Bingo in 47 minutes.', confidence: 0.9 }, ctx, 'how long until bingo');
    expect(r.kind).toBe('answer');
    if (r.kind === 'answer') {
      expect(r.say).not.toContain('47');
      expect(r.guarded).toBe(true);
      expect(r.say).toContain('112');
    }
  });

  it('rejects malformed, low-confidence and out-of-range proposals', () => {
    expect(validate('nonsense', ctx).kind).toBe('clarify');
    expect(validate({ intent: 'nav.selfDestruct', confidence: 1 }, ctx).kind).toBe('clarify');
    expect(validate({ intent: 'nav.setHeading', params: { heading_deg: 90 }, confidence: 0.4 }, ctx).kind).toBe('clarify');
    expect(validate({ intent: 'nav.setHeading', params: { heading_deg: 900 }, confidence: 0.9 }, ctx).kind).toBe('unable');
    expect(validate({ intent: 'nav.setAltitude', params: { alt_ft: 1000 }, confidence: 0.9 }, ctx).kind).toBe('unable');
    const ok = validate({ intent: 'nav.setHeading', params: { heading_deg: 90 }, confidence: 0.9, readback: 'Heading zero nine zero' }, ctx);
    expect(ok.kind).toBe('intent');
  });
});
