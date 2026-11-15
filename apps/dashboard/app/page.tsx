'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { Session } from '@supabase/supabase-js';
import { createClient } from '../lib/supabase/client';

type Site = {
  id: string;
  name: string;
  default_currency: 'CDF' | 'USD';
  timezone: string;
  status: string;
  created_at: string;
  role: string;
};

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
  const supabase = useMemo(() => {
    try {
      return createClient();
    } catch {
      return null;
    }
  }, []);
  const [session, setSession] = useState<Session | null>(null);
  const [authReady, setAuthReady] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState('');
  const [authLoading, setAuthLoading] = useState(false);
  const [sites, setSites] = useState<Site[]>([]);
  const [newSiteName, setNewSiteName] = useState('');
  const [newSiteCurrency, setNewSiteCurrency] = useState<'CDF' | 'USD'>('CDF');
  const [creatingSite, setCreatingSite] = useState(false);
  const [siteMessage, setSiteMessage] = useState('');
  const [siteId, setSiteId] = useState('');
  const [routers, setRouters] = useState<Router[]>([]);
  const [routerName, setRouterName] = useState('');
  const [routerIdentity, setRouterIdentity] = useState('');
  const [gatewayKind, setGatewayKind] = useState<'android' | 'linux'>('linux');
  const [registeringRouter, setRegisteringRouter] = useState(false);
  const [enrollment, setEnrollment] = useState<{ routerId: string; enrollmentToken: string; expiresInSeconds: number } | null>(null);
  const [enrollmentCopied, setEnrollmentCopied] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!supabase) {
      setAuthReady(true);
      return;
    }
    let active = true;
    supabase.auth.getSession().then(({ data }) => {
      if (active) {
        setSession(data.session);
        setAuthReady(true);
      }
    });
    const { data: listener } = supabase.auth.onAuthStateChange((_event, nextSession) => {
      setSession(nextSession);
      setSites([]);
      setSiteId('');
      setRouters([]);
      setLoaded(false);
      setError('');
    });
    return () => {
      active = false;
      listener.subscription.unsubscribe();
    };
  }, [supabase]);

  useEffect(() => {
    if (!session?.access_token) {
      setSites([]);
      return;
    }
    let active = true;
    fetch(`${API_BASE}/v1/sites`, {
      headers: { Authorization: `Bearer ${session.access_token}`, Accept: 'application/json' },
      cache: 'no-store',
    }).then(async response => {
      if (!response.ok) throw new Error(response.status === 401 ? 'Votre session a expiré. Reconnectez-vous.' : `Chargement des sites impossible (HTTP ${response.status}).`);
      return response.json() as Promise<Site[]>;
    }).then(data => {
      if (active) {
        setSites(data);
        setSiteId(current => current && data.some(site => site.id === current) ? current : data[0]?.id ?? '');
      }
    }).catch(err => {
      if (active) setError(err instanceof Error ? err.message : 'Erreur lors du chargement des sites.');
    });
    return () => { active = false; };
  }, [session?.access_token]);

  async function signIn(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setAuthError('');
    if (!supabase) {
      setAuthError('La connexion Supabase n’est pas encore configurée.');
      return;
    }
    setAuthLoading(true);
    try {
      const { error: signInError } = await supabase.auth.signInWithPassword({ email: email.trim(), password });
      if (signInError) throw signInError;
      setPassword('');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Connexion impossible.');
    } finally {
      setAuthLoading(false);
    }
  }

  async function createSite(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session?.access_token) return;
    setError('');
    setSiteMessage('');
    setCreatingSite(true);
    try {
      const response = await fetch(`${API_BASE}/v1/sites`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          name: newSiteName.trim(),
          defaultCurrency: newSiteCurrency,
          timezone: 'Africa/Lubumbashi',
        }),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `Création du site impossible (HTTP ${response.status}).`);
      }
      const created = await response.json() as { id: string };
      const refresh = await fetch(`${API_BASE}/v1/sites`, {
        headers: { Authorization: `Bearer ${session.access_token}`, Accept: 'application/json' },
        cache: 'no-store',
      });
      if (!refresh.ok) throw new Error('Le site a été créé, mais la liste n’a pas pu être actualisée. Rechargez la page.');
      const data = await refresh.json() as Site[];
      setSites(data);
      setSiteId(created.id);
      setNewSiteName('');
      setSiteMessage('Votre site Wi-Fi a été créé avec succès.');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Une erreur est survenue pendant la création du site.');
    } finally {
      setCreatingSite(false);
    }
  }

  async function loadRouters() {
    if (!session?.access_token || !siteId) return;
    setError('');
    setLoading(true);
    setLoaded(false);
    try {
      const response = await fetch(`${API_BASE}/v1/sites/${encodeURIComponent(siteId)}/routers`, {
        headers: { Authorization: `Bearer ${session.access_token}`, Accept: 'application/json' },
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

  async function registerRouter(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!session?.access_token || !siteId) return;
    setError('');
    setEnrollment(null);
    setEnrollmentCopied(false);
    setRegisteringRouter(true);
    try {
      const response = await fetch(`${API_BASE}/v1/sites/${encodeURIComponent(siteId)}/routers`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          name: routerName.trim(),
          routerIdentity: routerIdentity.trim(),
          gatewayKind,
        }),
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `Enregistrement du routeur impossible (HTTP ${response.status}).`);
      }
      const result = await response.json() as { routerId: string; enrollmentToken: string; expiresInSeconds: number };
      setEnrollment(result);
      setRouterName('');
      setRouterIdentity('');
      await loadRouters();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Une erreur est survenue pendant l’enregistrement du routeur.');
    } finally {
      setRegisteringRouter(false);
    }
  }

  async function revokeRouter(router: Router) {
    if (!session?.access_token || !siteId) return;
    const confirmed = window.confirm(`Révoquer la passerelle de « ${router.name} » ? Son jeton actuel sera immédiatement invalidé.`);
    if (!confirmed) return;
    setError('');
    try {
      const response = await fetch(`${API_BASE}/v1/sites/${encodeURIComponent(siteId)}/routers/${encodeURIComponent(router.id)}/revoke`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `Révocation impossible (HTTP ${response.status}).`);
      }
      await loadRouters();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'La révocation a échoué.');
    }
  }

  async function reenrollRouter(router: Router) {
    if (!session?.access_token || !siteId) return;
    const confirmed = window.confirm(`Générer un nouveau code d’enrôlement pour « ${router.name} » ? L’ancien jeton reste révoqué.`);
    if (!confirmed) return;
    setError('');
    setEnrollment(null);
    setEnrollmentCopied(false);
    setRegisteringRouter(true);
    try {
      const response = await fetch(`${API_BASE}/v1/sites/${encodeURIComponent(siteId)}/routers/${encodeURIComponent(router.id)}/reenroll`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${session.access_token}`,
          Accept: 'application/json',
        },
      });
      if (!response.ok) {
        const detail = await response.text();
        throw new Error(detail || `Réenrôlement impossible (HTTP ${response.status}).`);
      }
      const result = await response.json() as { routerId: string; enrollmentToken: string; expiresInSeconds: number };
      setEnrollment(result);
      await loadRouters();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Le réenrôlement a échoué.');
    } finally {
      setRegisteringRouter(false);
    }
  }

  async function signOut() {
    if (!supabase) return;
    await supabase.auth.signOut();
    setSession(null);
  }

  if (!authReady) return <main style={shellStyle}><p>Vérification de la session…</p></main>;

  if (!supabase) return (
    <main style={shellStyle}>
      <p style={eyebrowStyle}>GESTION CENTRALISÉE DES SITES WI-FI</p>
      <h1 style={{ fontSize: 34, margin: '8px 0' }}>Mtandao Cloud</h1>
      <section style={panelStyle}>
        <h2 style={{ fontSize: 20, marginTop: 0 }}>Configuration requise</h2>
        <p style={mutedStyle}>Le tableau de bord est prêt, mais la connexion Supabase n’est pas encore configurée. Définissez NEXT_PUBLIC_SUPABASE_URL et NEXT_PUBLIC_SUPABASE_ANON_KEY dans l’environnement de déploiement, puis relancez l’application.</p>
      </section>
    </main>
  );

  if (!session) {
    return (
      <main style={shellStyle}>
        <header style={{ marginBottom: 32 }}>
          <p style={eyebrowStyle}>GESTION CENTRALISÉE DES SITES WI-FI</p>
          <h1 style={{ fontSize: 34, margin: '8px 0' }}>Mtandao Cloud</h1>
          <p style={mutedStyle}>Connectez-vous pour accéder à vos espaces de gestion.</p>
        </header>
        <section style={panelStyle}>
          <h2 style={{ fontSize: 20, marginTop: 0 }}>Connexion</h2>
          <form onSubmit={signIn} style={{ display: 'grid', gap: 14 }}>
            <label style={labelStyle}>Adresse e-mail
              <input required type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} style={inputStyle} />
            </label>
            <label style={labelStyle}>Mot de passe
              <input required type="password" autoComplete="current-password" value={password} onChange={e => setPassword(e.target.value)} style={inputStyle} />
            </label>
            {authError && <p role="alert" style={errorStyle}>{authError}</p>}
            <button disabled={authLoading} type="submit" style={buttonStyle}>{authLoading ? 'Connexion…' : 'Se connecter'}</button>
          </form>
          <p style={{ ...mutedStyle, fontSize: 12, marginBottom: 0 }}>Les comptes sont gérés par Supabase Auth. La création de compte et la récupération du mot de passe seront activées dans une prochaine étape.</p>
        </section>
      </main>
    );
  }

  return (
    <main style={shellStyle}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'start', gap: 16, marginBottom: 32, flexWrap: 'wrap' }}>
        <div>
          <p style={eyebrowStyle}>GESTION CENTRALISÉE DES SITES WI-FI</p>
          <h1 style={{ fontSize: 34, margin: '8px 0' }}>Mtandao Cloud</h1>
          <p style={mutedStyle}>Connecté en tant que {session.user.email ?? 'utilisateur'}.</p>
        </div>
        <button type="button" onClick={signOut} style={secondaryButtonStyle}>Se déconnecter</button>
      </header>

      <section style={panelStyle}>
        <h2 style={{ fontSize: 18, marginTop: 0 }}>Créer un site Wi-Fi</h2>
        <form onSubmit={createSite} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, alignItems: 'end' }}>
          <label style={labelStyle}>Nom du site
            <input required minLength={2} maxLength={120} value={newSiteName} onChange={e => setNewSiteName(e.target.value)} placeholder="Ex. Site principal – Kindu" style={inputStyle} />
          </label>
          <label style={labelStyle}>Devise
            <select value={newSiteCurrency} onChange={e => setNewSiteCurrency(e.target.value as 'CDF' | 'USD')} style={inputStyle}>
              <option value="CDF">CDF</option>
              <option value="USD">USD</option>
            </select>
          </label>
          <button type="submit" disabled={creatingSite || newSiteName.trim().length < 2} style={{ ...buttonStyle, width: '100%' }}>{creatingSite ? 'Création…' : 'Créer le site'}</button>
        </form>
        <p style={{ ...mutedStyle, fontSize: 12, marginTop: 10 }}>Fuseau horaire : Africa/Lubumbashi</p>
        {siteMessage && <p role="status" style={{ color: '#166534', fontSize: 13 }}>{siteMessage}</p>}
      </section>

      <section style={panelStyle}>
        <h2 style={{ fontSize: 18, marginTop: 0 }}>Mes sites</h2>
        {sites.length === 0 ? <p style={mutedStyle}>Aucun site accessible avec ce compte, ou chargement en cours.</p> : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, alignItems: 'end' }}>
            <label style={labelStyle}>Espace de travail
              <select value={siteId} onChange={e => { setSiteId(e.target.value); setLoaded(false); setRouters([]); }} style={inputStyle}>
                {sites.map(site => <option key={site.id} value={site.id}>{site.name} · {site.role} · {site.default_currency}</option>)}
              </select>
            </label>
            <button type="button" disabled={!siteId || loading} onClick={loadRouters} style={{ ...buttonStyle, width: '100%' }}>{loading ? 'Chargement…' : 'Afficher les routeurs'}</button>
          </div>
        )}
        {error && <p role="alert" style={errorStyle}>{error}</p>}
      </section>

      {siteId && (
        <section style={panelStyle}>
          <h2 style={{ fontSize: 18, marginTop: 0 }}>Enregistrer un routeur</h2>
          <p style={{ ...mutedStyle, fontSize: 13, marginBottom: 14 }}>Déclarez un équipement et générez un code temporaire pour enrôler sa passerelle Mtandao.</p>
          <form onSubmit={registerRouter} style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 12, alignItems: 'end' }}>
            <label style={labelStyle}>Nom du routeur
              <input required minLength={2} maxLength={120} value={routerName} onChange={e => setRouterName(e.target.value)} placeholder="Ex. Routeur principal" style={inputStyle} />
            </label>
            <label style={labelStyle}>Identité RouterOS
              <input required minLength={2} maxLength={128} value={routerIdentity} onChange={e => setRouterIdentity(e.target.value)} placeholder="Identité affichée dans MikroTik" style={inputStyle} />
            </label>
            <label style={labelStyle}>Type de passerelle
              <select value={gatewayKind} onChange={e => setGatewayKind(e.target.value as 'android' | 'linux')} style={inputStyle}>
                <option value="linux">Linux (passerelle permanente)</option>
                <option value="android">Android (passerelle mobile)</option>
              </select>
            </label>
            <button type="submit" disabled={registeringRouter || routerName.trim().length < 2 || routerIdentity.trim().length < 2} style={{ ...buttonStyle, width: '100%' }}>{registeringRouter ? 'Enregistrement…' : 'Enregistrer le routeur'}</button>
          </form>
          {enrollment && (
            <div role="status" style={{ marginTop: 16, padding: 14, border: '1px solid #d6a84f', borderRadius: 9, background: '#fffbeb' }}>
              <strong>Code d’enrôlement généré</strong>
              <p style={{ fontSize: 13 }}>Ce code est affiché une seule fois et expire dans 15 minutes. Conservez-le de manière sécurisée et ne le partagez pas publiquement.</p>
              <code style={{ display: 'block', overflowWrap: 'anywhere', padding: 12, background: '#fff', borderRadius: 6, fontSize: 13 }}>{enrollment.enrollmentToken}</code>
              <button type="button" onClick={() => { void navigator.clipboard.writeText(enrollment.enrollmentToken).then(() => setEnrollmentCopied(true)); }} style={{ ...secondaryButtonStyle, marginTop: 10 }}>{enrollmentCopied ? 'Code copié' : 'Copier le code'}</button>
              <p style={{ fontSize: 12, color: '#854d0e', marginBottom: 0 }}>Après expiration, vous devrez générer un nouveau code. L’enregistrement du routeur ne signifie pas encore que le MikroTik est connecté.</p>
            </div>
          )}
        </section>
      )}

      {loaded && (
        <section>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, marginBottom: 14 }}>
            <h2 style={{ fontSize: 20, margin: 0 }}>Routeurs du site</h2>
            <span style={mutedStyle}>{routers.length} équipement(s)</span>
          </div>
          {routers.length === 0 ? <p style={mutedStyle}>Aucun routeur enregistré pour ce site.</p> : (
            <div style={{ overflowX: 'auto', border: '1px solid #dce3ec', borderRadius: 12 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760, textAlign: 'left' }}>
                <thead><tr style={{ background: '#f5f7fa' }}>
                  {['Nom / identité', 'Passerelle', 'Gateway', 'Routeur MikroTik', 'Dernier heartbeat', 'Dernière réponse MikroTik', 'Action'].map(label => <th key={label} style={thStyle}>{label}</th>)}
                </tr></thead>
                <tbody>{routers.map(router => (
                  <tr key={router.id} style={{ borderTop: '1px solid #e7edf3' }}>
                    <td style={tdStyle}><strong>{router.name}</strong><br /><span style={{ color: '#64748b', fontSize: 12 }}>{router.router_identity}</span></td>
                    <td style={tdStyle}>{router.gateway_kind === 'android' ? 'Android' : 'Linux'}</td>
                    <td style={tdStyle}><Status value={gatewayLabel(router.status)} good={router.status === 'online'} /></td>
                    <td style={tdStyle}><Status value={routerLabel(router.router_connection_status)} good={router.router_connection_status === 'online'} /></td>
                    <td style={tdStyle}>{dateLabel(router.last_seen_at)}</td>
                    <td style={tdStyle}>{dateLabel(router.router_last_seen_at)}</td>
                    <td style={tdStyle}>{(sites.find(site => site.id === siteId)?.role === 'owner' || sites.find(site => site.id === siteId)?.role === 'admin') ? (router.status === 'revoked' ? <button type="button" disabled={registeringRouter} onClick={() => void reenrollRouter(router)} style={{ ...secondaryButtonStyle, padding: '7px 10px', fontSize: 12 }}>Réenrôler</button> : <button type="button" onClick={() => void revokeRouter(router)} style={{ ...secondaryButtonStyle, padding: '7px 10px', fontSize: 12 }}>Révoquer</button>) : '—'}</td>
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

const shellStyle = { maxWidth: 1120, margin: '0 auto', padding: '48px 24px', fontFamily: 'Arial, sans-serif', color: '#172033' };
const eyebrowStyle = { color: '#52627a', fontSize: 13, letterSpacing: 1, fontWeight: 700 };
const mutedStyle = { color: '#52627a', margin: 0 };
const panelStyle = { border: '1px solid #dce3ec', borderRadius: 12, padding: 20, marginBottom: 28 };
const labelStyle = { display: 'grid', gap: 6, fontSize: 13, fontWeight: 600 };
const inputStyle = { width: '100%', boxSizing: 'border-box' as const, border: '1px solid #cbd5e1', borderRadius: 7, padding: '11px 12px', fontSize: 14, marginTop: 6 };
const buttonStyle = { border: 0, borderRadius: 7, background: '#173b69', color: 'white', padding: '12px 18px', fontSize: 14, fontWeight: 700, cursor: 'pointer' };
const secondaryButtonStyle = { ...buttonStyle, background: '#e8edf4', color: '#173b69' };
const errorStyle = { background: '#fff1f2', color: '#9f1239', padding: 12, borderRadius: 8, fontSize: 13 };
const thStyle = { padding: '13px 14px', fontSize: 12, color: '#475569', whiteSpace: 'nowrap' as const };
const tdStyle = { padding: '14px', fontSize: 13, verticalAlign: 'top' as const };
