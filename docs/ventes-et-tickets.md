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
- Le dashboard propose un panneau « Stock de tickets » (compteurs par forfait et import par collage ou fichier, réservé à owner, admin et manager).
- L'import de stock est idempotent : les codes déjà présents ou répétés sont ignorés. La réponse donne `submitted`, `inserted` et `skipped`.
- Les codes du stock donnent accès au réseau : seuls owner, admin et manager peuvent les lire. Les autres rôles voient uniquement les compteurs.
- Création, modification de forfait et import de stock sont inscrits au [journal d'audit](audit-et-roles.md) (`plan.created`, `plan.updated`, `ticket_stock.imported`).
- Erreurs : `403` rôle insuffisant, `404` forfait absent du site, `400` données invalides.

## Limites actuelles

- Le stock est consommé par les paiements confirmés (voir [paiements.md](paiements.md)) ; les ventes synchronisées depuis l'application ne le consomment pas.
- Les forfaits ne sont pas supprimables, seulement désactivables, pour conserver l'historique.

Tests : `supabase/tests/catalog.test.sql` (via `supabase/tests/run.sh`) et `apps/api/src/commerce/commerce.service.spec.ts`.

## Tarifs par durée standard

Chaque site fixe son propre prix pour cinq durées :

| Palier | Durée | Libellé par défaut |
| --- | --- | --- |
| `1h` | 60 minutes | 1 heure |
| `2h` | 120 minutes | 2 heures |
| `24h` | 1 440 minutes | 24 heures |
| `1w` | 10 080 minutes (7 jours) | 1 semaine |
| `1m` | 43 200 minutes (30 jours) | 1 mois |

- `GET /v1/sites/:siteId/pricing` (tout membre) : les cinq paliers dans l'ordre des durées, qu'ils soient définis ou non, avec `configured`, prix, devise, `active`, profil Hotspot, limite de données et stock disponible. `complete` vaut `true` quand les cinq paliers sont définis **et** actifs.
- `POST /v1/sites/:siteId/pricing/:tier` (owner, admin, manager) : `price` (≥ 0, 2 décimales), `currency` (par défaut la devise du site), `active` (vrai par défaut), `dataLimitMb`, `hotspotProfile`, `name` (par défaut le libellé). Crée ou met à jour le forfait du palier.
- Un palier est un forfait dont la durée est imposée par la base : un seul forfait par palier et par site, et une durée incohérente est refusée.
- Chaque site a ses prix et sa devise : le même palier peut valoir 500 CDF sur un site et 1 USD sur un autre.
- Un changement de prix modifie le même forfait ; les paiements déjà créés gardent le montant d'origine, et le journal d'audit conserve l'ancien prix.
- Un palier désactivé ou non défini n'apparaît pas dans le portail client. Le portail liste les forfaits du plus court au plus long.
- Les forfaits personnalisés (`POST /plans`, sans palier) restent possibles en plus des cinq paliers.
- Le tableau de bord affiche le panneau « Tarifs du site » avec un bandeau indiquant combien de paliers restent à définir ; la modification est réservée aux rôles owner, admin et manager.

Un site dont les cinq paliers ne sont pas définis reste utilisable : le Cloud ne bloque pas la vente, il signale ce qui manque.
