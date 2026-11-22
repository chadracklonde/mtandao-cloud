'use client';

import { useCallback, useEffect, useState } from 'react';
import { downloadCsv, toCsv } from './csv';

type Tab = 'report' | 'sales' | 'cash' | 'tickets' | 'gaps' | 'conflicts';
type Row = Record<string, unknown>;
type Page = { items: Row[]; next_cursor: string | null };
type Reconciliation = { items: Row[]; summary: Record<string, number>; truncated: boolean };

const TABS: { id: Tab; label: string }[] = [
  { id: 'report', label: 'Rapport' },
  { id: 'sales', label: 'Ventes' },
  { id: 'cash', label: 'Caisse' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'gaps', label: 'Écarts' },
  { id: 'conflicts', label: 'Conflits' },
];

const CONFLICT_LABELS: Record<string, string> = {
  sale_mismatch: 'Même vente reçue avec des données différentes',
  ticket_code_taken: 'Code de ticket déjà utilisé par une autre vente',
  concurrent_duplicate: 'Doublon simultané',
};

const GAP_LABELS: Record<string, string> = {
  cash_entry_missing: 'Vente en espèces sans entrée de caisse',
  cash_entry_mismatch: 'Montant de caisse différent de la vente',
  cash_entry_unexpected: 'Entrée de caisse pour une vente non payée en espèces',
  ticket_missing: 'Vente sans ticket correspondant',
  sync_conflict_open: 'Conflit de synchronisation à traiter',
  sync_event_rejected: 'Événement rejeté par le serveur',
  sync_event_stuck: 'Événement en attente de traitement',
};

const METHOD_LABELS: Record<string, string> = { cash: 'Espèces', mobile_money: 'Mobile Money' };

function isoDay(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function money(value: unknown, currency: unknown): string {
  const amount = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(amount)) return '—';
  return `${amount.toLocaleString('fr-FR', { minimumFractionDigits: 0, maximumFractionDigits: 2 })} ${String(currency ?? '')}`.trim();
}

function when(value: unknown): string {
  if (typeof value !== 'string') return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? '—' : date.toLocaleString('fr-FR');
}

async function getJson<T>(url: string, token: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    cache: 'no-store',
    signal,
  });
  if (response.status === 403) throw new Error('Votre rôle ne permet pas de consulter cette section.');
  if (response.status === 401) throw new Error('Votre session a expiré. Reconnectez-vous.');
  if (!response.ok) throw new Error(`Chargement impossible (HTTP ${response.status}).`);
  return (await response.json()) as T;
}

