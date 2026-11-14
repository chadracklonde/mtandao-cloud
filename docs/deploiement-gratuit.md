# Déploiement gratuit de l'API Mtandao Cloud

Ce guide prépare l'API NestJS pour un déploiement de test sur Render Free.

## Limites à connaître

- L'instance gratuite s'endort après 15 minutes sans requête entrante.
- Le premier appel après l'endormissement peut prendre environ une minute.
- Le système de fichiers est éphémère : ne jamais y stocker de données métier.
- Render Free est destiné aux tests et projets de démonstration, pas à une exploitation commerciale critique.
- Les quotas mensuels de bande passante et de minutes de compilation s'appliquent. Sans moyen de paiement enregistré, leur dépassement suspend les services concernés plutôt que de facturer un supplément.

La base de données reste sur le projet Supabase Mtandao existant. Ne créez pas de base PostgreSQL Render.

## Déploiement

1. Connecter le compte GitHub à Render.
2. Dans Render, choisir **New > Blueprint**.
3. Sélectionner le dépôt `chadracklonde/mtandao-cloud`.
4. Render détecte `render.yaml`. Vérifier que le service `mtandao-cloud-api` est bien sur le plan **Free** avant de confirmer.
5. Laisser Render construire et démarrer le service.
6. Vérifier le contrôle de santé à l'adresse `https://<nom-du-service>.onrender.com/v1/health`. La réponse attendue contient `status: "ok"`.

Le fichier Blueprint contient uniquement l'URL Supabase et sa clé publishable, destinée aux clients publics et protégée par les politiques RLS. Aucune clé `service_role` ou clé secrète Supabase ne doit être ajoutée à Render.

## Après le déploiement

- Copier l'URL HTTPS du service Render.
- Configurer `NEXT_PUBLIC_MTANDAO_API_URL` dans le tableau de bord avec cette URL.
- Définir `DASHBOARD_ORIGIN` dans Render avec l'origine exacte du tableau de bord (sans chemin), puis redéployer.
- Tester l'authentification, la création/liste des sites, les invitations et les opérations Gateway.
- Ne pas utiliser cette instance gratuite comme seule API d'un service Wi-Fi commercial : le démarrage à froid et les interruptions possibles ne garantissent pas une disponibilité permanente.

## Coût

Le Blueprint demande explicitement le plan Render Free. Ne sélectionnez aucun plan payant et n'ajoutez aucun moyen de paiement pour ce déploiement de test. Surveillez néanmoins les quotas affichés dans le tableau de bord Render.
