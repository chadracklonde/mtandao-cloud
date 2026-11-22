# Déploiement : API (Render) et dashboard (Vercel)

Ordre à suivre : API d'abord (son adresse est nécessaire au dashboard), puis dashboard, puis retour sur l'API pour autoriser l'adresse du dashboard.

## 1. API sur Render

1. Render → New → Blueprint → choisir le dépôt : le fichier `render.yaml` crée le service `mtandao-cloud-api`.
2. Passer le service sur une offre **toujours active** (le plan gratuit s'endort et coupe les Gateways).
3. Saisir les variables marquées « secret » :

| Variable | Valeur | Remarque |
| --- | --- | --- |
| `SUPABASE_URL` | `https://supzoqcfzwrxdfbtqdzo.supabase.co` | déjà dans `render.yaml` |
| `SUPABASE_ANON_KEY` | clé publique (« publishable ») du projet | déjà dans `render.yaml` |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase → Project Settings → API → clé `service_role` | **secret**, jamais côté navigateur |
| `TRUST_PROXY_HOPS` | `1` | déjà dans `render.yaml` |
| `DASHBOARD_ORIGIN` | adresse du dashboard Vercel, sans `/` final (ex. `https://mtandao-dashboard.vercel.app`) | à renseigner après l'étape 2 ; sans elle le navigateur est bloqué par CORS |
| `PAYMENT_SANDBOX_WEBHOOK_SECRET` | longue chaîne aléatoire (`openssl rand -hex 32`) | **tests seulement** ; vide en production |
| `ANTHROPIC_API_KEY` | clé API Anthropic | facultative : sans elle, l'assistant est désactivé |
| `ASSISTANT_MODEL` | (vide) | facultative, défaut `claude-opus-5-5` |

4. Vérifier : `https://<api>/v1/health` répond `ok`.

## 2. Dashboard sur Vercel

1. Vercel → Add New → Project → importer le dépôt.
2. **Root Directory** : `apps/dashboard`. Cocher « Include source files outside of the Root Directory » (le projet est un monorepo npm). Le fichier `apps/dashboard/vercel.json` fournit les commandes d'installation et de build.
3. Variables d'environnement (toutes publiques, visibles dans le navigateur — n'y mettez jamais de clé secrète) :

| Variable | Valeur |
| --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | `https://supzoqcfzwrxdfbtqdzo.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | la clé publique (« publishable ») du projet |
| `NEXT_PUBLIC_MTANDAO_API_URL` | adresse de l'API Render, sans `/` final |

4. Déployer. Le lien du dashboard est celui donné par Vercel ; le portail client est à `<dashboard>/portal/<identifiant-du-site>`.
5. Retourner dans Render et renseigner `DASHBOARD_ORIGIN` avec cette adresse, puis redéployer l'API.

## 3. Supabase Auth

Authentication → URL Configuration : mettre l'adresse du dashboard dans **Site URL** et l'ajouter aux **Redirect URLs**. Activer la protection contre les mots de passe compromis (Auth → Passwords).

## 4. Vérifier

1. Ouvrir le dashboard, créer un compte, créer un site.
2. Le panneau « Prêt pour la vente ? » doit se charger sans erreur réseau (sinon `DASHBOARD_ORIGIN` ou `NEXT_PUBLIC_MTANDAO_API_URL` est faux).
3. Poursuivre avec [mise-en-service.md](mise-en-service.md).

## Domaine propre

Vercel et Render acceptent un domaine personnalisé. Si vous en ajoutez un, mettez à jour `DASHBOARD_ORIGIN`, `NEXT_PUBLIC_MTANDAO_API_URL` et les URL Supabase Auth en conséquence.
