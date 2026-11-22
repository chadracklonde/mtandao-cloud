# Plan de réalisation par lots

Ce plan découpe les phases du [cahier des charges](cahier-des-charges.md) (§9) en lots exécutables. Chaque lot livre migrations, tests, documentation et un critère de sortie. Statut mis à jour à chaque lot. Les migrations des lots 1 et 2 sont appliquées sur le projet Supabase `mtandao-cloud`.

| Lot | Contenu | Phase | Statut |
| --- | --- | --- | --- |
| 1 | Clôture de la synchronisation | 3 | Terminé, hors application sur Supabase |
| 2 | Audit et rôles | 2 | Terminé, hors application sur Supabase |
| 3 | Ventes et tickets côté API | 3-4 | Terminé, migration 003 non appliquée sur Supabase |
| 4 | Dashboard, rapports, rapprochement | 4 | Terminé, migrations 003 et 004 non appliquées sur Supabase |
| 5 | Commandes typées vers le Gateway | 5 | Terminé, migrations 003 à 005 non appliquées sur Supabase |
| 6 | Adaptateur RouterOS 6 et 7 | 6 | Code livré sous forme de correctifs pour le dépôt Gateway (à appliquer) ; validation sur routeur réel à faire |
| 7 | Paiement sandbox | 7 | Terminé, migrations 003 à 007 non appliquées sur Supabase |
| 8 | Portail client | 8 | Terminé (fournisseur sandbox), migrations 003 à 008 non appliquées sur Supabase |
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
- Tarifs par durée standard définis site par site : 1 h, 2 h, 24 h, 1 semaine, 1 mois (voir [ventes-et-tickets.md](ventes-et-tickets.md)).
- Contrats dans `packages/contracts`.

**Critère de sortie** : les ventes synchronisées sont consultables via l'API, avec isolation par site. Atteint ; voir [ventes-et-tickets.md](ventes-et-tickets.md).

## LOT 4 — Dashboard, rapports et rapprochement

- Pages Ventes, Caisse, Tickets ; rapports journaliers et mensuels.
- Écarts de rapprochement vente / caisse / ticket (puis paiement).

**Critère de sortie** : les écarts sont signalés. Atteint ; voir [rapports-et-rapprochement.md](rapports-et-rapprochement.md). Reste : résolution des conflits, export, contrôle visuel du dashboard.

## LOT 5 — Commandes typées vers le Gateway

- Table `gateway_commands` (file, statut, expiration), endpoints de création, récupération et accusé.
- Validation par `gateway-command.schema.json`.

**Critère de sortie** : une commande n'est délivrée qu'une fois, à un Gateway valide ; un Gateway révoqué ou suspendu n'en reçoit aucune. Atteint ; voir [commandes-gateway.md](commandes-gateway.md).

## LOT 6 — Adaptateur RouterOS

- Contrat d'adaptateur (utilisateurs hotspot), implémentations RouterOS 6 et 7, tests avec double simulé puis équipement réel.

**Critère de sortie** : activation d'un ticket testée sur RouterOS 6 et 7. Non atteint : le code est testé avec un routeur simulé et contre l'API Cloud réelle, la validation sur équipements est décrite dans le plan de test du dépôt Gateway (`docs/lab-test-plan.md`).

**Point d'alignement (résolu)** : le Gateway n'accepte que les codes de voucher `[A-Za-z0-9_.-]{1,64}` ; le Cloud accepte aujourd'hui toute chaîne de 1 à 64 caractères. À resserrer côté Cloud (commandes et import de stock) pour qu'un code accepté soit toujours exécutable.

## LOT 7 — Paiement sandbox

- Tables `payment_transactions` et `webhook_events`, webhook signé et idempotent, état « payé en attente » si Gateway absent.
- Prérequis : choix du fournisseur Mobile Money (cahier des charges §11).

**Critère de sortie** : webhook dupliqué = un seul ticket ; faux webhook rejeté. Atteint ; voir [paiements.md](paiements.md).

## LOT 8 — Portail client

- Parcours public d'achat et d'accès ; refus des accès expirés ou d'un autre ticket ; paiement autonome.

**Critère de sortie** : les accès expirés ou destinés à un autre ticket sont refusés. Atteint ; voir [portail-client.md](portail-client.md). Reste : intégration de l'invite de paiement d'un vrai fournisseur.

## LOT 9 — Assistant analytique IA

- Questions en langage naturel, en lecture seule, limitées au site de l'utilisateur.

## LOT 10 — Pilote terrain

- Déploiement sur 1 à 3 sites, supervision, support, décision de généralisation.
