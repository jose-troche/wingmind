import { useEffect, useRef, useState } from 'react';
import { Console } from './console/Console';
import { startSortie } from './controller';
import { observe, type ObserverFrame } from './observer';
import { ui, useUi } from './store';

// Start screen, console and the read-only observer view.

function StartScreen() {
  const scenarios = useUi(s => s.scenarios);
  const selected = useUi(s => s.scenarioId);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <main className="start">
      <h1>WINGMIND</h1>
      <p className="lede">A browser fighter simulator where twelve cooperating agents act as your digital wingman: they fuse the sensors, rank the threats, and speak short alerts. You speak commands back.</p>
      <fieldset className="scenarios">
        <legend>Training ladder</legend>
        {scenarios.map(s => (
          <label key={s.id} className={selected === s.id ? 'sel' : ''}>
            <input type="radio" name="scenario" value={s.id} checked={selected === s.id} onChange={() => ui.set({ scenarioId: s.id })} />
            <b>{s.ladder}.</b> {s.title}
          </label>
        ))}
      </fieldset>
      <button
        type="button"
        className="primary"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(null);
          startSortie(selected).catch((e: unknown) => setError(String(e))).finally(() => setBusy(false));
        }}
      >
        Start sortie
      </button>
      {error && <p className="error" role="alert">{error}</p>}
      <section className="help">
        <h2>Controls</h2>
        <ul>
          <li><kbd>Space</kbd> hold to talk · arrows fly · <kbd>=</kbd>/<kbd>-</kbd> throttle</li>
          <li><kbd>C</kbd> chaff · <kbd>F</kbd> flares · <kbd>E</kbd> emissions control · <kbd>K</kbd> acknowledge · <kbd>P</kbd> pause</li>
          <li>Try: “heading two seven zero”, “angels twenty”, “radar silent”, “status”, “route around the SAM”, “explain that”.</li>
          <li>Headphones recommended: warning tones are placed at the threat's bearing.</li>
        </ul>
      </section>
    </main>
  );
}

function ObserverView({ sessionId }: { sessionId: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState('connecting');
  const [last, setLast] = useState<ObserverFrame | null>(null);
  const trail = useRef<[number, number][]>([]);
  useEffect(() => observe(sessionId, f => {
    trail.current.push([f.x, f.y]);
    if (trail.current.length > 600) trail.current.shift();
    setLast(f);
  }, setState), [sessionId]);
  useEffect(() => {
    const c = canvas.current?.getContext('2d');
    if (!c || !last) return;
    const W = 600, H = 600, s = W / 160_000;
    c.fillStyle = '#050b0e'; c.fillRect(0, 0, W, H);
    c.strokeStyle = '#4fc3f7'; c.beginPath();
    trail.current.forEach(([x, y], i) => { const px = W / 2 + (x - last.x) * s, py = H / 2 - (y - last.y) * s; if (i) c.lineTo(px, py); else c.moveTo(px, py); });
    c.stroke();
    c.fillStyle = '#5ee0a0'; c.beginPath(); c.arc(W / 2, H / 2, 5, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#ff6b81';
    for (const t of last.threats) {
      const r = t.nm * 1852 * s, a = (t.brg * Math.PI) / 180;
      c.fillRect(W / 2 + Math.sin(a) * r - 3, H / 2 - Math.cos(a) * r - 3, 6, 6);
    }
  }, [last]);
  return (
    <main className="observer">
      <h1>WINGMIND observer</h1>
      <p>Session {sessionId} · {state}{last ? ` · heading ${last.hdg} · ${last.alt} ft · ${last.kcas} kt` : ''}</p>
      <canvas ref={canvas} width={600} height={600} aria-label="Observer map" />
    </main>
  );
}

export function App() {
  const screen = useUi(s => s.screen);
  const observeId = new URLSearchParams(location.search).get('observe');
  useEffect(() => {
    fetch('/scenarios/index.json').then(r => r.json()).then((list: { id: string; title: string; ladder: number }[]) => ui.set({ scenarios: list })).catch(() => undefined);
  }, []);
  if (observeId) return <ObserverView sessionId={observeId} />;
  return screen === 'console' ? <Console /> : <StartScreen />;
}
