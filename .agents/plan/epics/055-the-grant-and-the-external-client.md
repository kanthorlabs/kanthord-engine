# EPIC 055 — The grant and the external client

Status: **draft**. It follows EPIC 054 by sequence order.

## Goal

A human mints a grant, and the grant is the authority of every external write:

- a grant names one root subtree, one external worker, an operation list, an expiry and two limits;
- `claim`, `report` and `renew` each read the grant inside their own transaction and refuse an operation the list omits or a node outside `root`;
- the run records the grant that opened it, so a limit, a revocation and an adoption rule all have a subject;
- an expiry, a revocation and a closed root each have an implemented effect on a new claim and on an open run;
- a grant is immutable, and its two counters are monotone by trigger.

## Non-goals

- **No holder key.** `worker.md` section 10 states the daemon and the client run on one trusted machine, and a holder key adds no boundary. The epic states the boundary at which one becomes necessary — a remote daemon, a second human, or a shared runner — and adds none.
- **No process identity.** The caller of an external client is the grant id. Two holders of one grant give one audit trail attributed to neither, and the epic records that as an accepted failure mode.
- **No client.** Nothing here drives Claude Code or opencode.
- **No actor removal.** `src/domain/actor.ts` and the actor token stay. A human authenticates as an actor to mint a grant.
- **No authority pin.** `worker.md` section 10 also requires every authority input to be pinned by content hash. EPIC 054 owns that, and this epic does not restate it.

## Decisions

- **A grant is a row, and `grant` joins `identityKinds`.** Migration `16` creates `grant` with `id`, `handle`, `root`, `worker`, `operations_json`, `issuer`, `expires_at`, `max_active_runs`, `max_claims`, `claims_used`, `revoked_at`. `src/domain/identity.ts:3` gains `grant`, with the prefix `grant`.

- **The grant id is the bearer credential, and the handle is the name a human uses.** `worker.md` section 10 states a grant is a bearer credential and the caller is the grant id, and it gives the grant no key. A `grant.show` that returned the id would hand the credential to any reader. `handle` is a separate non-secret `grant_h_`-prefixed ULID, returned by `grant.list` and `grant.show`, and accepted by `grant.revoke`. The id is returned once, by `grant.mint`, and never again.

- **A client presents the grant id in its own scheme.** `Authorization: Grant <grantId>`. The actor scheme is unchanged, and the two are distinguished by the scheme token, never by the value shape. The middleware resolves a grant to a caller principal of kind `grant`, and an actor to one of kind `actor`.

- **Authentication and authorization are separate steps, because an expired grant must still write.** The middleware authenticates any grant row that exists and is not revoked, including an expired one. The operation then authorizes: `claim` refuses an expired grant, and `report` and `renew` do not. A revoked grant fails authentication outright, because its runs are already ended.

- **`root` is a scope, never a unit of work, and the daemon refuses a claim on it.** `worker.md` section 10 states it. `grantScopeVerdict` returns `outside-root` for a node outside the subtree, and `root-not-claimable` for `targetId === root`. A membership test alone admits exactly what the rule forbids.

- **A grant names exactly one worker, and that worker must be external.** `worker.md` section 4 states a grant names one worker, which narrows delegation to one subject. `grant.mint` refuses `worker-unknown` for an id outside the registry of EPIC 048, and `worker-not-external` for an entry whose `driver` is `internal`. An internal worker stays behind its supervisor, and a grant that named one would route around it.

- **`worker-not-external` is tested against a registry fixture, because the production registry holds no internal worker.** A human deferred every internal worker to phase 2, so both production entries are external and the refusal has no production subject. The check ships now because EPIC 110 adds the first internal worker, and a refusal added after the worker it must refuse is a refusal that arrives late.

- **A client asserts its own availability, and the daemon trusts it.** `worker.md` section 4 states a worker runs a self health check before it claims. A client has no supervisor, so it makes the assertion itself, in the `available` field EPIC 050 adds to the claim request. A client that asserts `true` when it is not available holds a run it cannot use until the run expires. `worker.md` section 11 lists that among the client failure modes the daemon does not detect.

