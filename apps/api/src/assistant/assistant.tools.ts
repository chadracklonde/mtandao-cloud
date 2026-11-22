import { HttpException } from '@nestjs/common';
import Anthropic from '@anthropic-ai/sdk';
import { CommerceService, parseInstant } from '../commerce/commerce.service';
import { ReportsService } from '../reports/reports.service';
import { RoutersService } from '../routers/routers.service';

/** Everything a tool may touch: the user's own token, scoped to one site. */
export interface ToolContext {
  siteId: string;
  accessToken: string;
  reports: ReportsService;
  commerce: CommerceService;
  routers: RoutersService;
}

export interface ToolOutcome {
  content: string;
  isError: boolean;
}

const MAX_RESULT_CHARS = 30_000;
const MAX_ROWS_FOR_MODEL = 50;

/**
 * Fields the assistant never sees: voucher codes and customer phone numbers are
 * access secrets or personal data, and nothing in a question needs them.
 */
const REDACTED_KEYS = new Set([
  'ticket_code',
  'code',
  'customer_phone',
  'access_token_hash',
  'password',
  'token',
  'device_id',
  'source_event_id',
]);

export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (!REDACTED_KEYS.has(key)) out[key] = redact(inner);
    }
    return out;
  }
  return value;
}

class ToolInputError extends Error {}

const DATE_PROPERTIES = {
  from: {
    type: 'string',
    description: 'Début de période inclus, au format AAAA-MM-JJ ou date ISO 8601. Par défaut : 30 jours avant `to`.',
  },
  to: {
    type: 'string',
    description: 'Fin de période exclue, au format AAAA-MM-JJ ou date ISO 8601. Par défaut : maintenant.',
  },
} as const;

