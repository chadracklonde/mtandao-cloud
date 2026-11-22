'use client';

import { useCallback, useEffect, useState } from 'react';

type Tab = 'report' | 'sales' | 'cash' | 'tickets' | 'gaps';
type Row = Record<string, unknown>;
type Page = { items: Row[]; next_cursor: string | null };
type Reconciliation = { items: Row[]; summary: Record<string, number>; truncated: boolean };

const TABS: { id: Tab; label: string }[] = [
  { id: 'report', label: 'Rapport' },
  { id: 'sales', label: 'Ventes' },
  { id: 'cash', label: 'Caisse' },
  { id: 'tickets', label: 'Tickets' },
  { id: 'gaps', label: 'Écarts' },
];

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

export function SiteReports({ apiBase, accessToken, siteId }: { apiBase: string; accessToken: string; siteId: string }) {
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
        if (tab === 'report') {
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
  }, [endpoint, accessToken, tab, from, to]);

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
            style={{ ...pill, background: tab === item.id ? '#173b69' : '#e8edf4', color: tab === item.id ? '#fff' : '#173b69' }}>
            {item.label}
            {item.id === 'gaps' && tab === 'gaps' && rows.length > 0 ? ` (${rows.length}${truncated ? '+' : ''})` : ''}
          </button>
        ))}
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12, alignItems: 'end', marginBottom: 14 }}>
        <label style={label}>Du<input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} style={input} /></label>
        <label style={label}>Au<input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} style={input} /></label>
        {tab === 'report' && (
          <label style={label}>Regroupement
            <select value={group} onChange={e => setGroup(e.target.value as 'day' | 'month')} style={input}>
              <option value="day">Par jour</option><option value="month">Par mois</option>
            </select>
          </label>
        )}
      </div>

      {error && <p role="alert" style={errorBox}>{error}</p>}
      {loading && <p style={muted}>Chargement…</p>}
      {!loading && !error && rows.length === 0 && (
        <p style={muted}>{tab === 'gaps' ? 'Aucun écart détecté sur cette période.' : 'Aucune donnée sur cette période.'}</p>
      )}

      {tab === 'gaps' && rows.length > 0 && (
        <p style={{ ...muted, marginBottom: 10 }}>
          {Object.entries(summary).map(([kind, count]) => `${GAP_LABELS[kind] ?? kind} : ${count}`).join(' · ')}
          {truncated ? ' — liste tronquée à 500 écarts, réduisez la période.' : ''}
        </p>
      )}

      {rows.length > 0 && (
        <div style={{ overflowX: 'auto', border: '1px solid #dce3ec', borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 640, textAlign: 'left' }}>
            <thead><tr style={{ background: '#f5f7fa' }}>{headers(tab).map(h => <th key={h} style={th}>{h}</th>)}</tr></thead>
            <tbody>{rows.map((row, index) => <tr key={`${String(row.id ?? row.reference_id ?? row.period)}-${index}`} style={{ borderTop: '1px solid #e7edf3' }}>{cells(tab, row).map((cell, i) => <td key={i} style={td}>{cell}</td>)}</tr>)}</tbody>
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
  return [when(row.occurred_at), GAP_LABELS[String(row.kind)] ?? String(row.kind), JSON.stringify(row.details ?? {})];
}

const panel = { border: '1px solid #dce3ec', borderRadius: 12, padding: 20, marginBottom: 28 };
const label = { display: 'grid', gap: 6, fontSize: 13, fontWeight: 600 };
const input = { border: '1px solid #cbd5e1', borderRadius: 7, padding: '9px 10px', fontSize: 14 };
const pill = { border: 0, borderRadius: 20, padding: '8px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer', background: '#e8edf4', color: '#173b69' };
const muted = { color: '#52627a', margin: 0, fontSize: 13 };
const errorBox = { background: '#fff1f2', color: '#9f1239', padding: 12, borderRadius: 8, fontSize: 13 };
const th = { padding: '13px 14px', fontSize: 12, color: '#475569', whiteSpace: 'nowrap' as const };
const td = { padding: 14, fontSize: 13, verticalAlign: 'top' as const, overflowWrap: 'anywhere' as const };
