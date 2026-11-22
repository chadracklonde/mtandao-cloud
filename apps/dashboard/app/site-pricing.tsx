'use client';

import { useCallback, useEffect, useState } from 'react';

type Tier = {
  tier: string;
  label: string;
  duration_minutes: number;
  configured: boolean;
  plan_id: string | null;
  name: string | null;
  price: number | null;
  currency: string | null;
  active: boolean;
  data_limit_mb: number | null;
  hotspot_profile: string | null;
  stock_available: number;
};
type Pricing = { complete: boolean; tiers: Tier[] };
type Draft = { price: string; currency: string; active: boolean; dataLimit: string; profile: string };

function toDraft(tier: Tier, defaultCurrency: string): Draft {
  return {
    price: tier.price === null ? '' : String(tier.price),
    currency: tier.currency ?? defaultCurrency,
    active: tier.configured ? tier.active : true,
    dataLimit: tier.data_limit_mb === null ? '' : String(tier.data_limit_mb),
    profile: tier.hotspot_profile ?? '',
  };
}

function isValid(draft: Draft): boolean {
  const price = Number(draft.price);
  if (draft.price.trim() === '' || !Number.isFinite(price) || price < 0 || Math.round(price * 100) / 100 !== price) return false;
  if (draft.dataLimit.trim() !== '' && !/^[1-9][0-9]{0,8}$/.test(draft.dataLimit.trim())) return false;
  return draft.profile === '' || /^[A-Za-z0-9 _.-]{1,120}$/.test(draft.profile);
}

