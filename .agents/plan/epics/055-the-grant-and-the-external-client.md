# EPIC 055 — The grant and the external client

Status: **draft**. It follows EPIC 054 by sequence order, and it runs before EPIC 055.1. It consumes EPIC 048's worker registry and EPIC 015's actor identity.

It holds the grant itself: the row, the operations a human calls, and the scheme a client presents. EPIC 055.1 holds every enforcement that reads a grant. The two split on a provable boundary — after this epic a grant exists, authenticates and is read, and **no operation admits a grant caller**, so an external client is refused `actor-forbidden` everywhere until EPIC 055.1 wires the enforcement.

**Dispatch prerequisite.** Story 5 inserts `"055"` into `scripts/epic-sequence-range.ts:1` — `authoredEpics` after the entry EPIC 054's family adds, and Story 9 appends it to `shippedEpics`, which `test/sequence/conformance.test.ts:254` — `shippedEpics` requires to stay a prefix of `authoredEpics`. Story 9 is therefore last in dispatch order.

## Goal

A human mints a grant, and the grant is a readable authority with no consumer yet:

- a grant names one root subtree, one external worker, an operation list, an expiry and two limits;
- the grant id is the bearer credential, returned once, and the handle is the name a human uses;
- a client presents the grant id in its own authentication scheme, and an expired grant still authenticates;
- a grant is immutable, and its two counters are monotone by trigger;
- the four grant operations are human-only, their reads are scoped to the issuer, and a grant caller is refused on every operation the daemon serves.

## Non-goals

- **No enforcement.** EPIC 055.1 owns the claim, the report, the renew, the revocation and the root close. Nothing in this epic reads a grant inside a worker operation, and no operation admits a grant caller.
- **No holder key.** `worker.md` section 10 states the daemon and the client run on one trusted machine, and a holder key adds no boundary. The epic states the boundary at which one becomes necessary — a remote daemon, a second human, or a shared runner — and adds none.
- **No process identity.** The caller of an external client is the grant id. Two holders of one grant give one audit trail attributed to neither, and the epic records that as an accepted failure mode.
- **No client.** Nothing here drives Claude Code or opencode.
- **No actor removal.** `src/domain/actor.ts:15` — `actorRow` and the actor token stay. A human authenticates as an actor to mint a grant.
- **No authority pin.** `worker.md` section 10 also requires every authority input to be pinned by content hash. EPIC 054's family owns that, and this epic does not restate it.
- **No `human-only-operation` code.** The refusal is registry data. See the caller-kind decision.

## Decisions

- **A grant is a row, and `grant` joins `identityKinds`.** Migration `17` creates `grant` with `id`, `handle`, `root`, `worker`, `operations_json`, `issuer`, `expires_at`, `max_active_runs`, `max_claims`, `claims_used`, `revoked_at`. `src/domain/identity.ts:3` — `identityKinds` gains `grant`, and `src/domain/identity.ts:27` — `identityPrefixes` gains the prefix `grant`.

- **The migration is `17`, and it serves the whole family.** `.agents/plan/epics/050.5-the-lease-table-removal.md:35` — `migration` rules the allocation: `12` is EPIC 050.1's, `13` is EPIC 051's, `14` is EPIC 051.3's, `15` is vacant and stays vacant, `16` is EPIC 054's, `17` is this epic's and `18` is EPIC 057's. `.agents/plan/authoring.md:48` — `migration` binds a migration to every statement that writes its changed columns, and EPIC 055.1 holds the first writer of `claims_used`, of `revoked_at` and of `run.grant_id`. `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md:30` — `migration` already rules that case: a new table and an added nullable column invalidate no shipped statement, and `.agents/plan/epics/051.3-the-checkpoint-and-the-land.md:29` — `caller` ships the precedent by creating two columns with no writer at all. Splitting the migration by writer would renumber EPIC 057's `18` and take a version out of ship order, which `src/services/storage/sqlite.ts:181` — `validateMigrations` permits and an upgraded database does not survive. The family therefore takes one migration, and this epic states the reading rather than leaving a reader to derive it.

