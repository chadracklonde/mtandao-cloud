# Paiements — Lot 7 (fournisseur sandbox)

Aucun paiement réel n'est activé. Le fournisseur `sandbox` sert à construire et tester toute la chaîne ; un fournisseur Mobile Money réel s'ajoute en implémentant l'interface `PaymentProvider` (`apps/api/src/payments/payment-provider.ts`) et en élargissant la liste des fournisseurs de la base, sans toucher à l'idempotence ni à la livraison.

## Parcours

1. **Création** — `POST /v1/sites/:siteId/payments` `{ planId, routerId, customerPhone?, idempotencyKey? }` (rôles owner, admin, manager, seller). Le **montant vient toujours du forfait**, jamais du client. Le paiement expire au bout de 30 minutes. Réponse : `payment_id`, `provider_ref` (référence à transmettre au fournisseur), montant, devise, échéance. Rejouer la même `idempotencyKey` renvoie le même paiement, même si le forfait a été désactivé entre-temps.
2. **Webhook du fournisseur** — `POST /v1/webhooks/payments/:provider`, public, authentifié uniquement par signature.
3. **Livraison** — quand le paiement est confirmé, la base attribue un voucher du stock, enregistre la vente (mode `mobile_money`), crée le ticket et met en file la commande `hotspot.voucher.create` (durée et profil du forfait) pour le Gateway du routeur choisi.
4. **Activation** — le ticket n'est marqué `activated` que lorsque le Gateway confirme la commande.

## Webhook sandbox

En-tête `X-Mtandao-Signature: t=<secondes unix>,v1=<hex>` avec `v1 = HMAC-SHA256(secret, "<t>." + corps brut)`. Les requêtes datant de plus de 5 minutes (ou du futur) sont refusées, ce qui limite le rejeu. Corps JSON :

```json
{ "event_id": "evt-1", "provider_ref": "MTD-…", "status": "succeeded", "amount": 500, "currency": "CDF" }
```

| Réponse | Cas |
| --- | --- |
| `200 {"outcome": …}` | événement traité (voir ci-dessous) |
| `401` | signature absente, fausse, altérée ou hors fenêtre |
| `400` | signature valide mais corps invalide |
| `404` / `503` | fournisseur inconnu / non configuré |
| `502` / `503` | base indisponible : le fournisseur doit réessayer |

Résultats (`outcome`) : `paid`, `failed`, `duplicate`, `already_paid`, `amount_mismatch`, `unmatched`, `ignored`.

## Garanties

- **Idempotence** : un événement est identifié par `(fournisseur, event_id)`. Un webhook dupliqué ne produit rien (`duplicate`). Un second événement de succès pour un paiement déjà payé ne crée ni deuxième vente ni deuxième ticket (`already_paid`).
- **Faux webhook rejeté** : la signature est vérifiée avant tout accès à la base, avec comparaison à temps constant. Un corps altéré ou signé avec un autre secret est refusé.
- **Montant et devise contrôlés** : un montant ou une devise différents du prix du forfait ne confirment rien ; le paiement passe en `mismatch` et apparaît au rapprochement.
- **Argent reçu = honoré** : un succès reçu après expiration, échec ou annulation est accepté (le fournisseur a encaissé).
- **Gateway absent** : le paiement est `paid` / `activation_pending`, le ticket reste `sold`. Aucune fausse activation. La commande attend jusqu'à 24 h.
- **Pas de stock** : le paiement est `paid` / `out_of_stock`, sans ticket. Après réapprovisionnement, `POST /v1/sites/:siteId/payments/:id/retry-activation` (owner, admin, manager) le livre.
- **Échec d'activation** : `activation_failed` ; le même endpoint de reprise met en file une nouvelle commande. Si le routeur répond que le voucher existe déjà (tentative précédente aboutie), le ticket est considéré activé.
- **Confidentialité** : le numéro de téléphone n'apparaît ni dans la liste des paiements, ni dans le journal d'audit.

## Consultation

`GET /v1/sites/:siteId/payments` (pagination par curseur, filtres `from`/`to`). Un paiement en attente dont l'échéance est passée est affiché `expired`. Les états de livraison sont `none`, `activation_pending`, `activated`, `activation_failed`, `out_of_stock`.

## Rapprochement

Quatre nouveaux écarts dans `reconciliation` : `payment_amount_mismatch`, `payment_out_of_stock`, `payment_activation_failed`, `payment_activation_stuck` (activation en attente depuis plus d'une heure).

## Configuration

| Variable | Rôle |
| --- | --- |
| `SUPABASE_SERVICE_ROLE_KEY` | clé serveur qui permet d'appeler la fonction de traitement des webhooks. **Secret serveur uniquement**, jamais dans le navigateur ni un client mobile. |
| `PAYMENT_SANDBOX_WEBHOOK_SECRET` | secret de signature, 32 caractères minimum. Sans lui (ou trop court), le fournisseur sandbox est désactivé. |

Le fournisseur sandbox confirme des paiements sans argent réel : ne pas le configurer sur un déploiement de production. La fonction `expire_pending_payments()` (rôle `service_role`) marque les paiements échus ; elle peut être planifiée.

## Limites actuelles

- Un seul fournisseur (sandbox). Le choix du fournisseur Mobile Money réel et la qualification du compte marchand restent à faire.
- Pas de remboursement ni d'annulation côté Cloud.
- Les webhooks sans paiement correspondant (`unmatched`) sont enregistrés mais ne sont pas rattachés à un site, donc absents du rapprochement par site.
- Le dashboard n'expose pas encore les paiements.

Tests : `supabase/tests/payments.test.sql`, `apps/api/src/payments/*.spec.ts`.
