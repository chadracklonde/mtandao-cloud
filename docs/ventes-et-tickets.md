# Ventes, tickets et catalogue — Lot 3

Toutes les routes exigent `Authorization: Bearer <jeton Supabase>` et sont préfixées par `/v1/sites/:siteId`. L'isolation par site est appliquée par la base (RLS) avec le jeton de l'utilisateur : un utilisateur étranger au site reçoit une liste vide.

## Lecture

| Route | Contenu | Accès |
| --- | --- | --- |
| `GET /sales` | ventes synchronisées | tout membre |
| `GET /tickets` | tickets vendus | tout membre |
| `GET /cash-entries` | entrées de caisse | tout membre |
| `GET /plans` | catalogue de forfaits | tout membre |
| `GET /ticket-stock/summary` | compteurs de stock par forfait (disponible, réservé, vendu) | tout membre |

Paramètres des listes (`sales`, `tickets`, `cash-entries`) :

- `limit` : 1 à 200 (50 par défaut).
- `from` (inclus) et `to` (exclu) : dates ISO 8601, filtrées sur `sold_at`, `created_at` ou `occurred_at` selon la ressource.
- `cursor` : valeur `next_cursor` de la page précédente.

Réponse : `{ "items": [...], "next_cursor": "<horodatage>|<uuid>" | null }`, du plus récent au plus ancien. La pagination par curseur composite (horodatage, identifiant) ne saute ni ne répète aucune ligne, même si plusieurs lignes ont le même horodatage. `next_cursor` est nul à la dernière page.

## Écriture

| Route | Corps | Rôles |
| --- | --- | --- |
| `POST /plans` | `name`, `price` (≥ 0, 2 décimales), `currency` (`CDF`/`USD`), `durationMinutes` (1 à 525 600), `dataLimitMb` (optionnel), `hotspotProfile` (optionnel : profil RouterOS Hotspot des vouchers du forfait) | owner, admin, manager |
| `POST /plans/:planId/active` | `{ "active": true\|false }` | owner, admin, manager |
| `POST /plans/:planId/ticket-stock` | `{ "codes": ["..."] }`, 1 à 1000 codes de 1 à 64 caractères parmi lettres, chiffres, point, tiret et souligné | owner, admin, manager |

Règles :

- Le nom d'un forfait est unique par site (`400` sinon).
- L'import de stock est idempotent : les codes déjà présents ou répétés sont ignorés. La réponse donne `submitted`, `inserted` et `skipped`.
- Les codes du stock donnent accès au réseau : seuls owner, admin et manager peuvent les lire. Les autres rôles voient uniquement les compteurs.
- Création, modification de forfait et import de stock sont inscrits au [journal d'audit](audit-et-roles.md) (`plan.created`, `plan.updated`, `ticket_stock.imported`).
- Erreurs : `403` rôle insuffisant, `404` forfait absent du site, `400` données invalides.

## Limites actuelles

- Le stock est consommé par les paiements confirmés (voir [paiements.md](paiements.md)) ; les ventes synchronisées depuis l'application ne le consomment pas.
- Les forfaits ne sont pas supprimables, seulement désactivables, pour conserver l'historique.

Tests : `supabase/tests/catalog.test.sql` (via `supabase/tests/run.sh`) et `apps/api/src/commerce/commerce.service.spec.ts`.
