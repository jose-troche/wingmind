import type { Directive, SimSnapshot, SpeakItem } from '@wingmind/shared';

// REC: own state at 10 Hz plus every spoken alert and directive. Sorties are
// recorded in the prototype, not yet replayable (implementation 1).

export interface ReplayFile {
  version: 1;
  scenarioId: string;
  frames: number[][];            // [tMs, x, y, z, heading, pitch, roll, kcas, fuelLb, g]
  speak: { tMs: number; level: string; text: string; cls: string }[];
  directives: { tMs: number; axis: string; source: string; value: unknown; why: string[] }[];
}

export class Recorder {
  private frames: number[][] = [];
  private spoken: ReplayFile['speak'] = [];
  private dirs: ReplayFile['directives'] = [];
  private lastFrameMs = -Infinity;
  private tMs = 0;

  constructor(private scenarioId: string) {}

  frame(s: SimSnapshot): void {
    this.tMs = s.tMs;
    if (s.tMs - this.lastFrameMs < 100) return;
    this.lastFrameMs = s.tMs;
    const o = s.own;
    const r = (x: number, d = 1) => Math.round(x * d) / d;
    this.frames.push([s.tMs, r(o.pos[0]), r(o.pos[1]), r(o.pos[2]), r(o.headingDeg, 10), r(o.pitchDeg, 10), r(o.rollDeg, 10), r(o.kcas), r(o.fuelLb), r(o.g, 100)]);
  }

  speak(i: SpeakItem): void {
    this.spoken.push({ tMs: this.tMs, level: i.level, text: i.text, cls: i.cls });
  }

  directive(d: Directive): void {
    this.dirs.push({ tMs: this.tMs, axis: d.axis, source: d.source, value: d.value, why: d.why });
  }

  export(): ReplayFile {
    return { version: 1, scenarioId: this.scenarioId, frames: this.frames, speak: this.spoken, directives: this.dirs };
  }
}
