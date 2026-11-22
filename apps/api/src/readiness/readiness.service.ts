import { HttpException, Injectable } from '@nestjs/common';
import { CommerceService } from '../commerce/commerce.service';
import { ReportsService } from '../reports/reports.service';
import { RoutersService } from '../routers/routers.service';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'unknown';

export interface ReadinessCheck {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
}

export interface Readiness {
  /** True when no check failed: the site can sell. Warnings do not block. */
  ready: boolean;
  checks: ReadinessCheck[];
}

interface Tier {
  tier: string;
  label: string;
  configured: boolean;
  active: boolean;
  stock_available: number;
}

const LOW_STOCK = 20;
const DAY = 24 * 60 * 60 * 1000;

/**
 * Answers one question for a site manager before and during a pilot: can this
 * site sell today, and if not, what is missing? It only reads, with the user's
 * own token, so each check respects the user's role ("unknown" when not allowed).
 */
@Injectable()
export class ReadinessService {
  constructor(
    private readonly commerce: CommerceService,
    private readonly routers: RoutersService,
    private readonly reports: ReportsService,
  ) {}

  private async safe<T>(read: () => Promise<T>): Promise<{ value?: T; denied: boolean; failed: boolean }> {
    try {
      return { value: await read(), denied: false, failed: false };
    } catch (error) {
      const denied = error instanceof HttpException && error.getStatus() === 403;
      return { denied, failed: !denied };
    }
  }

  async check(siteId: string, accessToken: string, now: Date = new Date()): Promise<Readiness> {
    const [pricing, routers, reconciliation] = await Promise.all([
      this.safe(() => this.commerce.sitePricing(siteId, accessToken) as Promise<{ complete: boolean; tiers: Tier[] }>),
      this.safe(() => this.routers.list(siteId, accessToken)),
      this.safe(() =>
        this.reports.reconciliation(siteId, accessToken, {
          from: new Date(now.getTime() - 7 * DAY).toISOString(),
          to: now.toISOString(),
        }),
      ),
    ]);

    const unknown = (id: string, label: string, denied: boolean): ReadinessCheck => ({
      id,
      label,
      status: 'unknown',
      detail: denied ? 'Votre rôle ne permet pas de vérifier ce point.' : 'Vérification momentanément impossible.',
    });

    const checks: ReadinessCheck[] = [];

    // 1. Prices for the five standard durations.
    if (!pricing.value) {
      checks.push(unknown('pricing', 'Tarifs des cinq durées', pricing.denied));
    } else {
      const missing = pricing.value.tiers.filter(tier => !tier.configured || !tier.active);
      const configured = pricing.value.tiers.filter(tier => tier.configured && tier.active).length;
      checks.push(
        missing.length === 0
          ? { id: 'pricing', label: 'Tarifs des cinq durées', status: 'ok', detail: 'Les cinq tarifs sont définis et actifs.' }
          : {
              id: 'pricing',
              label: 'Tarifs des cinq durées',
              status: configured === 0 ? 'fail' : 'warn',
              detail: `À définir ou à activer : ${missing.map(tier => tier.label).join(', ')}.`,
            },
      );

      // 2. Voucher stock for every plan that customers can buy.
      const sellable = pricing.value.tiers.filter(tier => tier.configured && tier.active);
      const empty = sellable.filter(tier => tier.stock_available === 0);
      const low = sellable.filter(tier => tier.stock_available > 0 && tier.stock_available < LOW_STOCK);
      if (sellable.length === 0) {
        checks.push({ id: 'stock', label: 'Stock de tickets', status: 'fail', detail: 'Aucun forfait actif : rien à vendre.' });
      } else if (empty.length > 0) {
        checks.push({
          id: 'stock',
          label: 'Stock de tickets',
          status: 'fail',
          detail: `Plus de tickets pour : ${empty.map(tier => tier.label).join(', ')}. Importez des codes.`,
        });
      } else if (low.length > 0) {
        checks.push({
          id: 'stock',
          label: 'Stock de tickets',
          status: 'warn',
          detail: `Stock bas (moins de ${LOW_STOCK}) : ${low.map(tier => `${tier.label} (${tier.stock_available})`).join(', ')}.`,
        });
      } else {
        checks.push({ id: 'stock', label: 'Stock de tickets', status: 'ok', detail: 'Chaque forfait actif a des tickets disponibles.' });
      }
    }

    // 3 and 4. Router registered, Gateway online and router reachable.
    if (!routers.value) {
      checks.push(unknown('router', 'Routeur enregistré', routers.denied));
      checks.push(unknown('gateway', 'Passerelle en ligne', routers.denied));
    } else {
      const usable = routers.value.filter(router => router.status !== 'revoked' && router.status !== 'suspended');
      checks.push(
        usable.length > 0
          ? { id: 'router', label: 'Routeur enregistré', status: 'ok', detail: `${usable.length} routeur(s) actif(s).` }
          : { id: 'router', label: 'Routeur enregistré', status: 'fail', detail: 'Aucun routeur actif. Enregistrez un routeur et enrôlez sa passerelle.' },
      );
      const online = usable.filter(router => router.status === 'online');
      const reachable = online.filter(router => router.router_connection_status === 'online');
      if (usable.length === 0) {
        checks.push({ id: 'gateway', label: 'Passerelle en ligne', status: 'fail', detail: 'Pas de passerelle à vérifier.' });
      } else if (online.length === 0) {
        checks.push({
          id: 'gateway',
          label: 'Passerelle en ligne',
          status: 'fail',
          detail: 'Aucune passerelle ne répond. Les tickets payés resteront « en attente d’activation ».',
        });
      } else if (reachable.length === 0) {
        checks.push({
          id: 'gateway',
          label: 'Passerelle en ligne',
          status: 'warn',
          detail: 'La passerelle répond, mais le routeur MikroTik n’est pas confirmé joignable.',
        });
      } else {
        checks.push({ id: 'gateway', label: 'Passerelle en ligne', status: 'ok', detail: `${reachable.length} passerelle(s) et routeur(s) joignables.` });
      }
    }

    // 5. Nothing left unreconciled over the last seven days.
    if (!reconciliation.value) {
      checks.push(unknown('reconciliation', 'Rapprochement (7 derniers jours)', reconciliation.denied));
    } else {
      const total = reconciliation.value.items.length;
      checks.push(
        total === 0
          ? { id: 'reconciliation', label: 'Rapprochement (7 derniers jours)', status: 'ok', detail: 'Aucun écart.' }
          : {
              id: 'reconciliation',
              label: 'Rapprochement (7 derniers jours)',
              status: 'warn',
              detail: `${reconciliation.value.truncated ? '500 écarts ou plus' : `${total} écart(s)`} à examiner dans l’onglet Écarts.`,
            },
      );
    }

    // 6. Payment provider: only the sandbox exists today.
    checks.push({
      id: 'payments',
      label: 'Paiement Mobile Money',
      status: 'warn',
      detail: 'Mode sandbox : aucun paiement réel n’est encaissé. Un fournisseur réel doit être raccordé avant une vente publique.',
    });

    return { ready: checks.every(check => check.status !== 'fail'), checks };
  }
}
