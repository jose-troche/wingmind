// Data model and message contracts (spec section 12), plus the prototype's
// transport records. Positions are local east-north-up meters around the
// scenario origin; bearings are degrees true, clockwise from north.

export type Vec3 = [number, number, number];
export type Vec2 = [number, number];
export type Quat = [number, number, number, number]; // w, x, y, z (body FLU -> world ENU)
export type Level = 'WARNING' | 'CAUTION' | 'ADVISORY' | 'STATUS';
export type Axis = 'heading' | 'altitude' | 'speed' | 'throttle' | 'emitters' | 'countermeasures' | 'route';
export type Tier = 'R' | 'T' | 'D';
export type Emcon = 0 | 1 | 2 | 3;
export type Phase = 'cruise' | 'combat' | 'lowlevel';
export type Verbosity = 'terse' | 'standard' | 'instructional';

export type EngineMode =
  | 'off' | 'starting' | 'idle' | 'military' | 'afterburner'
  | 'stalled' | 'flamedout' | 'relighting' | 'fire' | 'shutdown';

export interface EngineState {
  side: 'left' | 'right';
  mode: EngineMode;
  abStage: number;          // 0..5
  n1: number;               // percent
  n2: number;               // percent
  titC: number;             // turbine inlet temperature
  oilPsi: number;
  oilC: number;
  nozzlePct: number;
  fuelFlowPph: number;
  thrustPct: number;
  thrustN: number;
  vibration: number;        // inches per second
  fault: EngineFault | null;
}

export type EngineFault = 'fire' | 'flameout' | 'oil_pressure' | 'compressor_stall' | 'generator';

export interface TankState { id: 'fwd' | 'aft' | 'wing'; lb: number; capacityLb: number; armM: number }

export interface FuelState {
  tanks: TankState[];
  totalLb: number;
  flowPph: number;
  cgPctMac: number;
  bingoLb: number;
  jokerLb: number;
}

export interface OwnState {
  tick: number; pos: Vec3; vel: Vec3; att: Quat;
  mach: number; kcas: number; altFt: number; aglFt: number; aoaDeg: number; g: number;
  fuelLb: number; engines: EngineState[]; emcon: Emcon;
  cm: { chaff: number; flares: number; decoys: number };
  // derived values every consumer would otherwise recompute
  headingDeg: number; pitchDeg: number; rollDeg: number; vsFpm: number; tasKt: number;
  gMax: number; throttle: number; trackDeg: number;
}

export type TrackKind = 'air' | 'missile' | 'drone' | 'ground' | 'unknown';
export type Identity = 'friend' | 'hostile' | 'neutral' | 'unknown';

export interface Track {
  id: string; kind: TrackKind; identity: Identity;
  pos: Vec3; vel: Vec3; cov: number[];
  quality: number; sources: string[]; lastSeenTick: number;
}

export type ThreatClass = 'radar_missile' | 'ir_missile' | 'fighter' | 'drone' | 'swarm' | 'sam' | 'shorad' | 'gun' | 'radar';

export interface Threat {
  id: string; trackId: string;
  class: ThreatClass;
  lethality: number; pEngage: number; tActS: number; confidence: number;
  score: number; level: Level; intent?: string; envelope?: { rMaxM: number; rNoEscapeM: number };
  bearingDeg?: number; rangeM?: number; altFt?: number; count?: number; source?: string;
}

export interface Advice {
  id: string; axis: Axis; value: unknown; utility: number;
  safetyRank: number;       // 1 = ground collision ... 9 = navigation
  source: string; evidence: string[]; ttlMs: number;
  expiresAt: number;        // sim ms, filled by the bus from ttlMs
  threatId?: string;
}

export interface Directive {
  id: string; axis: Axis; value: unknown; source: string; supersedes: string[]; why: string[];
  evidence?: string[]; threatId?: string; execute?: boolean; tMs?: number;
}

export interface Alert {
  id: string; level: Level; text: string; terse: string;
  bearingDeg?: number; threatId?: string; dedupKey: string; ttlMs: number;
  // prototype extensions
  cls: AlertClass; evidence: string[]; confidence: number;
  slots?: Record<string, string>; eventWallMs?: number; instructional?: string;
}

export type AlertClass =
  | 'radar_missile' | 'ir_missile' | 'missile_defeated' | 'sam_track' | 'bandit' | 'swarm'
  | 'detection' | 'pull_up' | 'obstacle' | 'engine_fire' | 'engine_fault' | 'bingo' | 'joker'
  | 'weather' | 'over_g' | 'aoa' | 'cm_low' | 'readback' | 'status' | 'advisory' | 'traffic';

