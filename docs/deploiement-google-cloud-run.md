# Déployer l'API Mtandao Cloud sur Google Cloud Run

Ce guide prépare le déploiement de `apps/api` comme conteneur Node.js sur Cloud Run. Le dépôt contient le `Dockerfile` à la racine ; le tableau de bord Next.js n'est pas inclus dans cette image.

## Avant de commencer

- Un projet Google Cloud dédié à Mtandao Cloud.
- La facturation activée sur ce projet (Cloud Run exige un compte de facturation, même si l'usage reste dans les quotas gratuits).
- Google Cloud CLI installé et authentifié.
- Les migrations Supabase déjà appliquées sur le projet `mtandao-cloud`.

Le déploiement n'est pas lancé automatiquement par ce guide. La création du service Cloud Run et l'activation de la facturation nécessitent une action explicite dans votre compte Google Cloud.

## 1. Sélectionner le projet et la région

La région recommandée est Paris (`europe-west9`) pour rapprocher l'API de la base Supabase hébergée à Paris.

```bash
gcloud auth login
gcloud config set project VOTRE_PROJECT_ID
gcloud config set run/region europe-west9
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com
```

Le nom de projet Google Cloud est distinct du nom et de la référence du projet Supabase.

## 2. Configurer les variables d'environnement

Valeurs nécessaires au backend :

- `SUPABASE_URL=https://supzoqcfzwrxdfbtqdzo.supabase.co`
- `SUPABASE_ANON_KEY` : clé publishable du projet Supabase Mtandao Cloud.
- `DASHBOARD_ORIGIN` : origine HTTPS exacte du tableau de bord une fois celui-ci hébergé, par exemple `https://votre-dashboard.example` (remplacer par la vraie URL).
- `NODE_ENV=production`

La clé publishable est conçue pour être utilisée côté client ; elle ne remplace jamais les contrôles d'accès et les politiques RLS. **Ne configurez jamais une clé `service_role` ou une clé secrète dans cette API.** Le backend valide les jetons des utilisateurs et utilise les permissions RLS.

Pour éviter de placer la clé dans l'historique du terminal, vous pouvez la définir dans la console Google Cloud Run, section Variables et secrets, au moment du déploiement. N'ajoutez aucun secret dans le dépôt Git.

## 3. Construire et déployer

Depuis la racine du dépôt :

```bash
gcloud run deploy mtandao-cloud-api \
  --source . \
  --region europe-west9 \
  --allow-unauthenticated \
  --cpu 1 \
  --memory 512Mi \
  --concurrency 20 \
  --min 0 \
  --max 2 \
  --cpu-throttling \
  --set-env-vars NODE_ENV=production,SUPABASE_URL=https://supzoqcfzwrxdfbtqdzo.supabase.co
```

Après cette commande, renseignez la clé publishable et `DASHBOARD_ORIGIN` dans la configuration du service Cloud Run, puis déployez la nouvelle révision. Vous pouvez aussi les fournir dans la console lors de la création du service.

L'API écoute le port fourni par Cloud Run (`PORT`) et expose le contrôle de santé sur `/v1/health`.

## 4. Vérifier le service

Récupérez l'URL du service :

```bash
gcloud run services describe mtandao-cloud-api \
  --region europe-west9 \
  --format='value(status.url)'
```

Puis vérifiez le point de santé :

```bash
curl https://URL_DU_SERVICE/v1/health
```

Testez ensuite la connexion au tableau de bord, la création/lecture d'un site et les endpoints Gateway dans un environnement de test. N'effectuez pas de ventes ni de paiements réels pendant cette validation.

## 5. Maîtriser les coûts

Cloud Run propose un quota mensuel gratuit pour certains usages, mais **ce n'est pas une garantie de facture nulle**. La facturation dépend notamment de la région, du mode de facturation, du trafic sortant et des autres services Google Cloud utilisés. Les quotas gratuits sont partagés au niveau du compte de facturation et les dépassements sont facturés.

Mesures de prudence recommandées :

- conserver `--min 0` pour éviter une instance toujours active ;
- garder `--max 2` au départ pour limiter la montée en charge ;
- utiliser la facturation à la demande (request-based) ;
- créer un budget et des alertes de facturation dans Google Cloud ;
- surveiller les métriques et les journaux après mise en ligne.

Un budget/une alerte informe d'un dépassement potentiel mais ne constitue pas un plafond automatique de dépenses.

## 6. Retour arrière et suppression

Pour revenir à une révision précédente, utilisez la console Cloud Run et réorientez le trafic vers la révision connue comme stable. Pour arrêter la facturation liée au service, supprimez le service Cloud Run et vérifiez également les images stockées dans Artifact Registry et les autres ressources créées.

## Configuration de sécurité

- Le point de santé est public ; les routes métier restent protégées par les gardes d'authentification ou les jetons Gateway.
- Ne publiez jamais l'API MikroTik directement sur Internet.
- Gardez les politiques RLS activées dans Supabase.
- Limitez `DASHBOARD_ORIGIN` à l'origine réelle du tableau de bord.
- Ajoutez une limitation de débit côté API/edge pour les points d'entrée publics Gateway avant une exploitation à grande échelle.
