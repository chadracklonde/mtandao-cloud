'use client';

import { FormEvent, useEffect, useRef, useState } from 'react';

type Turn = { role: 'user' | 'assistant'; content: string; tools?: string[] };

const SUGGESTIONS = [
  'Quelles sont les ventes de cette semaine ?',
  'Quels écarts de rapprochement dois-je traiter ?',
  'Quels forfaits n’ont plus de stock ?',
  'Mes passerelles sont-elles en ligne ?',
  'Les cinq tarifs sont-ils bien définis ?',
];

const TOOL_LABELS: Record<string, string> = {
  get_sales_summary: 'totaux des ventes',
  get_reconciliation: 'rapprochement',
  list_recent_sales: 'dernières ventes',
  list_payments: 'paiements',
  get_pricing: 'tarifs',
  get_stock: 'stock de tickets',
  list_routers: 'routeurs',
};

const MAX_QUESTION = 500;

export function SiteAssistant({ apiBase, accessToken, siteId }: { apiBase: string; accessToken: string; siteId: string }) {
  const [question, setQuestion] = useState('');
  const [turns, setTurns] = useState<Turn[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const end = useRef<HTMLDivElement>(null);

  // A different site is a different conversation.
  useEffect(() => {
    setTurns([]);
    setError('');
    setQuestion('');
  }, [siteId]);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'nearest' });
  }, [turns, loading]);

  async function ask(text: string) {
    const trimmed = text.trim();
    if (!trimmed || trimmed.length > MAX_QUESTION || loading) return;
    setError('');
    setLoading(true);
    const history = turns.slice(-6).map(({ role, content }) => ({ role, content: content.slice(0, 2000) }));
    setTurns(current => [...current, { role: 'user', content: trimmed }]);
    setQuestion('');
    try {
      const response = await fetch(`${apiBase}/v1/sites/${siteId}/assistant`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ question: trimmed, history }),
      });
      if (response.status === 401) throw new Error('Votre session a expiré. Reconnectez-vous.');
      if (response.status === 429) throw new Error('Trop de questions en peu de temps. Patientez un instant.');
      if (response.status === 503) throw new Error('L’assistant n’est pas disponible pour le moment.');
      if (!response.ok) throw new Error('L’assistant n’a pas pu répondre. Réessayez.');
      const data = (await response.json()) as { answer: string; toolsUsed?: Array<{ name: string }> };
      const tools = Array.from(new Set((data.toolsUsed ?? []).map(tool => TOOL_LABELS[tool.name] ?? tool.name)));
      setTurns(current => [...current, { role: 'assistant', content: data.answer, tools }]);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'L’assistant n’a pas pu répondre.');
    } finally {
      setLoading(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    void ask(question);
  }

  return (
    <section style={panel} aria-label="Assistant analytique">
      <h2 style={{ fontSize: 18, marginTop: 0 }}>Assistant</h2>
      <p style={{ ...muted, marginBottom: 12 }}>
        Posez une question sur les ventes, la caisse, les paiements, les tarifs, le stock ou les routeurs de ce site. L’assistant consulte vos données en lecture seule : il ne modifie rien. Vérifiez les chiffres importants avant de les utiliser.
      </p>

      {turns.length === 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
          {SUGGESTIONS.map(suggestion => (
            <button key={suggestion} type="button" disabled={loading} onClick={() => void ask(suggestion)} style={chip}>{suggestion}</button>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gap: 10, marginBottom: 12 }} aria-live="polite">
        {turns.map((turn, index) => (
          <div key={index} style={turn.role === 'user' ? userBubble : answerBubble}>
            <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{turn.content}</div>
            {turn.tools && turn.tools.length > 0 && <div style={{ ...muted, marginTop: 8, fontSize: 12 }}>Données consultées : {turn.tools.join(', ')}</div>}
          </div>
        ))}
        {loading && <div style={{ ...answerBubble, color: '#52627a' }}>Analyse en cours…</div>}
        <div ref={end} />
      </div>

      {error && <p role="alert" style={errorBox}>{error}</p>}

      <form onSubmit={submit} style={{ display: 'flex', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
        <label style={{ flex: '1 1 260px' }}>
          <span style={{ position: 'absolute', left: -9999 }}>Votre question</span>
          <input
            value={question}
            maxLength={MAX_QUESTION}
            onChange={event => setQuestion(event.target.value)}
            placeholder="Ex. Quel est le chiffre d’affaires du mois dernier ?"
            style={input}
          />
        </label>
        <button type="submit" disabled={loading || question.trim().length === 0} style={{ ...button, opacity: loading || question.trim().length === 0 ? 0.5 : 1 }}>Demander</button>
        {turns.length > 0 && <button type="button" onClick={() => { setTurns([]); setError(''); }} style={secondary}>Nouvelle conversation</button>}
      </form>
      <p style={{ ...muted, marginTop: 10, fontSize: 12 }}>Les questions et les chiffres consultés sont traités par Anthropic pour produire la réponse. La plateforme ne transmet ni les codes de tickets ni les numéros de téléphone des clients.</p>
    </section>
  );
}

const panel = { border: '1px solid #dce3ec', borderRadius: 12, padding: 20, marginBottom: 28 };
const muted = { color: '#52627a', margin: 0, fontSize: 13 };
const input = { width: '100%', boxSizing: 'border-box' as const, border: '1px solid #cbd5e1', borderRadius: 8, padding: '12px', fontSize: 14 };
const button = { border: 0, borderRadius: 8, background: '#173b69', color: '#fff', padding: '12px 18px', fontSize: 14, fontWeight: 700, cursor: 'pointer' };
const secondary = { ...button, background: '#e8edf4', color: '#173b69' };
const chip = { border: '1px solid #cbd5e1', borderRadius: 20, background: '#fff', color: '#173b69', padding: '8px 12px', fontSize: 13, cursor: 'pointer' };
const userBubble = { justifySelf: 'end', maxWidth: '85%', background: '#173b69', color: '#fff', padding: '10px 14px', borderRadius: 12, fontSize: 14 };
const answerBubble = { justifySelf: 'start', maxWidth: '95%', background: '#f1f5f9', color: '#172033', padding: '12px 14px', borderRadius: 12, fontSize: 14 };
const errorBox = { background: '#fff1f2', color: '#9f1239', padding: 12, borderRadius: 8, fontSize: 13 };