- **The grant id is the bearer credential, and the handle is the name a human uses.** `worker.md` section 10 states a grant is a bearer credential and the caller is the grant id, and it gives the grant no key. A `grant.show` that returned the id would hand the credential to any reader. `handle` is a separate non-secret `grant_h_`-prefixed ULID, returned by `grant.list` and `grant.show`, and accepted by `grant.revoke`. The id is returned once, by `grant.mint`, and never again.

- **A client presents the grant id in its own scheme.** `Authorization: Grant <grantId>`. `src/http/server/auth.ts:28` — `resolveActor` parses only the `Bearer` scheme today, and it gains a second resolver. The two schemes are distinguished by the scheme token, never by the value shape.

- **Authentication and authorization are separate steps, because an expired grant must still write.** The middleware authenticates any grant row that exists and is not revoked, including an expired one. The operation then authorizes, in EPIC 055.1: `claim` refuses an expired grant, and `report` and `renew` do not. A revoked grant fails authentication outright, because its runs are already ended.

- **The caller kind is registry data, and `actor-forbidden` is the one refusal.** `src/http/contract/operation.ts:39` — `allowedActors` is typed `readonly RegisteredActorKind[]` over the two kinds at `src/domain/actor.ts:6` — `registeredActorKinds`, and `src/http/server/authorize.ts:11` — `allowedActors` refuses a kind an operation omits with the shipped `actor-forbidden` at `src/http/contract/errors.ts:12` — `actor-forbidden`. `src/domain/caller.ts` therefore declares `callerKinds` as `["human", "harness", "grant"]`, `allowedActors` is retyped `readonly CallerKind[]`, and the four grant operations declare `allowedActors: ["human"]`. A bespoke `human-only-operation` code was drafted and is rejected: `.agents/plan/epics/056.1-the-close-and-the-human-boundary.md` rules the actor boundary is registry data, the code names no condition a client acts on differently, and `AGENTS.md` requires route lifecycle to be registry data rather than a branch in a handler. This also makes EPIC 056's and EPIC 056.1's phrase "EPIC 055's caller kinds" resolve to a real tuple.

- **The authenticated principal is a discriminated union on the request, and it reaches a command as command input.** `src/domain/caller.ts` declares `CallerPrincipal` as `{ kind: "human" | "harness"; actor: ActorRow }` or `{ kind: "grant"; grant: GrantRow }`. `src/http/server/variables.ts:11` — `actor` gains a `caller` variable beside it, the middleware sets `caller` for both schemes and sets `actor` for the `Bearer` scheme alone, and `src/http/server/authorize.ts:11` — `allowedActors` reads `caller.kind`. `src/http/server/node/claim-node.ts:31` — `actorId` shows the shipped route from the middleware to a command: the handler passes the principal into command **input**, never into the wire schema, which is what `.agents/plan/epics/050.1-the-claim.md:42` requires. **`src/http/server/app.ts:36` — `actor` and `src/http/server/dispatch.ts:39` — `actor` do not change in this epic**, because no operation admits a grant caller here and `demand(c, "actor")` is therefore never reached by one. EPIC 055.1 admits the grant caller to four handlers, and it carries the `HandlerContext` change and the twenty-four `context.actor` call sites in the same epic.

- **`root` is a scope, never a unit of work, and the daemon refuses a claim on it.** `worker.md` section 10 states it. `grantScopeVerdict` returns `outside-root` for a node outside the subtree, and `root-not-claimable` for `targetId === root`. A membership test alone admits exactly what the rule forbids. The verdict function ships here; EPIC 055.1 wires it.

- **A grant names exactly one worker, and that worker must be external.** `worker.md` section 4 states a grant names one worker, which narrows delegation to one subject. `grant.mint` refuses `worker-unknown` for an id outside the registry of EPIC 048, and `worker-not-external` for an entry whose `src/domain/worker-registry.ts:11` — `driver` is `internal`. An internal worker stays behind its supervisor, and a grant that named one would route around it.

- **`worker-not-external` is tested against a registry fixture, because the production registry holds no internal worker.** A human deferred every internal worker to phase 2, so both entries at `src/domain/worker-registry.ts:22` — `driver` and `:31` — `driver` are external and the refusal has no production subject. The check ships now because EPIC 110 adds the first internal worker, and a refusal added after the worker it must refuse is a refusal that arrives late.