- **A grant-backed worker never opens a structural run, and the refusal is at claim.** `worker.md` section 10 states an external client does orchestration only: it submits no graph patch and creates no node. Refusing only at acceptance lets a client hold an unusable structural run for a full lifetime. `claim` refuses `client-not-author` when the node's run kind is `structural` and the caller is a grant. `accept-structural` keeps the same refusal as the second gate.

- **`operations` is a closed set of three.** `claim`, `report` and `renew`. `close` is a human verb and never appears in a grant. The stored list is deduplicated and sorted into the order above, so two grants with the same operations are byte-identical.

- **The run records its grant.** Migration `16` adds `run.grant_id TEXT REFERENCES grant(id)`, with `CHECK ((driver = 'external') OR grant_id IS NULL)`. Without it the daemon cannot count active runs of a grant, cannot end every run of a grant on revocation, and cannot refuse a second grant's write to a run the first opened. A `report` or `renew` whose grant is not the run's grant refuses `run-grant-mismatch`.

- **A grant is immutable, and its counters are monotone, and both are triggers.** One `BEFORE UPDATE` trigger aborts a change to `id`, `handle`, `root`, `worker`, `operations_json`, `issuer`, `expires_at`, `max_active_runs` or `max_claims`. A second aborts when `NEW.claims_used < OLD.claims_used`. A third aborts when `OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at`. A frozen-column list that omits `id` and `issuer` is not immutability, and an unguarded counter is not monotone.

- **`max_claims` counts claims that opened a run.** `worker.md` section 10 states it. The replay branch at `src/commands/node/claim-node.ts:186` adopts an existing run and opens none, so it raises nothing.

- **Both limits are read, checked and incremented inside the claim transaction.** `worker.md` section 10 states the daemon counts every limit against the grant id in one operation. The `BEGIN IMMEDIATE` transaction of EPIC 050 serialises two concurrent claims, and the increment is conditional on the value read.

- **The three end conditions are one function and three wired paths.** `grantEndEffect({ end })` returns `{ newClaim: "reject", openRun: "keep" | "end" }`, and each row has an implementation:

  | end                               | new claim                       | open run                                                | implemented by                                |
  | --------------------------------- | ------------------------------- | ------------------------------------------------------- | --------------------------------------------- |
  | `expires_at` passes               | `claim` refuses `grant-expired` | kept: `report` and `renew` work until `max_lifetime_at` | the claim path and the renew path of EPIC 050 |
  | a human revokes                   | authentication fails            | ended, fence raised                                     | `revoke-grant.ts`                             |
  | a human closes or discards `root` | `claim` refuses `root-closed`   | ended, fence raised                                     | `close-objective.ts` and `discard-node.ts`    |

  A renew under an expired grant is still capped by `max_lifetime_at`, so an expired grant cannot hold a run open indefinitely.

- **A revocation and a root close end their runs in the same transaction that records them.** A revocation that left a run alive for one more write would let a revoked client land a commit.

- **A new grant adopts no run.** `worker.md` section 4 states it. A `report` under grant B against a run opened by grant A refuses `run-grant-mismatch`, whatever the two grants name.

- **The four grant operations follow the path grammar.** They join `src/http/contract/credential.ts`: `grant.mint` is `POST /grant`, `grant.revoke` is `POST /grant/{handle}/revoke`, `grant.list` is `GET /grant`, `grant.show` is `GET /grant/{handle}`. Singular resource segments and closed action segments, per `docs/proposal/api/README.md`.

- **The four operations are human-only, and reads are scoped to the issuer.** A caller principal of kind `grant` is refused `human-only-operation` on all four. `grant.list` returns the grants whose `issuer` is the calling actor. `grant.show` refuses `404` for a handle another actor issued. `grant.revoke` accepts any handle the calling actor issued.

