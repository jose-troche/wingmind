import { useEffect, useState } from 'react';
import type { Threat } from '@wingmind/shared';
import { endSortie, keyboardIntent, setPaused, startSortie } from '../controller';
import { ui, useUi } from '../store';
import { ACTION_LABELS, saveBindings, type Action, type InputManager } from './input';

// Top bar, threat priority stack, checklist, remap screen and debrief.

const T_REF = 10;

export function TopBar({ clockRef }: { clockRef: (el: HTMLSpanElement | null) => void }) {
  const phase = useUi(s => s.board?.phase ?? 'cruise');
  const scenarioId = useUi(s => s.scenarioId);
  const llm = useUi(s => s.llm);
  const verbosity = useUi(s => s.verbosity);
  const paused = useUi(s => s.paused);
  const isolated = useUi(s => s.isolated);
  const title = useUi(s => s.scenarios.find(x => x.id === s.scenarioId)?.title ?? s.scenarioId);
  return (
    <header className="topbar">
      <strong className="brand">WINGMIND</strong>
      <span className="chip" data-testid="phase">{phase.toUpperCase()}</span>
      <span className="chip mono" ref={clockRef} aria-label="Mission clock">00:00</span>
      <span className="chip" title={scenarioId}>{title}</span>
      <span className={`chip llm ${llm}`} data-testid="llm-status" data-state={llm} title="Language model status">
        <span aria-hidden="true">{llm === 'online' ? '●' : llm === 'templates' ? '◐' : '○'}</span> LLM {llm === 'online' ? 'online' : llm === 'templates' ? 'templates' : llm === 'offline' ? 'offline (grammar only)' : '…'}
      </span>
      {!isolated && <span className="chip" title="SharedArrayBuffer unavailable; using postMessage snapshots">postMessage mode</span>}
      <label className="chip">
        Verbosity{' '}
        <select
          value={verbosity}
          onChange={e => {
            const v = e.target.value as 'terse' | 'standard' | 'instructional';
            ui.set({ verbosity: v });
            keyboardIntent('pia.verbosity', { level: v });
          }}
        >
          <option value="terse">terse</option>
          <option value="standard">standard</option>
          <option value="instructional">instructional</option>
        </select>
      </label>
      <span className="spacer" />
      <button type="button" onClick={() => setPaused(!paused)}>{paused ? 'Resume' : 'Pause'}</button>
      <button type="button" onClick={() => ui.set({ remapOpen: true })}>Controls</button>
      <button type="button" onClick={() => void endSortie('aborted')}>End sortie</button>
    </header>
  );
}

function factors(t: Threat) {
  const urgency = Math.min(1, T_REF / Math.max(t.tActS, 0.1));
  return [
    { k: 'L', v: t.lethality, label: 'lethality' },
    { k: 'P', v: t.pEngage, label: 'can engage now' },
    { k: 'U', v: urgency, label: 'urgency (10 s / time to act)' },
    { k: 'C', v: t.confidence, label: 'confidence' },
  ];
}

const NO_THREATS: Threat[] = [];

export function ThreatStack() {
  const ranked = useUi(s => s.board?.ranked ?? NO_THREATS);
  return (
    <section className="panel threats" aria-label="Threat priority stack">
      <h2>Threats <small>score = L × P × U × C</small></h2>
      <ol data-testid="threat-stack">
        {ranked.slice(0, 6).map(t => (
          <li key={t.id} className={`level-${t.level.toLowerCase()}`}>
            <div className="tline"><b>{t.class.replace('_', ' ')}</b> <span className="mono">{t.score.toFixed(2)}</span> <small>{t.intent ?? ''}</small></div>
            <div className="bars">
              {factors(t).map(f => (
                <span key={f.k} className="bar" title={`${f.label}: ${f.v.toFixed(2)}`} style={{ width: `${Math.max(4, f.v * 25)}%` }}>{f.k}</span>
              ))}
            </div>
          </li>
        ))}
        {ranked.length === 0 && <li className="muted">No threats.</li>}
      </ol>
    </section>
  );
}

