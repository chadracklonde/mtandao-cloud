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