export function SitePricing({
  apiBase,
  accessToken,
  siteId,
  defaultCurrency,
  canEdit,
}: {
  apiBase: string;
  accessToken: string;
  siteId: string;
  defaultCurrency: string;
  canEdit: boolean;
}) {
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const [drafts, setDrafts] = useState<Record<string, Draft>>({});
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [saving, setSaving] = useState('');

  const load = useCallback(
    async (signal?: AbortSignal) => {
      const response = await fetch(`${apiBase}/v1/sites/${siteId}/pricing`, {
        headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
        cache: 'no-store',
        signal,
      });
      if (!response.ok) throw new Error(response.status === 401 ? 'Votre session a expiré. Reconnectez-vous.' : `Chargement des tarifs impossible (HTTP ${response.status}).`);
      const data = (await response.json()) as Pricing;
      setPricing(data);
      setDrafts(Object.fromEntries(data.tiers.map(tier => [tier.tier, toDraft(tier, defaultCurrency)])));
    },
    [apiBase, accessToken, siteId, defaultCurrency],
  );

  useEffect(() => {
    const controller = new AbortController();
    setPricing(null);
    setError('');
    load(controller.signal).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : 'Chargement des tarifs impossible.');
    });
    return () => controller.abort();
  }, [load]);

  async function save(tier: Tier) {
    const draft = drafts[tier.tier];
    if (!draft || !isValid(draft)) return;
    setSaving(tier.tier);
    setError('');
    setMessage('');
    try {
      const body: Record<string, unknown> = { price: Number(draft.price), currency: draft.currency, active: draft.active };
      if (draft.dataLimit.trim() !== '') body.dataLimitMb = Number(draft.dataLimit);
      if (draft.profile.trim() !== '') body.hotspotProfile = draft.profile.trim();
      const response = await fetch(`${apiBase}/v1/sites/${siteId}/pricing/${tier.tier}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (response.status === 403) throw new Error('Votre rôle ne permet pas de modifier les tarifs.');
      if (!response.ok) throw new Error(`Enregistrement impossible (HTTP ${response.status}).`);
      await load();
      setMessage(`Tarif « ${tier.label} » enregistré.`);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Enregistrement impossible.');
    } finally {
      setSaving('');
    }
  }

  function change(tier: string, patch: Partial<Draft>) {
    setDrafts(current => ({ ...current, [tier]: { ...current[tier], ...patch } }));
  }

  const missing = pricing ? pricing.tiers.filter(tier => !tier.configured || !tier.active).length : 0;

  return (
    <section style={panel}>
      <h2 style={{ fontSize: 18, marginTop: 0 }}>Tarifs du site</h2>
      <p style={{ ...muted, marginBottom: 14 }}>Fixez le prix de chaque durée proposée aux clients : 1 heure, 2 heures, 24 heures, 1 semaine et 1 mois (30 jours). Un changement de prix ne modifie pas les paiements déjà créés.</p>

      {pricing && (
        <p role="status" style={pricing.complete ? okBox : warnBox}>
          {pricing.complete ? 'Les cinq tarifs sont définis et actifs.' : `${missing} tarif(s) à définir ou à activer : les clients ne verront que les forfaits actifs.`}
        </p>
      )}
      {error && <p role="alert" style={errorBox}>{error}</p>}
      {message && <p role="status" style={okBox}>{message}</p>}
      {!pricing && !error && <p style={muted}>Chargement…</p>}

      {pricing && (
        <div style={{ overflowX: 'auto', border: '1px solid #dce3ec', borderRadius: 12 }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 720, textAlign: 'left' }}>
            <thead><tr style={{ background: '#f5f7fa' }}>
              {['Durée', 'Prix', 'Devise', 'Actif', 'Profil Hotspot', 'Données (Mo)', 'Stock', ''].map(label => <th key={label} style={th}>{label}</th>)}
            </tr></thead>
            <tbody>
              {pricing.tiers.map(tier => {
                const draft = drafts[tier.tier];
                if (!draft) return null;
                const id = `tier-${tier.tier}`;
                return (
                  <tr key={tier.tier} style={{ borderTop: '1px solid #e7edf3' }}>
                    <td style={td}><strong>{tier.label}</strong>{!tier.configured && <><br /><span style={{ color: '#b45309', fontSize: 12 }}>À définir</span></>}</td>
                    <td style={td}><input aria-label={`Prix ${tier.label}`} id={`${id}-price`} inputMode="decimal" disabled={!canEdit} value={draft.price} onChange={event => change(tier.tier, { price: event.target.value })} style={{ ...input, width: 90 }} /></td>
                    <td style={td}>
                      <select aria-label={`Devise ${tier.label}`} disabled={!canEdit} value={draft.currency} onChange={event => change(tier.tier, { currency: event.target.value })} style={input}>
                        <option value="CDF">CDF</option><option value="USD">USD</option>
                      </select>
                    </td>
                    <td style={td}><input type="checkbox" aria-label={`Actif ${tier.label}`} disabled={!canEdit} checked={draft.active} onChange={event => change(tier.tier, { active: event.target.checked })} /></td>
                    <td style={td}><input aria-label={`Profil ${tier.label}`} disabled={!canEdit} value={draft.profile} onChange={event => change(tier.tier, { profile: event.target.value })} placeholder="par défaut" style={{ ...input, width: 120 }} /></td>
                    <td style={td}><input aria-label={`Données ${tier.label}`} inputMode="numeric" disabled={!canEdit} value={draft.dataLimit} onChange={event => change(tier.tier, { dataLimit: event.target.value })} placeholder="illimité" style={{ ...input, width: 90 }} /></td>
                    <td style={td}>{tier.configured ? tier.stock_available : '—'}</td>
                    <td style={td}>
                      {canEdit && <button type="button" disabled={!isValid(draft) || saving === tier.tier} onClick={() => void save(tier)} style={{ ...button, opacity: !isValid(draft) || saving === tier.tier ? 0.5 : 1 }}>{saving === tier.tier ? '…' : 'Enregistrer'}</button>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {!canEdit && <p style={{ ...muted, marginTop: 10 }}>Seuls le propriétaire, les administrateurs et les gestionnaires peuvent modifier les tarifs.</p>}
    </section>
  );
}

const panel = { border: '1px solid #dce3ec', borderRadius: 12, padding: 20, marginBottom: 28 };
const muted = { color: '#52627a', margin: 0, fontSize: 13 };
const input = { border: '1px solid #cbd5e1', borderRadius: 7, padding: '8px 9px', fontSize: 14 };
const button = { border: 0, borderRadius: 7, background: '#173b69', color: '#fff', padding: '9px 14px', fontSize: 13, fontWeight: 700, cursor: 'pointer' };
const th = { padding: '13px 14px', fontSize: 12, color: '#475569', whiteSpace: 'nowrap' as const };
const td = { padding: 14, fontSize: 13, verticalAlign: 'middle' as const };
const errorBox = { background: '#fff1f2', color: '#9f1239', padding: 12, borderRadius: 8, fontSize: 13 };
const okBox = { background: '#dcfce7', color: '#166534', padding: 12, borderRadius: 8, fontSize: 13 };
const warnBox = { background: '#fffbeb', color: '#854d0e', padding: 12, borderRadius: 8, fontSize: 13 };
