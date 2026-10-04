// Normalizer (implementation 6.3): lowercase, spoken digits to numbers
// ("two seven zero" -> 270, "niner" -> 9), strip fillers, map synonyms.

const DIGIT: Record<string, number> = {
  zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, niner: 9,
};
const TEENS: Record<string, number> = {
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19,
};
const TENS: Record<string, number> = { twenty: 20, thirty: 30, forty: 40, fourty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };

const FILLERS = new Set(['uh', 'um', 'er', 'ah', 'please', 'okay', 'ok', 'like', 'hey', 'wingmind', 'so', 'just', 'now']);

const SYNONYMS: [RegExp, string][] = [
  [/\bbogey\b|\bbogie\b/g, 'bandit'],
  [/\bflare\b(?! s)/g, 'flare'],
  [/\bcounter ?measures?\b/g, 'countermeasures'],
  [/\bsurface to air missile\b/g, 'sam'],
  [/\bs a m\b/g, 'sam'],
  [/\bwhat's\b/g, 'what is'],
  [/\bhow's\b/g, 'how is'],
  [/\bi'm\b/g, 'i am'],
  [/\broger\b|\bcopied\b|\bcopy that\b/g, 'copy'],
  [/\bthousand feet\b/g, 'thousand'],
  [/\bknots\b/g, ''],
  [/\bdegrees\b/g, ''],
  [/\bfeet\b/g, ''],
  [/\bway point\b/g, 'waypoint'],
  [/\bsteer\b/g, 'heading'],
  [/\bgo silent\b|\bemitters off\b/g, 'radar silent'],
];

/** Convert number words in a token stream to digits. Digit runs ("two seven zero") concatenate. */
export function wordsToNumbers(tokens: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i]!;
    if (t in DIGIT) {
      // a run of single digits reads as one number (headings, squawks)
      let s = '';
      while (i < tokens.length && tokens[i]! in DIGIT) s += String(DIGIT[tokens[i++]!]);
      const next = tokens[i];
      // "four hundred", "one five thousand" (pilots say 15,000 as "one five thousand")
      if (s.length <= 2 && (next === 'hundred' || next === 'thousand')) {
        let v = Number(s) * (next === 'hundred' ? 100 : 1000);
        i++;
        const rest = readCardinal(tokens, i);
        if (rest && rest.value < (next === 'hundred' ? 100 : 1000)) { v += rest.value; i = rest.next; }
        out.push(String(v));
        continue;
      }
      // "three fifty" -> 350, "four twenty" -> 420 (speeds)
      if (s.length === 1 && s !== '0' && next !== undefined && (next in TENS || next in TEENS)) {
        const rest = readCardinal(tokens, i);
        if (rest && rest.value < 100) {
          out.push(String(Number(s) * 100 + rest.value));
          i = rest.next;
          continue;
        }
      }
      out.push(s);
      continue;
    }
    const card = readCardinal(tokens, i);
    if (card) {
      out.push(String(card.value));
      i = card.next;
      continue;
    }
    out.push(t);
    i++;
  }
  return out;
}

function readCardinal(tokens: string[], start: number): { value: number; next: number } | null {
  let i = start;
  let value = 0;
  let matched = false;
  const t = tokens[i];
  if (t === undefined) return null;
  if (t in TEENS) { value = TEENS[t]!; i++; matched = true; }
  else if (t in TENS) {
    value = TENS[t]!; i++; matched = true;
    const u = tokens[i];
    if (u !== undefined && u in DIGIT && DIGIT[u]! > 0) { value += DIGIT[u]!; i++; }
  } else if (/^\d+$/.test(t)) { value = Number(t); i++; matched = true; }
  if (!matched) return null;
  if (tokens[i] === 'hundred') {
    value *= 100; i++;
    const r = readCardinal(tokens, i);
    if (r && r.value < 100) { value += r.value; i = r.next; }
  }
  if (tokens[i] === 'thousand') {
    value *= 1000; i++;
    const r = readCardinal(tokens, i);
    if (r && r.value < 1000) { value += r.value; i = r.next; }
  }
  return { value, next: i };
}

export function normalize(utter: string): string {
  let s = utter.toLowerCase().replace(/[-_]/g, ' ').replace(/[^a-z0-9' ]+/g, ' ');
  for (const [re, rep] of SYNONYMS) s = s.replace(re, rep);
  const tokens = s.split(/\s+/).filter(t => t && !FILLERS.has(t));
  return wordsToNumbers(tokens).join(' ').trim();
}

/** Every number mentioned in a sentence, including spelled-out ones. */
export function extractNumbers(text: string): number[] {
  const norm = wordsToNumbers(text.toLowerCase().replace(/,(?=\d{3})/g, '').replace(/[^a-z0-9. ]+/g, ' ').split(/\s+/).filter(Boolean));
  const out: number[] = [];
  for (const t of norm) {
    const m = t.match(/^\d+(?:\.\d+)?$/);
    if (m) out.push(Number(t));
  }
  return out;
}