- **The row invariants are stated, not left to a refine.** `max_active_runs >= 1`, `max_claims >= 1`, `claims_used` starts at `0`, `revoked_at` starts null, `expires_at` is strictly after the mint time, `operations` is non-empty, and `root` names an existing node of the calling actor's reachable projects.

## Stories

1. **The identity kind.** Add `grant` to `identityKinds` at `src/domain/identity.ts:3` and to `identityPrefixes` at line 27, plus the `grant_h_` handle prefix. Update `src/domain/identity.test.ts` for the extended tuple.

2. **Migration 16.** Add `src/services/storage/migration-0016-grant.ts` at version `16` creating `grant` with its columns and the three triggers, and adding `run.grant_id` with its CHECK. Register it at `src/services/storage/migrations.ts:13`. Add its test asserting the freeze trigger refuses an update to each of the nine frozen columns, asserting a decrease of `claims_used` is refused, asserting a change to a non-null `revoked_at` is refused, asserting an increase of `claims_used` and a first revocation succeed, and asserting an internal run carrying a `grant_id` is refused.

3. **The grant row.** Add `src/domain/grant.ts` with `grantRow`, `grantOperations`, `normalizeOperations` and one refine per invariant of the Decisions. Add `src/domain/grant.test.ts` with a case per invariant, a case asserting `close` in `operations` is refused, and a case asserting a duplicated, unsorted operation list normalises to the canonical order.

4. **Scope and operation verdicts.** Add `src/domain/grant-scope.ts` with `grantScopeVerdict` and `grantOperationVerdict`. Add cases asserting a node inside the subtree passes, a node outside refuses `outside-root` naming the root, the root itself refuses `root-not-claimable`, each granted operation passes, and each omitted one refuses `operation-not-granted` by name.

5. **The end effects.** Add `grantEndEffect` to `src/domain/grant.ts`. Add cases asserting all three rows by full result object.

6. **The claim enforces the grant.** Extend `src/commands/node/claim-node.ts` so a grant caller, inside the claim transaction, is checked for operation, scope, expiry, root closure, structural refusal, `max_claims` and `max_active_runs`, and the run records `grant_id`. Add cases per refusal — `operation-not-granted`, `outside-root`, `root-not-claimable`, `grant-expired`, `root-closed`, `client-not-author`, `max-claims-exhausted`, `max-active-runs-exhausted` — and a case asserting a replayed claim raises no counter.

7. **Report and renew enforce the grant.** Extend the report and renew paths with the operation check and `run-grant-mismatch`. Add cases asserting a `report` under a grant omitting `report` refuses, asserting a `report` under a second grant refuses `run-grant-mismatch`, and asserting a `report` and a `renew` under an expired grant succeed while a `claim` refuses.

8. **The limits are enforced under concurrency.** Add cases asserting: with `max_claims: 1`, two concurrent claims open exactly one run and leave `claims_used` at `1`; with `max_active_runs: 1`, two concurrent claims open exactly one run; a replay concurrent with a new claim leaves the counter at `1`; and a failure injected after the increment leaves `claims_used` unchanged.

9. **Mint.** Add `src/commands/grant/mint-grant.ts` validating the worker against the registry and refusing `worker-unknown` and `worker-not-external` — the second tested against a registry fixture holding one internal worker — validating the root, normalising the operations, and returning the id once alongside the handle. Add its test per refusal and a case asserting the id is absent from every later read.

10. **Revoke, and the root close.** Add `src/commands/grant/revoke-grant.ts` writing `revoked_at`, ending every open run of the grant and raising each fence, in one transaction. Extend `close-objective.ts` and `delete-node.ts` to end every open run of every grant whose `root` is that node, in their own transactions. Add cases asserting each ends the run and raises the fence by one, asserting a later write refuses `fence-stale`, and asserting a revoked grant fails authentication.

