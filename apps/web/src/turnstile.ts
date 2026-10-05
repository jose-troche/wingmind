// Turnstile on session start (implementation 7.1). The widget lives outside React
// so a token survives the switch from the start screen to the console, and it is
// reset lazily when the next sortie needs a fresh one (tokens are single use).
// Play never waits on it: the session only gates the LLM routes.

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id: string): void;
}

declare global {
  interface Window { turnstile?: TurnstileApi; onTurnstileLoad?: () => void }
}

const SITEKEY: string | undefined = import.meta.env.VITE_TURNSTILE_SITEKEY;
const enabled = (): boolean => Boolean(SITEKEY) && !__TEST_HOOKS__;

let widgetId: string | null = null;
let token: string | null = null;
let consumed = false;
let waiters: ((t: string) => void)[] = [];

export function initTurnstile(): void {
  if (!enabled() || window.onTurnstileLoad) return;
  const host = document.createElement('div');
  host.className = 'turnstile';
  host.setAttribute('data-testid', 'turnstile');
  document.body.appendChild(host);
  window.onTurnstileLoad = () => {
    widgetId = window.turnstile?.render(host, {
      sitekey: SITEKEY,
      action: 'turnstile-spin-v1',
      appearance: 'interaction-only',               // shows itself only when a click is needed
      callback: (t: string) => {
        token = t;
        for (const w of waiters.splice(0)) w(t);
      },
      'expired-callback': () => { token = null; },
      'error-callback': () => { token = null; },
    }) ?? null;
  };
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?onload=onTurnstileLoad&render=explicit';
  s.async = true;
  document.head.appendChild(s);
}

/** A fresh token for one session start, or undefined when Turnstile is off or does not answer in time. */
export function takeToken(timeoutMs = 20_000): Promise<string | undefined> {
  if (!enabled()) return Promise.resolve(undefined);
  const use = (t: string): string => { token = null; consumed = true; return t; };
  if (token) return Promise.resolve(use(token));
  if (consumed && widgetId !== null) { consumed = false; window.turnstile?.reset(widgetId); }
  return new Promise(resolve => {
    const w = (t: string) => { clearTimeout(timer); resolve(use(t)); };
    const timer = setTimeout(() => { waiters = waiters.filter(x => x !== w); resolve(undefined); }, timeoutMs);
    waiters.push(w);
  });
}
