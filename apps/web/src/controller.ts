import { numbersGrounded } from '@wingmind/nl';
import { percentile, type CompactContext, type Directive, type InjectEvent, type Intent, type RenderFrame, type Scenario, type SortieOutcome } from '@wingmind/shared';
import * as api from './api';
import { AlertEngine } from './audio/engine';
import { SimClient } from './sim-client';
import { pushLogEntry, pushTranscript, ui } from './store';
import { interpret, statusSummary } from './voice/interpret';
import { PushToTalk } from './voice/speech';

// The console controller: one place that owns the sim client, the audio engine,
// the voice pipeline, sortie metrics and (in test builds) window.__sky.

export const engine = new AlertEngine();
// test builds stay silent (latency is still stamped when audio is scheduled); ?sound=1 to listen
if (__TEST_HOOKS__ && new URLSearchParams(location.search).get('sound') !== '1') engine.muted = true;

interface SortieMetrics {
  directives: { axis: string; value: unknown; why: string[]; source: string; threatId?: string; tMs?: number }[];
  envelopeS: number;
  detectedS: number;
  reactionMs: number[];
  falseAlarms: number;
  missilesDefeated: number;
  alerts: number;
  startedAt: number;
  pendingReaction: number | null;
}

const fresh = (): SortieMetrics => ({
  directives: [], envelopeS: 0, detectedS: 0, reactionMs: [], falseAlarms: 0, missilesDefeated: 0, alerts: 0,
  startedAt: performance.now(), pendingReaction: null,
});

export let metrics = fresh();
let missilesAlive = 0;
let scenario: Scenario | null = null;
let budgetTimer: ReturnType<typeof setInterval> | null = null;
let ending = false;
const fpsSamples: number[] = [];

export const client = new SimClient({
  speak(items) {
    for (const it of items) {
      if (it.repeat === 0 && it.level !== 'STATUS') metrics.alerts++;
      if ((it.cls === 'radar_missile' || it.cls === 'ir_missile') && it.repeat === 0) {
        if (missilesAlive === 0) metrics.falseAlarms++;
        metrics.pendingReaction = performance.now();
      }
      if (it.cls === 'missile_defeated') metrics.missilesDefeated++;
    }
    engine.enqueue(items);
  },
  logs(entries) {
    entries.forEach(pushLogEntry);
  },
  directives(list) {
    for (const d of list) onDirective(d);
  },
  ui(intents) {
    for (const it of intents) onUiIntent(it);
  },
  board(b) {
    ui.set({ board: b });
    if (b.ranked.some(t => t.pEngage > 0.5 && t.class !== 'radar_missile' && t.class !== 'ir_missile')) metrics.envelopeS += 0.1;
    if (b.detection.some(d => d.pDetect > 0.5)) metrics.detectedS += 0.1;
  },
  outcome(o) {
    if (o === 'shot_down' || o === 'crashed') void endSortie(o);
  },
  simEvents(_events, truth) {
    missilesAlive = truth.missilesAlive;
  },
});

function onDirective(d: Directive): void {
  metrics.directives.push({ axis: d.axis, value: d.value, why: d.why, source: d.source, ...(d.threatId ? { threatId: d.threatId } : {}), ...(d.tMs !== undefined ? { tMs: d.tMs } : {}) });
  if (metrics.directives.length > 2000) metrics.directives.splice(0, 500);
  if (d.value === null) return;
  const mode = (d.value as Record<string, unknown>).mode;
  const cur = ui.get().lastDirective;
  // keep a recent decision on screen rather than flickering to routine steering cues
  if (mode === 'steer' && cur && (cur.value as Record<string, unknown> | null)?.mode !== 'steer' && Date.now() - lastDirectiveAt < 10_000) return;
  // the maneuver explains the alert: a same-moment EW or emitter decision does not replace it
  if (cur && FLIGHT_PATH.has(cur.axis) && !FLIGHT_PATH.has(d.axis) && Date.now() - lastDirectiveAt < 1000) return;
  lastDirectiveAt = Date.now();
  ui.set({ lastDirective: d });
}
let lastDirectiveAt = 0;
const FLIGHT_PATH = new Set<string>(['heading', 'altitude']);

const PAGES: Record<string, 'tsd' | 'rwr' | 'engine' | 'fuel'> = {
  engine: 'engine', systems: 'engine', fuel: 'fuel', tsd: 'tsd', situation: 'tsd', rwr: 'rwr', warning: 'rwr',
};
const CONCEPT_FOR_ALERT: Record<string, string> = {
  radar_missile: 'missile', ir_missile: 'missile', missile_defeated: 'missile', sam_track: 'masking', detection: 'polar',
  bandit: 'tsd', swarm: 'tsd', pull_up: 'hud', obstacle: 'hud', engine_fire: 'engine', engine_fault: 'engine',
  bingo: 'fuel', joker: 'fuel', weather: 'tsd', over_g: 'hud', aoa: 'hud', cm_low: 'rwr',
};

