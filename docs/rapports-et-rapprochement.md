# Rapports et rapprochement — Lot 4

## Rapports de ventes

`GET /v1/sites/:siteId/reports/sales?from=&to=&group=day|month`

- Regroupe les ventes par période et par devise : nombre de ventes, total, part espèces, part Mobile Money.
- Les périodes suivent le **fuseau horaire du site** (par exemple `Africa/Lubumbashi`, UTC+2) : une vente à 23 h 30 UTC le 30 novembre compte pour le 1er décembre.
- `from` inclus, `to` exclu (dates ISO 8601). Par défaut : les 30 derniers jours. Maximum 366 jours, `from` doit précéder `to`.
- Les ventes en conflit ou rejetées à la synchronisation ne sont pas comptées : seules les ventes acceptées existent dans `sales`.
- Rôles autorisés : owner, admin, manager, viewer. Un vendeur ou un technicien reçoit `403`.

## Rapprochement

`GET /v1/sites/:siteId/reports/reconciliation?from=&to=`

Réponse : `{ "items": [...], "summary": { "<type>": <nombre> }, "truncated": false }`. La liste est limitée à 500 écarts ; `truncated` indique qu'il faut réduire la période.

| Type | Signification |
| --- | --- |
| `cash_entry_missing` | vente en espèces sans entrée de caisse |
| `cash_entry_mismatch` | montant ou devise de la caisse différent de la vente |
| `cash_entry_unexpected` | entrée de caisse pour une vente payée autrement |
| `ticket_missing` | vente annonçant un code de ticket sans ticket correspondant |
| `sync_conflict_open` | conflit de synchronisation non résolu |
| `sync_event_rejected` | événement que le serveur n'a pas pu appliquer (raison dans `details`) |
| `sync_event_stuck` | événement resté en attente plus de 10 minutes |

Le traitement normal des événements maintient la cohérence vente / caisse / ticket : les quatre premiers types ne doivent apparaître qu'après une correction manuelle ou une anomalie. Les trois derniers signalent des problèmes de synchronisation à traiter. Les écarts de paiement (`payment_amount_mismatch`, `payment_out_of_stock`, `payment_activation_failed`, `payment_activation_stuck`) sont décrits dans [paiements.md](paiements.md).

## Tableau de bord

Le composant `apps/dashboard/app/site-reports.tsx` s'affiche dès qu'un site est sélectionné, avec cinq onglets : Rapport, Ventes, Caisse, Tickets, Écarts. Un sélecteur de dates (du / au, jour inclus) et le regroupement jour/mois s'appliquent aux onglets concernés ; les listes se chargent par pages de 50 avec « Charger plus ». Un rôle sans droit voit un message explicatif plutôt qu'une erreur technique.

## Limites actuelles

- La résolution des conflits (choisir quelle version garder) n'est pas encore possible : les conflits sont uniquement signalés.
- Pas d'export CSV ni de graphiques.
- Les pages du dashboard n'ont été vérifiées que par compilation et typage ; un contrôle visuel avec une session réelle reste à faire.

Tests : `supabase/tests/reports.test.sql` (via `supabase/tests/run.sh`) et `apps/api/src/reports/reports.service.spec.ts`.

## Conflits de synchronisation et export (Lot 11)

Un conflit (`sale_mismatch`, `ticket_code_taken`, `concurrent_duplicate`) reste ouvert jusqu'à décision. Les owner, admin et manager choisissent **Garder la version du Cloud** ou **Écarter**, avec une note facultative. La décision est conservée (auteur, date, note) et auditée, et l'écart disparaît du rapprochement. Elle ne modifie aucune vente.

Les listes (rapport, ventes, caisse, tickets) s'exportent en CSV depuis le dashboard, jusqu'à 10 000 lignes ; au-delà, réduire la période.
