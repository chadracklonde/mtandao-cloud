# Authentification API et création d’espace

## Authentification

Les routes protégées attendent un jeton d’accès Supabase dans l’en-tête :

```http
Authorization: Bearer <access_token>
```

Le garde NestJS vérifie le jeton auprès de `GET /auth/v1/user` en utilisant la clé publique `SUPABASE_ANON_KEY`. L'identifiant de l'utilisateur est pris dans la réponse Supabase, jamais dans le corps de la requête.

- Jeton absent, invalide ou expiré : HTTP 401.
- Service d'authentification indisponible ou configuration absente : HTTP 503.
- Les détails d'identité transmis au contrôleur proviennent exclusivement de Supabase Auth.

## Créer un espace

`POST /v1/sites`

Exemple de corps :

```json
{
  "name": "Point Wi-Fi Kindu",
  "defaultCurrency": "CDF",
  "timezone": "Africa/Lubumbashi"
}
```

La réponse est `{ "id": "<uuid>" }`. La création utilise la RPC SQL `create_site_with_owner`, appelée avec le jeton de l'utilisateur. La base récupère `auth.uid()` et ajoute l'adhésion `owner` dans la même transaction.

Validation API : nom de 2 à 120 caractères, devise CDF ou USD, fuseau horaire fourni comme chaîne. PostgreSQL valide le fuseau IANA exact.

Les champs inconnus sont refusés par la ValidationPipe globale (`whitelist` et `forbidNonWhitelisted`).

## Configuration locale

Copier `.env.example` vers `.env`, puis renseigner :

- `SUPABASE_URL`
- `SUPABASE_ANON_KEY`
- `PORT` (facultatif, 3001 par défaut)

Aucune clé `service_role` n'est nécessaire pour ces routes. Ne jamais exposer une clé privilégiée dans Flutter ou le navigateur.

## Tests présents

Le test Node vérifie l'extraction du jeton Bearer (cas normal, casse, espaces et en-têtes invalides). La CI compile l'API puis exécute les tests.

Les tests d'intégration Supabase restent à effectuer sur un projet de développement avec deux comptes de test : vérifier le refus sans jeton, la création atomique, puis l'isolation entre utilisateurs. Ne pas tester ces scénarios sur des données de production.
