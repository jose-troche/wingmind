import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type RefObject } from 'react';
import { client, keyboardIntent } from '../controller';
import { PilotShare } from '../observer';
import { ui, useUi } from '../store';
import { MaskingProfile } from '../visuals/Masking';
import { MeshView } from '../visuals/Mesh';
import { PolarPlot } from '../visuals/Polar';
import { DecisionTrace } from '../visuals/Trace';
import { ExplainBadge, ExplainCard } from '../visuals/Explain';
import { PushToTalkPanel } from '../voice/PushToTalk';
import { AlertLog, Caption, MasterLights } from './Alerts';
import { EnginePage } from './Engine';
import { FuelPage } from './Fuel';
import { Hud } from './Hud';
import { InputManager } from './input';
import { startLoop, type Instruments } from './loop';
import { Checklist, Debrief, RemapScreen, ThreatStack, TopBar } from './Panels';
import { Rwr } from './Rwr';
import { Scene } from './Scene';
import { Tsd } from './Tsd';

// Console layout (spec 11.1): out-the-window view with HUD in the centre, four
// multifunction displays below, standby and defensive panels on the left, and
// Agent Ops on the right. On a laptop the displays become tabs.

function useMedia(query: string): boolean {
  const mql = useMemo(() => window.matchMedia(query), [query]);
  return useSyncExternalStore(cb => { mql.addEventListener('change', cb); return () => mql.removeEventListener('change', cb); }, () => mql.matches);
}

const AGENT_INFO: Record<string, { mission: string; reads: string; writes: string }> = {
  FUSE: { mission: 'Correlates observations into tracks', reads: 'obs.radar, obs.irst, obs.das, obs.datalink', writes: 'track.table' },
  MAWS: { mission: 'Detects launches, computes time to impact', reads: 'obs.das, obs.rwr', writes: 'threat.missile, alert, advice' },
  AIR: { mission: 'Classifies aircraft, infers intent, clusters drones', reads: 'tracks, obs.rwr', writes: 'threat.air' },
  GBAD: { mission: 'SAM sites and terrain-masked rings', reads: 'obs.rwr, intel, terrain', writes: 'threat.ground, gbad.rings' },
  TAP: { mission: 'Ranks threats by score and time to act', reads: 'threat.*', writes: 'threat.ranked, alert' },
  SIG: { mission: 'Own detectability and signature advice', reads: 'obs.rwr, rings, tracks', writes: 'sig.detection, advice' },
  EW: { mission: 'Countermeasure programs and emissions', reads: 'threat.missile, intent.ew', writes: 'advice, alert, ew.state' },
  NAV: { mission: 'Ground collision, obstacles, beam checks, routing', reads: 'threat.missile, intent.nav', writes: 'advice, alert, nav.beam, nav.route' },
  SYS: { mission: 'Engines, fuel, weather and envelope', reads: 'obs.sys', writes: 'alert, env.limits' },
  ORCH: { mission: 'Arbitrates advice into directives; phase rate plan', reads: 'advice, intent.*, nav.beam, env.limits', writes: 'directive, orch.*' },
  PIA: { mission: 'The single voice: queues and phrases alerts', reads: 'alert, directive, intent.pia', writes: 'speak, alert.log' },
  NLU: { mission: 'Validated intents with read-back', reads: 'intent.pilot, say', writes: 'intent.*, alert' },
};

function AgentDetail({ id }: { id: string | null }) {
  const stats = useUi(s => (id ? s.board?.agentStats[id] : undefined));
  const rate = useUi(s => (id ? s.board?.rates[id] : undefined));
  if (!id || !AGENT_INFO[id]) return <p className="muted small">Click an agent for its inputs, outputs, rate and CPU time.</p>;
  const info = AGENT_INFO[id]!;
  return (
    <div className="agent-detail small" data-testid="agent-detail">
      <b>{id}</b> · {info.mission}<br />
      reads {info.reads} · writes {info.writes}<br />
      rate {rate ?? '-'} Hz · last {stats ? stats.lastMs.toFixed(2) : '-'} ms · avg {stats ? stats.avgMs.toFixed(2) : '-'} ms · overruns {stats?.overruns ?? 0}
    </div>
  );
}

const share = new PilotShare();