- **`operations` is a closed set of three.** `claim`, `report` and `renew`. `close` is a human verb and never appears in a grant. **`release` is not granted either, and the consequence is stated rather than discovered:** an external client cannot end its own run, and the run it abandons expires on `runTtlMs`. The stored list is deduplicated and sorted into the order above, so two grants with the same operations are byte-identical.

- **The run records its grant, and the column lands here with no writer.** Migration `17` adds `run.grant_id TEXT REFERENCES grant(id)`, with `CHECK ((driver = 'external') OR grant_id IS NULL)`. Every shipped external run writes a null `grant_id` and satisfies the CHECK, so the column invalidates no statement. Without it the daemon cannot count active runs of a grant, cannot end every run of a grant on revocation, and cannot refuse a second grant's write to a run the first opened. EPIC 055.1's claim is its first writer.

- **A grant is immutable, and its counters are monotone, and both are triggers.** One `BEFORE UPDATE` trigger aborts a change to `id`, `handle`, `root`, `worker`, `operations_json`, `issuer`, `expires_at`, `max_active_runs` or `max_claims`. A second aborts when `NEW.claims_used < OLD.claims_used`. A third aborts when `OLD.revoked_at IS NOT NULL AND NEW.revoked_at IS NOT OLD.revoked_at`. A frozen-column list that omits `id` and `issuer` is not immutability, and an unguarded counter is not monotone.

- **The three end conditions are one pure function here, and three wired paths in EPIC 055.1.** `grantEndEffect({ end })` returns `{ newClaim: "reject", openRun: "keep" | "end" }`, and each row names the epic that implements it:

  | end                               | new claim                       | open run                                                | implemented by                                        |
  | --------------------------------- | ------------------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
  | `expires_at` passes               | `claim` refuses `grant-expired` | kept: `report` and `renew` work until `max_lifetime_at` | EPIC 055.1, the claim path and the renew path         |
  | a human revokes                   | authentication fails            | ended, fence raised                                     | EPIC 055.1, `revoke-grant.ts`                         |
  | a human closes or discards `root` | `claim` refuses `root-closed`   | ended, fence raised                                     | EPIC 055.1, `close-objective.ts` and `delete-node.ts` |

  A renew under an expired grant is still capped by `max_lifetime_at`, so an expired grant cannot hold a run open indefinitely.

- **A new grant adopts no run.** `worker.md` section 4 states it. EPIC 055.1 refuses `run-grant-mismatch` for a `report` under grant B against a run opened by grant A, whatever the two grants name.

- **The four grant operations get their own contract file and their own server directory.** `src/http/contract/grant.ts` declares `grant.mint` as `POST /grant`, `grant.revoke` as `POST /grant/{handle}/revoke`, `grant.list` as `GET /grant` and `grant.show` as `GET /grant/{handle}`, registered at `src/http/contract/registry.ts:2` — `credential` beside the other subjects, and the handlers live at `src/http/server/grant/`. Every shipped contract file maps one-to-one onto a server directory, and `src/http/contract/credential.ts` already holds fourteen provider operations; adding a second subject to it would break the mapping the tree keeps. Singular resource segments and closed action segments, per `docs/proposal/api/README.md`.

- **The four operations are human-only, and reads are scoped to the issuer.** Each declares `allowedActors: ["human"]`, so a grant caller and a harness actor are both refused `actor-forbidden` by `src/http/server/authorize.ts:11` — `allowedActors`. `grant.list` returns the grants whose `issuer` is the calling actor, ordered by `id`, which is a ULID and therefore mint order. `grant.show` refuses `404` for a handle another actor issued. `grant.revoke` accepts any handle the calling actor issued.

- **The row invariants are stated, not left to a refine.** `max_active_runs >= 1`, `max_claims >= 1`, `claims_used` starts at `0`, `revoked_at` starts null, `expires_at` is strictly after the mint time, `operations` is non-empty, and `root` names an existing node of the calling actor's reachable projects.

## Stories

Each entry is a name and the output it contributes. The story file holds the change, the tasks and the diagrams, and it declares its kind. `.agents/plan/authoring.md` is the standard.

