# Enregistrement des routeurs MikroTik et Gateway

## Modèle

Chaque routeur appartient à un seul espace (`site_id`). L'enregistrement est autorisé au propriétaire, à l'administrateur et au technicien actif du site. Le routeur commence avec le statut `pending`.

Les types de Gateway acceptés sont `linux` et `android`. L'identité RouterOS est unique à l'intérieur d'un site.

## API

`POST /v1/sites/:siteId/routers`

En-tête : `Authorization: Bearer <access_token>`

Corps :

```json
{
  "name": "Routeur principal",
  "routerIdentity": "MikroTik-Kindu-01",
  "gatewayKind": "linux"
}
```

Réponse : `routerId`, `enrollmentToken` et `expiresInSeconds`. Le jeton d'enrôlement est aléatoire (32 octets), renvoyé une seule fois, et seul son hash SHA-256 est conservé en base. Sa durée de validité est de 15 minutes.

## Sécurité

- La base vérifie le rôle à partir de `auth.uid()`; le rôle fourni par le client n'est jamais accepté.
- L'accès direct en écriture aux tables est révoqué pour les rôles API publics.
- Les jetons d'enrôlement ne sont pas des mots de passe RouterOS et ne doivent pas être réutilisés.
- Aucun port RouterOS ne doit être exposé à Internet.
- L'enrôlement effectif du Gateway, la preuve de possession du jeton, l'échange contre des identifiants de longue durée, la rotation/révocation des secrets et les heartbeats sont des étapes ultérieures. Cette première API enregistre le routeur et prépare un jeton à usage unique; elle ne connecte pas encore le Gateway au routeur.

## À tester sur Supabase de développement

1. Un vendeur et un lecteur ne peuvent pas enregistrer de routeur.
2. Un technicien, administrateur ou propriétaire peut le faire.
3. Un utilisateur d'un autre site ne peut pas enregistrer dans le site ciblé.
4. L'identité RouterOS en doublon dans un même site est refusée.
5. Le jeton en clair n'est pas présent dans la table.
6. Un jeton expiré ne peut pas être enrôlé (validation à ajouter avec le endpoint d'échange Gateway).
