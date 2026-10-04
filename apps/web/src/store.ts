import { useSyncExternalStore } from 'react';
import type { LogEntry } from '@wingmind/agents';
import type { AlertLogStatus, BoardSummary, Directive, Level, SortieOutcome, Verbosity } from '@wingmind/shared';

// Event-rate UI state for React (alerts, captions, panels). Per-frame values
// never pass through here: instruments read the latest snapshot directly.

export interface LogRow { id: string; alertId: string; level: Level; text: string; status: AlertLogStatus; t: number; cls: string }
export interface TranscriptRow { id: number; who: 'pilot' | 'wingmind'; text: string; interim: boolean }
export interface DebriefState { outcome: SortieOutcome; durationS: number; metrics: Record<string, number | string | null>; text: string | null; saved: boolean; personalBest: boolean; error?: string }

export interface UiState {
  screen: 'start' | 'console';
  scenarios: { id: string; title: string; ladder: number }[];
  scenarioId: string;
  caption: string;
  captionLevel: Level | null;
  masterWarning: boolean;
  masterCaution: boolean;
  log: LogRow[];
  board: BoardSummary | null;
  lastDirective: Directive | null;
  llm: 'online' | 'templates' | 'offline' | 'unknown';
  verbosity: Verbosity;
  paused: boolean;
  transcript: TranscriptRow[];
  explain: string | null;
  debrief: DebriefState | null;
  sessionId: string;
  mfdTab: 'tsd' | 'rwr' | 'engine' | 'fuel';
  remapOpen: boolean;
  tsdRangeNm: number;
  showRings: boolean;
  checklist: string | null;
  listening: boolean;
  isolated: boolean;
  lastAlertCls: string | null;
}

type Listener = () => void;

export function createStore<T extends object>(initial: T) {
  let state = initial;
  const listeners = new Set<Listener>();
  return {
    get: () => state,
    set(patch: Partial<T> | ((s: T) => Partial<T>)) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...p };
      for (const l of listeners) l();
    },
    subscribe(l: Listener) {
      listeners.add(l);
      return () => listeners.delete(l);
    },
  };
}

export const ui = createStore<UiState>({
  screen: 'start',
  scenarios: [],
  scenarioId: 'fam-01',
  caption: '',
  captionLevel: null,
  masterWarning: false,
  masterCaution: false,
  log: [],
  board: null,
  lastDirective: null,
  llm: 'unknown',
  verbosity: 'standard',
  paused: false,
  transcript: [],
  explain: null,
  debrief: null,
  sessionId: 'local',
  mfdTab: 'tsd',
  remapOpen: false,
  tsdRangeNm: 40,
  showRings: true,
  checklist: null,
  listening: false,
  isolated: false,
  lastAlertCls: null,
});

export function useUi<S>(selector: (s: UiState) => S): S {
  return useSyncExternalStore(ui.subscribe, () => selector(ui.get()), () => selector(ui.get()));
}

let rowSeq = 0;
export function logRow(e: Omit<LogRow, 'id'>): string {
  const id = `row${++rowSeq}`;
  ui.set(s => ({ log: [{ ...e, id }, ...s.log].slice(0, 80) }));
  return id;
}

export function setRowStatus(id: string, status: AlertLogStatus): void {
  ui.set(s => ({ log: s.log.map(r => (r.id === id ? { ...r, status } : r)) }));
}

export function pushLogEntry(e: LogEntry): void {
  logRow({ alertId: e.alertId, level: e.level, text: e.text, status: e.status, t: e.tMs, cls: e.cls });
}

let tSeq = 0;
export function pushTranscript(who: TranscriptRow['who'], text: string, interim = false): void {
  ui.set(s => {
    const rows = interim && s.transcript[0]?.interim ? s.transcript.slice(1) : s.transcript;
    return { transcript: [{ id: ++tSeq, who, text, interim }, ...rows].slice(0, 30) };
  });
}