1. **The identity kind and migration 17.** Add `grant` to `src/domain/identity.ts:3` — `identityKinds` and the `grant` and `grant_h_` prefixes to `src/domain/identity.ts:27` — `identityPrefixes`, and update `src/domain/identity.test.ts` for the extended tuple. Add `src/services/storage/migration-0017-grant.ts` at version `17` creating `grant` with its eleven columns and its three triggers, and adding `run.grant_id` with its CHECK. Register it at `src/services/storage/migrations.ts:13` — `migration0012RunModel` and `:27` — `migration0012RunModel`. `story-foundation`.

2. **The grant domain.** Add `src/domain/grant.ts` with `grantRow`, `grantOperations`, `normalizeOperations`, `grantEndEffect` and one refine per row invariant, and `src/domain/grant-scope.ts` with `grantScopeVerdict` and `grantOperationVerdict`. `story-foundation`.

3. **The grant service.** Add `src/services/grant/index.ts` and one SQLite implementation, declaring the transaction-scoped read by id, the read by handle scoped to an issuer, the issuer-scoped list, the insert, the conditional counter increment and the revocation write. Every method takes the storage transaction context, per `AGENTS.md`. `story-foundation`.

4. **The caller principal and the `Grant` scheme.** Add `src/domain/caller.ts` with `callerKinds` and `CallerPrincipal`, retype `src/http/contract/operation.ts:39` — `allowedActors` to `readonly CallerKind[]`, add the `caller` variable at `src/http/server/variables.ts:11` — `actor`, extend `src/http/server/auth.ts:28` — `resolveActor` with the `Grant` scheme and its resolver, and repoint `src/http/server/authorize.ts:11` — `allowedActors` at `caller.kind`. `story-foundation`.

5. **The contract, the refusal codes and the CLI.** Add `src/http/contract/grant.ts` with the four operations, their path tuples, their request and response schemas and their `errors` records; register it at `src/http/contract/registry.ts:2` — `credential`; add the mint and read refusal codes to `src/http/contract/errors.ts:12` — `actor-forbidden` and `src/cli/exit-code.ts:18` — `actor-forbidden`; add the four CLI commands and their inventory rows; regenerate `src/http/contract/field-decisions.fixture.ts`. Insert `"055"` into `authoredEpics`. `story-foundation`.

6. **Mint.** Add `src/commands/grant/mint-grant.ts` validating the worker against the registry and refusing `worker-unknown` and `worker-not-external` — the second against a registry fixture holding one internal worker — validating the root, normalising the operations, and returning the id once alongside the handle. Adds the handler at `src/http/server/grant/mint-grant.ts` and the `src/main.ts` binding. Draws `grant-mint-success`, with an empty prior set. `story-implement`.

7. **`grant.list`.** Add `src/queries/grant/list-grants.ts` returning the calling actor's grants by handle, the handler at `src/http/server/grant/list-grants.ts` and the `src/main.ts` binding. Draws `grant-list-success`, with an empty prior set. `story-implement`.

8. **`grant.show`.** Add `src/queries/grant/show-grant.ts` refusing `404` for a handle another actor issued, the handler at `src/http/server/grant/show-grant.ts` and the `src/main.ts` binding. Draws `grant-show-success`, with an empty prior set. `story-implement`.

9. **The proposal records the grant.** Add `docs/proposal/phase-2/grants-and-clients.md` stating the grant fields, the id-and-handle split, the authentication scheme and the authenticate-then-authorize rule, the three granted operations and the two ungranted verbs, the immutability and monotonicity triggers, the run binding, the caller kinds as registry data, and the trust boundary at which a holder key becomes necessary. It states that the enforcement is EPIC 055.1 and names no unimplemented behaviour as shipped. Append `"055"` to `shippedEpics`. It is last in dispatch order. `story-foundation`.

## Amendments this epic asks of other epics

None is applied here, and a human applies each before dispatch.

- **EPIC 056** — its Dispatch prerequisite says Story 1 inserts `"056"` into `authoredEpics` "after the entry EPIC 055 adds". This epic and EPIC 055.1 add two entries, so the last one is `"055.1"`. **The default if no ruling arrives: EPIC 056 inserts its entry after `"055"`**, and `shippedEpics` stops being a prefix of `authoredEpics` when EPIC 055.1 lands after it.