const CHECKLISTS: Record<string, string[]> = {
  engine_fire: ['Throttle, affected engine: OFF', 'Fire switch: PULL', 'Discharge agent if light persists', 'Land as soon as possible'],
  engine_flameout: ['Throttle: IDLE', 'Below 30,000 ft and 400 knots', 'Relight switch: ON', 'If no relight in 30 s: OFF, retry'],
  engine_failure: ['Throttle, affected engine: IDLE', 'Check oil pressure and temperature', 'Reduce to 85% on the good engine', 'Divert'],
};

export function Checklist() {
  const id = useUi(s => s.checklist);
  if (!id) return null;
  return (
    <section className="panel checklist" aria-label="Checklist">
      <h2>{id.replace('_', ' ').toUpperCase()} <button type="button" className="link" onClick={() => ui.set({ checklist: null })}>close</button></h2>
      <ol>{(CHECKLISTS[id] ?? ['No checklist']).map(s => <li key={s}>{s}</li>)}</ol>
    </section>
  );
}

export function RemapScreen({ input }: { input: InputManager }) {
  const open = useUi(s => s.remapOpen);
  const [binding, setBinding] = useState<Action | null>(null);
  const [, force] = useState(0);
  useEffect(() => {
    if (!binding) return;
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      input.bindings = { ...input.bindings, [binding]: e.code };
      saveBindings(input.bindings);
      setBinding(null);
      force(x => x + 1);
    };
    window.addEventListener('keydown', onKey, { once: true });
    return () => window.removeEventListener('keydown', onKey);
  }, [binding, input]);
  if (!open) return null;
  return (
    <div className="modal-backdrop">
      <div className="modal" role="dialog" aria-modal="true" aria-label="Controls">
        <h3>Controls</h3>
        <table className="remap">
          <tbody>
            {(Object.keys(ACTION_LABELS) as Action[]).map(a => (
              <tr key={a}>
                <td>{ACTION_LABELS[a]}</td>
                <td className="mono">{binding === a ? 'press a key…' : input.bindings[a]}</td>
                <td><button type="button" onClick={() => setBinding(a)}>Change</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">Gamepad: left stick flies, right stick Y is throttle, A talks, B chaff, X flares, Y acknowledges.</p>
        <button type="button" onClick={() => ui.set({ remapOpen: false })}>Done</button>
      </div>
    </div>
  );
}

export function Debrief() {
  const d = useUi(s => s.debrief);
  const scenarioId = useUi(s => s.scenarioId);
  if (!d) return null;
  const rows: [string, string][] = [
    ['Outcome', d.outcome.replace('_', ' ')],
    ['Duration', `${Math.floor(d.durationS / 60)} min ${d.durationS % 60} s`],
    ['Minutes inside threat envelopes', String(d.metrics.envelopeMin ?? 0)],
    ['Minutes detected', String(d.metrics.detectedMin ?? 0)],
    ['Reaction time, median', d.metrics.reactionP50Ms === null ? 'n/a' : `${String(d.metrics.reactionP50Ms)} ms`],
    ['False alarms', String(d.metrics.falseAlarms ?? 0)],
    ['Missiles defeated', String(d.metrics.missilesDefeated ?? 0)],
    ['Fuel at end', `${String(d.metrics.fuelAtEndLb ?? 0)} lb`],
    ['Alert latency, 95th percentile', d.metrics.alertLatencyP95Ms === null ? 'n/a' : `${String(d.metrics.alertLatencyP95Ms)} ms`],
  ];
  return (
    <div className="modal-backdrop">
      <div className="modal debrief" data-testid="debrief" role="dialog" aria-modal="true" aria-label="Debrief">
        <h3>Debrief {d.personalBest && <span className="chip pb">Personal best</span>}</h3>
        <table><tbody>{rows.map(([k, v]) => <tr key={k}><th scope="row">{k}</th><td>{v}</td></tr>)}</tbody></table>
        <p data-testid="debrief-text" className="narrative">{d.text ?? 'Writing debrief…'}</p>
        <p className="muted" data-testid="debrief-saved">{d.saved ? 'Sortie saved.' : d.text ? 'Not saved (offline).' : 'Saving…'}</p>
        <div className="row">
          <button type="button" onClick={() => void startSortie(scenarioId)}>Fly again</button>
          <button type="button" onClick={() => ui.set({ screen: 'start', debrief: null })}>Scenarios</button>
        </div>
      </div>
    </div>
  );
}
