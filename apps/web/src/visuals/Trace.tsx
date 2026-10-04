import { useUi } from '../store';

// Decision trace, "Why?" (implementation 8.2): the newest directive's why list,
// with suppressed advice greyed out and evidence ids linked to the display.

function describe(axis: string, value: unknown): string {
  if (!value || typeof value !== 'object') return String(value);
  const v = value as Record<string, unknown>;
  switch (axis) {
    case 'heading':
      return v.mode === 'break' ? `Break ${String(v.side)} to ${Math.round(Number(v.headingDeg))}°, ${String(v.gCap ?? '')} G`
        : `Heading ${Math.round(Number(v.headingDeg))}°${v.mode ? ` (${String(v.mode)})` : ''}`;
    case 'altitude': return v.flyup ? 'Automatic fly-up' : v.gcasAuto !== undefined ? `Ground collision auto ${v.gcasAuto ? 'on' : 'off'}` : `Altitude ${String(v.altFt)} ft`;
    case 'countermeasures': return `Dispense ${String(v.kind)}${v.program ? `, program ${String(v.program)}` : ''}`;
    case 'emitters': return `Emissions control level ${String(v.emcon)}`;
    case 'speed': return `Speed ${String(v.kcas)} knots`;
    case 'throttle': return `Throttle ${Math.round(Number(v.throttle) * 100)}%`;
    default: return JSON.stringify(v);
  }
}

export function DecisionTrace({ onEvidence }: { onEvidence(id: string): void }) {
  const d = useUi(s => s.lastDirective);
  return (
    <section className="panel trace" aria-label="Decision trace">
      <h2>Why? <small>decision trace</small></h2>
      <div data-testid="decision-trace">
        {!d ? <p className="muted">No directive yet.</p> : (
          <>
            <p className="directive"><b>{d.axis.toUpperCase()}</b> · {describe(d.axis, d.value)} <small>source {d.source}</small></p>
            <ul>
              {d.why.map((w, i) => (
                <li key={i} className={w.includes('suppressed') ? 'suppressed' : i === 0 ? 'winner' : ''}>{w}</li>
              ))}
            </ul>
            {d.evidence && d.evidence.length > 0 && (
              <p className="evidence">Evidence:{' '}
                {d.evidence.map(id => <button key={id} type="button" className="link" onClick={() => onEvidence(id)}>{id}</button>)}
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}
