import type { RenderFrame } from '@wingmind/shared';

// Optional read-only observer (implementation 7.4): the pilot's client pushes a
// compact state frame at 2 Hz over the session's WebSocket; observers receive it.

export interface ObserverFrame { t: number; x: number; y: number; alt: number; hdg: number; kcas: number; threats: { cls: string; brg: number; nm: number }[] }

const wsUrl = (sessionId: string, role: 'pilot' | 'observer') =>
  `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/session/${encodeURIComponent(sessionId)}/observe?role=${role}`;

export class PilotShare {
  private ws: WebSocket | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;

  start(sessionId: string, frame: () => RenderFrame | null, threats: () => ObserverFrame['threats']): string {
    this.stop();
    this.ws = new WebSocket(wsUrl(sessionId, 'pilot'));
    this.timer = setInterval(() => {
      const f = frame();
      if (!f || this.ws?.readyState !== WebSocket.OPEN) return;
      const msg: ObserverFrame = { t: f.tMs, x: Math.round(f.own.pos[0]), y: Math.round(f.own.pos[1]), alt: Math.round(f.own.altFt), hdg: Math.round(f.own.headingDeg), kcas: Math.round(f.own.kcas), threats: threats() };
      this.ws.send(JSON.stringify(msg));
    }, 500);
    return `${location.origin}/?observe=${encodeURIComponent(sessionId)}`;
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.ws?.close();
    this.ws = null;
    this.timer = null;
  }
}

export function observe(sessionId: string, onFrame: (f: ObserverFrame) => void, onState: (s: string) => void): () => void {
  const ws = new WebSocket(wsUrl(sessionId, 'observer'));
  ws.onopen = () => onState('connected');
  ws.onclose = () => onState('closed');
  ws.onerror = () => onState('error');
  ws.onmessage = e => { try { onFrame(JSON.parse(String(e.data)) as ObserverFrame); } catch { /* ignore */ } };
  return () => ws.close();
}
