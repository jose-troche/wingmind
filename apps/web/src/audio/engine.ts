import { phraseToClips } from '@wingmind/nl';
import type { Level, SpeakItem } from '@wingmind/shared';
import { logRow, setRowStatus, ui } from '../store';
import { ClipLibrary } from './clips';
import { earconFor, synthEarcons, type EarconKind } from './earcons';

// The audio side of PIA (implementation 6.1, spec 9.1/9.4/9.5). Items queue by
// level; a WARNING cuts current speech at the next clip boundary and the cut
// item is re-queued. Earcons play through an HRTF panner at the threat's
// relative bearing; the voice stays centred. Every phrase is also captioned.

const RANK: Record<Level, number> = { WARNING: 0, CAUTION: 1, STATUS: 2, ADVISORY: 3 };
const CLIP_GAP_S = 0.03;

interface Active {
  item: SpeakItem;
  rowId: string;
  sources: AudioScheduledSourceNode[];
  clipEnds: number[];          // context times at which each clip ends (cut points)
  endAt: number;               // wall ms when the phrase finishes
  timer: ReturnType<typeof setTimeout>;
  utterance: SpeechSynthesisUtterance | null;
}

interface Queued { item: SpeakItem; rowId: string }

export class AlertEngine {
  ctx: AudioContext | null = null;
  private earcons: Record<EarconKind, AudioBuffer> | null = null;
  readonly clips = new ClipLibrary();
  private queue: Queued[] = [];
  private active: Active | null = null;
  readonly latencies: number[] = [];
  readonly spoken: { text: string; level: Level; at: number }[] = [];
  muted = false;
  private voiceGain: GainNode | null = null;

  /** Create the AudioContext on the "Start sortie" click (autoplay rules, implementation 8.4). */
  async start(): Promise<void> {
    if (this.ctx) { await this.ctx.resume().catch(() => undefined); return; }
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    this.ctx = new Ctx({ latencyHint: 'interactive' });
    await this.ctx.resume().catch(() => undefined);
    this.earcons = synthEarcons(this.ctx);
    this.voiceGain = this.ctx.createGain();
    this.voiceGain.connect(this.ctx.destination);
    void this.clips.load(this.ctx);
  }

  reset(): void {
    this.queue = [];
    if (this.active) this.stopActive();
    this.active = null;
    this.latencies.length = 0;
    this.spoken.length = 0;
  }

  enqueue(items: SpeakItem[]): void {
    for (const item of items) {
      const rowId = logRow({ alertId: item.alertId, level: item.level, text: item.text, status: 'queued', t: Date.now(), cls: item.cls });
      if (item.level === 'WARNING') ui.set({ masterWarning: true });
      if (item.level === 'CAUTION') ui.set({ masterCaution: true });
      if (item.level !== 'STATUS' && item.cls !== 'readback') ui.set({ lastAlertCls: item.cls });
      // a newer read-back replaces any queued one
      if (item.level === 'STATUS') this.queue = this.queue.filter(q => q.item.level !== 'STATUS');
      this.queue.push({ item, rowId });
      this.queue.sort((a, b) => RANK[a.item.level] - RANK[b.item.level]);
      this.maybePreempt(item);
    }
    this.pump();
  }

  /** A WARNING preempts anything below it; a newer STATUS replaces an older one. */
  private maybePreempt(item: SpeakItem): void {
    const a = this.active;
    if (!a) return;
    const cut = (item.level === 'WARNING' && a.item.level !== 'WARNING') ||
      (item.level === 'WARNING' && a.item.level === 'WARNING' && item.repeat === 0 && a.item.repeat > 0) ||
      (item.level === 'STATUS' && a.item.level === 'STATUS');
    if (!cut) return;
    const requeue = a.item.level === 'ADVISORY' || a.item.level === 'CAUTION';
    this.stopActive(true);
    if (requeue) {
      setRowStatus(a.rowId, 'requeued');
      this.queue.push({ item: a.item, rowId: a.rowId });
      this.queue.sort((x, y) => RANK[x.item.level] - RANK[y.item.level]);
    } else {
      setRowStatus(a.rowId, 'spoken');
    }
  }

