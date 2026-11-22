'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useParams, useSearchParams } from 'next/navigation';

const API_BASE = (process.env.NEXT_PUBLIC_MTANDAO_API_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const POLL_MS = 4000;
const POLL_MAX_MS = 30 * 60 * 1000;

type Plan = {
  id: string;
  name: string;
  price: number;
  currency: string;
  duration_minutes: number;
  data_limit_mb: number | null;
  in_stock: boolean;
};
type Catalog = { site: { id: string; name: string; currency: string }; plans: Plan[] };
type Saved = { paymentId: string; accessToken: string; providerRef: string };
type Status = {
  provider_ref: string;
  plan: string;
  amount: number;
  currency: string;
  status: string;
  fulfillment_status: string;
  ticket: { code: string; duration_minutes: number } | null;
};

function money(amount: number, currency: string): string {
  return `${amount.toLocaleString('fr-FR', { maximumFractionDigits: 2 })} ${currency}`;
}

function duration(minutes: number): string {
  if (minutes % 1440 === 0) return `${minutes / 1440} jour(s)`;
  if (minutes % 60 === 0) return `${minutes / 60} h`;
  return `${minutes} min`;
}

function storageKey(siteId: string): string {
  return `mtandao-portal-${siteId}`;
}

function loadSaved(siteId: string): Saved | null {
  try {
    const raw = sessionStorage.getItem(storageKey(siteId));
    if (!raw) return null;
    const value = JSON.parse(raw) as Partial<Saved>;
    return typeof value.paymentId === 'string' && typeof value.accessToken === 'string' && typeof value.providerRef === 'string'
      ? (value as Saved)
      : null;
  } catch {
    return null;
  }
}

function persist(siteId: string, value: Saved | null): void {
  try {
    if (value) sessionStorage.setItem(storageKey(siteId), JSON.stringify(value));
    else sessionStorage.removeItem(storageKey(siteId));
  } catch {
    // Storage can be unavailable (private mode): the page still works until reloaded.
  }
}

function Portal() {
  const params = useParams<{ siteId: string }>();
  const search = useSearchParams();
  const siteId = params.siteId;
  const routerId = search.get('router') ?? '';
  const validLink = UUID.test(siteId) && UUID.test(routerId);

  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [loadError, setLoadError] = useState('');
  const [planId, setPlanId] = useState('');
  const [phone, setPhone] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [formError, setFormError] = useState('');
  const [saved, setSaved] = useState<Saved | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState('');
  const [copied, setCopied] = useState(false);
  const attemptKey = useRef(`visit-${Math.random().toString(36).slice(2)}-${Date.now()}`);

  useEffect(() => {
    if (UUID.test(siteId)) setSaved(loadSaved(siteId));
  }, [siteId]);

  useEffect(() => {
    if (!validLink) return;
    const controller = new AbortController();
    fetch(`${API_BASE}/v1/portal/sites/${siteId}`, { cache: 'no-store', signal: controller.signal })
      .then(async response => {
        if (!response.ok) throw new Error(response.status === 404 ? 'Ce point d’accès est introuvable.' : 'Service momentanément indisponible.');
        setCatalog((await response.json()) as Catalog);
      })
      .catch(error => {
        if (!controller.signal.aborted) setLoadError(error instanceof Error ? error.message : 'Service momentanément indisponible.');
      });
    return () => controller.abort();
  }, [siteId, validLink]);

  const finished = useMemo(() => {
    if (!status) return false;
    if (status.fulfillment_status === 'activated') return true;
    return ['failed', 'expired', 'mismatch', 'cancelled'].includes(status.status) ||
      ['activation_failed', 'out_of_stock'].includes(status.fulfillment_status);
  }, [status]);

  useEffect(() => {
    if (!saved || finished) return;
    const startedAt = Date.now();
    let active = true;
    const controller = new AbortController();
    async function poll() {
      try {
        const response = await fetch(`${API_BASE}/v1/portal/payments/${saved!.paymentId}`, {
          headers: { Authorization: `Bearer ${saved!.accessToken}` },
          cache: 'no-store',
          signal: controller.signal,
        });
        if (!active) return;
        if (response.status === 404 || response.status === 401) {
          persist(siteId, null);
          setSaved(null);
          setStatus(null);
          setStatusError('Cet accès a expiré. Recommencez votre achat.');
          return;
        }
        if (response.status === 429) throw new Error('Trop de vérifications, patientez un instant.');
        if (!response.ok) throw new Error('Vérification momentanément impossible.');
        setStatus((await response.json()) as Status);
        setStatusError('');
      } catch (error) {
        if (active && !controller.signal.aborted) setStatusError(error instanceof Error ? error.message : 'Vérification impossible.');
      }
    }
    void poll();
    const timer = setInterval(() => {
      if (Date.now() - startedAt > POLL_MAX_MS) clearInterval(timer);
      else void poll();
    }, POLL_MS);
    return () => {
      active = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [saved, finished, siteId]);

  const submit = useCallback(async () => {
    setSubmitting(true);
    setFormError('');
    try {
      const response = await fetch(`${API_BASE}/v1/portal/sites/${siteId}/payments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ planId, routerId, customerPhone: phone.replace(/[\s.-]/g, ''), idempotencyKey: attemptKey.current }),
      });
      if (response.status === 429) throw new Error('Trop de demandes en cours. Réessayez dans quelques minutes.');
      if (response.status === 400) throw new Error('Vérifiez le numéro de téléphone et le forfait choisi.');
      if (!response.ok) throw new Error('Impossible de démarrer le paiement. Réessayez.');
      const data = (await response.json()) as { paymentId: string; accessToken: string; providerRef: string };
      const next = { paymentId: data.paymentId, accessToken: data.accessToken, providerRef: data.providerRef };
      persist(siteId, next);
      setStatus(null);
      setSaved(next);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : 'Impossible de démarrer le paiement.');
    } finally {
      setSubmitting(false);
    }
  }, [siteId, routerId, planId, phone]);

  function restart() {
    persist(siteId, null);
    attemptKey.current = `visit-${Math.random().toString(36).slice(2)}-${Date.now()}`;
    setSaved(null);
    setStatus(null);
    setStatusError('');
    setCopied(false);
  }

  if (!validLink) {
    return <Shell><p role="alert" style={errorBox}>Lien de connexion invalide. Reconnectez-vous au Wi-Fi pour ouvrir cette page depuis la fenêtre de connexion.</p></Shell>;
  }
  if (loadError) return <Shell><p role="alert" style={errorBox}>{loadError}</p></Shell>;
  if (!catalog) return <Shell><p style={muted}>Chargement…</p></Shell>;

  const selected = catalog.plans.find(plan => plan.id === planId);
  const phoneOk = /^\+?[0-9]{8,15}$/.test(phone.replace(/[\s.-]/g, ''));

  return (
    <Shell title={catalog.site.name}>
      {saved ? (
        <section aria-live="polite">
          {!status && !statusError && <p style={muted}>Vérification de votre paiement…</p>}
          {statusError && <p role="alert" style={errorBox}>{statusError}</p>}
          {status && <PaymentState status={status} onCopy={() => { void navigator.clipboard.writeText(status.ticket?.code ?? '').then(() => setCopied(true)); }} copied={copied} />}
          {(finished || statusError) && <button type="button" onClick={restart} style={secondaryButton}>Nouvel achat</button>}
        </section>
      ) : (
        <section>
          <h2 style={{ fontSize: 17, margin: '0 0 12px' }}>Choisissez votre forfait</h2>
          {catalog.plans.length === 0 && <p style={muted}>Aucun forfait disponible pour le moment.</p>}
          <div role="radiogroup" aria-label="Forfaits" style={{ display: 'grid', gap: 10 }}>
            {catalog.plans.map(plan => (
              <button
                key={plan.id}
                type="button"
                role="radio"
                aria-checked={planId === plan.id}
                disabled={!plan.in_stock}
                onClick={() => setPlanId(plan.id)}
                style={{ ...planButton, borderColor: planId === plan.id ? 'var(--primary)' : 'var(--border-strong)', background: planId === plan.id ? 'var(--primary-soft)' : 'var(--surface)', opacity: plan.in_stock ? 1 : 0.5 }}
              >
                <strong>{plan.name}</strong>
                <span style={{ color: 'var(--muted-fg)', fontSize: 13 }}>{duration(plan.duration_minutes)}{plan.data_limit_mb ? ` · ${plan.data_limit_mb} Mo` : ''}{plan.in_stock ? '' : ' · épuisé'}</span>
                <span style={{ fontWeight: 700 }}>{money(plan.price, plan.currency)}</span>
              </button>
            ))}
          </div>
          <label style={{ display: 'grid', gap: 6, fontSize: 14, fontWeight: 600, marginTop: 18 }}>
            Numéro de téléphone Mobile Money
            <input inputMode="tel" autoComplete="tel" value={phone} onChange={event => setPhone(event.target.value)} placeholder="+243 97 000 0000" style={input} />
          </label>
          {formError && <p role="alert" style={{ ...errorBox, marginTop: 12 }}>{formError}</p>}
          <button type="button" disabled={!selected || !phoneOk || submitting} onClick={() => void submit()} style={{ ...primaryButton, marginTop: 16, opacity: !selected || !phoneOk || submitting ? 0.5 : 1 }}>
            {submitting ? 'Envoi…' : selected ? `Payer ${money(selected.price, selected.currency)}` : 'Payer'}
          </button>
        </section>
      )}
    </Shell>
  );
}

function PaymentState({ status, onCopy, copied }: { status: Status; onCopy: () => void; copied: boolean }) {
  const reference = <p style={{ ...muted, marginTop: 14 }}>Référence : <code>{status.provider_ref}</code> · {status.plan} · {money(status.amount, status.currency)}</p>;

  if (status.fulfillment_status === 'activated' && status.ticket) {
    return (
      <div role="status">
        <p style={{ ...successBox, fontWeight: 700 }}>Paiement reçu, votre accès est actif.</p>
        <p style={{ marginBottom: 6 }}>Votre code de connexion ({duration(status.ticket.duration_minutes)}) :</p>
        <code style={{ display: 'block', textAlign: 'center', fontSize: 26, letterSpacing: 2, padding: 16, background: 'var(--surface-2)', borderRadius: 10, overflowWrap: 'anywhere' }}>{status.ticket.code}</code>
        <button type="button" onClick={onCopy} style={{ ...secondaryButton, marginTop: 10 }}>{copied ? 'Code copié' : 'Copier le code'}</button>
        <p style={muted}>Retournez à la page de connexion Wi-Fi et saisissez ce code comme identifiant <em>et</em> mot de passe. Conservez-le jusqu’à la fin de votre forfait.</p>
        {reference}
      </div>
    );
  }
  if (status.status === 'paid' && status.fulfillment_status === 'activation_pending') {
    return <div role="status"><p style={infoBox}>Paiement reçu. Activation de votre accès en cours… cela peut prendre quelques instants.</p>{reference}</div>;
  }
  if (status.status === 'paid') {
    return <div role="alert"><p style={errorBox}>Votre paiement est bien reçu, mais l’activation a rencontré un problème. Présentez la référence ci-dessous au responsable du point d’accès : il pourra la finaliser.</p>{reference}</div>;
  }
  if (status.status === 'pending') {
    return <div role="status"><p style={infoBox}>En attente de la confirmation de votre paiement. Validez la demande sur votre téléphone en indiquant la référence ci-dessous si nécessaire.</p>{reference}</div>;
  }
  if (status.status === 'expired') return <div role="alert"><p style={errorBox}>Le délai de paiement est dépassé. Si vous avez été débité, présentez la référence au responsable.</p>{reference}</div>;
  if (status.status === 'mismatch') return <div role="alert"><p style={errorBox}>Le montant reçu ne correspond pas au forfait. Présentez la référence au responsable.</p>{reference}</div>;
  return <div role="alert"><p style={errorBox}>Le paiement n’a pas abouti.</p>{reference}</div>;
}

function Shell({ title, children }: { title?: string; children: React.ReactNode }) {
  return (
    <main id="contenu" style={{ maxWidth: 480, margin: '0 auto', padding: '28px 16px 48px', color: 'var(--fg)' }}>
      <p style={{ color: 'var(--muted-fg)', fontSize: 12, letterSpacing: 1, fontWeight: 700, margin: 0 }}>WI-FI</p>
      <h1 style={{ fontSize: 24, margin: '4px 0 20px' }}>{title ?? 'Connexion Wi-Fi'}</h1>
      {children}
    </main>
  );
}

export default function PortalPage() {
  return (
    <Suspense fallback={<Shell><p style={muted}>Chargement…</p></Shell>}>
      <Portal />
    </Suspense>
  );
}

const muted = { color: 'var(--muted-fg)', fontSize: 13, margin: '10px 0 0' };
const input = { width: '100%', boxSizing: 'border-box' as const, border: '1px solid var(--border-strong)', borderRadius: 8, padding: '13px 12px', fontSize: 16 };
const planButton = { display: 'grid', gap: 4, textAlign: 'left' as const, border: '2px solid', borderRadius: 10, padding: '12px 14px', fontSize: 15, cursor: 'pointer', color: 'var(--fg)' };
const primaryButton = { width: '100%', border: 0, borderRadius: 8, background: 'var(--primary)', color: 'var(--on-primary)', padding: '14px 18px', fontSize: 16, fontWeight: 700, cursor: 'pointer' };
const secondaryButton = { border: 0, borderRadius: 8, background: 'var(--primary-soft)', color: 'var(--primary-fg)', padding: '11px 16px', fontSize: 14, fontWeight: 700, cursor: 'pointer', marginTop: 16 };
const errorBox = { background: 'var(--danger-bg)', color: 'var(--danger)', padding: 12, borderRadius: 8, fontSize: 14, margin: 0 };
const infoBox = { background: 'var(--primary-soft)', color: 'var(--primary-fg)', padding: 12, borderRadius: 8, fontSize: 14, margin: 0 };
const successBox = { background: 'var(--ok-bg)', color: 'var(--ok)', padding: 12, borderRadius: 8, fontSize: 14, margin: '0 0 14px' };
