# Invitations et membres d’un espace Mtandao

## Rôles disponibles

- `owner` : propriétaire initial, non attribuable par invitation.
- `admin` : peut inviter les rôles non propriétaires; seul le propriétaire peut inviter un autre administrateur.
- `manager`, `seller`, `technician`, `viewer` : rôles opérationnels.

Seuls `owner` et `admin` peuvent créer des invitations. Un administrateur ne peut pas inviter un autre administrateur. Les rôles sont contrôlés dans PostgreSQL, pas uniquement dans l'API.

## Créer une invitation

`POST /v1/sites/:siteId/invitations`

En-tête : `Authorization: Bearer <access_token>`

Corps :

```json
{
  "email": "collaborateur@example.com",
  "role": "seller"
}
```

Réponse : `{ "invitationId": "<uuid>" }`.

Une invitation expire après 7 jours. Une seule invitation en attente est autorisée par adresse et par site. Le site doit exister et l'utilisateur qui invite doit être membre actif avec le rôle approprié.

## Accepter une invitation

Le destinataire doit d'abord se connecter ou créer son compte Supabase Auth avec la même adresse e-mail que celle invitée.

`POST /v1/invitations/:invitationId/accept`

En-tête : `Authorization: Bearer <access_token>`

Réponse : `{ "siteId": "<uuid>" }`.

La fonction SQL compare l'adresse du jeton authentifié avec l'adresse invitée, verrouille l'invitation, vérifie son état et sa date d'expiration, puis crée l'adhésion. Le rôle `owner` ne peut pas être accepté via ce mécanisme. Une invitation ne peut être acceptée qu'une fois.

## Limite actuelle

Cette version enregistre l'invitation dans PostgreSQL et permet son acceptation. Elle ne déclenche pas encore l'envoi d'un e-mail ou d'un SMS. Le partage du lien d'invitation et l'envoi de notifications seront ajoutés avec un service de notification sécurisé. Ne pas considérer la création d'une invitation comme la preuve que le destinataire a été notifié.

## Vérifications de sécurité à effectuer en environnement de test

- Un vendeur ou lecteur ne peut pas inviter.
- Un administrateur ne peut pas inviter un administrateur.
- Un administrateur peut inviter un vendeur.
- Un utilisateur d'un autre site ne peut pas inviter dans ce site.
- Un utilisateur dont l'e-mail diffère ne peut pas accepter.
- Une invitation expirée, révoquée ou déjà acceptée est refusée.
- L'acceptation n'altère jamais le rôle d'un membre déjà présent.
