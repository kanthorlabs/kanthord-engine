---
node: authentication.md
bindings: []
verifications:
  - node --test test/authentication-authorization.test.js
---

# Separate public, authenticated and administrator routes

## Requirement

Mount explicit public and authenticated routers, with role checks after authentication for administrator routes. Read the current user role on every private request. Implement `GET /api/v1/admin/stats` as an admin-only aggregate read that returns only `user_count` and `todo_count`, not a user-data browsing endpoint. Create `src/modules/admin` with this code.

## Criterion

- Liveness, registration and login are reachable without a token. Private authentication endpoints and admin stats are not.
- An anonymous stats request returns 401, a normal user's request returns 403 and an administrator's request returns 200 with only the aggregate fields `user_count` and `todo_count`.
- Header/body/query attempts to supply a role cannot override the stored account role. Tests include role escalation attempts.
- Tests show role authorization reads current account state rather than trusting token content or a stale process-local role cache.
- Shared authentication middleware exposes a server-derived user identity for later TODO routes, with a deny-by-default private-router pattern.
- Tests send direct unauthenticated requests to every private route implemented in this node.
