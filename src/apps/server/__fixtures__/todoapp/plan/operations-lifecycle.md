---
node: operations.md
bindings: []
verifications:
  - node --test test/operations-lifecycle.test.js
---

# Expose readiness and shut down within a deadline

## Requirement

Own the HTTP listener and injected resources in the process entrypoint. Define injectable readiness and resource-close hooks. Test them with controlled adapters and do not require unfinished authentication or TODO modules. The acceptance node wires these hooks to real SQLite.

Expose public `GET /health/ready` separately from public liveness. It returns 200 with `{ status: "ready" }` only when migrations finished, storage responds to a bounded probe and shutdown has not started. Otherwise it returns 503 with a safe error envelope. Configure request, header and keep-alive timeouts. Handle SIGTERM and SIGINT through one idempotent drain operation with a ten-second drain deadline.

## Criterion

- Liveness returns 200 independently of storage. Readiness returns 200 with `{ status: "ready" }` only when migrations finished, a bounded storage probe responds and shutdown has not started. It returns 503 with a safe error envelope before initialization, on a failed bounded storage probe and during shutdown, without operational secrets.
- Readiness and resource-close hooks are injectable. Tests use controlled adapters and need no authentication or TODO module.
- Request, header and keep-alive timeouts are configured.
- A process-level test sends SIGTERM with an in-flight request. The accepted request finishes within the grace period; the process observes resource closure and exits. The server stops accepting requests and closes idle connections and resources.
- A deliberately stuck connection is forcibly ended at the ten-second deadline. Repeated SIGTERM or SIGINT signals do not close resources twice or start multiple drains.
- Startup errors fail before the process advertises readiness and close already-opened resources.
- Tests own their child processes, use explicit timeouts and always clean up listeners and resources.