- **EPIC 054's family** — `.agents/plan/epics/054-attempt-classification-and-the-supervisor.md:148` — `caller` states the attempt `caller` is "from EPIC 055 the grant id". With the caller-kind decision above, the grant id arrives as a `CallerPrincipal` of kind `grant`, not as a substituted actor id, and the family must state which of the two it writes into `attempt.caller`. **The default if no ruling arrives: the family writes an actor id for every attempt**, and an external attempt is attributed to the issuer rather than to the grant.

- **EPIC 054's family** — its termination table gives `worker-released` the driver `both`. This epic rules `release` is not a granted operation, so an external client cannot release and `worker-released` has no external producer. **The default if no ruling arrives: a termination kind claims a driver that cannot produce it**, and a reviewer cannot tell whether the gap is the table or the grant.

## Verification Gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  src/domain/identity.test.ts \
  src/domain/grant.test.ts \
  src/domain/grant-scope.test.ts \
  src/domain/caller.test.ts \
  src/services/storage/migration-0017-grant.test.ts \
  src/services/grant/sqlite.test.ts \
  src/commands/grant/mint-grant.test.ts \
  src/queries/grant/list-grants.test.ts \
  src/queries/grant/show-grant.test.ts \
  src/http/contract/grant.test.ts \
  src/http/contract/registry.test.ts \
  src/http/server/auth.test.ts \
  src/http/server/authorize.test.ts \
  src/http/server/grant/mint-grant.test.ts \
  src/http/server/grant/list-grants.test.ts \
  src/http/server/grant/show-grant.test.ts \
  src/cli/exit-code.test.ts \
  src/cli/parity.test.ts \
  src/main.test.ts \
  test/sequence/conformance.test.ts \
  && echo "PASS EPIC-055"
