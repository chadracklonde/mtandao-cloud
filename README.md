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

Les applications et migrations seront ajoutées progressivement. Consulter `docs/architecture.md` et `docs/decisions.md`.

## État du projet

Phase initiale : fondations et contrats. Aucun paiement réel ni accès routeur de production n'est activé à ce stade.
