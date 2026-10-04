import { engine, keyboardIntent } from '../controller';
import { useUi } from '../store';

// Master lights, alert log and the HUD caption line (implementation 8.1).
// Every spoken alert also appears here (accessibility and muted play).

export function MasterLights() {
  const warning = useUi(s => s.masterWarning);
  const caution = useUi(s => s.masterCaution);
  return (
    <div className="master-lights">
      <button
        type="button"
        className={`master warning ${warning ? 'on' : ''}`}
        data-testid="master-warning"
        data-state={warning ? 'on' : 'off'}
        aria-label={warning ? 'Master warning on. Press to acknowledge' : 'Master warning off'}
        onClick={() => keyboardIntent('pia.ack')}
      >
        <span aria-hidden="true">▲</span> MASTER WARN
      </button>
      <button
        type="button"
        className={`master caution ${caution ? 'on' : ''}`}
        data-testid="master-caution"
        data-state={caution ? 'on' : 'off'}
        aria-label={caution ? 'Master caution on. Press to reset' : 'Master caution off'}
        onClick={() => engine.resetCaution()}
      >
        <span aria-hidden="true">●</span> MASTER CAUT
      </button>
    </div>
  );
}

export function Caption() {
  const caption = useUi(s => s.caption);
  const level = useUi(s => s.captionLevel);
  return (
    <div className={`caption level-${(level ?? 'none').toLowerCase()}`} data-testid="caption" aria-live="assertive" role="status">
      {caption}
    </div>
  );
}

const SHAPE: Record<string, string> = { WARNING: '▲', CAUTION: '●', ADVISORY: '◆', STATUS: '■' };

export function AlertLog() {
  const log = useUi(s => s.log);
  return (
    <section className="panel alert-log" aria-label="Alert log">
      <h2>Alert log</h2>
      <ol data-testid="alert-log">
        {log.map(r => (
          <li key={r.id} className={`row level-${r.level.toLowerCase()} status-${r.status}`} data-status={r.status} data-level={r.level}>
            <span className="lvl" aria-label={r.level}>{SHAPE[r.level]}</span>
            {' '}{r.text}{' '}
            <small className="st">{r.status}</small>
          </li>
        ))}
      </ol>
    </section>
  );
}
