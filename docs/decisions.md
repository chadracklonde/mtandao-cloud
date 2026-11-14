# Décisions d'architecture

| Sujet | Décision |
|---|---|
| Backend métier | NestJS |
| Authentification | Supabase Auth |
| Base | PostgreSQL / Supabase |
| Dashboard | Next.js |
| Application terrain | Flutter existant |
| Passerelles | Linux et Android; téléphone temporaire possible |
| Monnaies | CDF et USD, devise conservée par transaction |
| Multi-tenant | Un espace indépendant par site |
| Synchronisation | Outbox locale, déduplication serveur, accusé de réception |
| MikroTik | API RouterOS comme interface de compatibilité principale |

## Principes non négociables

1. Le mode local ne dépend pas de la disponibilité du Cloud.
2. Pas d'accès direct public aux routeurs.
3. Pas de confirmation de paiement basée sur le retour navigateur/mobile.
4. Les commandes Cloud vers Gateway sont autorisées par liste blanche.
5. Toute donnée métier porte son site et est contrôlée côté serveur.
6. Les événements sont idempotents et traçables.

## Points à décider avant production

- Hébergeur et région de déploiement.
- Fournisseurs Mobile Money et contrats marchands RDC.
- Politique de conservation des données et sauvegardes.
- Modèle exact d'unités monétaires et règles d'arrondi.
- Méthode de distribution/installation de la passerelle Android.