```

Hermetic coverage required beyond the Proof. **Every row names exactly one proof owner.**

| #   | assertion                                                                                                                                                                                                                                                                   | story |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1   | `identityKinds` holds `grant`, `identityPrefixes` maps it to `grant`, and a `grant_h_` handle parses as the handle kind and not as the grant kind. The cross-parse is the control that one prefix does not admit the other.                                                 | 1     |
| 2   | The freeze trigger refuses an update to each of the nine frozen columns, `id` and `issuer` included. Nine assertions against real SQLite, iterated from the frozen tuple.                                                                                                   | 1     |
| 3   | A decrease of `claims_used` is refused and an increase succeeds; a change to an already-set `revoked_at` is refused and a first revocation succeeds. Four assertions, so monotonicity is proven and not described.                                                          | 1     |
| 4   | An internal run carrying a non-null `grant_id` is refused by the CHECK, and an external run carrying one is accepted. Both directions, so the CHECK is not a blanket refusal.                                                                                               | 1     |
| 5   | Every shipped external run row still inserts with a null `grant_id` after the migration, asserted over the fixture the run tests already build. This is the assertion that the added column invalidates no shipped statement.                                               | 1     |
| 6   | Each row invariant refuses its own violation by value — `max_active_runs` of `0`, `max_claims` of `0`, a non-zero initial `claims_used`, a non-null initial `revoked_at`, an `expires_at` at or before the mint time, and an empty `operations`. Six cases.                 | 2     |
| 7   | `close` in `operations` is refused, `release` in `operations` is refused, and a duplicated unsorted list normalises to `claim`, `report`, `renew` byte-identically. The normalisation is asserted as bytes, so two grants with one operation set are one value.             | 2     |
| 8   | A node inside the subtree passes, a node outside refuses `outside-root` naming the root, and `targetId === root` refuses `root-not-claimable`. The third case is what a membership test alone would admit.                                                                  | 2     |
| 9   | Each granted operation passes and each omitted one refuses `operation-not-granted` naming the operation, iterated from `grantOperations`. Three passes and three refusals.                                                                                                  | 2     |
| 10  | `grantEndEffect` returns all three rows of the end-condition table by full result object, iterated from the end tuple. Three assertions, so no row falls through to a default.                                                                                              | 2     |
| 11  | Every grant service method requires the storage transaction context in its signature, asserted by construction, and a read of an absent id returns null rather than throwing. The null return is what lets the caller refuse rather than crash.                             | 3     |
| 12  | The conditional increment leaves `claims_used` unchanged when the read value no longer matches, and increments by one when it does. Both directions inside one transaction, which is what EPIC 055.1's concurrency cases rest on.                                           | 3     |
| 13  | `callerKinds` equals `["human", "harness", "grant"]` by value, and `allowedActors` accepts `grant` as a member type. The type-level acceptance is what makes the boundary registry data.                                                                                    | 4     |
| 14  | A valid grant id in the `Grant` scheme authenticates, an expired one authenticates, a revoked one refuses `unauthenticated`, and an actor token in the `Grant` scheme refuses `unauthenticated`. Four assertions covering both schemes in both directions.                  | 4     |
| 15  | A grant id in the `Bearer` scheme refuses `unauthenticated`, so the two schemes are separated by the scheme token and never by the value shape. This is the control for row 14.                                                                                             | 4     |
| 16  | An authenticated grant caller is refused `actor-forbidden` on **every** operation the registry declares, iterated over the registry, and a human actor passes at least one. The iteration is what proves this epic admits no grant caller anywhere.                         | 4     |
| 17  | The `caller` variable is set for both schemes and the `actor` variable only for the `Bearer` scheme, and `src/http/server/dispatch.ts:39` — `actor` is unchanged, asserted by the file holding no `caller` key. The unchanged dispatch is the boundary EPIC 055.1 moves.    | 4     |
| 18  | Each of the four grant operations declares `allowedActors` of `["human"]`, its method, its lifecycle status and its rendered path by value: `/grant`, `/grant/{handle}/revoke`, `/grant`, `/grant/{handle}`. Sixteen values, which is the whole contract surface.           | 5     |
| 19  | Every segment of the four paths comes from a closed set and every resource segment is singular, asserted through the path renderer, and a plural or free-form segment fails to type. The failure is the control.                                                            | 5     |
| 20  | The registry holds each of the four operation ids exactly once, and `src/http/contract/registry.test.ts` reports no duplicate path or method pair. A second registration of one id fails the assertion.                                                                     | 5     |
| 21  | Every refusal code the four operations declare has an entry in `errorStatuses` and an exit code in `src/cli/exit-code.ts`, and `compareCommandSets` reports the four new command paths. A code missing from either map fails the assertion.                                 | 5     |
| 22  | `grant.mint` refuses `worker-unknown` for an id outside the registry and `worker-not-external` for a fixture entry whose `driver` is `internal`, and accepts an external entry. The fixture is what makes the second rule testable before EPIC 110 adds an internal worker. | 6     |
| 23  | `grant.mint` refuses a `root` that names no node, and one outside the calling actor's reachable projects. Two refusals, so reachability is not assumed from existence.                                                                                                      | 6     |
| 24  | `grant.mint` returns the grant id exactly once, and the response also carries the handle. The id is asserted to parse as the `grant` kind and the handle as the handle kind.                                                                                                | 6     |
| 25  | A failure injected after the `grant` insert leaves no `grant` row, with `databaseBytes` byte-identical to the pre-call snapshot. The mint is one transaction.                                                                                                               | 6     |
| 26  | `grant.list` returns only the calling actor's grants, ordered by mint order, and a second actor's grant is absent. A grant issued by the second actor and readable by the first fails the assertion, which is the control.                                                  | 7     |
| 27  | `grant.show` answers `404` for a handle another actor issued and returns the grant for a handle the caller issued. Both directions, so the scoping is not a blanket refusal.                                                                                                | 8     |
| 28  | No response of the four grant operations except `grant.mint` carries a value with the `grant_` prefix, and `grant.mint`'s response carries exactly one. The assertion scans the serialised response recursively, so a nested id is caught.                                  | 8     |
| 29  | The conformance runner replays the three diagrams of this epic by equality, and the comparison fails when one seam call is removed from `grant-mint-success`.                                                                                                               | 9     |
| 30  | `docs/proposal/phase-2/grants-and-clients.md` names no behaviour this epic does not ship, asserted by the absence of `claims_used` enforcement, `run_grant_id` writing and `run-grant-mismatch` from its text. EPIC 055.1's proposal half is the control.                   | 9     |