function onUiIntent(it: Intent): void {
  switch (it.intent) {
    case 'ui.show': {
      const page = String(it.params.page);
      if (PAGES[page]) ui.set({ mfdTab: PAGES[page] });
      else if (page === 'threat rings') ui.set({ showRings: true });
      else if (['polar', 'masking', 'mesh', 'trace'].includes(page)) ui.set({ explain: page });
      break;
    }
    case 'ui.zoom':
      ui.set({ tsdRangeNm: Math.min(160, Math.max(5, Number(it.params.rangeNm) || 40)) });
      break;
    case 'ui.explain': {
      const cls = ui.get().lastAlertCls;
      ui.set({ explain: (cls && CONCEPT_FOR_ALERT[cls]) ?? 'mesh' });
      break;
    }
    case 'sys.checklist':
      ui.set({ checklist: String(it.params.checklist) });
      break;
    case 'sys.resetCaution':
      engine.resetCaution();
      break;
  }
}

export async function loadScenarioFile(id: string): Promise<Scenario> {
  const r = await fetch(`/scenarios/${id}.json`);
  if (!r.ok) throw new Error(`scenario ${id} not found`);
  return (await r.json()) as Scenario;
}

export async function refreshBudget(): Promise<void> {
  const b = await api.budget();
  ui.set({ llm: !b ? 'offline' : b.mode === 'full' ? 'online' : b.mode === 'templates' ? 'templates' : 'offline' });
}

export async function startSortie(id: string, seed = Math.floor(Math.random() * 1e6), opts: { paused?: boolean } = {}): Promise<void> {
  await engine.start();                              // AudioContext on the Start click
  engine.reset();
  scenario = await loadScenarioFile(id);
  metrics = fresh();
  missilesAlive = 0;
  ending = false;
  ui.set({
    screen: 'console', scenarioId: id, caption: '', captionLevel: null, log: [], board: null, lastDirective: null,
    masterWarning: false, masterCaution: false, debrief: null, paused: Boolean(opts.paused), transcript: [], checklist: null,
    isolated: client.isolated,
  });
  const local = `local-${crypto.randomUUID()}`;
  ui.set({ sessionId: local });
  await client.load(scenario, seed, { paused: Boolean(opts.paused), sessionId: local, verbosity: ui.get().verbosity });
  // the session (Turnstile-gated when configured) only matters for LLM routes; play never waits on it
  void api.startSession(id).then(sid => {
    if (sid) { ui.set({ sessionId: sid }); client.setSession(sid); }
  });
  void refreshBudget();
  if (budgetTimer) clearInterval(budgetTimer);
  budgetTimer = setInterval(() => void refreshBudget(), 30_000);
}

export function setPaused(p: boolean): void {
  if (p) client.pause(); else client.resume();
  ui.set({ paused: p });
}

// ---------- voice ----------

let lastEarly: { key: string; at: number } | null = null;

function currentContext(): CompactContext {
  const ctx = client.board?.context;
  const sessionId = ui.get().sessionId;
  if (ctx) return { ...ctx, sessionId };
  const f = client.frame();
  return {
    sessionId,
    own: {
      headingDeg: Math.round(f?.own.headingDeg ?? 0), altFt: Math.round(f?.own.altFt ?? 0), aglFt: Math.round(f?.own.aglFt ?? 0),
      kcas: Math.round(f?.own.kcas ?? 0), mach: f?.own.mach ?? 0, fuelLb: Math.round(f?.own.fuelLb ?? 0), bingoLb: f?.fuel.bingoLb ?? 0,
      minutesToBingo: 0, emcon: f?.own.emcon ?? 0, chaff: f?.own.cm.chaff ?? 0, flares: f?.own.cm.flares ?? 0,
    },
    threats: [], route: null, home: { bearingDeg: 0, rangeNm: 0 },
  };
}

/** One transcript, interim or final, through the tier router into the mesh. */
export async function handleTranscript(text: string, interim = false, confidence = 1): Promise<void> {
  const t = text.trim();
  if (!t) return;
  pushTranscript('pilot', t, interim);
  if (!interim && confidence < 0.7) { client.say('Say again.'); return; }
  const ctx = currentContext();
  const res = await interpret(t, ctx, { interim });
  if (!res) return;
  if (res.kind === 'intent') {
    const key = `${res.intent.intent}:${JSON.stringify(res.intent.params)}`;
    if (interim) lastEarly = { key, at: Date.now() };
    else if (lastEarly && lastEarly.key === key && Date.now() - lastEarly.at < 4000) { lastEarly = null; return; }   // already fired early
    if (res.intent.intent === 'pia.ack') engine.acknowledge();
    if (res.intent.intent === 'query.status') {
      const say = await statusSummary(ctx, c => api.summary(c, c.sessionId), s => numbersGrounded(s, ctx));
      client.say(say, t);
      pushTranscript('wingmind', say);
      return;
    }
    if (metrics.pendingReaction !== null && (res.intent.intent === 'ew.dispense' || res.intent.intent === 'nav.setHeading')) {
      metrics.reactionMs.push(performance.now() - metrics.pendingReaction);
      metrics.pendingReaction = null;
    }
    client.intent(res.intent);
    return;
  }
  client.say(res.say, t);
  pushTranscript('wingmind', res.say);
}

