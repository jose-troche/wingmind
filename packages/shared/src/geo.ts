import { NM, wrap180, wrap360 } from './math';

const CLOCK_WORDS = ['twelve', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven'];

/** Clock hour (1..12) for a bearing relative to the nose. */
export function clockHour(relDeg: number): number {
  const h = Math.round(wrap360(relDeg) / 30) % 12;
  return h === 0 ? 12 : h;
}

/**
 * Spoken clock position relative to the nose, as in spec section 9.2:
 * "nose" for twelve, "left eight" / "right four" on the sides, "six" for the tail.
 */
export function clockPhrase(relDeg: number, style: 'tactical' | 'oclock' = 'tactical'): string {
  const h = clockHour(relDeg);
  const word = CLOCK_WORDS[h % 12]!;
  if (style === 'oclock') return `${word} o'clock`;
  if (h === 12) return 'nose';
  if (h === 6) return 'six';
  return `${h < 6 ? 'right' : 'left'} ${word}`;
}

export const relBearing = (absBearingDeg: number, headingDeg: number): number => wrap180(absBearingDeg - headingDeg);

const ONES = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten',
  'eleven', 'twelve', 'thirteen', 'fourteen', 'fifteen', 'sixteen', 'seventeen', 'eighteen', 'nineteen'];
const TENS = ['', '', 'twenty', 'thirty', 'forty', 'fifty', 'sixty', 'seventy', 'eighty', 'ninety'];

/** Plain English for a non-negative integer, e.g. 120 -> "one hundred twenty". */
export function spellNumber(n: number): string {
  n = Math.round(Math.abs(n));
  if (n < 20) return ONES[n]!;
  if (n < 100) return TENS[Math.floor(n / 10)]! + (n % 10 ? ` ${ONES[n % 10]}` : '');
  if (n < 1000) return `${ONES[Math.floor(n / 100)]} hundred` + (n % 100 ? ` ${spellNumber(n % 100)}` : '');
  if (n < 1_000_000) return `${spellNumber(Math.floor(n / 1000))} thousand` + (n % 1000 ? ` ${spellNumber(n % 1000)}` : '');
  return String(n);
}

const DIGITS = ['zero', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'niner'];

/** Digit-by-digit as pilots read headings: "270" -> "two seven zero". */
export function spellDigits(s: string | number): string {
  return String(s)
    .split('')
    .filter(c => c >= '0' && c <= '9')
    .map(c => (c === '9' ? 'nine' : DIGITS[+c]!))
    .join(' ');
}

/** A heading as three digits, spelled. */
export const spellHeading = (deg: number): string => spellDigits(String(Math.round(wrap360(deg)) || 360).padStart(3, '0'));

/** Range in nautical miles as spoken: "six miles", "close" under one mile. */
export function rangePhrase(rangeM: number): string {
  const nm = rangeM / NM;
  if (nm < 1) return 'close';
  const r = Math.round(nm);
  return `${spellNumber(r)} ${r === 1 ? 'mile' : 'miles'}`;
}

export function altitudeBand(altFt: number, ownAltFt: number): string {
  if (altFt < 3000) return 'low';
  if (altFt > ownAltFt + 5000) return 'high';
  return `angels ${spellNumber(Math.round(altFt / 1000))}`;
}

export const capitalize = (s: string): string => (s ? s[0]!.toUpperCase() + s.slice(1) : s);
