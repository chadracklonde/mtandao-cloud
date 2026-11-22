# Commandes typées vers le Gateway — Lot 5

Le Cloud met des commandes en file ; le Gateway les récupère par sondage (connexion sortante uniquement) et renvoie le résultat. Le contrat de commande est `packages/contracts/gateway-command.schema.json`, celui du résultat `gateway-command-result.schema.json`.

## Opérations

| Opération | Payload | Rôles autorisés à l'émettre |
| --- | --- | --- |
| `health.check` | aucun | owner, admin, manager, technician |
| `hotspot.profile.list` | aucun | owner, admin, manager, technician |
| `hotspot.active-sessions.list` | aucun | owner, admin, manager, technician |
| `hotspot.voucher.create` | `code` (1-64), `profile` (optionnel), `duration_minutes` (entier, optionnel) | owner, admin, manager |
| `hotspot.voucher.disable` | `code` | owner, admin, manager |

Toute autre opération ou tout champ inattendu est refusé : le Gateway n'exécute que des opérations connues, jamais de commande RouterOS libre.

## Côté utilisateur (jeton Supabase)

- `POST /v1/sites/:siteId/routers/:routerId/commands` — corps : `operation`, `payload`, `ttlSeconds` (30 à 3600, 300 par défaut), `idempotencyKey` (optionnel). Réponse : `{ "commandId": "..." }`.
- `GET /v1/sites/:siteId/commands?routerId=&status=&limit=` — lecture réservée à owner, admin, manager et technician (les payloads contiennent des codes de voucher).
- `POST /v1/sites/:siteId/commands/:commandId/cancel` — annule une commande encore en attente.

Avec la même `idempotencyKey`, le même ordre renvoie la même commande ; un ordre différent avec la même clé est refusé (`409`). Au plus 50 commandes ouvertes par routeur (`409` au-delà). Un routeur révoqué ou suspendu refuse toute nouvelle commande.

## Côté Gateway (jeton permanent, comme le heartbeat)

- `POST /v1/gateway/commands/claim` — corps optionnel `{ "limit": 1..50 }`. Retourne `{ "commands": [...] }` pour le routeur du Gateway uniquement, du plus ancien au plus récent.
- `POST /v1/gateway/commands/:commandId/result` — corps `{ "success": true|false, "result": {...}, "error": "..." }`. Résultat limité à 64 Ko.

Seul le hachage SHA-256 du jeton est transmis à la base.

## Cycle de vie

`pending` → `delivered` (récupérée par le Gateway) → `succeeded` ou `failed`. Autres états : `expired` (jamais récupérée avant `expires_at`) et `cancelled`.

- **Livraison unique** : une commande récupérée n'est plus jamais renvoyée, même si le Gateway redemande. Si le Gateway tombe avant d'avoir répondu, la commande n'est pas rejouée automatiquement (une création de voucher ne doit pas s'exécuter deux fois) : sans résultat après 15 minutes, elle passe en `failed` (« gateway did not report a result ») et l'utilisateur peut en émettre une nouvelle.
- **Résultat idempotent** : renvoyer le même résultat est accepté ; un résultat contradictoire est refusé (`409`).
- **Expiration** : une commande en attente après `expires_at` n'est jamais livrée. La base la marque `expired` lors du prochain sondage ; l'API l'affiche déjà comme expirée avant. La fonction `expire_gateway_commands()` (réservée à `service_role`) peut aussi être planifiée.
- **Révocation** : révoquer ou suspendre un routeur annule ses commandes ouvertes, et son Gateway ne peut plus ni récupérer ni répondre (`401`).

## Audit

`command.created` et `command.cancelled` sont inscrits au journal d'audit avec l'opération et le routeur, jamais le payload.

## Limites actuelles

- Pas de signature de commande : l'intégrité repose sur TLS et le jeton du Gateway (le champ `signature` du contrat reste optionnel).
- Le Gateway fonctionne par sondage ; pas de notification poussée.
- L'exécution réelle sur RouterOS relève du Lot 6 (adaptateur) ; ce lot fournit le canal et ses garanties.
- Le dashboard n'expose pas encore l'envoi de commandes.

Tests : `supabase/tests/gateway_commands.test.sql` (via `supabase/tests/run.sh`) et `apps/api/src/commands/commands.service.spec.ts`.
