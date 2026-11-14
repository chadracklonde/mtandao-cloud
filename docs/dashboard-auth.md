# Authentification du tableau de bord Mtandao Cloud

Le tableau de bord utilise Supabase Auth avec `@supabase/ssr`. L'application ne demande plus à l'utilisateur de copier un access token.

## Variables d'environnement du dashboard

Créer `apps/dashboard/.env.local` à partir de `.env.example` :

- `NEXT_PUBLIC_SUPABASE_URL` : URL du projet Supabase choisi pour Mtandao Cloud.
- `NEXT_PUBLIC_SUPABASE_ANON_KEY` : clé publique anon/publishable du même projet.
- `NEXT_PUBLIC_MTANDAO_API_URL` : URL publique de l'API Mtandao Cloud, sans slash final.

Ces trois valeurs sont publiques par conception. Ne jamais placer une clé `service_role`, une clé secrète Supabase ou un secret backend dans une variable `NEXT_PUBLIC_*`.

## Variables de l'API

Configurer côté serveur :

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `DASHBOARD_ORIGIN` : origine exacte du dashboard, par exemple `https://cloud.example.com`, sans chemin.

La valeur de l'API et celle du dashboard doivent désigner le même projet Supabase.

## Configuration Supabase Auth

1. Dans le projet Supabase dédié à Mtandao Cloud, activer le fournisseur Email.
2. Configurer les URL du site et les URL de redirection autorisées pour les domaines de développement et de production.
3. Créer les utilisateurs via le mécanisme d'administration retenu ; l'écran actuel fournit la connexion e-mail/mot de passe, pas l'inscription publique.
4. Appliquer les migrations Mtandao dans l'ordre prévu, après vérification du projet cible.

## Flux d'accès

1. Le navigateur ouvre une session via Supabase Auth.
2. `@supabase/ssr` conserve et renouvelle la session dans les cookies du navigateur.
3. Le dashboard transmet l'access token de la session à l'API via HTTPS.
4. L'API valide le token auprès de Supabase Auth.
5. `GET /v1/sites` liste les sites où l'utilisateur possède une adhésion active ; la politique RLS reste appliquée par PostgreSQL.
6. `GET /v1/sites/:siteId/routers` fournit les routeurs autorisés pour le site sélectionné.

## Sécurité et limites actuelles

- Aucune clé `service_role` n'est utilisée dans le navigateur.
- Le token n'est plus saisi ni stocké dans un champ applicatif.
- Les endpoints métier restent protégés par `SupabaseAuthGuard` et les politiques RLS.
- L'API doit être publiée en HTTPS en production.
- Configurer précisément `DASHBOARD_ORIGIN` ; ne pas ouvrir CORS à toutes les origines.
- La création de compte, la réinitialisation du mot de passe et la MFA ne sont pas encore exposées dans l'interface.
- Ne pas appliquer les migrations à un projet Supabase dont l'identité n'a pas été confirmée.
