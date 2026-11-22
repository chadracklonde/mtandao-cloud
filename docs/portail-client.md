# Portail client — Lot 8

Page publique où un client Wi-Fi choisit un forfait, paie et reçoit son code de connexion, sans compte. Elle s'appuie sur le circuit de paiement du [Lot 7](paiements.md).

## Parcours client

1. Le client se connecte au Wi-Fi ; la page de connexion Hotspot du routeur l'envoie vers `https://<dashboard>/portal/<siteId>?router=<routerId>` (voir ci-dessous).
2. La page affiche les forfaits actifs du site, du plus court au plus long, aux prix fixés par le site pour chaque durée (les forfaits sans stock sont grisés), le client saisit son numéro Mobile Money et valide.
3. La page affiche la référence de paiement et interroge l'état toutes les 4 secondes (30 minutes au plus).
4. Le **code n'apparaît qu'une fois l'activation confirmée par le routeur**. Entre le paiement et la confirmation, la page indique « activation en cours » : jamais de code qui ne fonctionne pas encore.
5. Le client saisit le code comme identifiant *et* mot de passe sur la page de connexion Wi-Fi.

La page reprend l'état après un rechargement (stockage de session) et prévoit les cas : paiement expiré, montant incorrect, échec, stock épuisé ou activation en échec (le client est invité à présenter sa référence au responsable, qui peut relancer la livraison avec `retry-activation`).

## API publique

Sous `/v1/portal`, sans authentification utilisateur. Toutes les réponses portent `Cache-Control: no-store`.

| Route | Rôle |
| --- | --- |
| `GET /sites/:siteId` | site et forfaits actifs (`in_stock` booléen, jamais de quantités ni de codes) |
| `POST /sites/:siteId/payments` | crée un paiement : `planId`, `routerId`, `customerPhone` (obligatoire), `idempotencyKey` (optionnel). Retourne `accessToken`, **affiché une seule fois** |
| `GET /payments/:paymentId` | état du paiement ; en-tête `Authorization: Bearer <accessToken>` |

## Sécurité

- **Jeton d'accès par paiement** : aléatoire (256 bits), seul son hachage SHA-256 est stocké. Il n'ouvre que *son* paiement : le jeton d'un client ne permet pas de lire le paiement d'un autre.
- **Accès expirés refusés** : le jeton est valable 2 heures après la création, puis 24 heures après le paiement (le temps de relire son code). Passé ce délai, même le bon jeton est refusé.
- **Réponses uniformes** : paiement inconnu, jeton faux, jeton mal formé ou accès expiré donnent la même réponse `404`, pour qu'on ne puisse pas tester des jetons.
- **Aucun accès direct à la base** : les fonctions du portail ne sont appelables qu'avec la clé de service, côté API ; ni `anon` ni les utilisateurs connectés n'y ont accès.
- **Montant décidé par le serveur** : il vient du forfait, jamais du client.
- **Limitation d'abus** : en base, 3 paiements ouverts au plus par numéro de téléphone (30 minutes) et 500 par site (`429`). Côté API, limite par adresse IP : 60 consultations du catalogue par minute, 10 créations par 10 minutes, 120 consultations d'état par minute.
- **Rejeu** : rejouer la même `idempotencyKey` (double clic, rechargement) renvoie le même paiement avec un nouveau jeton, et l'ancien jeton cesse de fonctionner. Un paiement déjà traité ne peut plus être rejoué.
- Le numéro de téléphone et le jeton ne figurent ni dans le journal d'audit ni dans les listes du personnel.

## Configuration

| Variable | Rôle |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | requise (secret serveur) |
| `TRUST_PROXY_HOPS` | nombre de proxys de confiance devant l'API (0 par défaut). À mettre à `1` sur Render ou Cloud Run pour que la limitation voie la vraie adresse du client. Ne pas l'activer sans proxy : l'adresse deviendrait falsifiable. |
| `NEXT_PUBLIC_MTANDAO_API_URL` | URL de l'API, côté tableau de bord |
| `DASHBOARD_ORIGIN` | origine autorisée (CORS) : le domaine où la page est servie |

## Brancher la page de connexion du routeur MikroTik

Non testé sur un équipement réel. Principe :

1. **Walled garden** : autoriser l'accès, avant connexion, au domaine du tableau de bord et à celui de l'API :
   `/ip hotspot walled-garden add dst-host=<dashboard> action=allow` et idem pour `<api>`. Prévoir aussi les domaines du fournisseur de paiement quand il y en aura un.
2. **Redirection** : dans `hotspot/login.html` du routeur, rediriger vers `https://<dashboard>/portal/<siteId>?router=<routerId>`, par exemple avec `<meta http-equiv="refresh" content="0; url=…">`. Les identifiants du site et du routeur sont ceux affichés dans le tableau de bord.
3. Le client revient ensuite sur la page de connexion native pour saisir son code.

## Limites actuelles

- Le paiement lui-même n'est pas réalisé par la page : avec le fournisseur sandbox, seule la confirmation par webhook fait avancer l'état. L'invite de paiement du vrai fournisseur Mobile Money reste à intégrer.
- La limitation par adresse IP est en mémoire et propre à chaque instance de l'API ; les plafonds par téléphone et par site en base sont la protection de fond.
- Pas de connexion automatique du client au Hotspot (il saisit son code), pas de langue autre que le français.

Tests : `supabase/tests/portal.test.sql`, `apps/api/src/portal/portal.service.spec.ts`. La page a été vérifiée dans un navigateur (écran de téléphone) contre une API simulée.
