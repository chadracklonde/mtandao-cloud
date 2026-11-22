# Mise en service

Guide pas à pas pour passer du code à un site réel. Chaque étape a un point de contrôle : ne passez à la suivante que s'il est vert.

## 0. Ce qui est déjà en place

- Projet Supabase `mtandao-cloud` avec toutes les migrations (`202611160001` à `202611160012`), dont les tâches planifiées (passerelles inactives, commandes et paiements échus).
- Code Cloud complet sur la branche de la PR #1 ; correctifs Gateway livrés sous forme de fichiers (à appliquer sur le dépôt `mtandao-gateway`).

## 1. Supabase

| Réglage | Où | Pourquoi |
| --- | --- | --- |
| Protection contre les mots de passe compromis | Auth → mots de passe | signalé par l'analyse de sécurité, désactivé par défaut |
| URL du site et URL de redirection | Auth → URL | l'adresse du tableau de bord |
| Courriel d'envoi (SMTP) | Auth → SMTP | le service intégré est très limité en volume |
| Sauvegardes quotidiennes, idéalement point-in-time | Base de données → sauvegardes | reprise après incident |

**Contrôle** : `select jobname, active from cron.job where jobname like 'mtandao-%';` renvoie trois lignes actives.

## 2. API (NestJS)

Variables d'environnement :

| Variable | Obligatoire | Remarque |
| --- | --- | --- |
| `SUPABASE_URL`, `SUPABASE_ANON_KEY` | oui | clé publique « publishable » |
| `SUPABASE_SERVICE_ROLE_KEY` | oui pour paiements et portail | **secret serveur**, jamais dans Git ni dans un navigateur |
| `PAYMENT_SANDBOX_WEBHOOK_SECRET` | pour les essais | 32 caractères minimum ; **à ne pas définir en production réelle** (le fournisseur sandbox confirme des paiements sans argent) |
| `TRUST_PROXY_HOPS` | oui derrière Render ou Cloud Run | `1` ; `0` sans proxy |
| `DASHBOARD_ORIGIN` | oui | l'origine exacte du tableau de bord (CORS) |
| `ANTHROPIC_API_KEY`, `ASSISTANT_MODEL` | facultatif | active l'assistant ; voir [assistant-analytique.md](assistant-analytique.md) |
| `PORT`, `NODE_ENV=production` | oui | |

**Hébergement** : l'offre gratuite de Render met le service en veille. Pour un pilote, utilisez une instance toujours active (Render payant, ou Cloud Run avec une instance minimale), car les webhooks de paiement et les sondages des passerelles doivent trouver l'API réveillée. Voir [deploiement-gratuit.md](deploiement-gratuit.md) et [deploiement-google-cloud-run.md](deploiement-google-cloud-run.md).

**Contrôle** : `GET /v1/health` répond `ok`.

## 3. Tableau de bord (Next.js)

`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `NEXT_PUBLIC_MTANDAO_API_URL` (voir [dashboard-auth.md](dashboard-auth.md)). Ces variables sont lues à la construction : reconstruisez après les avoir changées.

**Contrôle** : connexion, création d'un site, le panneau « Prêt pour la vente ? » s'affiche.

## 4. Premier site

1. **Créer le site** (nom, devise, fuseau horaire).
2. **Tarifs** : panneau « Tarifs du site », les cinq durées (1 h, 2 h, 24 h, 1 semaine, 1 mois), avec le profil Hotspot de chaque forfait tel qu'il existe sur le routeur (profils créés avec l'application Mtandao Ticket ou Mikhmon).
3. **Stock de tickets** : il n'y a pas encore d'écran d'import ; utilisez l'API (1 à 1 000 codes par appel, lettres, chiffres, point, tiret, souligné) :

   ```sh
   curl -X POST "$API/v1/sites/$SITE/plans/$PLAN/ticket-stock" \
     -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
     -d '{"codes":["AB12CD","EF34GH"]}'
   ```

   Les codes importés doivent **ne pas exister déjà sur le routeur** : le Gateway refuse de créer un ticket dont le code existe (`voucher_exists`).
4. **Routeur** : enregistrer le routeur dans le tableau de bord, noter le code d'enrôlement (affiché une seule fois, valable 15 minutes).

## 5. Gateway

1. Appliquer les correctifs sur `mtandao-gateway` (voir le `LISEZ-MOI` joint), construire : `go build -o mtandao-gateway ./cmd/gateway`.
2. Installer : `packaging/linux/install.sh ./mtandao-gateway` (service systemd durci).
3. Enrôler : `gateway enroll` avec le code d'enrôlement ([gateway-enrollment.md](gateway-enrollment.md)).
4. Configurer la connexion au routeur (`router.json`, API-SSL, certificat approuvé via `ca_file`) : voir le guide RouterOS du dépôt Gateway.
5. Dans `/etc/mtandao-gateway/gateway.env` : `GATEWAY_COMMANDS_ENABLED=true`, `GATEWAY_SITE_ID` et `GATEWAY_ROUTER_ID` pour verrouiller la cible.

**Contrôle** : le panneau « Prêt pour la vente ? » montre la passerelle en ligne et le routeur joignable ; une commande `health.check` envoyée depuis l'API réussit.

## 6. Test de bout en bout

```sh
API_URL=… ACCESS_TOKEN=… SITE_ID=… ROUTER_ID=… PLAN_ID=… PAYMENT_WEBHOOK_SECRET=… \
node scripts/pilot-smoke.mjs --yes-this-uses-the-sandbox
```

Il consomme un ticket de ce forfait et crée un paiement sandbox. Il vérifie : site prêt, paiement au bon prix, **faux webhook rejeté**, webhook authentique confirmé, **webhook dupliqué sans effet**, ticket activé par la passerelle. Tout doit être vert ; sinon corrigez avant d'aller plus loin.

## 7. Ouverture au public

- **Vente assistée / espèces** : la vente par l'application Mtandao Ticket et sa synchronisation fonctionnent sans fournisseur de paiement.
- **Portail client** : ne redirigez pas encore la page de connexion du routeur vers `/portal/…` tant qu'un **fournisseur Mobile Money réel** n'est pas raccordé. Avec le sandbox, un client pourrait créer un paiement que rien ne confirmera. Procédure de redirection : [portail-client.md](portail-client.md).

## 8. Retour arrière

| Besoin | Action |
| --- | --- |
| Arrêter toute modification du routeur par le Cloud | `GATEWAY_COMMANDS_ENABLED=false` sur le Gateway, redémarrer le service |
| Couper l'assistant | `ASSISTANT_DISABLED=true` |
| Couper un Gateway compromis ou perdu | « Révoquer » dans le tableau de bord (ses commandes ouvertes sont annulées) |
| Continuer à vendre sans le Cloud | rien à faire : Mikhmon et l'application Mtandao Ticket fonctionnent directement avec le routeur |
