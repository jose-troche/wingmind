// Pre-synthesized voice fragments (implementation 6.1). tools/gen-voice.ts packs
// every MP3 clip into one file plus a manifest of byte ranges, so the console
// loads the library in two requests and decodes each clip once at start.

export interface ClipManifest { version: 1; clips: Record<string, [number, number]> }

export class ClipLibrary {
  readonly buffers = new Map<string, AudioBuffer>();
  ready = false;

  get keys(): ReadonlySet<string> {
    return new Set(this.buffers.keys());
  }

  async load(ctx: BaseAudioContext, base = '/voice'): Promise<void> {
    try {
      const mres = await fetch(`${base}/clips.json`);
      if (!mres.ok) return;
      const manifest = (await mres.json()) as ClipManifest;
      const bres = await fetch(`${base}/clips.bin`);
      if (!bres.ok) return;
      const bin = await bres.arrayBuffer();
      await Promise.all(Object.entries(manifest.clips).map(async ([key, [off, len]]) => {
        try {
          this.buffers.set(key, await ctx.decodeAudioData(bin.slice(off, off + len)));
        } catch {
          // a clip that fails to decode falls back to speech synthesis for its phrases
        }
      }));
      this.ready = this.buffers.size > 0;
    } catch {
      this.ready = false;
    }
  }
}
