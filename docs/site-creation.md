# Création sécurisée d’un espace Wi-Fi

La migration `202611140002_site_creation_rpc.sql` ajoute la fonction PostgreSQL
`public.create_site_with_owner(name, currency, timezone)`.

## Contrat

- L’utilisateur doit être authentifié avec Supabase Auth.
- L’identité propriétaire est toujours obtenue par `auth.uid()`; le client ne peut pas choisir un autre propriétaire.
- Le nom doit contenir entre 2 et 120 caractères.
- La devise par défaut est limitée à `CDF` ou `USD`.
- Le fuseau horaire doit exister dans PostgreSQL.
- La création de la ligne `sites` et de l’adhésion `owner` se fait dans la même transaction PostgreSQL. En cas d’échec, aucune création partielle n’est conservée.
- L’exécution est accordée à `authenticated`, refusée à `anon` et à `public`.

## Appel depuis un client Supabase

Après connexion, le client peut appeler la fonction RPC. Exemple TypeScript :

```ts
const { data: siteId, error } = await supabase.rpc('create_site_with_owner', {
  p_name: 'Mon point Wi-Fi',
  p_default_currency: 'CDF',
  p_timezone: 'Africa/Lubumbashi',
});

if (error) throw error;
// data est l’UUID du nouvel espace.
```

Ne jamais envoyer de `user_id` depuis le client pour déterminer le propriétaire.

## Vérifications à effectuer dans un projet Supabase de test

1. Appel sans session : refusé.
2. Appel avec un nom vide ou trop long : refusé.
3. Appel avec une devise autre que CDF/USD : refusé.
4. Appel avec un fuseau horaire inconnu : refusé.
5. Appel valide : une ligne `sites` et exactement une adhésion `owner` active pour l’utilisateur connecté.
6. Un second utilisateur ne doit pas lire ce site tant qu’il n’a pas d’adhésion active.

Cette migration n’est pas encore une preuve de test exécuté sur une instance Supabase : elle doit être appliquée et vérifiée dans le projet de développement avant toute mise en production.
