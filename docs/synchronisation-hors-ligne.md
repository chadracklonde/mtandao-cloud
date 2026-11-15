# Synchronisation hors ligne — Lot 1

## Flux cible

1. Le client Flutter produit un événement métier avec un UUID stable, le site, l'appareil, le type, la version du schéma, l'heure UTC et le payload.
2. L'événement est enregistré dans la base locale Sembast avant que l'opération soit considérée comme mise en file.
3. Quand l'application dispose d'un accès Cloud et d'un jeton utilisateur valide, elle envoie un lot d'au plus 50 événements vers `POST /v1/sites/:siteId/sync/events`.
4. L'API NestJS authentifie l'utilisateur, valide les DTO et transmet le lot à la fonction PostgreSQL `ingest_sync_events`.
5. PostgreSQL vérifie l'appartenance active au site, valide le lot (1 à 100 événements), insère les nouveaux identifiants et ignore les événements déjà reçus pour ce site.
6. L'API retourne les identifiants acquittés. Le client ne supprime localement que les événements dont l'identifiant figure dans un accusé complet et valide.
7. En cas d'échec, les événements restent en base locale et un délai exponentiel est enregistré avant la prochaine tentative.

## Contrat API

`POST /v1/sites/{siteId}/sync/events`

En-têtes : `Authorization: Bearer <Supabase access token>`, `Content-Type: application/json`.

Corps : `{ "events": [ ... ] }`, avec 1 à 100 événements. Chaque événement suit `packages/contracts/sync-event.schema.json`.

La réponse contient `site_id`, `received_count`, `inserted_count` et `acknowledged_event_ids`.

## Garanties et limites actuelles

- Les événements sont conservés localement jusqu'à acquittement serveur.
- L'identifiant stable permet la déduplication lors des renvois après coupure.
- La file locale utilise une base Sembast dans le répertoire privé de l'application.
- Les tentatives échouées sont différées avec backoff exponentiel plafonné à une heure.
- L'API et la migration PostgreSQL sont préparées ; la migration n'est pas appliquée à un projet Supabase.
- Le flux n'est pas encore branché aux écrans de vente/tickets : l'application ne possède pas encore de session Cloud/site actif intégrée à son parcours utilisateur.
- Le déclenchement automatique à la reconnexion et le traitement des conflits restent à faire.
- Les événements métiers ne doivent pas contenir de mots de passe, tokens ou autres secrets.

## Sécurité

La table d'inbox est isolée par `site_id` et protégée par RLS. Le client authentifié dispose du droit d'insertion nécessaire à la fonction, mais ne dispose pas d'un accès direct en lecture aux payloads d'événements. L'API vérifie que les événements du lot appartiennent tous au site indiqué dans l'URL.