export function Console() {
  const tabs = useMedia('(max-width: 1399px)');
  const mfdTab = useUi(s => s.mfdTab);
  const sessionId = useUi(s => s.sessionId);
  const [agent, setAgent] = useState<string | null>(null);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const refs = {
    scene: useRef<HTMLDivElement>(null), hud: useRef<HTMLDivElement>(null), tsd: useRef<HTMLDivElement>(null),
    rwr: useRef<HTMLDivElement>(null), engine: useRef<HTMLDivElement>(null), fuel: useRef<HTMLDivElement>(null),
    mesh: useRef<HTMLDivElement>(null), polar: useRef<HTMLDivElement>(null), masking: useRef<HTMLDivElement>(null),
    chaff: useRef<HTMLSpanElement>(null), flares: useRef<HTMLSpanElement>(null), emcon: useRef<HTMLSpanElement>(null), mode: useRef<HTMLSpanElement>(null),
  };
  const clockEl = useRef<HTMLSpanElement | null>(null);
  const tsdRef = useRef<Tsd | null>(null);
  const inputRef = useRef<InputManager>(new InputManager());

  useEffect(() => {
    const r = refs;
    const ins: Instruments = {
      scene: new Scene(r.scene.current!),
      hud: new Hud(r.hud.current!),
      tsd: new Tsd(r.tsd.current!),
      rwr: new Rwr(r.rwr.current!),
      engine: new EnginePage(r.engine.current!),
      fuel: new FuelPage(r.fuel.current!),
      mesh: new MeshView(r.mesh.current!),
      polar: new PolarPlot(r.polar.current!),
      masking: new MaskingProfile(r.masking.current!),
      defensive: { chaff: r.chaff.current!, flares: r.flares.current!, emcon: r.emcon.current!, mode: r.mode.current! },
      clock: clockEl.current,
    };
    tsdRef.current = ins.tsd;
    const input = inputRef.current;
    input.attach();
    const stop = startLoop(ins, input);
    const onSelect = (e: Event) => setAgent((e as CustomEvent<string | null>).detail);
    r.mesh.current!.addEventListener('agent-select', onSelect);
    return () => {
      stop();
      input.detach();
      ins.scene.dispose();
      for (const k of ['hud', 'tsd', 'rwr', 'engine', 'fuel', 'mesh', 'polar', 'masking'] as const) r[k].current?.replaceChildren();
      share.stop();
    };
    // instruments are created once per console mount
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mfd = (id: 'tsd' | 'rwr' | 'engine' | 'fuel', testid: string, title: string, concept: string, ref: RefObject<HTMLDivElement | null>) => (
    <section className={`mfd mfd-${id} ${tabs && mfdTab !== id ? 'hidden' : ''}`} data-testid={testid} aria-label={title}>
      <header><h2>{title}</h2><ExplainBadge concept={concept} label={title} /></header>
      <div className="mfd-body" ref={ref} />
    </section>
  );

  return (
    <div className={`console ${tabs ? 'tabs' : ''}`}>
      <TopBar clockRef={el => { clockEl.current = el; }} />
      <aside className="left">
        <MasterLights />
        <section className="panel defensive" aria-label="Defensive systems">
          <h2>Defensive</h2>
          <dl>
            <dt>Chaff</dt><dd><span data-testid="cm-chaff-count" ref={refs.chaff}>-</span></dd>
            <dt>Flares</dt><dd><span data-testid="cm-flare-count" ref={refs.flares}>-</span></dd>
            <dt>Emcon</dt><dd><span data-testid="emcon-level" ref={refs.emcon}>-</span></dd>
            <dt>Mode</dt><dd><span data-testid="ew-mode" ref={refs.mode}>-</span></dd>
          </dl>
          <div className="row">
            <button type="button" onClick={() => keyboardIntent('ew.dispense', { kind: 'chaff' })}>Chaff (C)</button>
            <button type="button" onClick={() => keyboardIntent('ew.dispense', { kind: 'flare' })}>Flares (F)</button>
            <button type="button" onClick={() => keyboardIntent('sig.setEmcon', { level: 3 })}>Radar silent</button>
          </div>
        </section>
        <section className="panel" aria-label="Signature polar plot">
          <header><h2>Signature</h2><ExplainBadge concept="polar" label="signature polar plot" /></header>
          <div className="polar-body" ref={refs.polar} />
        </section>
        <section className="panel" aria-label="Terrain masking profile">
          <header><h2>Masking</h2><ExplainBadge concept="masking" label="terrain masking profile" /></header>
          <div className="masking-body" ref={refs.masking} />
        </section>
        <Checklist />
      </aside>
      <main className="center">
        <div className="scene" ref={refs.scene} />
        <div className="hud" ref={refs.hud} />
        <div className="hud-badge"><ExplainBadge concept="hud" label="head-up display" /></div>
        <Caption />
      </main>
      <aside className="right" aria-label="Agent Ops">
        <section className="panel mesh-panel" aria-label="Agent mesh">
          <header><h2>Agent mesh</h2><ExplainBadge concept="mesh" label="agent mesh" /></header>
          <div className="mesh-body" ref={refs.mesh} />
          <AgentDetail id={agent} />
        </section>
        <ThreatStack />
        <DecisionTrace onEvidence={id => { if (tsdRef.current) tsdRef.current.highlight = id; }} />
        <AlertLog />
        <PushToTalkPanel />
        <div className="share">
          {shareUrl
            ? <span className="small">Observer link: <code>{shareUrl}</code> <button type="button" className="link" onClick={() => { share.stop(); setShareUrl(null); }}>stop</button></span>
            : <button type="button" className="link" disabled={sessionId.startsWith('local')} onClick={() => setShareUrl(share.start(sessionId, () => client.frame(), () => (client.board?.context?.threats ?? []).map(t => ({ cls: t.cls, brg: t.bearingDeg, nm: t.rangeNm }))))}>Share live view</button>}
        </div>
      </aside>
      <footer className="bottom">
        {tabs && (
          <nav className="mfd-tabs" data-testid="mfd-tabs" aria-label="Displays">
            {(['tsd', 'rwr', 'engine', 'fuel'] as const).map(t => (
              <button key={t} type="button" aria-pressed={mfdTab === t} onClick={() => ui.set({ mfdTab: t })}>{t.toUpperCase()}</button>
            ))}
          </nav>
        )}
        <div className="mfds">
          {mfd('tsd', 'tsd', 'Situation', 'tsd', refs.tsd)}
          {mfd('rwr', 'rwr', 'Warning receiver', 'rwr', refs.rwr)}
          {mfd('engine', 'engine-page', 'Engines', 'engine', refs.engine)}
          {mfd('fuel', 'fuel-page', 'Fuel', 'fuel', refs.fuel)}
        </div>
      </footer>
      <ExplainCard />
      <RemapScreen input={inputRef.current} />
      <Debrief />
    </div>
  );
}
