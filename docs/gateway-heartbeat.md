# Gateway heartbeat

## Endpoint

`POST /v1/gateway/heartbeat`

Header: `Authorization: Bearer <gatewayToken>`

No request body is required. Send the heartbeat approximately every 60 seconds over HTTPS.

Successful response:

```json
{
  "routerId": "<uuid>",
  "siteId": "<uuid>",
  "status": "online",
  "lastSeenAt": "<UTC timestamp>"
}
```

The API hashes the bearer token with SHA-256 and sends only the hash to the Supabase RPC. The database checks that the credential exists and is not revoked, locks the credential and router rows, rejects suspended/revoked routers, updates credential last-used time and marks the router online in one transaction.

## Offline state

The trusted database scheduler must execute `public.mark_stale_gateways_offline()` periodically (for example, once per minute). Gateways with no heartbeat for more than three minutes are marked offline. This function changes only rows currently marked online; it does not reactivate suspended or revoked routers.

## Operational requirements

- Use HTTPS only and redact Authorization headers from logs.
- Store the permanent token in Android Keystore or an appropriate Linux secret store.
- Send heartbeat every 60 seconds with jitter and exponential backoff when offline.
- The SQL function `mark_stale_gateways_offline()` is not scheduled by this migration; configure Supabase Cron or another trusted scheduler.
- This bearer-token mechanism is a first secure baseline, not mutual TLS. Credential rotation, revocation management UI, rate limiting, and end-to-end Gateway client implementation remain follow-up work.

## État du routeur MikroTik

Le Gateway peut transmettre l'état du lien MikroTik dans le corps JSON :

```json
{ "routerConnectionStatus": "online" }
```

Valeurs acceptées : `unknown`, `online`, `unavailable`. L'API enregistre cet état séparément du statut du Gateway. La colonne `router_last_seen_at` conserve la dernière réponse positive du MikroTik.

Appliquer les migrations `202611140007_router_connection_status.sql` et `202611140008_stale_gateway_router_state.sql` avant d'activer cette version du Gateway. Quand le heartbeat du Gateway devient périmé, le statut du routeur repasse à `unknown` : on ne doit pas confondre une passerelle hors ligne avec un routeur confirmé indisponible.

## Tableau de bord

Le tableau de bord appelle `GET /v1/sites/:siteId/routers` avec un jeton d'accès utilisateur Supabase. Configurer `NEXT_PUBLIC_MTANDAO_API_URL` avec l'URL publique de l'API et `DASHBOARD_ORIGIN` avec l'origine exacte du dashboard pour autoriser CORS. Le jeton de session saisi dans l'interface reste en mémoire et n'est pas conservé dans le stockage du navigateur.