  private stopActive(atBoundary = false): void {
    const a = this.active;
    if (!a) return;
    clearTimeout(a.timer);
    const ctx = this.ctx;
    if (ctx && atBoundary) {
      // let the clip in progress finish, cancel the rest (cut at a word boundary)
      const now = ctx.currentTime;
      const boundary = a.clipEnds.find(t => t > now) ?? now;
      a.sources.forEach((s, i) => { if ((a.clipEnds[i] ?? 0) > boundary + 1e-3) { try { s.stop(); } catch { /* not started */ } } });
    } else {
      a.sources.forEach(s => { try { s.stop(); } catch { /* already stopped */ } });
    }
    if (a.utterance && typeof speechSynthesis !== 'undefined') speechSynthesis.cancel();
    this.active = null;
  }

  private pump(): void {
    if (this.active || this.queue.length === 0) return;
    const next = this.queue.shift()!;
    this.play(next);
  }

  private wallFromContextTime(t: number): number {
    const ctx = this.ctx!;
    const ts = ctx.getOutputTimestamp?.();
    if (ts && ts.contextTime !== undefined && ts.performanceTime && ts.performanceTime > 0) {
      return performance.timeOrigin + ts.performanceTime + (t - ts.contextTime) * 1000;
    }
    return performance.timeOrigin + performance.now() + (t - ctx.currentTime) * 1000;
  }

  private play({ item, rowId }: Queued): void {
    setRowStatus(rowId, 'speaking');
    ui.set({ caption: item.text, captionLevel: item.level });
    this.spoken.push({ text: item.text, level: item.level, at: Date.now() });
    const ctx = this.ctx;
    const sources: AudioScheduledSourceNode[] = [];
    const clipEnds: number[] = [];
    let durationS = 0;
    let utterance: SpeechSynthesisUtterance | null = null;

    if (ctx && this.earcons) {
      let t = ctx.currentTime + 0.005;
      const kind = earconFor(item.cls, item.level);
      if (kind) {
        const src = ctx.createBufferSource();
        src.buffer = this.earcons[kind];
        const panner = ctx.createPanner();
        panner.panningModel = 'HRTF';
        const b = ((item.bearingDeg ?? 0) * Math.PI) / 180;
        panner.positionX.value = Math.sin(b);
        panner.positionY.value = 0;
        panner.positionZ.value = -Math.cos(b);
        src.connect(panner).connect(ctx.destination);
        src.start(t);
        // latency: event stamp from the sim tick to the moment the first audio starts
        if (item.eventWallMs !== undefined) this.latencies.push(this.wallFromContextTime(t) - item.eventWallMs);
        sources.push(src);
        clipEnds.push(t + src.buffer.duration);
        t += src.buffer.duration + 0.02;
        durationS += src.buffer.duration + 0.02;
      } else if (item.eventWallMs !== undefined) {
        this.latencies.push(this.wallFromContextTime(t) - item.eventWallMs);
      }
      const plan = this.clips.ready ? phraseToClips(item.text, this.clips.keys) : null;
      if (plan && !this.muted) {
        for (const p of plan) {
          const buf = this.clips.buffers.get(p.key)!;
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(this.voiceGain!);
          src.start(t);
          sources.push(src);
          t += buf.duration;
          clipEnds.push(t);
          const gap = Math.max(CLIP_GAP_S, p.pauseAfterMs / 1000);
          t += gap;
          durationS += buf.duration + gap;
        }
      } else {
        durationS += estimateSpeechS(item.text);
        if (!this.muted && typeof speechSynthesis !== 'undefined' && speechSynthesis.getVoices().length > 0) {
          utterance = new SpeechSynthesisUtterance(item.text);
          utterance.rate = 1.15;
          speechSynthesis.speak(utterance);
        }
      }
    } else {
      if (item.eventWallMs !== undefined) this.latencies.push(performance.timeOrigin + performance.now() - item.eventWallMs);
      durationS = estimateSpeechS(item.text);
    }
    const timer = setTimeout(() => {
      if (this.active?.item.id !== item.id) return;
      setRowStatus(rowId, 'spoken');
      this.active = null;
      this.pump();
    }, durationS * 1000 + 60);
    this.active = { item, rowId, sources, clipEnds, endAt: Date.now() + durationS * 1000, timer, utterance };
  }

  /** "Copy" / acknowledge button: clear the master warning (PIA stops the repeats). */
  acknowledge(): void {
    ui.set({ masterWarning: false });
  }

  resetCaution(): void {
    ui.set({ masterCaution: false });
  }
}

/** Speaking time for a phrase without clips, for queueing and preemption. */
export const estimateSpeechS = (text: string): number => 0.4 + text.split(/\s+/).filter(Boolean).length * 0.38;
