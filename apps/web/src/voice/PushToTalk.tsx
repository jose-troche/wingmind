import { useState } from 'react';
import { handleTranscript, ptt } from '../controller';
import { useUi } from '../store';

// Voice panel (implementation 8.1): hold to talk (Space or the button), or type
// a command. Typed commands go through the same grammar and tier router.

export function PushToTalkPanel() {
  const listening = useUi(s => s.listening);
  const transcript = useUi(s => s.transcript);
  const [text, setText] = useState('');
  return (
    <section className="panel voice" aria-label="Voice">
      <h2>Voice</h2>
      <div className="ptt-row">
        <button
          type="button"
          data-testid="ptt"
          className={`ptt ${listening ? 'live' : ''}`}
          aria-pressed={listening}
          onPointerDown={() => void ptt.down()}
          onPointerUp={() => ptt.up()}
          onPointerLeave={() => ptt.up()}
        >
          {listening ? '● Listening' : 'Hold to talk (Space)'}
        </button>
        <span className="mode">{ptt.mode === 'browser' ? 'browser speech' : 'server speech'}</span>
      </div>
      <form
        onSubmit={e => {
          e.preventDefault();
          const t = text;
          setText('');
          void handleTranscript(t, false, 1);
        }}
      >
        <label className="sr-only" htmlFor="cmd">Type a command</label>
        <input id="cmd" data-testid="command-input" value={text} onChange={e => setText(e.target.value)} placeholder='Type a command, e.g. "heading two seven zero"' autoComplete="off" />
      </form>
      <ul className="transcript" aria-label="Transcript">
        {transcript.map(r => (
          <li key={r.id} className={`${r.who} ${r.interim ? 'interim' : ''}`}>
            <b>{r.who === 'pilot' ? 'PILOT' : 'WINGMIND'}</b> {r.text}
          </li>
        ))}
      </ul>
    </section>
  );
}
