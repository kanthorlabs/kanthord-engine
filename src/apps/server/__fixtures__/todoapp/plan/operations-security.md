---
node: operations.md
bindings: []
verifications:
  - node --test test/operations-security.test.js
  - npm ci && npm run test:operations
  - npm run test:foundation
  - npm run --if-present test:foundation && npm run --if-present test:persistence && npm run --if-present test:operations && npm run --if-present test:authentication && npm run --if-present test:todos
  - npm run lint && npm run format:check
---

# Apply secure middleware and secret-safe request logging

## Requirement

Configure Helmet, explicit-origin `cors`, `express-rate-limit`, Pino and `pino-http`. Use bounded request-rate middleware and structured request logging. Register logging before parsing so rejected bodies still receive correlation. Respect only explicitly trusted proxy addresses.

Emit one structured completion event per request with request_id, method, route template, status, duration and severity. Redact authorization, cookies, passwords, access tokens, token hashes and password hashes. Do not log request or response bodies, TODO titles or descriptions, email addresses, raw URLs, query strings or configuration secrets. Document the single-process limiter and storage assumptions, and make no untested claim of distributed rate limiting or multi-host SQLite safety. Provide the `test:operations` script, which runs the three operations suites.

## Criterion

- HTTP tests assert security headers. Allowed-origin preflight handles Authorization, Content-Type and If-Match and exposes ETag, Location and X-Request-Id. Disallowed browser origins receive no allow-origin header. CORS is never treated as authorization.
- Global API limits default to 300 requests/minute/IP. Registration and login have a stricter 10 requests/minute/IP. Limiters return 429 with standard rate-limit headers and Retry-After at their limits. Health routes (liveness and readiness) are exempt and remain available.
- Fake forwarded IPs cannot bypass limits when proxy trust is false; only explicitly trusted proxy addresses are respected.
- Each request produces one completion log with request_id, method, route template, status, duration and severity. The server generates the request_id. Unknown routes use a constant fallback template. Logging runs before parsing.
- Captured logs contain none of the sentinels placed in authorization, cookies, passwords, tokens, token hashes, password hashes, email, TODO content, raw URLs, query strings or configuration secrets, even on parsing/error paths, failures and unknown routes. No request or response body is logged.
- In-memory limiters and storage are documented as single-process controls, not cross-replica or multi-host protection. No untested distributed claim is made.
