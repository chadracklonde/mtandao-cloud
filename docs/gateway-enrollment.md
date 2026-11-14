# Gateway enrollment

## Exchange

A registered router receives a 32-byte random enrollment token, valid for 15 minutes. The API stores only its SHA-256 hash. The Gateway exchanges it once:

`POST /v1/gateway/enroll`

```json
{ "enrollmentToken": "<64 lowercase hexadecimal characters>" }
```

Successful response:

```json
{
  "routerId": "<uuid>",
  "siteId": "<uuid>",
  "gatewayToken": "<64 lowercase hexadecimal characters>"
}
```

The Gateway must store the returned permanent token in the operating system's secure storage and send it only over HTTPS. The API stores only its SHA-256 hash. The enrollment token is consumed atomically; parallel or later redemption attempts fail.

## Security boundaries

- Enrollment and Gateway tokens each contain 256 bits of randomness.
- The SQL function locks the enrollment row, checks expiry and consumption, rejects suspended/revoked routers, inserts the credential hash, and consumes the enrollment in one transaction.
- The public RPC accepts only hashes, not plaintext secrets.
- The enrollment endpoint does not use a user session; possession of the high-entropy, short-lived enrollment token is its authorization.
- Apply edge/proxy rate limiting, TLS-only ingress, request-body redaction, and abuse monitoring before production exposure. These controls are deployment requirements and are not implemented by this endpoint alone.
- The permanent token is currently a bearer credential. Rotation, revocation API, heartbeat authentication, and mutual TLS are follow-up work. Do not expose it to logs or client UI after enrollment.
