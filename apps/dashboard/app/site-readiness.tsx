'use client';

import { useCallback, useEffect, useState } from 'react';

type Check = { id: string; label: string; status: 'ok' | 'warn' | 'fail' | 'unknown'; detail: string };
type Readiness = { ready: boolean; checks: Check[] };

const ICON: Record<Check['status'], string> = { ok: '✓', warn: '!', fail: '✕', unknown: '?' };
const COLORS: Record<Check['status'], { bg: string; fg: string }> = {
  ok: { bg: '#dcfce7', fg: '#166534' },
  warn: { bg: '#fffbeb', fg: '#854d0e' },
  fail: { bg: '#fff1f2', fg: '#9f1239' },
  unknown: { bg: '#f1f5f9', fg: '#475569' },
};
const STATUS_TEXT: Record<Check['status'], string> = { ok: 'OK', warn: 'À surveiller', fail: 'Bloquant', unknown: 'Inconnu' };

export function SiteReadiness({ apiBase, accessToken, siteId }: { apiBase: string; accessToken: string; siteId: string }) {
  const [data, setData] = useState<Readiness | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError('');
      try {
        const response = await fetch(`${apiBase}/v1/sites/${siteId}/readiness`, {
          headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
          cache: 'no-store',
          signal,
        });
        if (!response.ok) throw new Error(response.status === 401 ? 'Votre session a expiré. Reconnectez-vous.' : `Vérification impossible (HTTP ${response.status}).`);
        setData((await response.json()) as Readiness);
      } catch (reason) {
        if (!signal?.aborted) setError(reason instanceof Error ? reason.message : 'Vérification impossible.');
      } finally {
        if (!signal?.aborted) setLoading(false);
      }
    },
    [apiBase, accessToken, siteId],
  );

  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    void load(controller.signal);
    return () => controller.abort();
  }, [load]);

  const blockers = data ? data.checks.filter(check => check.status === 'fail').length : 0;

  return (
    <section style={panel} aria-label="Prêt pour la vente">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <h2 style={{ fontSize: 18, margin: 0 }}>Prêt pour la vente ?</h2>
        <button type="button" onClick={() => void load()} disabled={loading} style={{ ...button, opacity: loading ? 0.6 : 1 }}>{loading ? 'Vérification…' : 'Actualiser'}</button>
      </div>

      {error && <p role="alert" style={{ ...box, background: '#fff1f2', color: '#9f1239', marginTop: 14 }}>{error}</p>}

      {data && (
        <>
          <p role="status" style={{ ...box, marginTop: 14, ...(data.ready ? { background: '#dcfce7', color: '#166534' } : { background: '#fff1f2', color: '#9f1239' }) }}>
            {data.ready ? 'Le site peut vendre. Vérifiez les points à surveiller ci-dessous.' : `${blockers} point(s) bloquant(s) à régler avant de vendre.`}
          </p>
          <ul style={{ listStyle: 'none', padding: 0, margin: '14px 0 0', display: 'grid', gap: 8 }}>
            {data.checks.map(check => (
              <li key={check.id} style={{ display: 'flex', gap: 12, alignItems: 'flex-start', border: '1px solid #e7edf3', borderRadius: 10, padding: '10px 12px' }}>
                <span aria-hidden="true" style={{ width: 24, height: 24, borderRadius: 12, flex: '0 0 24px', display: 'grid', placeItems: 'center', fontWeight: 700, fontSize: 13, background: COLORS[check.status].bg, color: COLORS[check.status].fg }}>{ICON[check.status]}</span>
                <div>
                  <strong style={{ fontSize: 14 }}>{check.label}</strong>{' '}
                  <span style={{ fontSize: 12, color: COLORS[check.status].fg, fontWeight: 700 }}>{STATUS_TEXT[check.status]}</span>
                  <div style={{ fontSize: 13, color: '#52627a', marginTop: 2 }}>{check.detail}</div>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {!data && !error && <p style={{ color: '#52627a', fontSize: 13, margin: '14px 0 0' }}>Vérification…</p>}
    </section>
  );
}

const panel = { border: '1px solid #dce3ec', borderRadius: 12, padding: 20, marginBottom: 28 };
const box = { padding: 12, borderRadius: 8, fontSize: 13, margin: 0 };
const button = { border: 0, borderRadius: 8, background: '#e8edf4', color: '#173b69', padding: '9px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer' };