export function SiteReports({ apiBase, accessToken, siteId, canResolve = false }: { apiBase: string; accessToken: string; siteId: string; canResolve?: boolean }) {
  const [tab, setTab] = useState<Tab>('report');
  const [from, setFrom] = useState(() => isoDay(new Date(Date.now() - 29 * 86400000)));
  const [to, setTo] = useState(() => isoDay(new Date()));
  const [group, setGroup] = useState<'day' | 'month'>('day');
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [summary, setSummary] = useState<Record<string, number>>({});
  const [truncated, setTruncated] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);
  const [resolving, setResolving] = useState('');
  const [reload, setReload] = useState(0);

  const range = useCallback((): string => {
    // `to` is an inclusive day for the user, exclusive instant for the API.
    const end = new Date(`${to}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    return `from=${encodeURIComponent(`${from}T00:00:00Z`)}&to=${encodeURIComponent(end.toISOString())}`;
  }, [from, to]);

  const endpoint = useCallback(
    (after?: string | null): string => {
      const base = `${apiBase}/v1/sites/${siteId}`;
      const paging = after ? `&cursor=${encodeURIComponent(after)}` : '';
      if (tab === 'report') return `${base}/reports/sales?${range()}&group=${group}`;
      if (tab === 'gaps') return `${base}/reports/reconciliation?${range()}`;
      if (tab === 'conflicts') return `${base}/reports/conflicts?status=open`;
      const path = tab === 'sales' ? 'sales' : tab === 'cash' ? 'cash-entries' : 'tickets';
      return `${base}/${path}?${range()}&limit=50${paging}`;
    },
    [apiBase, siteId, tab, range, group],
  );

  useEffect(() => {
    if (new Date(`${from}T00:00:00Z`) > new Date(`${to}T00:00:00Z`)) {
      setError('La date de début doit précéder la date de fin.');
      setRows([]);
      return;
    }
    const controller = new AbortController();
    setLoading(true);
    setError('');
    setRows([]);
    setCursor(null);
    getJson<unknown>(endpoint(), accessToken, controller.signal)
      .then(data => {
        if (tab === 'report' || tab === 'conflicts') {
          setRows(data as Row[]);
        } else if (tab === 'gaps') {
          const rec = data as Reconciliation;
          setRows(rec.items);
          setSummary(rec.summary);
          setTruncated(rec.truncated);
        } else {
          const page = data as Page;
          setRows(page.items);
          setCursor(page.next_cursor);
        }
      })
      .catch(reason => {
        if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Chargement impossible.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [endpoint, accessToken, tab, from, to, reload]);

  async function exportCsv() {
    setExporting(true);
    setError('');
    try {
      let all = rows;
      let next = cursor;
      const controller = new AbortController();
      while (next && all.length < 10000) {
        const page = await getJson<Page>(endpoint(next), accessToken, controller.signal);
        all = [...all, ...page.items];
        next = page.next_cursor;
      }
      const name = TABS.find(item => item.id === tab)?.label.toLowerCase() ?? 'export';
      downloadCsv(`mtandao-${name}-${from}-${to}.csv`, toCsv(headers(tab), all.map(row => cells(tab, row))));
      if (next) setError('Export limité à 10 000 lignes : réduisez la période pour obtenir le reste.');
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Export impossible.');
    } finally {
      setExporting(false);
    }
  }

  async function resolve(id: string, resolution: 'keep_cloud' | 'dismissed') {
    const note = window.prompt('Note (facultatif) : pourquoi cette décision ?') ?? undefined;
    if (note === undefined) return;
    setResolving(id);
    setError('');
    try {
      const response = await fetch(`${apiBase}/v1/sites/${siteId}/reports/conflicts/${id}/resolve`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ resolution, ...(note.trim() ? { note: note.trim() } : {}) }),
      });
      if (response.status === 403) throw new Error('Votre rôle ne permet pas de résoudre un conflit.');
      if (!response.ok && response.status !== 409) throw new Error(`Résolution impossible (HTTP ${response.status}).`);
      setReload(value => value + 1);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Résolution impossible.');
    } finally {
      setResolving('');
    }
  }

  async function loadMore() {
    if (!cursor) return;
    setLoading(true);
    try {
      const page = await getJson<Page>(endpoint(cursor), accessToken, new AbortController().signal);
      setRows(current => [...current, ...page.items]);
      setCursor(page.next_cursor);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Chargement impossible.');
    } finally {
      setLoading(false);
    }
  }

  return (
    <section style={panel}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>Activité commerciale</h2>
      <div role="tablist" style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 14 }}>
        {TABS.map(item => (
          <button key={item.id} role="tab" aria-selected={tab === item.id} type="button" onClick={() => setTab(item.id)}
            style={{ ...pill, background: tab === item.id ? 'var(--primary)' : 'var(--primary-soft)', color: tab === item.id ? 'var(--on-primary)' : 'var(--primary-fg)' }}>
            {item.label}
            {item.id === 'gaps' && tab === 'gaps' && rows.length > 0 ? ` (${rows.length}${truncated ? '+' : ''})` : ''}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'end', marginBottom: 14 }}>
        {tab !== 'conflicts' && <label style={label}>Du<input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} style={input} /></label>}
        {tab !== 'conflicts' && <label style={label}>Au<input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} style={input} /></label>}
        {tab === 'report' && (
          <label style={label}>Regroupement
            <select value={group} onChange={e => setGroup(e.target.value as 'day' | 'month')} style={input}>
              <option value="day">Par jour</option><option value="month">Par mois</option>
            </select>
          </label>
        )}
        {tab !== 'gaps' && tab !== 'conflicts' && rows.length > 0 && (
          <button type="button" disabled={exporting || loading} onClick={() => void exportCsv()} style={pill}>{exporting ? 'Export…' : 'Exporter en CSV'}</button>
        )}
      </div>

      {error && <p role="alert" style={errorBox}>{error}</p>}
      {loading && <p style={muted}>Chargement…</p>}
      {!loading && !error && rows.length === 0 && (
        <p style={muted}>{tab === 'gaps' ? 'Aucun écart détecté sur cette période.' : tab === 'conflicts' ? 'Aucun conflit en attente.' : 'Aucune donnée sur cette période.'}</p>
      )}

      {tab === 'gaps' && rows.length > 0 && (
        <p style={{ ...muted, marginBottom: 10 }}>
          {Object.entries(summary).map(([kind, count]) => `${GAP_LABELS[kind] ?? kind} : ${count}`).join(' · ')}
          {truncated ? ' — liste tronquée à 500 écarts, réduisez la période.' : ''}
        </p>
      )}

      {rows.length > 0 && (
        <div style={{ overflowX: 'auto', border: '1px solid var(--border)', borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640, textAlign: 'left' }}>
            <thead><tr style={{ background: 'var(--surface-2)' }}>{headers(tab).map(h => <th key={h} style={th}>{h}</th>)}{tab === 'conflicts' && canResolve && <th style={th}>Décision</th>}</tr></thead>
            <tbody>{rows.map((row, index) => <tr key={`${String(row.id ?? row.reference_id ?? row.period)}-${index}`} style={{ borderTop: '1px solid var(--border)' }}>{cells(tab, row).map((cell, i) => <td key={i} style={td}>{cell}</td>)}{tab === 'conflicts' && canResolve && (
              <td style={td}><div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                <button type="button" disabled={resolving === String(row.id)} onClick={() => void resolve(String(row.id), 'keep_cloud')} style={pill} title="La version déjà enregistrée par le Cloud reste la référence">Garder la version du Cloud</button>
                <button type="button" disabled={resolving === String(row.id)} onClick={() => void resolve(String(row.id), 'dismissed')} style={pill} title="Écarter sans autre action">Écarter</button>
              </div></td>)}</tr>)}</tbody>
          </table>
        </div>
      )}

      {cursor && <button type="button" disabled={loading} onClick={() => void loadMore()} style={{ ...pill, marginTop: 14 }}>Charger plus</button>}
    </section>
  );
}

function headers(tab: Tab): string[] {
  if (tab === 'report') return ['Période', 'Devise', 'Ventes', 'Total', 'Espèces', 'Mobile Money'];
  if (tab === 'sales') return ['Date', 'Forfait', 'Montant', 'Paiement', 'Ticket'];
  if (tab === 'cash') return ['Date', 'Sens', 'Montant'];
  if (tab === 'tickets') return ['Date', 'Code', 'Statut'];
  if (tab === 'conflicts') return ['Reçu le', 'Type', 'Détail'];
  return ['Date', 'Écart', 'Détail'];
}

function cells(tab: Tab, row: Row): string[] {
  if (tab === 'report') {
    return [String(row.period ?? ''), String(row.currency ?? ''), String(row.sales_count ?? 0),
      money(row.total_amount, row.currency), money(row.cash_amount, row.currency), money(row.mobile_money_amount, row.currency)];
  }
  if (tab === 'sales') {
    return [when(row.sold_at), String(row.plan_name ?? '—'), money(row.amount, row.currency),
      METHOD_LABELS[String(row.payment_method)] ?? String(row.payment_method ?? '—'), String(row.ticket_code ?? '—')];
  }
  if (tab === 'cash') return [when(row.occurred_at), row.direction === 'out' ? 'Sortie' : 'Entrée', money(row.amount, row.currency)];
  if (tab === 'tickets') return [when(row.created_at), String(row.code ?? ''), String(row.status ?? '')];
  if (tab === 'conflicts') return [when(row.created_at), CONFLICT_LABELS[String(row.conflict_type)] ?? String(row.conflict_type), JSON.stringify(row.details ?? {})];
  return [when(row.occurred_at), GAP_LABELS[String(row.kind)] ?? String(row.kind), JSON.stringify(row.details ?? {})];
}

const panel = { border: '1px solid var(--border)', borderRadius: 12, padding: 20, marginBottom: 28 };
const label = { display: 'grid', gap: 6, fontSize: 13, fontWeight: 600 };
const input = { border: '1px solid var(--border-strong)', borderRadius: 7, padding: '9px 10px', fontSize: 14 };
const pill = { border: 0, borderRadius: 20, padding: '8px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer', background: 'var(--primary-soft)', color: 'var(--primary-fg)' };
const muted = { color: 'var(--muted-fg)', margin: 0, fontSize: 13 };
const errorBox = { background: 'var(--danger-bg)', color: 'var(--danger)', padding: 12, borderRadius: 8, fontSize: 13 };
const th = { padding: '13px 14px', fontSize: 12, color: 'var(--muted-fg)', whiteSpace: 'nowrap' as const };
const td = { padding: 14, fontSize: 13, verticalAlign: 'top' as const, overflowWrap: 'anywhere' as const };
