'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';

type StockRow = { plan_id: string; plan_name: string; available: number; reserved: number; sold: number };
type ImportResult = { submitted: number; inserted: number; skipped: number };

const CODE_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;
const BATCH = 1000;

/** Codes may be separated by new lines, spaces, commas or semicolons (Mikhmon / Mtandao Ticket exports). */
export function parseCodes(text: string): { codes: string[]; invalid: string[]; duplicates: number } {
  const seen = new Set<string>();
  const invalid: string[] = [];
  let duplicates = 0;
  for (const raw of text.split(/[\s,;]+/)) {
    const code = raw.trim();
    if (!code) continue;
    if (!CODE_PATTERN.test(code)) {
      if (!invalid.includes(code)) invalid.push(code);
      continue;
    }
    if (seen.has(code)) duplicates += 1;
    else seen.add(code);
  }
  return { codes: [...seen], invalid, duplicates };
}

export function SiteStock({ apiBase, accessToken, siteId, canImport }: { apiBase: string; accessToken: string; siteId: string; canImport: boolean }) {
  const [rows, setRows] = useState<StockRow[] | null>(null);
  const [planId, setPlanId] = useState('');
  const [text, setText] = useState('');
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);

  const headers = useMemo(() => ({ Authorization: `Bearer ${accessToken}`, Accept: 'application/json' }), [accessToken]);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(`${apiBase}/v1/sites/${siteId}/ticket-stock/summary`, { headers, cache: 'no-store', signal });
      if (!response.ok) throw new Error(response.status === 401 ? 'Votre session a expiré. Reconnectez-vous.' : `Chargement du stock impossible (HTTP ${response.status}).`);
      const data = (await response.json()) as StockRow[];
      setRows(data);
      setPlanId(current => (data.some(row => row.plan_id === current) ? current : (data[0]?.plan_id ?? '')));
    },
    [apiBase, siteId, headers],
  );

  useEffect(() => {
    const controller = new AbortController();
    setRows(null);
    setError('');
    setMessage('');
    load(controller.signal).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Chargement du stock impossible.');
    });
    return () => controller.abort();
  }, [load]);

  const parsed = useMemo(() => parseCodes(text), [text]);
  const plan = rows?.find(row => row.plan_id === planId);

  async function readFile(file: File | undefined) {
    if (!file) return;
    if (file.size > 2_000_000) {
      setError('Fichier trop volumineux (2 Mo maximum).');
      return;
    }
    setError('');
    setText(await file.text());
  }

  async function submit() {
    if (!planId || parsed.codes.length === 0 || parsed.invalid.length > 0) return;
    setBusy(true);
    setError('');
    setMessage('');
    const total: ImportResult = { submitted: 0, inserted: 0, skipped: 0 };
    try {
      for (let start = 0; start < parsed.codes.length; start += BATCH) {
        const response = await fetch(`${apiBase}/v1/sites/${siteId}/plans/${planId}/ticket-stock`, {
          method: 'POST',
          headers: { ...headers, 'Content-Type': 'application/json' },
          body: JSON.stringify({ codes: parsed.codes.slice(start, start + BATCH) }),
        });
        if (!response.ok) {
          const done = total.inserted > 0 ? ` ${total.inserted} code(s) déjà ajouté(s) avant l’interruption ; relancer ne crée pas de doublon.` : '';
          throw new Error(`Import refusé (HTTP ${response.status}).${done}`);
        }
        const result = (await response.json()) as ImportResult;
        total.submitted += result.submitted;
        total.inserted += result.inserted;
        total.skipped += result.skipped;
      }
      setMessage(`${total.inserted} code(s) ajouté(s)${total.skipped ? `, ${total.skipped} ignoré(s) car déjà présents` : ''}.`);
      setText('');
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Import impossible.');
      await load().catch(() => undefined);
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = canImport && !busy && !!planId && parsed.codes.length > 0 && parsed.invalid.length === 0;

  return (
    <section style={panel}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>Stock de tickets</h2>
      <p style={{ ...muted, marginBottom: 14 }}>Importez les codes déjà créés sur le routeur (Mikhmon ou Mtandao Ticket). Ils seront vendus un par un selon le forfait choisi. Un code déjà présent est ignoré.</p>

      {error && <p role="alert" style={errorBox}>{error}</p>}
      {message && <p role="status" style={okBox}>{message}</p>}
      {!rows && !error && <p style={muted}>Chargement…</p>}
      {rows && rows.length === 0 && <p style={muted}>Aucun forfait : définissez d’abord les tarifs du site.</p>}

      {rows && rows.length > 0 && (
        <>
          <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 12, marginBottom: 16 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 480, textAlign: 'left' }}>
              <thead><tr style={{ background: 'var(--surface-2)' }}>{['Forfait', 'Disponibles', 'Réservés', 'Vendus'].map(label => <th key={label} style={th}>{label}</th>)}</tr></thead>
              <tbody>
                {rows.map(row => (
                  <tr key={row.plan_id} style={{ borderTop: '1px solid var(--border)' }}>
                    <td style={td}><strong>{row.plan_name}</strong></td>
                    <td style={{ ...td, color: row.available === 0 ? 'var(--warn)' : undefined }}>{row.available}{row.available === 0 ? ' — vide' : ''}</td>
                    <td style={td}>{row.reserved}</td>
                    <td style={td}>{row.sold}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {canImport ? (
            <div style={{ display: 'grid', gap: 12 }}>
              <label style={label}>Forfait concerné
                <select value={planId} onChange={event => setPlanId(event.target.value)} style={input}>
                  {rows.map(row => <option key={row.plan_id} value={row.plan_id}>{row.plan_name}</option>)}
                </select>
              </label>
              <label style={label}>Codes (un par ligne, ou séparés par des virgules)
                <textarea value={text} onChange={event => setText(event.target.value)} rows={6} spellCheck={false} placeholder={'ab12cd\nef34gh'} style={{ ...input, fontFamily: 'monospace' }} />
              </label>
              <label style={label}>… ou un fichier texte / CSV
                <input type="file" accept=".txt,.csv,text/plain,text/csv" onChange={event => void readFile(event.target.files?.[0])} />
              </label>

              {text.trim() !== '' && (
                <p role="status" style={parsed.invalid.length ? errorBox : muted}>
                  {parsed.codes.length} code(s) valide(s){parsed.duplicates ? `, ${parsed.duplicates} doublon(s) dans la liste` : ''}
                  {parsed.invalid.length > 0 && ` — ${parsed.invalid.length} code(s) refusé(s) (lettres, chiffres, point, tiret et soulignement uniquement, 64 caractères max) : ${parsed.invalid.slice(0, 5).join(', ')}${parsed.invalid.length > 5 ? '…' : ''}`}
                </p>
              )}
              <div>
                <button type="button" disabled={!canSubmit} onClick={() => void submit()} style={{ ...button, opacity: canSubmit ? 1 : 0.5 }}>
                  {busy ? 'Import en cours…' : `Importer ${parsed.codes.length || ''} code(s)${plan ? ` dans « ${plan.plan_name} »` : ''}`}
                </button>
              </div>
            </div>
          ) : (
            <p style={muted}>Seuls le propriétaire, les administrateurs et les gestionnaires peuvent importer des codes.</p>
          )}
        </>
      )}
    </section>
  );
}

const panel = { border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 28 };
const muted = { color: 'var(--muted-fg)', margin: 0, fontSize: 13 };
const label = { display: 'grid', gap: 6, fontSize: 13, fontWeight: 600 };
const input = { border: '1px solid var(--border-strong)', borderRadius: 7, padding: '9px 10px', fontSize: 14, width: '100%', boxSizing: 'border-box' as const };
const button = { border: 0, borderRadius: 7, background: 'var(--primary)', color: 'var(--on-primary)', padding: '10px 16px', fontSize: 13, fontWeight: 700, cursor: 'pointer' };
const th = { padding: '13px 14px', fontSize: 12, color: 'var(--muted-fg)', whiteSpace: 'nowrap' as const };
const td = { padding: 14, fontSize: 13, verticalAlign: 'middle' as const };
const errorBox = { background: 'var(--danger-bg)', color: 'var(--danger)', padding: 12, borderRadius: 8, fontSize: 13, margin: 0 };
const okBox = { background: 'var(--ok-bg)', color: 'var(--ok)', padding: 12, borderRadius: 8, fontSize: 13 };
