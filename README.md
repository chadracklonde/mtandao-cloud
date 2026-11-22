# Mtandao Cloud

Plateforme centrale de gestion des sites Wi-Fi Mtandao.

## Architecture

- `apps/api` : backend métier NestJS.
- `apps/dashboard` : tableau de bord Web Next.js.
- `supabase/migrations` : migrations PostgreSQL versionnées.
- `packages/contracts` : contrats API et événements partagés.
- `docs` : décisions d'architecture et guides.

## Principes

1. Chaque site constitue un espace de données isolé.
2. Les opérations locales doivent rester possibles sans Cloud.
3. Les paiements ne sont confirmés qu'après validation serveur du fournisseur.
4. Les événements de synchronisation sont idempotents.
5. Les secrets ne sont jamais intégrés au client Flutter ou au navigateur.

## Stack retenue

- NestJS pour la logique métier.
- Next.js pour le tableau de bord.
- Supabase Auth et PostgreSQL.
- Redis et une file de tâches seront ajoutés lorsque les traitements asynchrones seront introduits.

## Démarrage

Consulter `docs/architecture.md`, `docs/decisions.md` et le guide [authentification du tableau de bord](docs/dashboard-auth.md).

## État du projet

Fondations, Gateway et synchronisation des ventes réalisés (Lots 0 à 5, 7 et 8 ; Lot 6 livré par correctifs pour le dépôt Gateway). Voir le [plan de réalisation](docs/plan-de-realisation.md). Aucun paiement réel ni accès routeur de production n'est activé à ce stade.

## Cahier des charges et documentation

- [Cahier des charges Mtandao Cloud](docs/cahier-des-charges.md) — exigences produit et techniques de référence.
- [Architecture](docs/architecture.md) — responsabilités des composants et flux.
- [Décisions d'architecture](docs/decisions.md) — choix structurants.
- [Authentification du tableau de bord](docs/dashboard-auth.md) — configuration Supabase Auth.
- [Déploiement gratuit de l'API](docs/deploiement-gratuit.md) — configuration Render Free et limites de disponibilité.
- [Déploiement Google Cloud Run](docs/deploiement-google-cloud-run.md) — conteneur Docker, configuration et garde-fous de coûts.
- [Plan de réalisation par lots](docs/plan-de-realisation.md).
- [Audit et rôles](docs/audit-et-roles.md).
- [Ventes, tickets et catalogue](docs/ventes-et-tickets.md).
- [Rapports et rapprochement](docs/rapports-et-rapprochement.md).
- [Commandes Gateway](docs/commandes-gateway.md).
- [Paiements (sandbox)](docs/paiements.md).
- [Portail client](docs/portail-client.md).
- [Synchronisation hors ligne](docs/synchronisation-hors-ligne.md) — contrat d'événements, file locale, accusés de réception et reprise.
- [Enrôlement Gateway](docs/gateway-enrollment.md) et [Heartbeat](docs/gateway-heartbeat.md).
- [Mtandao Ticket — cahier des charges](https://github.com/chadracklonde/mtandao-ticket-app/blob/main/docs/cahier-des-charges.md).
- [Mtandao Gateway — cahier des charges](https://github.com/chadracklonde/mtandao-gateway/blob/main/docs/cahier-des-charges.md).
