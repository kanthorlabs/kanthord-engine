---
node: operations.md
bindings: []
verifications:
  - node --test test/operations-errors.test.js
---

# Normalize failures into safe, correlated API errors

## Requirement

Maintain one final Express error middleware and a typed application error catalog. Use the shared error envelope `{ error: { code, message, request_id, details } }` and server-generated request IDs. Define stable codes for validation, malformed JSON, body size, media type, authentication, permission, absence, conflicts, preconditions, throttling, storage unavailable and unexpected errors. Expose only safe details.

Define a typed storage-error interface. Translate bounded storage lock exhaustion or unavailability to 503 with `Retry-After`, not an internal SQL error. Map parser, validation, service and storage failures to the envelope without passing internal exception text to clients. Internal errors have correlated diagnostic logs but safe client responses.

## Criterion

- Tests cover 400, 401, 403, 404, 409, 412, 413, 415, 428, 429, 500 and 503 mappings through test routes/adapters, without adding production debug routes.
- Stable error codes exist for validation, malformed JSON, body size, media type, authentication, permission, absence, conflicts, preconditions, throttling, storage unavailable and unexpected errors. Codes are distinct where clients need different recovery behavior.
- Validation details name safe field paths, not submitted values or raw Zod input. Only safe details reach the client.
- Errors correlate their request_id with X-Request-Id. Async rejection and synchronous throw share the same safe 500 response.
- Parsing failures and async exceptions produce exactly one response and one correlated completion log. Unexpected errors are 500; known service errors retain their safe status/code.
- Internal errors write correlated diagnostic logs while the client response stays safe.
- Storage contention exhaustion, reported through the typed storage-error interface, returns 503 with Retry-After; stack, filesystem paths, SQL, passwords and tokens do not enter the response.
- Already-started responses follow Express's safe termination path rather than attempting a second JSON response.
