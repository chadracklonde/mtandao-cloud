'use client';

import { FormEvent, useState } from 'react';

type Router = {
  id: string;
  name: string;
  router_identity: string;
  gateway_kind: 'android' | 'linux';
  status: string;
  last_seen_at: string | null;
  router_connection_status: 'unknown' | 'online' | 'unavailable';
  router_last_seen_at: string | null;
  created_at: string;
};

const API_BASE = (process.env.NEXT_PUBLIC_MTANDAO_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');

function dateLabel(value: string | null): string {
  if (!value) return 'Jamais';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Date inconnue' : date.toLocaleString('fr-FR');
}

function gatewayLabel(status: string): string {
  if (status === 'online') return 'En ligne';
  if (status === 'offline') return 'Hors ligne';
  if (status === 'pending') return 'En attente';
  if (status === 'suspended') return 'Suspendu';
  if (status === 'revoked') return 'Révoqué';
  return status;
}

function routerLabel(status: Router['router_connection_status']): string {
  if (status === 'online') return 'Disponible';
  if (status === 'unavailable') return 'Injoignable';
  return 'Non vérifié';
}

export default function HomePage() {
  const [siteId, setSiteId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [routers, setRouters] = useState<Router[]>([]);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  async function loadRouters(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError('');
    setLoading(true);
    setLoaded(false);
    try {
      const response = await fetch(`${API_BASE}/v1/sites/${encodeURIComponent(siteId.trim())}/routers`, {
        headers: { Authorization: `Bearer ${accessToken.trim()}`, Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!response.ok) {
        if (response.status === 401 || response.status === 403) throw new Error('Session invalide ou accès non autorisé à ce site.');
        throw new Error(`Impossible de charger les routeurs (HTTP ${response.status}).`);
      }
      const data: unknown = await response.json();
      if (!Array.isArray(data)) throw new Error('Réponse inattendue du serveur.');
      setRouters(data as Router[]);
      setLoaded(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Une erreur est survenue.');
      setRouters([]);
    } finally {
      setLoading(false);
    }
  }

  return (
    <main style={{ maxWidth: 1120, margin: '0 auto', padding: '48px 24px', fontFamily: 'Arial, sans-serif', color: '#172033' }}>
      <header style={{ marginBottom: 32 }}>
        <p style={{ color: '#52627a', fontSize: 13, letterSpacing: 1, fontWeight: 700 }}>GESTION CENTRALISÉE DES SITES WI-FI</p>
        <h1 style={{ fontSize: 34, margin: '8px 0' }}>Mtandao Cloud</h1>
        <p style={{ color: '#52627a', margin: 0 }}>État des passerelles et disponibilité des routeurs MikroTik.</p>
      </header>

      <section style={{ border: '1px solid #dce3ec', borderRadius: 12, padding: 20, marginBottom: 28 }}>
        <h2 style={{ fontSize: 18, marginTop: 0 }}>Sélectionner un site</h2>
        <form onSubmit={loadRouters} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 14, alignItems: 'end' }}>
          <label style={{ display: 'grid', gap: 6, fontSize: 13, fontWeight: 600 }}>
            Identifiant du site (UUID)
            <input required value={siteId} onChange={e => setSiteId(e.target.value)} placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx" style={inputStyle} />
          </label>
          <label style={{ display: 'grid', gap: 6, fontSize: 13, fontWeight: 600 }}>
            Jeton d'accès Supabase
            <input required type="password" autoComplete="off" value={accessToken} onChange={e => setAccessToken(e.target.value)} placeholder="Jeton de session" style={inputStyle} />
          </label>
          <button disabled={loading} type="submit" style={buttonStyle}>{loading ? 'Chargement…' : 'Afficher les routeurs'}</button>
        </form>
        <p style={{ color: '#64748b', fontSize: 12, marginBottom: 0 }}>Le jeton est utilisé uniquement en mémoire pendant cette session et n'est pas enregistré dans le navigateur.</p>
      </section>

      {error && <p role="alert" style={{ background: '#fff1f2', color: '#9f1239', padding: 14, borderRadius: 8 }}>{error}</p>}

      {loaded && (
        <section>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <h2 style={{ fontSize: 20, margin: 0 }}>Routeurs du site</h2>
            <span style={{ color: '#64748b', fontSize: 13 }}>{routers.length} équipement(s)</span>
          </div>
          {routers.length === 0 ? <p style={{ color: '#64748b' }}>Aucun routeur enregistré pour ce site.</p> : (
            <div style={{ overflowX: 'auto', border: '1px solid #dce3ec', borderRadius: 12 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760, textAlign: 'left' }}>
                <thead><tr style={{ background: '#f5f7fa' }}>
                  {['Nom / identité', 'Passerelle', 'Gateway', 'Routeur MikroTik', 'Dernier heartbeat', 'Dernière réponse MikroTik'].map(label => <th key={label} style={thStyle}>{label}</th>)}
                </tr></thead>
                <tbody>{routers.map(router => (
                  <tr key={router.id} style={{ borderTop: '1px solid #e7edf3' }}>
                    <td style={tdStyle}><strong>{router.name}</strong><br /><span style={{ color: '#64748b', fontSize: 12 }}>{router.router_identity}</span></td>
                    <td style={tdStyle}>{router.gateway_kind === 'android' ? 'Android' : 'Linux'}</td>
                    <td style={tdStyle}><Status value={gatewayLabel(router.status)} good={router.status === 'online'} /></td>
                    <td style={tdStyle}><Status value={routerLabel(router.router_connection_status)} good={router.router_connection_status === 'online'} /></td>
                    <td style={tdStyle}>{dateLabel(router.last_seen_at)}</td>
                    <td style={tdStyle}>{dateLabel(router.router_last_seen_at)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </section>
      )}
      <footer style={{ color: '#94a3b8', fontSize: 12, marginTop: 48 }}>Mtandao Cloud · Les états affichés dépendent des dernières données reçues par l'API.</footer>
    </main>
  );
}

function Status({ value, good }: { value: string; good: boolean }) {
  return <span style={{ display: 'inline-block', padding: '5px 9px', borderRadius: 20, background: good ? '#dcfce7' : '#f1f5f9', color: good ? '#166534' : '#475569', fontSize: 12, fontWeight: 700 }}>{value}</span>;
}

const inputStyle = { width: '100%', boxSizing: 'border-box' as const, border: '1px solid #cbd5e1', borderRadius: 7, padding: '11px 12px', fontSize: 14 };
const buttonStyle = { border: 0, borderRadius: 7, background: '#173b69', color: 'white', padding: '12px 18px', fontSize: 14, fontWeight: 700, cursor: 'pointer' };
const thStyle = { padding: '13px 14px', fontSize: 12, color: '#475569', whiteSpace: 'nowrap' as const };
const tdStyle = { padding: '14px', fontSize: 13, verticalAlign: 'top' as const };
