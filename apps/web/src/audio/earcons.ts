import type { AlertClass, Level } from '@wingmind/shared';

// Earcons (spec 9.5): missile fast warble, SAM pulse, terrain low whoop, fire
// bell, caution chime. Synthesized into AudioBuffers at start so playback is a
// single buffer start, with no decode on the alert path.

export type EarconKind = 'missile' | 'sam' | 'terrain' | 'fire' | 'chime';

export function earconFor(cls: AlertClass, level: Level): EarconKind | null {
  if (cls === 'radar_missile' || cls === 'ir_missile') return 'missile';
  if (cls === 'sam_track') return 'sam';
  if (cls === 'pull_up' || cls === 'obstacle') return 'terrain';
  if (cls === 'engine_fire') return 'fire';
  if (level === 'WARNING' || level === 'CAUTION') return 'chime';
  return null;
}

export function synthEarcons(ctx: BaseAudioContext): Record<EarconKind, AudioBuffer> {
  const sr = ctx.sampleRate;
  const make = (seconds: number, fn: (t: number) => number): AudioBuffer => {
    const n = Math.floor(seconds * sr);
    const buf = ctx.createBuffer(1, n, sr);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) {
      const t = i / sr;
      const env = Math.min(1, t / 0.005) * Math.min(1, (seconds - t) / 0.02);
      d[i] = fn(t) * env * 0.5;
    }
    return buf;
  };
  return {
    missile: make(0.45, t => Math.sin(2 * Math.PI * (t < 0 ? 0 : (900 + 500 * Math.sign(Math.sin(2 * Math.PI * 16 * t))) * t))),
    sam: make(0.5, t => (Math.floor(t * 8) % 2 === 0 ? Math.sin(2 * Math.PI * 660 * t) : 0)),
    terrain: make(0.6, t => Math.sin(2 * Math.PI * (220 + 300 * t) * t)),
    fire: make(0.7, t => Math.sin(2 * Math.PI * 1200 * t) * Math.exp(-((t * 8) % 1) * 4)),
    chime: make(0.35, t => Math.sin(2 * Math.PI * 880 * t) * Math.exp(-t * 6) + 0.5 * Math.sin(2 * Math.PI * 1320 * t) * Math.exp(-t * 8)),
  };
}
