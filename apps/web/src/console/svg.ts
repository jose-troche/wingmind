// Tiny helpers for instruments drawn as SVG in the requestAnimationFrame loop:
// elements are created once and only their attributes change per frame.

export const SVG_NS = 'http://www.w3.org/2000/svg';

export function el<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, parent?: Element): SVGElementTagNameMap[K] {
  const e = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  parent?.appendChild(e);
  return e;
}

export function setText(e: Element, text: string): void {
  if (e.textContent !== text) e.textContent = text;
}

export function setAttr(e: Element, name: string, value: string | number): void {
  const v = String(value);
  if (e.getAttribute(name) !== v) e.setAttribute(name, v);
}

/** Colorblind-safe cockpit palette: shape and label always carry meaning too. */
export const COLORS = {
  normal: '#5ee0a0',
  advisory: '#4fc3f7',
  caution: '#ffb000',
  warning: '#ff4d6d',
  dim: '#2d4a3e',
  text: '#d8f3e6',
  hostile: '#ff6b81',
  unknown: '#ffd166',
  friend: '#4fc3f7',
} as const;

export const band = (v: number, caution: number, warning: number, invert = false): string => {
  const c = invert ? v < caution : v > caution;
  const w = invert ? v < warning : v > warning;
  return w ? COLORS.warning : c ? COLORS.caution : COLORS.normal;
};
