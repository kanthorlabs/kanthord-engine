---
node: foundation.md
bindings: []
verifications:
  - node --test test/foundation-http.test.js
---

# Establish public routing and safe JSON responses

## Requirement

Use Express Router and bounded JSON parsing: `express.json` with a 32 KiB limit, accepting only JSON object request bodies where a route expects JSON. Supply public liveness, JSON route-not-found handling and central synchronous/asynchronous error forwarding. Generate a server request identifier for every request and echo it as `X-Request-Id`.

Return JSON responses. Use snake_case property names shared by domain objects and HTTP payloads. Shape every error as `{ error: { code, message, request_id, details } }`, where `details` is a safe list that is empty when not applicable. Register the error middleware last. Application errors distinguish safe client messages from internal diagnostics.

## Criterion

- `GET /health/live` returns 200 with `{ status: "ok" }` without authentication.
- Errors use `{ error: { code, message, request_id, details } }` and correlate with the response header. `details` is an empty list when not applicable. Arbitrary incoming request IDs are not trusted or copied into logs.
- `express.json` uses a 32 KiB limit. Tests cover malformed JSON 400, payload too large 413, unsupported media type 415 on JSON write routes, unmatched route 404 and unexpected async exception 500.
- Unknown routes return a JSON 404. Asynchronous route failures reach the central error handler, which is the last middleware.
- Application errors keep safe client messages apart from internal diagnostics. Internal errors expose neither a stack nor a SQL statement.
- JSON write routes accept only JSON object bodies and reject arrays, null and primitive bodies with 400.
- Responses are JSON and use snake_case property names.
- Middleware ordering and response behavior are exercised through HTTP requests, not only mocked handler calls.
