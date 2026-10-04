import { test as base, expect, type Page } from '@playwright/test';

// Shared fixture (implementation 10.4): drive the console through window.__sky.

type InjectEvent = Record<string, unknown> & { type: string };

export interface Sky {
  start(scenario: string, seed?: number, path?: string): Promise<void>;
  step(frames: number): Promise<void>;
  inject(event: InjectEvent): Promise<void>;
  say(text: string, interim?: boolean): Promise<void>;
  metrics(): Promise<{ alertLatencyMs: number[]; directives: { axis: string; value: unknown; why: string[]; source: string }[]; spoken: { text: string; level: string }[]; fps: number[] }>;
  state(): Promise<{ own: { headingDeg: number; kcas: number; altFt: number; engines: Record<string, number | string>[] }; fuel: { totalLb: number } } | null>;
  resume(): Promise<void>;
}

interface SkyHooks {
  loadScenario(id: string, seed?: number): Promise<void>;
  pause(): Promise<void>;
  step(frames: number): Promise<void>;
  inject(event: unknown): Promise<void>;
  transcript(text: string, opts: { interim: boolean }): Promise<void>;
  metrics(): unknown;
  state(): unknown;
}

declare global {
  interface Window { __sky: SkyHooks }
}

export const test = base.extend<{ sky: Sky }>({
  sky: async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', e => errors.push(e.message));
    await use({
      start: async (scenario, seed = 42, path = '/') => {
        await page.goto(path);
        await page.getByRole('button', { name: 'Start sortie' }).click();
        await page.waitForFunction(() => typeof window.__sky !== 'undefined');
        await page.evaluate(([s, n]) => window.__sky.loadScenario(s, n), [scenario, seed] as const);
        await page.evaluate(() => window.__sky.pause());
      },
      step: frames => page.evaluate(f => window.__sky.step(f), frames),
      inject: event => page.evaluate(e => window.__sky.inject(e), event),
      say: (text, interim = false) => page.evaluate(([t, i]) => window.__sky.transcript(t, { interim: i }), [text, interim] as const),
      metrics: () => page.evaluate(() => window.__sky.metrics()) as ReturnType<Sky['metrics']>,
      state: () => page.evaluate(() => window.__sky.state()) as ReturnType<Sky['state']>,
      resume: async () => { await page.getByRole('button', { name: 'Resume' }).click(); },
    });
    expect(errors, 'no uncaught page errors').toEqual([]);
  },
});

export { expect };
export type { Page };
