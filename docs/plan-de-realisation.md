# Plan de réalisation par lots

Ce plan découpe les phases du [cahier des charges](cahier-des-charges.md) (§9) en lots exécutables. Chaque lot livre migrations, tests, documentation et un critère de sortie. Statut mis à jour à chaque lot. Les migrations des lots 1 et 2 sont appliquées sur le projet Supabase `mtandao-cloud`.

| Lot | Contenu | Phase | Statut |
| --- | --- | --- | --- |
| 1 | Clôture de la synchronisation | 3 | Terminé, hors application sur Supabase |
| 2 | Audit et rôles | 2 | Terminé, hors application sur Supabase |
| 3 | Ventes et tickets côté API | 3-4 | Terminé, migration 003 non appliquée sur Supabase |
| 4 | Dashboard, rapports, rapprochement | 4 | Terminé, migrations 003 et 004 non appliquées sur Supabase |
| 5 | Commandes typées vers le Gateway | 5 | À faire |
| 6 | Adaptateur RouterOS 6 et 7 | 6 | À faire |
| 7 | Paiement sandbox | 7 | À faire |
| 8 | Portail client | 8 | À faire |
| 9 | Assistant analytique IA | 9 | À faire |
| 10 | Pilote terrain | 10 | À faire |

Déjà livré avant le plan : socle Cloud (auth, sites, invitations, RLS), routeurs, enrôlement/heartbeat/révocation/ré-enrôlement du Gateway, inbox de synchronisation idempotente.

## LOT 1 — Clôture de la synchronisation

- 1.1 Statut des événements et tables métier (`sales`, `tickets`, `cash_entries`, `sync_conflicts`).
- 1.2 Traitement idempotent des événements de l'inbox (`sale.recorded`).
- 1.3 Détection et enregistrement des conflits.
- 1.4 Tests d'intégration contre PostgreSQL (`supabase/tests`).
- 1.5 Documentation, README, application des migrations sur Supabase.

**Critère de sortie** : un événement de vente envoyé deux fois ne produit qu'une écriture. Atteint et vérifié par `supabase/tests/run.sh`.
**Reste hors lot** : application des migrations sur un projet Supabase (projet cible à désigner) ; déclenchement à la reconnexion côté Flutter.

## LOT 2 — Audit et rôles

- Table `audit_log` alimentée par les opérations sensibles (invitations, révocation et ré-enrôlement Gateway, création de site).
- Contrôle des rôles (owner, admin, manager, seller, technician, viewer) couvert par des tests.
- Endpoint de consultation de l'audit réservé aux admins.

**Critère de sortie** : chaque action sensible laisse une trace ; deux sites restent isolés. Atteint ; voir [audit-et-roles.md](audit-et-roles.md).

## LOT 3 — Ventes et tickets côté API

- Endpoints de lecture : ventes, tickets, caisse, par site et par période.
- Catalogue de forfaits et stock de tickets.
- Contrats dans `packages/contracts`.

**Critère de sortie** : les ventes synchronisées sont consultables via l'API, avec isolation par site. Atteint ; voir [ventes-et-tickets.md](ventes-et-tickets.md).

## LOT 4 — Dashboard, rapports et rapprochement

- Pages Ventes, Caisse, Tickets ; rapports journaliers et mensuels.
- Écarts de rapprochement vente / caisse / ticket (puis paiement).

**Critère de sortie** : les écarts sont signalés. Atteint ; voir [rapports-et-rapprochement.md](rapports-et-rapprochement.md). Reste : résolution des conflits, export, contrôle visuel du dashboard.

## LOT 5 — Commandes typées vers le Gateway

- Table `gateway_commands` (file, statut, expiration), endpoints de création, récupération et accusé.
- Validation par `gateway-command.schema.json`.

**Critère de sortie** : une commande n'est délivrée qu'une fois, à un Gateway valide ; un Gateway révoqué ou suspendu n'en reçoit aucune.

## LOT 6 — Adaptateur RouterOS

- Contrat d'adaptateur (utilisateurs hotspot), implémentations RouterOS 6 et 7, tests avec double simulé puis équipement réel.

**Critère de sortie** : activation d'un ticket testée sur RouterOS 6 et 7.

## LOT 7 — Paiement sandbox

- Tables `payment_transactions` et `webhook_events`, webhook signé et idempotent, état « payé en attente » si Gateway absent.
- Prérequis : choix du fournisseur Mobile Money (cahier des charges §11).

**Critère de sortie** : webhook dupliqué = un seul ticket ; faux webhook rejeté.

## LOT 8 — Portail client

- Parcours public d'achat et d'accès ; refus des accès expirés ou d'un autre ticket ; paiement autonome.

## LOT 9 — Assistant analytique IA

- Questions en langage naturel, en lecture seule, limitées au site de l'utilisateur.

## LOT 10 — Pilote terrain

- Déploiement sur 1 à 3 sites, supervision, support, décision de généralisation.
