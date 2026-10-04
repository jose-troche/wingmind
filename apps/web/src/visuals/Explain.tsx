import { useEffect, useState } from 'react';
import { ui, useUi } from '../store';

// Explain mode (implementation 8.2, spec 11.2): a "?" badge on every display
// opens a short concept card from public/concepts/*.md; "Explain that" opens the
// card tied to the last alert class.

export function ExplainBadge({ concept, label }: { concept: string; label: string }) {
  return (
    <button type="button" className="explain-badge" aria-label={`Explain ${label}`} onClick={() => ui.set({ explain: concept })}>?</button>
  );
}

/** Minimal Markdown: headings, paragraphs, bold and bullet lists (cards are ours, not user input). */
function render(md: string): { tag: 'h3' | 'p' | 'li'; text: string }[] {
  return md.split(/\n+/).filter(l => l.trim()).map(l => {
    if (l.startsWith('#')) return { tag: 'h3' as const, text: l.replace(/^#+\s*/, '') };
    if (/^[-*]\s/.test(l)) return { tag: 'li' as const, text: l.replace(/^[-*]\s+/, '') };
    return { tag: 'p' as const, text: l };
  });
}

function Inline({ text }: { text: string }) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return <>{parts.map((p, i) => (p.startsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : <span key={i}>{p}</span>))}</>;
}

export function ExplainCard() {
  const concept = useUi(s => s.explain);
  const [md, setMd] = useState<string | null>(null);
  useEffect(() => {
    if (!concept) return;
    let alive = true;
    setMd(null);
    fetch(`/concepts/${concept}.md`).then(r => (r.ok ? r.text() : `# ${concept}\nNo card yet.`)).then(t => { if (alive) setMd(t); }).catch(() => undefined);
    return () => { alive = false; };
  }, [concept]);
  if (!concept) return null;
  const blocks = md ? render(md) : [];
  return (
    <div className="modal-backdrop" onClick={() => ui.set({ explain: null })}>
      <div className="modal explain-card" data-testid="explain-card" role="dialog" aria-modal="true" aria-label="Concept card" onClick={e => e.stopPropagation()}>
        {md === null ? <p>Loading…</p> : blocks.map((b, i) => {
          if (b.tag === 'h3') return <h3 key={i}><Inline text={b.text} /></h3>;
          if (b.tag === 'li') return <li key={i}><Inline text={b.text} /></li>;
          return <p key={i}><Inline text={b.text} /></p>;
        })}
        <button type="button" onClick={() => ui.set({ explain: null })}>Close</button>
      </div>
    </div>
  );
}
