import type { AlertClass } from '@wingmind/shared';

// Alert templates (implementation 6.1, spec 9.2): condition, position, range,
// extra, action. One standard and one terse variant per class, plus the reason
// that the instructional verbosity appends.

export interface Template { std: string; terse: string; why?: string }

export const templates: Record<AlertClass, Template> = {
  radar_missile: { std: 'Missile, {clock}, {range}. {action}.', terse: 'Missile, {clock}, {action}.', why: 'Beam it to deny its radar a clean track.' },
  ir_missile: { std: 'Missile, {clock}, close. {action}.', terse: 'Missile, {clock}, {action}.', why: 'Flares decoy its heat seeker.' },
  missile_defeated: { std: 'Missile defeated.', terse: 'Defeated.' },
  sam_track: { std: 'SAM tracking, {clock}, {range}. {action}.', terse: 'SAM, {clock}.', why: 'Terrain between you and its radar breaks the track.' },
  bandit: { std: 'Bandit, {clock}, {range}, {alt}, {intent}.', terse: 'Bandit, {clock}, {intent}.' },
  swarm: { std: 'Drone swarm, {clock}, {range}, {alt}, {count} contacts.', terse: 'Drones, {clock}.' },
  detection: { std: 'Search radar has you. {action}.', terse: 'Radar has you.', why: 'Your frontal sector has the smallest signature.' },
  pull_up: { std: 'Pull up. Pull up.', terse: 'Pull up.' },
  obstacle: { std: '{obstacle}, {clockOclock}, {range}, {height}.', terse: '{obstacle}, {clockOclock}.' },
  engine_fire: { std: 'Fire, {side} engine. Throttle off, fire switch.', terse: 'Fire, {side} engine.' },
  engine_fault: { std: '{Side} engine {fault}. {action}.', terse: '{Side} engine {fault}.' },
  bingo: { std: 'Bingo fuel. Home plate {bearing}, {range}.', terse: 'Bingo.' },
  joker: { std: 'Joker fuel.', terse: 'Joker.' },
  weather: { std: '{hazard} ahead, {range}. Suggest heading {heading}.', terse: '{hazard} ahead.' },
  over_g: { std: 'Over G.', terse: 'Over G.' },
  aoa: { std: 'Angle of attack.', terse: 'Angle of attack.' },
  cm_low: { std: '{Kind} {state}.', terse: '{Kind} {state}.' },
  traffic: { std: 'Traffic, {clock}, {range}.', terse: 'Traffic, {clock}.' },
  readback: { std: '{text}', terse: '{text}' },
  status: { std: '{text}', terse: '{text}' },
  advisory: { std: '{text}', terse: '{text}' },
};

/** Fill a template's slots. Missing slots are dropped along with the comma before them. */
export function fillTemplate(cls: AlertClass, slots: Record<string, string>, variant: 'std' | 'terse' = 'std'): string {
  const t = templates[cls][variant];
  let out = t.replace(/\{(\w+)\}/g, (_, k: string) => {
    const lower = k[0]!.toLowerCase() + k.slice(1);
    const v = slots[k] ?? slots[lower];
    if (v === undefined || v === '') return '\u0000';
    return k[0] === k[0]!.toUpperCase() && k[0] !== k[0]!.toLowerCase() ? v[0]!.toUpperCase() + v.slice(1) : v;
  });
  out = out.replace(/,?\s*\u0000\.?/g, '').replace(/\s+\./g, '.').replace(/\.\./g, '.').replace(/\s{2,}/g, ' ').trim();
  if (!/[.!?]$/.test(out)) out += '.';
  return out;
}

/** "Possible launch" phrasing for medium-confidence missile calls (spec 6.5). */
export function possiblePrefix(text: string, confidence: number): string {
  if (confidence >= 0.8 || confidence < 0.5) return text;
  return text.replace(/^Missile,/, 'Possible launch,').replace(/^(?!Possible)/, 'Possible: ');
}

/** Words and phrases that have pre-recorded clips. tools/gen-voice.ts renders each one. */
export const CLIP_PHRASES: string[] = (() => {
  const numbers = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'niner', 'ten', 'eleven', 'twelve',
    'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen', 'twenty', 'thirty', 'forty', 'fifty',
    'sixty', 'seventy', 'eighty', 'ninety', 'hundred', 'thousand'];
  const phrases = [
    'missile', 'possible launch', 'missile defeated', 'defeated', 'sam tracking', 'sam', 'bandit', 'drone swarm', 'drones', 'contacts',
    'search radar has you', 'radar has you', 'pull up', 'tower', 'cable', "o'clock", 'fire', 'left engine', 'right engine', 'engine',
    'throttle off', 'fire switch', 'oil pressure', 'flameout', 'reduce throttle', 'relight window below', 'bingo fuel', 'bingo', 'home plate',
    'joker fuel', 'joker', 'thunderstorm ahead', 'ahead', 'suggest heading', 'over g', 'angle of attack', 'chaff', 'flares', 'low', 'out',
    'traffic', 'left', 'right', 'nose', 'miles', 'mile', 'close', 'high', 'angels', 'feet', 'break', 'break left', 'break right',
    'descend', 'mask behind the ridge', 'come', 'to reduce signature', 'committing', 'searching', 'unaware', 'launching', 'disengaging',
    'heading', 'speed', 'hold altitude', 'radar silent', 'radar on', 'emcon', 'program', 'countermeasures', 'auto', 'semi auto', 'manual',
    'copy', 'say again', 'unable', 'voice queries offline', 'direct waypoint', 'new route avoids the sam', 'accept', 'route cancelled',
    'terse mode', 'standard mode', 'instructional mode', 'advisories quiet', 'turn cold', 'climb', 'fuel', 'minutes', 'compressor stall',
    'generator', 'stalled', 'dispense', 'checklist', 'master caution reset', 'ground collision auto', 'off', 'on', 'confirm', 'home',
    'beam it to deny its radar a clean track', 'flares decoy its heat seeker', 'terrain between you and its radar breaks the track',
    'your frontal sector has the smallest signature', 'showing', 'page', 'zoom', 'and', 'in', 'is', 'at',
  ];
  return [...new Set([...numbers, ...phrases])];
})();

/**
 * Split a sentence into clip keys by greedy longest match. Returns null when any
 * word has no clip, so the caller can fall back to speech synthesis.
 */
export function phraseToClips(text: string, available: ReadonlySet<string>): { key: string; pauseAfterMs: number }[] | null {
  const tokens = text.toLowerCase().replace(/[^a-z0-9'.,!? ]+/g, ' ').split(/\s+/).filter(Boolean);
  const words: { w: string; pause: number }[] = tokens.map(t => {
    const pause = /[.!?]$/.test(t) ? 140 : /,$/.test(t) ? 60 : 30;
    return { w: t.replace(/[.,!?]+$/, ''), pause };
  });
  const out: { key: string; pauseAfterMs: number }[] = [];
  let i = 0;
  while (i < words.length) {
    let matched = false;
    for (let n = Math.min(8, words.length - i); n >= 1; n--) {
      const key = words.slice(i, i + n).map(x => x.w).join(' ');
      if (available.has(key)) {
        out.push({ key, pauseAfterMs: words[i + n - 1]!.pause });
        i += n;
        matched = true;
        break;
      }
    }
    if (!matched) return null;
  }
  return out;
}

/** File-safe clip name for a phrase. */
export const clipFileName = (phrase: string): string => phrase.replace(/'/g, '').replace(/\s+/g, '_');