/** Read-only tools. There is deliberately no tool that changes anything. */
export const TOOL_DEFINITIONS: Anthropic.Beta.BetaTool[] = [
  {
    name: 'get_sales_summary',
    description:
      "Totaux des ventes du site par jour ou par mois et par devise : nombre de ventes, total, part espèces, part Mobile Money. À utiliser pour toute question de chiffre d'affaires ou d'évolution. Les jours suivent le fuseau horaire du site. Période maximale : 366 jours.",
    input_schema: {
      type: 'object',
      properties: {
        ...DATE_PROPERTIES,
        group: { type: 'string', enum: ['day', 'month'], description: 'Regroupement. Par défaut : day.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_reconciliation',
    description:
      "Écarts de rapprochement du site : ventes sans entrée de caisse, montants différents, ticket manquant, conflits de synchronisation, événements rejetés ou bloqués, paiements en écart de montant, en rupture de stock ou dont l'activation a échoué. Renvoie un résumé par type et les premiers écarts.",
    input_schema: { type: 'object', properties: { ...DATE_PROPERTIES }, additionalProperties: false },
  },
  {
    name: 'list_recent_sales',
    description:
      'Dernières ventes individuelles du site (date, forfait, montant, devise, mode de paiement), de la plus récente à la plus ancienne. Les codes de tickets ne sont pas disponibles.',
    input_schema: {
      type: 'object',
      properties: {
        ...DATE_PROPERTIES,
        limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS_FOR_MODEL, description: 'Nombre de lignes. Par défaut : 20.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_payments',
    description:
      "Paiements Mobile Money du site (montant, devise, statut, état de livraison du ticket), du plus récent au plus ancien. Statuts : pending, paid, failed, expired, mismatch, cancelled. États de livraison : none, activation_pending, activated, activation_failed, out_of_stock. Les numéros de téléphone ne sont pas disponibles.",
    input_schema: {
      type: 'object',
      properties: {
        ...DATE_PROPERTIES,
        status: {
          type: 'string',
          enum: ['pending', 'paid', 'failed', 'expired', 'mismatch', 'cancelled'],
          description: 'Filtre facultatif sur le statut du paiement.',
        },
        limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS_FOR_MODEL, description: 'Nombre de lignes. Par défaut : 20.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_pricing',
    description:
      'Tarifs du site pour les cinq durées standard (1 heure, 2 heures, 24 heures, 1 semaine, 1 mois) : prix, devise, actif ou non, limite de données, profil Hotspot, stock de tickets disponible. Indique aussi si les cinq tarifs sont définis.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_stock',
    description: 'Stock de tickets par forfait : disponibles, réservés et vendus.',
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_routers',
    description:
      "Routeurs et passerelles du site : nom, état de la passerelle (online, offline, pending, revoked), état de la liaison avec le routeur MikroTik et dernière activité.",
    input_schema: { type: 'object', properties: {}, additionalProperties: false },
  },
];

export const TOOL_NAMES = new Set(TOOL_DEFINITIONS.map(tool => tool.name));

function asObject(input: unknown): Record<string, unknown> {
  if (input === undefined || input === null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) throw new ToolInputError('Les paramètres doivent être un objet.');
  return input as Record<string, unknown>;
}

function allowOnly(input: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(input)) {
    if (!allowed.includes(key)) throw new ToolInputError(`Paramètre inconnu : ${key}.`);
  }
}

function optionalDate(input: Record<string, unknown>, key: 'from' | 'to'): string | undefined {
  const value = input[key];
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string') throw new ToolInputError(`${key} doit être une date.`);
  try {
    return parseInstant(value, key);
  } catch {
    throw new ToolInputError(`${key} doit être une date ISO 8601 valide (AAAA-MM-JJ).`);
  }
}

function optionalLimit(input: Record<string, unknown>): number {
  const value = input.limit;
  if (value === undefined || value === null) return 20;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_ROWS_FOR_MODEL) {
    throw new ToolInputError(`limit doit être un entier entre 1 et ${MAX_ROWS_FOR_MODEL}.`);
  }
  return value;
}

function pack(value: unknown): ToolOutcome {
  let text = JSON.stringify(redact(value));
  if (text.length > MAX_RESULT_CHARS) {
    text = `${text.slice(0, MAX_RESULT_CHARS)}…[résultat tronqué : réduisez la période ou le nombre de lignes]`;
  }
  return { content: text, isError: false };
}

function fail(message: string): ToolOutcome {
  return { content: message, isError: true };
}

/** Executes one tool call. Never throws: failures become error results the model can explain. */
export async function runTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  try {
    const input = asObject(rawInput);
    switch (name) {
      case 'get_sales_summary': {
        allowOnly(input, ['from', 'to', 'group']);
        const group = input.group ?? 'day';
        if (group !== 'day' && group !== 'month') throw new ToolInputError('group doit valoir day ou month.');
        return pack(
          await ctx.reports.sales(ctx.siteId, ctx.accessToken, {
            from: optionalDate(input, 'from'),
            to: optionalDate(input, 'to'),
            group,
          }),
        );
      }
      case 'get_reconciliation': {
        allowOnly(input, ['from', 'to']);
        const report = await ctx.reports.reconciliation(ctx.siteId, ctx.accessToken, {
          from: optionalDate(input, 'from'),
          to: optionalDate(input, 'to'),
        });
        return pack({
          summary: report.summary,
          truncated: report.truncated || report.items.length > MAX_ROWS_FOR_MODEL,
          items: report.items.slice(0, MAX_ROWS_FOR_MODEL),
        });
      }
      case 'list_recent_sales': {
        allowOnly(input, ['from', 'to', 'limit']);
        const page = await ctx.commerce.list('sales', ctx.siteId, ctx.accessToken, {
          limit: optionalLimit(input),
          from: optionalDate(input, 'from'),
          to: optionalDate(input, 'to'),
        });
        return pack(page.items);
      }
      case 'list_payments': {
        allowOnly(input, ['from', 'to', 'limit', 'status']);
        const status = input.status;
        if (
          status !== undefined &&
          !['pending', 'paid', 'failed', 'expired', 'mismatch', 'cancelled'].includes(String(status))
        ) {
          throw new ToolInputError('status inconnu.');
        }
        const page = await ctx.commerce.list('payments', ctx.siteId, ctx.accessToken, {
          limit: status ? MAX_ROWS_FOR_MODEL : optionalLimit(input),
          from: optionalDate(input, 'from'),
          to: optionalDate(input, 'to'),
        });
        const wanted = typeof status === 'string' ? page.items.filter(item => item.status === status) : page.items;
        return pack(wanted.slice(0, optionalLimit(input)));
      }
      case 'get_pricing':
        allowOnly(input, []);
        return pack(await ctx.commerce.sitePricing(ctx.siteId, ctx.accessToken));
      case 'get_stock':
        allowOnly(input, []);
        return pack(await ctx.commerce.stockSummary(ctx.siteId, ctx.accessToken));
      case 'list_routers':
        allowOnly(input, []);
        return pack(await ctx.routers.list(ctx.siteId, ctx.accessToken));
      default:
        return fail(`Outil inconnu : ${name}.`);
    }
  } catch (error) {
    if (error instanceof ToolInputError) return fail(error.message);
    if (error instanceof HttpException) {
      const status = error.getStatus();
      if (status === 403) return fail("Votre rôle sur ce site ne permet pas de consulter cette information.");
      if (status === 404) return fail("Information introuvable pour ce site.");
      if (status === 400) return fail('Paramètres refusés (période invalide ou trop longue ?).');
    }
    return fail("Cette information est momentanément indisponible.");
  }
}
