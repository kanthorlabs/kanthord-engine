# Actor identity

Reviewer: platform and security. Conventions are [README.md](README.md). The decisions are the `actor` rows of the registry and `../database/actor.md`.

## Routes

| operationId      | Method and path             | introducedIn | status | Source                                 |
| ---------------- | --------------------------- | ------------ | ------ | -------------------------------------- |
| `actor.register` | `POST /v1/actor`            | phase-1      | routed | EPIC 015, one-time token disclosure    |
| `actor.list`     | `GET /v1/actor`             | phase-1      | routed | EPIC 015, lost-token recovery          |
| `actor.show`     | `GET /v1/actor/:id`         | phase-1      | routed | EPIC 015                               |
| `actor.revoke`   | `POST /v1/actor/:id/revoke` | phase-1      | routed | EPIC 015, retirement and lease fencing |
| `actor.rotate`   | `POST /v1/actor/:id/rotate` | phase-1      | routed | EPIC 015, lost-token recovery          |

All five declare `allowedActors: ["human"]`. A harness never manages an actor, and a harness never rotates its own token. The three `POST` rows declare `idempotency: "memory"` and `replayable: [200]`.

## An actor is a row, and the token is the row's secret

The `actor` table holds the id, the kind (`human` or `harness`), the unique name and the SHA-256 digest of the token, and the audit columns of the bootstrap and of the registration. A registered actor name matches `^[a-z0-9][a-z0-9-]{0,62}$`. The bootstrap row stores no digest, because the configured token lives in configuration and the daemon never persists it.

A token is `<actorId>.<secret>`: the id embeds a ULID, and the secret is 43 base64url characters. The response of `actor.register` and `actor.rotate` discloses the token once. No other response schema in the contract carries a `token` field. Delivery is an operator responsibility: the daemon terminates no TLS, so a token that leaves the internal network without an operator-supplied tunnel travels in cleartext.

## `actor.register`

The body carries `{ name }` and no `kind` field. A registration creates a `harness` and nothing else. The response returns the view plus the token exactly once; a replay under the same `Idempotency-Key` returns the stored response of that execution and mints nothing. A second registration with the same name is `400 invalid-request` with `details.refusal = "name-taken"`. Registration is refused with `details.refusal = "no-configured-token"` while the configured token is empty, because a local process must not mint a credential that outlives that mode.

## `actor.list` and `actor.show`

Both return the view with no token field. `actor.list` orders by id ascending, so the bootstrap row sorts first and a revoked row stays listed with its `revokedAt`. A lost token is recovered by listing the actors, then rotating the id.

## `actor.revoke`

The route stamps `revoked_at` and `revoked_by`, fences every live lease the actor owns in the same transaction, and appends the `actor.revoked` event. A revocation affects a request that authenticates after it commits. A second revoke of the same actor returns the same view with `200`, so a retry is not an error. Revoking the bootstrap actor is `400 invalid-request` with `details.refusal = "bootstrap-actor"`.

## `actor.rotate`

The route replaces the token digest and preserves the identity: the id, the name, the audit history and every live lease survive, and the replaced secret authenticates no request that arrives after the commit. The response discloses the replacement token once. The bootstrap actor is refused with `details.refusal = "bootstrap-actor"`, and a revoked actor with `details.refusal = "actor-revoked"`, because a rotation is not an undo.