11. **The routed operations.** Add the four operations to `src/http/contract/credential.ts` with the path tuples, request and response schemas and refusal sets of the Decisions. Add `src/queries/grant/list-grants.ts` and `src/queries/grant/show-grant.ts`, the four handlers under `src/http/server/grant/`, and the `src/main.ts` bindings. Add cases asserting a grant caller is refused `human-only-operation` on all four, asserting `grant.list` returns only the calling actor's grants, asserting `grant.show` answers `404` for another actor's handle, and asserting no response carries a `grant_` id.

12. **The authentication scheme.** Extend the authorization middleware with the `Grant` scheme, resolving a caller principal of kind `grant`, refusing a revoked grant at authentication and admitting an expired one. Add cases asserting each, asserting an actor token in the `Grant` scheme is refused, and asserting the resolved principal becomes the `caller` of EPIC 054.

13. **The proposal records the grant.** Add `docs/proposal/phase-2/grants-and-clients.md` stating the grant fields, the id-and-handle split, the authentication scheme and the authenticate-then-authorize rule, the three operations, the immutability and monotonicity triggers, the run binding, the two limits and their counting rule, the three end effects with their implementations, the orchestration-only rule and its claim-time refusal, and the trust boundary at which a holder key becomes necessary.

## Verification gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  src/domain/identity.test.ts \
  src/domain/grant.test.ts \
  src/domain/grant-scope.test.ts \
  src/services/storage/migration-0016-grant.test.ts \
  src/commands/grant/mint-grant.test.ts \
  src/commands/grant/revoke-grant.test.ts \
  src/commands/node/claim-node.test.ts \
  src/commands/outcome/report-outcome.test.ts \
  src/commands/run/renew-run.test.ts \
  src/commands/outcome/close-objective.test.ts \
  src/http/server/grant/list-grants.test.ts \
  src/http/server/authorization.test.ts \
  && echo "PASS EPIC-055"
```

Hermetic coverage required beyond the Proof:

- The freeze trigger refuses an update to each of the nine frozen columns, `id` and `issuer` included. Nine assertions against real SQLite.
- A decrease of `claims_used` is refused, and an increase succeeds. A change to an already-set `revoked_at` is refused, and a first revocation succeeds. Four assertions, so monotonicity is proven and not described.
- A claim on the root node itself refuses `root-not-claimable`. Without this the scope decision admits what the design forbids.
- A client claim carrying `available: false` refuses `unroutable` with `failedSet: "available"`, and `claims_used` is unchanged.
- A claim of a node whose run kind is `structural` by a grant caller refuses `client-not-author` at claim time, before any run row is written.
- `grant.mint` refuses `worker-not-external` for an internal fixture entry, so a grant cannot route around a supervisor. The production registry holds no internal worker, so the fixture is what makes the rule testable before EPIC 110.
- With `max_claims: 1`, two concurrent claims open exactly one run and leave `claims_used` at `1`. With `max_active_runs: 1`, two concurrent claims open exactly one run. Both are concurrency cases, not two sequential calls.
- A replayed claim concurrent with a new claim leaves `claims_used` at `1`.
- A failure injected after the increment leaves `claims_used` unchanged.
- An expired grant refuses `claim` and admits `report` and `renew`. A renew under an expired grant is still refused past `max_lifetime_at`. Three assertions covering the first end-condition row.
- A human close of `root` ends every open run of every grant rooted there and raises each fence, in the close transaction. The row is read inside the same snapshot as the node transition.
- A revoked grant fails authentication, and its runs are already ended.
- A `report` under grant B against a run opened by grant A refuses `run-grant-mismatch`.
- A `report` under a grant whose `operations` omits `report` refuses `operation-not-granted`, naming the operation.
- No response of the four grant operations carries a value with the `grant_` prefix. The assertion scans the serialised response recursively.
- `grant.show` answers `404` for a handle another actor issued, and `grant.list` returns only the calling actor's grants.
- A grant caller is refused `human-only-operation` on all four grant operations.
