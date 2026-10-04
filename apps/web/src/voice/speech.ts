// Speech input (implementation 6.2): push-to-talk opens the browser's
// SpeechRecognition with interim results; without it, MediaRecorder captures the
// clip for the /api/stt Whisper fallback.

interface RecognitionResultLike { isFinal: boolean; 0: { transcript: string; confidence: number } }
interface RecognitionEventLike { resultIndex: number; results: ArrayLike<RecognitionResultLike> }
interface RecognitionLike {
  continuous: boolean; interimResults: boolean; lang: string;
  onresult: ((e: RecognitionEventLike) => void) | null;
  onerror: ((e: unknown) => void) | null;
  onend: (() => void) | null;
  start(): void; stop(): void; abort(): void;
}

export interface SpeechHandlers {
  transcript(text: string, interim: boolean, confidence: number): void;
  audio(blob: Blob, seconds: number): void;
  state(listening: boolean): void;
}

export type SpeechMode = 'browser' | 'server';

export function preferredMode(): SpeechMode {
  const forced = new URLSearchParams(location.search).get('stt');
  if (forced === 'server') return 'server';
  const w = window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown };
  return w.SpeechRecognition || w.webkitSpeechRecognition ? 'browser' : 'server';
}

export class PushToTalk {
  private rec: RecognitionLike | null = null;
  private media: MediaRecorder | null = null;
  private chunks: Blob[] = [];
  private startedAt = 0;
  private stream: MediaStream | null = null;
  listening = false;

  constructor(private h: SpeechHandlers, readonly mode: SpeechMode = preferredMode()) {}

  async down(): Promise<void> {
    if (this.listening) return;
    this.listening = true;
    this.h.state(true);
    if (this.mode === 'browser') {
      const w = window as unknown as { SpeechRecognition?: new () => RecognitionLike; webkitSpeechRecognition?: new () => RecognitionLike };
      const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
      if (!Ctor) return;
      const rec = new Ctor();
      rec.continuous = true;
      rec.interimResults = true;                 // early fire on "chaff" and "flares"
      rec.lang = 'en-US';
      rec.onresult = e => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const r = e.results[i]!;
          this.h.transcript(r[0].transcript, !r.isFinal, r[0].confidence || 0.9);
        }
      };
      rec.onerror = () => undefined;
      rec.onend = () => { if (this.listening) this.up(); };
      this.rec = rec;
      try { rec.start(); } catch { /* already started */ }
      return;
    }
    try {
      this.stream ??= await navigator.mediaDevices.getUserMedia({ audio: true });
      const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : '';
      this.media = new MediaRecorder(this.stream, mime ? { mimeType: mime } : undefined);
      this.chunks = [];
      this.media.ondataavailable = ev => { if (ev.data.size) this.chunks.push(ev.data); };
      this.media.onstop = () => {
        const seconds = Math.min(8, (performance.now() - this.startedAt) / 1000);
        const blob = new Blob(this.chunks, { type: this.media?.mimeType || 'audio/webm' });
        if (blob.size > 0) this.h.audio(blob, seconds);
      };
      this.startedAt = performance.now();
      this.media.start(250);
      // clips are capped at 8 s (implementation 7.1)
      setTimeout(() => { if (this.media?.state === 'recording') this.up(); }, 8000);
    } catch {
      this.listening = false;
      this.h.state(false);
    }
  }

  up(): void {
    if (!this.listening) return;
    this.listening = false;
    this.h.state(false);
    try { this.rec?.stop(); } catch { /* not running */ }
    this.rec = null;
    if (this.media?.state === 'recording') this.media.stop();
  }
}