export interface BusMessage<T> {
  id: string; topic: string; source: string; tick: number; snapshotVersion: number;
  priority: number; ttlMs: number; confidence: number; evidence: string[]; payload: T;
}

// ---------- sensor observations (what agents are allowed to see) ----------

export type Observation = RadarObs | IrstObs | DasObs | DatalinkObs;

export interface RadarObs {
  id: string; sensor: 'radar'; tick: number;
  rangeM: number; bearingDeg: number; elevDeg: number; closureMps: number; rcsDbsm: number;
}
export interface IrstObs { id: string; sensor: 'irst'; tick: number; bearingDeg: number; elevDeg: number; intensity: number }
export interface DasObs {
  id: string; sensor: 'das'; tick: number; kind: 'plume' | 'missile' | 'aircraft';
  bearingDeg: number; elevDeg: number; rangeM: number; closureMps: number;
}
export interface DatalinkObs { id: string; sensor: 'datalink'; tick: number; pos: Vec3; vel: Vec3; identity: Identity; ageS: number }

export type EmitterType = 'fighter' | 'sam_long' | 'sam_short' | 'ew_radar' | 'unknown';
export type EmitterMode = 'search' | 'track' | 'guidance';

export interface RwrEmitter {
  id: string; emitterId: string; bearingDeg: number; type: EmitterType; mode: EmitterMode;
  strength: number; newGuidance?: boolean;
}

export type SimEventType =
  | 'missile_launch' | 'missile_hit' | 'missile_miss' | 'engine_transition' | 'engine_fault'
  | 'crash' | 'cm_dispensed' | 'trigger' | 'force_alert' | 'gcas_flyup' | 'waypoint';

export interface SimEvent {
  id: string; type: SimEventType; tick: number; wallMs: number;
  data: Record<string, unknown>;
}

/** What the sim publishes to agents each frame (never ground truth). */
export interface SimSnapshot {
  version: number; tick: number; tMs: number; wallMs: number;
  own: OwnState;
  obs: Observation[];
  rwr: RwrEmitter[];
  events: SimEvent[];
  gcasAuto: boolean;
}

/** What the sim publishes to the console each frame (truth, for rendering only). */
export interface RenderFrame {
  tick: number; tMs: number; wallMs: number; paused: boolean;
  own: OwnState;
  fuel: FuelState;
  autopilot: { heading?: number; altFt?: number; kcas?: number; flyup: boolean };
  entities: RenderEntity[];
  outcome: SortieOutcome | null;
  stick: { pitch: number; roll: number };
  rwr: RwrEmitter[];          // the warning receiver's picture (sensor data, not truth)
  activeWp: number;
}

export interface RenderEntity {
  id: string; type: 'fighter' | 'missile' | 'sam' | 'shorad' | 'drone' | 'chaff' | 'flare' | 'tower';
  pos: Vec3; headingDeg: number; alive: boolean; emitting?: EmitterMode | null; side: 'red' | 'blue';
}

export type SortieOutcome = 'survived' | 'shot_down' | 'crashed' | 'aborted';

// ---------- natural language ----------

export type IntentName =
  | 'nav.setHeading' | 'nav.setAltitude' | 'nav.setSpeed' | 'nav.holdAltitude' | 'nav.replan' | 'nav.direct'
  | 'nav.home' | 'nav.accept' | 'nav.reject' | 'ew.dispense' | 'ew.setMode' | 'ew.program' | 'sig.setEmcon'
  | 'ui.show' | 'ui.zoom' | 'ui.explain' | 'pia.verbosity' | 'pia.ack' | 'pia.sayAgain' | 'pia.quietAdvisories'
  | 'sys.checklist' | 'sys.resetCaution' | 'prot.gcas' | 'query.status' | 'query.fuel' | 'query.bingo'
  | 'query.answer' | 'clarify' | 'confirm';

export interface Intent {
  intent: IntentName;
  params: Record<string, unknown>;
  confidence: number;
  requires_confirmation?: boolean;
  readback?: string;
  answer?: string;
  source: 'grammar' | 'llm' | 'ondevice' | 'keyboard' | 'template';
}

