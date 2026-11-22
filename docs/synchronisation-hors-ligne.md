# Synchronisation hors ligne — Lot 1

## Flux cible

1. Le client Flutter produit un événement métier avec un UUID stable, le site, l'appareil, le type, la version du schéma, l'heure UTC et le payload.
2. L'événement est enregistré dans la base locale Sembast avant que l'opération soit considérée comme mise en file.
3. Quand l'application dispose d'un accès Cloud et d'un jeton utilisateur valide, elle envoie un lot d'au plus 50 événements vers `POST /v1/sites/:siteId/sync/events`.
4. L'API NestJS authentifie l'utilisateur, valide les DTO et transmet le lot à la fonction PostgreSQL `ingest_sync_events`.
5. PostgreSQL vérifie l'appartenance active au site, valide le lot (1 à 100 événements), insère les nouveaux identifiants et ignore les événements déjà reçus pour ce site. Chaque nouvel événement est traité dans la même transaction (voir « Traitement des événements »).
6. L'API retourne les identifiants acquittés. Le client ne supprime localement que les événements dont l'identifiant figure dans un accusé complet et valide.
7. En cas d'échec, les événements restent en base locale et un délai exponentiel est enregistré avant la prochaine tentative.

## Contrat API

`POST /v1/sites/{siteId}/sync/events`

En-têtes : `Authorization: Bearer <Supabase access token>`, `Content-Type: application/json`.

Corps : `{ "events": [ ... ] }`, avec 1 à 100 événements. Chaque événement suit `packages/contracts/sync-event.schema.json`.

La réponse contient `site_id`, `received_count`, `inserted_count`, `processed_count`, `conflict_count`, `rejected_count` et `acknowledged_event_ids`. Un événement en conflit ou rejeté est tout de même acquitté : il est conservé côté serveur et ne doit pas être renvoyé.

## Garanties et limites actuelles

- Les événements sont conservés localement jusqu'à acquittement serveur.
- L'identifiant stable permet la déduplication lors des renvois après coupure.
- La file locale utilise une base Sembast dans le répertoire privé de l'application.
- Les tentatives échouées sont différées avec backoff exponentiel plafonné à une heure.
- L'API et les migrations PostgreSQL sont préparées et testées sur PostgreSQL local (`supabase/tests/run.sh`) ; les migrations ne sont pas encore appliquées à un projet Supabase.
- Le flux n'est pas encore branché aux écrans de vente/tickets : l'application ne possède pas encore de session Cloud/site actif intégrée à son parcours utilisateur.
- Le déclenchement automatique à la reconnexion (côté Flutter) reste à faire. La résolution des conflits (décision humaine) est prévue au Lot 4 ; ils sont déjà enregistrés.
- Les événements métiers ne doivent pas contenir de mots de passe, tokens ou autres secrets.

## Sécurité

La table d'inbox est isolée par `site_id` et protégée par RLS. Le client authentifié dispose du droit d'insertion nécessaire à la fonction, mais ne dispose pas d'un accès direct en lecture aux payloads d'événements. L'API vérifie que les événements du lot appartiennent tous au site indiqué dans l'URL.

## Traitement des événements (Lot 1)

Chaque événement a un statut : `pending`, `processed`, `conflict` ou `rejected` (colonnes `status`, `processed_at`, `process_error` de `sync_events`).

Type pris en charge : `sale.recorded`, avec le payload suivant.

| Champ | Obligatoire | Règle |
| --- | --- | --- |
| `sale_id` | oui | UUID stable de la vente |
| `amount` | oui | nombre ≥ 0 |
| `currency` | oui | `CDF` ou `USD` |
| `payment_method` | oui | `cash` ou `mobile_money` |
| `plan_name` | non | texte, 120 caractères max |
| `ticket_code` | non | texte, 64 caractères max, unique par site |
| `sold_at` | non | date ISO ; par défaut `occurred_at` |

Effets d'un événement valide : une ligne dans `sales`, une dans `tickets` si `ticket_code` est fourni, une dans `cash_entries` si le paiement est `cash`.

Règles d'idempotence et de conflit :

- Un événement déjà reçu (même `id`) est ignoré.
- Même `sale_id` avec un contenu identique : aucune nouvelle écriture, événement `processed`.
- Même `sale_id` avec un contenu différent : statut `conflict` (`sale_mismatch`), la vente d'origine n'est pas modifiée.
- `ticket_code` déjà utilisé par une autre vente : `conflict` (`ticket_code_taken`).
- Payload invalide ou type inconnu : `rejected`, avec la raison dans `process_error`.

Les conflits sont listés dans `sync_conflicts` (lecture réservée aux membres du site). Les tables métier ne sont modifiables que par les fonctions PostgreSQL. La fonction `process_pending_sync_events(site_id, limit)`, réservée au rôle `service_role`, retraite les événements restés `pending`.

## Tests

`supabase/tests/run.sh` lance un PostgreSQL temporaire, applique toutes les migrations et exécute `sync_processing.test.sql` (idempotence, conflits, rejets, isolation entre sites, droits).