/** Keyboard shortcuts and buttons issue the same intents as voice (accessibility, spec 14.1). */
export function keyboardIntent(intent: Intent['intent'], params: Record<string, unknown> = {}): void {
  if (intent === 'pia.ack') engine.acknowledge();
  if (metrics.pendingReaction !== null && intent === 'ew.dispense') {
    metrics.reactionMs.push(performance.now() - metrics.pendingReaction);
    metrics.pendingReaction = null;
  }
  client.intent({ intent, params, confidence: 1, source: 'keyboard' });
}

export const ptt = new PushToTalk({
  transcript: (text, interim, confidence) => void handleTranscript(text, interim, confidence),
  audio: (blob, seconds) => {
    void api.stt(blob, seconds, ui.get().sessionId).then(text => {
      if (text) void handleTranscript(text, false, 0.9);
      else client.say('Unable, voice queries offline.');
    });
  },
  state: listening => ui.set({ listening }),
});

/** Called by input when the stick moves a lot after a missile call (reaction time metric). */
export function notePilotInput(): void {
  if (metrics.pendingReaction !== null) {
    metrics.reactionMs.push(performance.now() - metrics.pendingReaction);
    metrics.pendingReaction = null;
  }
}

export function recordFps(fps: number): void {
  fpsSamples.push(fps);
  if (fpsSamples.length > 600) fpsSamples.shift();
}

// ---------- sortie end and debrief ----------

export async function endSortie(outcome: SortieOutcome = 'survived'): Promise<void> {
  if (ending) return;
  ending = true;
  client.finish(outcome);
  ui.set({ paused: true });
  const f: RenderFrame | null = client.frame();
  const durationS = Math.round((f?.tMs ?? 0) / 1000);
  const m: Record<string, number | string | null> = {
    envelopeMin: Math.round((metrics.envelopeS / 60) * 10) / 10,
    detectedMin: Math.round((metrics.detectedS / 60) * 10) / 10,
    reactionP50Ms: metrics.reactionMs.length ? Math.round(percentile(metrics.reactionMs, 50)) : null,
    falseAlarms: metrics.falseAlarms,
    missilesDefeated: metrics.missilesDefeated,
    alerts: metrics.alerts,
    fuelAtEndLb: Math.round(f?.own.fuelLb ?? 0),
    alertLatencyP95Ms: engine.latencies.length ? Math.round(percentile(engine.latencies, 95)) : null,
  };
  const score = Math.max(0, Math.round(
    (outcome === 'survived' ? 100 : outcome === 'aborted' ? 40 : 0)
    - Number(m.envelopeMin) * 4 - Number(m.detectedMin) * 2 - metrics.falseAlarms * 2 + metrics.missilesDefeated * 5,
  ));
  ui.set({ debrief: { outcome, durationS, metrics: m, text: null, saved: false, personalBest: false } });
  const replay = await client.exportReplay();
  const gz = replay ? await api.gzipJson(replay) : null;
  const saved = await api.saveSortie({
    sessionId: ui.get().sessionId, player: api.playerId(), scenarioId: scenario?.id ?? 'unknown', durationS, outcome, score, metrics: m,
  }, gz);
  ui.set(s => ({
    debrief: s.debrief && {
      ...s.debrief,
      text: saved?.debrief ?? 'Debrief unavailable offline. Metrics are shown above.',
      saved: Boolean(saved),
      personalBest: saved?.personalBest ?? false,
      ...(saved ? {} : { error: 'offline' }),
    },
  }));
}

// ---------- test hooks (VITE_TEST_HOOKS=1 builds only) ----------

export interface SkyHooks {
  loadScenario(id: string, seed?: number): Promise<void>;
  pause(): Promise<void>;
  step(frames: number): Promise<void>;
  inject(event: InjectEvent): Promise<void>;
  transcript(text: string, opts?: { interim?: boolean }): Promise<void>;
  metrics(): { alertLatencyMs: number[]; directives: SortieMetrics['directives']; spoken: { text: string; level: string }[]; fps: number[] };
  state(): RenderFrame | null;
  board(): unknown;
  end(outcome?: SortieOutcome): Promise<void>;
}

if (__TEST_HOOKS__) {
  const hooks: SkyHooks = {
    loadScenario: async (id, seed = 42) => { await startSortie(id, seed, { paused: true }); },
    pause: async () => { setPaused(true); },
    step: async frames => { ui.set({ paused: true }); await client.step(frames); },
    inject: async ev => { client.inject(ev); },
    transcript: async (text, opts = {}) => { await handleTranscript(text, opts.interim ?? false, 1); },
    metrics: () => ({ alertLatencyMs: [...engine.latencies], directives: metrics.directives, spoken: engine.spoken.map(s => ({ text: s.text, level: s.level })), fps: [...fpsSamples] }),
    state: () => client.frame(),
    board: () => client.board,
    end: async outcome => { await endSortie(outcome ?? 'survived'); },
  };
  (window as unknown as { __sky: SkyHooks }).__sky = hooks;
}