export interface CompactContext {
  sessionId: string;
  own: {
    headingDeg: number; altFt: number; aglFt: number; kcas: number; mach: number;
    fuelLb: number; bingoLb: number; minutesToBingo: number; emcon: Emcon;
    chaff: number; flares: number;
  };
  threats: { id: string; cls: ThreatClass; clock: string; bearingDeg: number; rangeNm: number; level: Level; intent?: string }[];
  route: { nextWp: number; bearingDeg: number; distNm: number } | null;
  home: { bearingDeg: number; rangeNm: number };
  lastAnswers?: { q: string; a: string }[];
}

/** One spoken item, sent from PIA (agent worker) to the audio engine (main thread). */
export interface SpeakItem {
  id: string; alertId: string; level: Level; text: string; cls: AlertClass;
  bearingDeg?: number; eventWallMs?: number; dedupKey: string; repeat: number;
}

export type AlertLogStatus = 'queued' | 'speaking' | 'spoken' | 'requeued' | 'suppressed' | 'held';

// ---------- scenarios ----------

export interface TerrainFeature {
  type: 'ridge' | 'hill' | 'valley' | 'plateau';
  from?: Vec2; to?: Vec2; at?: Vec2; heightM: number; widthM?: number; radiusM?: number;
}

export interface TerrainSpec {
  id: string; seed: number; bounds: [number, number, number, number]; spacingM: number;
  baseM: number; roughnessM: number; features: TerrainFeature[];
}

export interface ScenarioRed {
  id: string;
  type: 'sam_long' | 'sam_short' | 'fighter_gen4' | 'drone_swarm';
  pos?: Vec2; emcon?: 'silent_until_cued' | 'active'; count?: number;
  cap?: Vec3; skill?: number; target?: Vec2; altFt?: number; intel?: boolean; active?: boolean;
}

export interface ScenarioTrigger {
  at: { t?: number; near?: Vec2; r?: number };
  do: 'fault' | 'activate' | 'launch_swarm' | 'commit';
  target: string; kind?: string;
}

export interface Scenario {
  id: string; title: string; ladder: number; description: string;
  theater: { terrain: TerrainSpec; origin: Vec2; towers: { pos: Vec2; heightFt: number }[]; homePlate: Vec2 };
  weather: {
    isaDeltaC: number;
    wind: { altFt: number; dirDeg: number; kt: number }[];
    gustKt: number;
    clouds: { baseFt: number; topFt: number; cover: number }[];
    visibilityKm: number;
    cells: { pos: Vec2; radiusM: number; topFt: number }[];
  };
  own: { fuelLb: number; pos: Vec2; altFt: number; headingDeg: number; kcas: number; cm: { chaff: number; flares: number; decoys: number } };
  route: Vec3[];   // x, y, altFt
  red: ScenarioRed[];
  friendly: { type: 'awacs'; latencyS: number }[];
  triggers: ScenarioTrigger[];
  objectives: string[];
  settings: { falseAlarmPerMin: number; gcasAuto: boolean; durationS: number };
}

// ---------- worker protocol ----------

export type InjectEvent =
  | { type: 'missile_launch'; guidance: 'radar' | 'ir'; bearingRelDeg: number; rangeNm: number; elevDeg?: number }
  | { type: 'force_alert'; level: Level; text: string }
  | { type: 'set_throttle'; value: number }
  | { type: 'engine_fault'; side: 'left' | 'right'; kind: EngineFault }
  | { type: 'set_altitude'; altFt: number }
  | { type: 'set_heading'; headingDeg: number }
  | { type: 'teleport'; pos?: Vec2; altFt?: number; headingDeg?: number };   // test hooks only

export interface Controls { pitch: number; roll: number; throttle: number | null }

export interface MeshEdge { from: string; to: string; count: number; priority: number }

export interface BoardSummary {
  version: number; tick: number; phase: Phase;
  tracks: Track[];
  ranked: Threat[];
  detection: DetectionRing[];
  gbadRings: GbadRing[];
  route: Vec3[]; activeWp: number; proposedRoute: Vec3[] | null;
  beam: { side: 'left' | 'right'; headingDeg: number } | null;
  directives: Directive[];
  rates: Record<string, number>;
  agentStats: Record<string, { lastMs: number; avgMs: number; runs: number; overruns: number }>;
  ew: { mode: 'manual' | 'semi' | 'auto'; program: number };
  cue: { kind: 'break' | 'pullup' | 'steer' | null; headingDeg?: number; side?: 'left' | 'right' };
  context: CompactContext | null;
}

export interface DetectionRing { emitterId: string; pos: Vec2; radiusM: number; pDetect: number; aspectDeg: number; type: EmitterType }
export interface GbadRing { siteId: string; pos: Vec2; radii: number[]; type: 'sam_long' | 'sam_short'; known: boolean }
