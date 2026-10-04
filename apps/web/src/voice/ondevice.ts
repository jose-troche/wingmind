import type { CompactContext } from '@wingmind/shared';

// Tier 0: the browser's on-device model (Chrome built-in AI) when present.
// Costs nothing; its output goes through the same validation as Tier 1.

interface LanguageModelSession { prompt(input: string, opts?: { responseConstraint?: unknown }): Promise<string>; destroy(): void }
interface LanguageModelApi {
  availability(): Promise<'unavailable' | 'downloadable' | 'downloading' | 'available'>;
  create(opts: { initialPrompts: { role: 'system'; content: string }[] }): Promise<LanguageModelSession>;
}

const api = (): LanguageModelApi | null => (globalThis as unknown as { LanguageModel?: LanguageModelApi }).LanguageModel ?? null;

let session: LanguageModelSession | null = null;
let disabled = false;

export const onDevice = {
  async available(): Promise<boolean> {
    if (disabled) return false;
    const lm = api();
    if (!lm) return false;
    try {
      return (await lm.availability()) === 'available';
    } catch {
      return false;
    }
  },
  async intent(utter: string, ctx: CompactContext, system: string, schema: unknown): Promise<unknown> {
    const lm = api();
    if (!lm) return null;
    try {
      session ??= await lm.create({ initialPrompts: [{ role: 'system', content: system }] });
      const out = await session.prompt(`Context: ${JSON.stringify({ own: ctx.own, threats: ctx.threats, route: ctx.route, home: ctx.home })}\nPilot said: "${utter}"`, { responseConstraint: schema });
      return JSON.parse(out) as unknown;
    } catch {
      return null;
    }
  },
  disable(): void {
    disabled = true;
  },
};
