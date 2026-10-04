import { clamp } from '@wingmind/shared';
import { client, keyboardIntent, notePilotInput, ptt, setPaused } from '../controller';
import { ui } from '../store';

// Keyboard and Gamepad API for stick, throttle and push-to-talk, with a remap
// screen (implementation 8.4). Every defensive command has a key.

export type Action = 'pitchUp' | 'pitchDown' | 'rollLeft' | 'rollRight' | 'throttleUp' | 'throttleDown'
  | 'chaff' | 'flares' | 'emcon' | 'ack' | 'ptt' | 'pause';

export const ACTION_LABELS: Record<Action, string> = {
  pitchUp: 'Nose down (push)', pitchDown: 'Nose up (pull)', rollLeft: 'Roll left', rollRight: 'Roll right',
  throttleUp: 'Throttle up', throttleDown: 'Throttle down', chaff: 'Chaff', flares: 'Flares',
  emcon: 'Cycle emissions control', ack: 'Acknowledge (copy)', ptt: 'Push to talk', pause: 'Pause',
};

export const DEFAULT_BINDINGS: Record<Action, string> = {
  pitchUp: 'ArrowUp', pitchDown: 'ArrowDown', rollLeft: 'ArrowLeft', rollRight: 'ArrowRight',
  throttleUp: 'Equal', throttleDown: 'Minus', chaff: 'KeyC', flares: 'KeyF', emcon: 'KeyE', ack: 'KeyK', ptt: 'Space', pause: 'KeyP',
};

export function loadBindings(): Record<Action, string> {
  try {
    const raw = localStorage.getItem('wingmind.bindings');
    if (raw) return { ...DEFAULT_BINDINGS, ...(JSON.parse(raw) as Partial<Record<Action, string>>) };
  } catch { /* storage unavailable */ }
  return { ...DEFAULT_BINDINGS };
}

export function saveBindings(b: Record<Action, string>): void {
  try { localStorage.setItem('wingmind.bindings', JSON.stringify(b)); } catch { /* storage unavailable */ }
}

export class InputManager {
  bindings = loadBindings();
  private held = new Set<string>();
  private throttle: number | null = null;
  private last = { pitch: 0, roll: 0, throttle: null as number | null };
  private padButtons: boolean[] = [];
  private onKeyDown = (e: KeyboardEvent) => this.key(e, true);
  private onKeyUp = (e: KeyboardEvent) => this.key(e, false);

  attach(): void {
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('keyup', this.onKeyUp);
  }

  detach(): void {
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('keyup', this.onKeyUp);
  }

  private action(code: string): Action | null {
    for (const [a, c] of Object.entries(this.bindings) as [Action, string][]) if (c === code) return a;
    return null;
  }

  private key(e: KeyboardEvent, down: boolean): void {
    const t = e.target as HTMLElement | null;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
    if (ui.get().remapOpen || ui.get().screen !== 'console') return;
    const a = this.action(e.code);
    if (!a) return;
    e.preventDefault();
    if (down && this.held.has(e.code)) return;            // key repeat
    if (down) this.held.add(e.code); else this.held.delete(e.code);
    if (!down) { if (a === 'ptt') ptt.up(); return; }
    switch (a) {
      case 'ptt': void ptt.down(); break;
      case 'chaff': keyboardIntent('ew.dispense', { kind: 'chaff' }); break;
      case 'flares': keyboardIntent('ew.dispense', { kind: 'flare' }); break;
      case 'emcon': {
        const cur = client.frame()?.own.emcon ?? 0;
        keyboardIntent('sig.setEmcon', { level: (cur + 1) % 4 });
        break;
      }
      case 'ack': keyboardIntent('pia.ack'); break;
      case 'pause': setPaused(!ui.get().paused); break;
      default: break;
    }
  }

  /** Poll keys and gamepad once per animation frame; send controls only when they change. */
  poll(): void {
    const b = this.bindings;
    let pitch = (this.held.has(b.pitchDown) ? 1 : 0) - (this.held.has(b.pitchUp) ? 1 : 0);
    let roll = (this.held.has(b.rollRight) ? 1 : 0) - (this.held.has(b.rollLeft) ? 1 : 0);
    if (this.held.has(b.throttleUp) || this.held.has(b.throttleDown)) {
      const cur = this.throttle ?? client.frame()?.own.throttle ?? 0.6;
      this.throttle = clamp(cur + (this.held.has(b.throttleUp) ? 0.01 : -0.01), 0, 1);
    }
    const pads = typeof navigator.getGamepads === 'function' ? navigator.getGamepads() : [];
    const pad = pads && [...pads].find(p => p && p.connected);
    if (pad) {
      const dz = (v: number) => (Math.abs(v) < 0.08 ? 0 : v);
      roll = roll || dz(pad.axes[0] ?? 0);
      pitch = pitch || dz(pad.axes[1] ?? 0);                 // stick back (positive) pulls
      const thr = pad.axes[3] ?? pad.axes[2];
      if (thr !== undefined && Math.abs(thr) > 0.02) this.throttle = clamp((1 - thr) / 2, 0, 1);
      const buttons = pad.buttons.map(x => x.pressed);
      const edge = (i: number) => buttons[i] && !this.padButtons[i];
      if (edge(0)) void ptt.down();
      if (!buttons[0] && this.padButtons[0]) ptt.up();
      if (edge(1)) keyboardIntent('ew.dispense', { kind: 'chaff' });
      if (edge(2)) keyboardIntent('ew.dispense', { kind: 'flare' });
      if (edge(3)) keyboardIntent('pia.ack');
      this.padButtons = buttons;
    }
    const changed = pitch !== this.last.pitch || roll !== this.last.roll || this.throttle !== this.last.throttle;
    if (changed) {
      if (Math.abs(pitch) > 0.3 || Math.abs(roll) > 0.3) notePilotInput();
      client.controls({ pitch, roll, ...(this.throttle !== this.last.throttle ? { throttle: this.throttle } : {}) });
      this.last = { pitch, roll, throttle: this.throttle };
    }
  }
}
