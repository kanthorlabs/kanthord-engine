---
intent: implement
commit_type: feat
depends_on:
  - foundation.md
bindings:
  - todoapp-repo
verifications:
  - npm ci && npm run test:operations
  - npm run --if-present test:foundation && npm run --if-present test:persistence && npm run --if-present test:operations && npm run --if-present test:authentication && npm run --if-present test:todos
  - npm run lint && npm run format:check
---

# Harden errors, logging and process operation

## Requirement

Extend the Express foundation with Helmet, explicit-origin `cors`, `express-rate-limit`, Pino and `pino-http`. This node may run alongside persistence: define injectable readiness/resource-close hooks and a typed storage-error interface, and test them with controlled adapters. Do not require unfinished authentication or TODO modules. The final acceptance node wires these hooks to real SQLite.

Use the existing error envelope `{ error: { code, message, request_id, details } }` and server-generated request IDs. Define stable codes for validation, malformed JSON, body size, media type, authentication, permission, absence, conflicts, preconditions, throttling, storage unavailable and unexpected errors. Expose only safe details. Translate bounded storage lock exhaustion/unavailability to 503 with Retry-After, not an internal SQL error.

Emit one structured completion event per request with request_id, method, route template, status, duration and severity. Redact authorization, cookies, passwords, access tokens, token hashes and password hashes. Do not log request/response bodies, TODO titles/descriptions, email addresses, raw URLs/query strings or configuration secrets. Internal errors have correlated diagnostic logs but safe client responses.

Add public `GET /health/ready`: 200 with `{ status: "ready" }` only when migrations finished, storage responds to a bounded probe and shutdown has not started; otherwise 503 with a safe error envelope. Configure HTTP timeouts and graceful SIGTERM/SIGINT shutdown with a ten-second drain deadline. Add `test:operations`.

## Criterion

- Security headers are present; allowed-origin preflight handles Authorization, Content-Type and If-Match and exposes ETag, Location and X-Request-Id. Disallowed browser origins receive no allow-origin header. CORS is never treated as authorization.
- Global API limits default to 300 requests/minute/IP, with stricter 10/minute/IP on registration/login, 429, standard rate-limit headers and Retry-After. Health routes are exempt; proxy trust cannot be spoofed by an arbitrary forwarded header.
- Parsing failures and async exceptions produce exactly one response and one correlated completion log. Unexpected errors are 500; known service errors retain their safe status/code.
- Automated log capture proves secrets and user-content sentinels do not occur in logs, including failures and unknown routes.
- Readiness becomes unavailable during draining; accepted requests can finish before resources close. The server stops accepting requests, closes idle connections and resources, and forcibly ends remaining connections at the deadline.
- Document single-process limiter/storage assumptions. No untested claim of distributed rate limiting or multi-host SQLite safety is made.
