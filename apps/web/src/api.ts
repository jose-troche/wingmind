import type { CompactContext } from '@wingmind/shared';

// Thin client for the edge routes (implementation 7.1).

export async function startSession(scenarioId: string, turnstileToken?: string): Promise<string | null> {
  try {
    const r = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ scenarioId, ...(turnstileToken ? { turnstileToken } : {}) }),
    });
    if (!r.ok) return null;
    return ((await r.json()) as { sessionId: string }).sessionId;
  } catch {
    return null;
  }
}

export interface BudgetStatus { used: number; ceiling: number; remaining: number; mode: 'full' | 'templates' | 'offline' }

export async function budget(): Promise<BudgetStatus | null> {
  try {
    const r = await fetch('/api/budget');
    return r.ok ? ((await r.json()) as BudgetStatus) : null;
  } catch {
    return null;
  }
}

export async function summary(ctx: CompactContext, session: string): Promise<{ status: number; say?: string }> {
  try {
    const r = await fetch('/api/nl/summary', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ctx, session }) });
    if (!r.ok) return { status: r.status };
    const j = (await r.json()) as { say?: string };
    return { status: r.status, ...(j.say ? { say: j.say } : {}) };
  } catch {
    return { status: 0 };
  }
}

export async function stt(audio: Blob, seconds: number, session: string): Promise<string | null> {
  try {
    const r = await fetch(`/api/stt?session=${encodeURIComponent(session)}&seconds=${seconds.toFixed(1)}`, {
      method: 'POST', headers: { 'content-type': audio.type || 'audio/webm' }, body: audio,
    });
    if (!r.ok) return null;
    return ((await r.json()) as { text?: string }).text ?? null;
  } catch {
    return null;
  }
}

export interface SortieResult { id: string; debrief: string; personalBest: boolean; replayStored: boolean }

export async function saveSortie(meta: Record<string, unknown>, replay: Blob | null): Promise<SortieResult | null> {
  const form = new FormData();
  form.append('meta', JSON.stringify(meta));
  if (replay) form.append('replay', replay, 'replay.json.gz');
  try {
    const r = await fetch('/api/sortie', { method: 'POST', body: form });
    return r.ok ? ((await r.json()) as SortieResult) : null;
  } catch {
    return null;
  }
}

/** Gzip a JSON value in the browser (CompressionStream), for the replay upload. */
export async function gzipJson(value: unknown): Promise<Blob | null> {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([JSON.stringify(value)]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Response(stream).blob();
}

/** Anonymous player id kept in the browser (no accounts). */
export function playerId(): string {
  try {
    let id = localStorage.getItem('wingmind.player');
    if (!id) { id = `p-${crypto.randomUUID()}`; localStorage.setItem('wingmind.player', id); }
    return id;
  } catch {
    return 'p-anonymous';
  }
}
