# EPIC 054 — Attempt classification and the supervisor

Status: **draft**. It follows EPIC 053.1 by sequence order. It depends on EPIC 051.1 for `candidate.discard`, and on EPIC 051.5 for the post-commit step the expiry path needs.

**It holds twelve story entries, it declares no story kind, and it carries its hermetic coverage as a bullet list. `.agents/plan/authoring.md` refuses all three.** Its changed-path count is larger than its entry count: one implement story is one changed path, and the closure table below names twelve write sites alone. The epic is therefore replanned as a family of decimal epics, numbered from `054.1`, because EPIC 055, EPIC 056 and EPIC 057 are already numbered and renumbering them would break every cross-reference. `/author` cannot run on this file until that split lands. The rulings this file already carries — the migration, the evidence kinds, the closure and the amendment — are the input to the split and are settled here.

## Goal

A failed attempt carries a class, and the class decides whether it costs a budget:

- `termination` is `semantic`, `infrastructure` or `ambiguous`, and only a failed attempt carries one;
- one command gathers daemon-owned evidence, classifies it, converts on an exhausted budget, and writes the attempt in the transaction its caller already owns;
- a semantic termination consumes an attempt, an infrastructure termination consumes none, and an ambiguous one spends a separate budget that survives a new run;
- a worker never supplies its own class, and the transport schema has no field for one;
- the caller and the subject are derived from authenticated state, never from a request body.

## Non-goals

- **No supervisor process.** The supervisor is a domain contract and a service interface here. Launching a worker process, owning its process tree and delivering its credentials is EPIC 110.
- **No provider quota parsing.** The classifier consumes a provider-quota evidence value. Producing one from a real provider response is EPIC 102.
- **No retry loop.** This epic computes and persists the budget verdict. The loop that acts on it is EPIC 110.
- **No grant.** The external caller is the authenticated principal of today's actor middleware. EPIC 055 replaces it with a grant id, and the derivation site does not change.
- **No non-null constraint.** Every added column is nullable, per `worker.md` section 13. EPIC 057 makes `attempt.caller` and `attempt.subject` `NOT NULL` — `.agents/plan/epics/057-non-null-enforcement-and-legacy-removal.md:63` — `migration-0018-enforce.ts` names exactly those two of this epic's columns, and it tightens neither `attempt.termination` nor `node.ambiguous_used`.
- **No authority pin, and no `attempt.authority_json`.** EPIC 104 owns the whole slice: the column and its migration, the collector, `renderAuthorityPin`, the required-name list, the `authority-input-missing` refusal and the `attempt.show` field. Three of the five names the pin hashes — `role-contract`, `client-skill` and `guideline-block` — are instruction channels that epic produces and that exist in no source file today, and no seam reads the bytes of the other two: `src/services/git/index.ts` declares no file read, and `src/services/revision/index.ts:28` — `render` renders the whole plan inside a transaction the claim path does not open. A required input with no producer is a refusal no attempt could pass, so the pin lands with its inputs and not before.
- **No change to `attemptOutcome`.** The five outcomes at `src/domain/attempt.ts:7` — `attemptOutcomes` stay.

## Decisions

- **Migration `16` is additive, it backfills nothing, and it holds four columns.** `worker.md` section 13 puts non-null enforcement at step 8. `attempt.termination`, `attempt.caller`, `attempt.subject` and `node.ambiguous_used` are added nullable, by one migration. `attempt.authority_json` is **not** among them, per the authority Non-goal below. A historical row keeps a null caller and a null subject, because inventing one would manufacture audit evidence for an attempt nobody observed. EPIC 057 enforces them, and it refuses while a row written after this epic still holds a null.

- **A column whose first writer lands in a later epic of this family is legal, and one migration therefore serves the whole family.** `.agents/plan/authoring.md:48` — `migration` binds a migration to every statement that writes its changed columns, and the binding exists to stop a change from leaving shipped code invalid. An added nullable column invalidates no shipped statement, and the repository already ships the case: `.agents/plan/epics/051.3-the-checkpoint-and-the-land.md:29` — `caller` creates `checkpoint.caller` and `checkpoint.subject` nullable with no writer at all, and this epic is their first one. Splitting the four columns into one migration per writer would renumber EPIC 055's `17` and EPIC 057's `18` across four epic files, and it would take a version out of ship order — `src/services/storage/sqlite.ts:181` — `validateMigrations` admits any unique positive version, so a lower version added after a higher one applies in a different order on an upgraded database than on a fresh one.

- **Only a failed attempt carries a termination, and migration `16` states the half it can state alone.** `termination` is the class of a failed attempt, per `worker.md` section 9. `accepted` is the one successful outcome of the five at `src/domain/attempt.ts:7` — `attemptOutcomes`. Migration `16` adds `CHECK (termination IS NULL OR termination IN ('semantic', 'infrastructure', 'ambiguous'))` and `CHECK (outcome <> 'accepted' OR termination IS NULL)`. A null-equivalence CHECK would require a payer for a success.

- **The converse CHECK is a conditional non-null, and EPIC 057 owns it.** `CHECK (outcome IS NULL OR outcome = 'accepted' OR termination IS NOT NULL)` refuses every non-`accepted` attempt close that carries no termination, so it invalidates five shipped call sites on the commit that lands it: `src/commands/node/release-node.ts:124` — `closeAttempt`, `src/commands/node/release-node.ts:166` — `closeAttempt`, `src/commands/node/release-node.ts:262` — `closeAttempt`, `src/commands/startup/recover-expired-leases.ts:113` — `closeAttempt` and `src/commands/startup/recover-expired-leases.ts:196` — `closeAttempt`, all five of which write `outcome: "cancelled"`. The wiring of every failure path does not fit the epic that holds the migration, and this epic's `## Non-goals` already places non-null enforcement in EPIC 057. The CHECK therefore moves to migration `18`, and the amendment below carries the ask.

- **Termination evidence is a closed discriminated union, not a bag of booleans.** `src/domain/termination.ts` defines `TerminationEvidence` as a union with one `kind` per case, so two conflicting facts cannot be supplied at once and no precedence rule has to be invented:

  | `kind`                    | driver   | class            |
  | ------------------------- | -------- | ---------------- |
  | `daemon-rejected`         | both     | `semantic`       |
  | `worker-reported-failure` | both     | `semantic`       |
  | `operator-handoff`        | both     | `infrastructure` |
  | `provider-quota`          | internal | `infrastructure` |
  | `contended`               | both     | `infrastructure` |
  | `human-cancellation`      | external | `infrastructure` |
  | `worker-released`         | both     | `infrastructure` |
  | `ancestor-ended`          | both     | `infrastructure` |
  | `run-expired`             | external | `ambiguous`      |
  | `process-exit`            | internal | `ambiguous`      |

  `provider-quota` carries `{ providerId, responseHash }`, a value the provider transport produces from a signed response. A boolean would be a flag any caller could set. `ancestor-ended` carries `{ ancestorRunId }`, the run whose ending closed this attempt.

- **A voluntary release is `worker-released`, and it is `infrastructure`.** The human ruling of 2026-09-03 settles it. A worker that returns its claim reports no failure of the work, so it pays no attempt, which is the budget effect `worker.md` section 8 gives a non-failure. `operator-handoff` was rejected as the carrier: a release is the worker's own act, and one kind for both would make an audit unable to separate them.

- **A release no longer advances the attempt limit, and the shipped `attempt-limit` branch stays reachable only through an earlier semantic attempt.** `src/commands/node/release-node.ts:113` — `accountAttempts` projects the closing attempt onto the accounting, and the projection now carries `termination: "infrastructure"`. `exhausted` reads `semanticCount` by the accounting decision below, so a run whose attempts are all releases never exhausts its limit, and the `blocked` write at `src/commands/node/release-node.ts:134` — `attempt-limit` is reached only when an earlier attempt of the same run carried a semantic termination. This is a behaviour change to shipped code, it is stated here, and the story that wires the release asserts both directions.

- **A cascade close is `ancestor-ended`, and it is `infrastructure`.** `src/commands/node/release-node.ts:262` — `closeAttempt` and `src/commands/startup/recover-expired-leases.ts:196` — `closeAttempt` close the open attempt of a **descendant** run while the command ends its ancestor. The descendant worker produced no failure and made no claim, so it pays neither an attempt nor an ambiguous budget. Propagating the ancestor's own kind was rejected: an ancestor expiry is `run-expired`, which is `ambiguous`, so propagation would charge a descendant's crash-loop budget for an event the descendant never caused.

- **The classifier is two total functions over two evidence types.** `classifyInternal(evidence: InternalEvidence)` and `classifyExternal(evidence: ExternalEvidence)`, where the two types are disjoint subsets of the union above. `worker.md` section 9 states the two sources, and one function with a driver parameter would let an external value reach an internal rule.

- **The trust boundary is the transport schema, not a type signature.** A TypeScript signature is erased at runtime. `node.report` is a `z.strictObject` with no `termination` key and no `caller` key, so an unknown key is refused rather than stripped. An external termination is constructed by the daemon from its own facts: a rejection it produced, an explicit failure report, a cancellation it performed, or an expiry its clock observed. A runtime test posts a body carrying `termination` and asserts the request is refused.

- **A worker's own claim of quota exhaustion is `worker-reported-failure`.** `worker.md` section 9 states a worker's claim is evidence, never a verdict. Only `provider-quota`, whose `responseHash` names a response the daemon's own transport received, classifies `infrastructure`.

- **Contention is `infrastructure`, and this is a decision taken here.** `worker.md` section 9 lists an operator handoff and a provider-signed quota response as infrastructure sources, and section 8 states contention consumes no attempt and is not a worker failure. The source list is read as non-exhaustive, and contention takes the class whose budget effect the document already assigns it. A fourth class would carry no different behaviour.

- **The ambiguous budget belongs to the node, not to the run, because a crash loop opens a new run each time.** `worker.md` section 9 states the budget bounds a crash loop. An unexplained expiry ends the run, so a per-run counter resets on the very event it must count. Migration `16` adds `node.ambiguous_used INTEGER`, nullable, incremented on every ambiguous termination under the node's current assignment. `ambiguousBudget` is configuration, not a column.

- **The counter resets when the assignment changes, and at nothing else.** A worker switch of EPIC 056 clears `ambiguous_used`, because the budget bounds one worker's crash loop and a new worker starts clean. `node.unblock` does not clear it.

- **The boundary is `>=`, and the conversion is stated for three values.** With `ambiguousBudget = n`: an ambiguous termination is stored `ambiguous` while `ambiguous_used < n`, and stored `semantic` once `ambiguous_used >= n`. `ambiguousBudget = 0` therefore converts the first ambiguous termination. `ambiguousBudget` defaults to 2, refuses a negative value at startup, and refuses a non-integer.

- **The conversion is applied at classification time, and the stored value is what was charged.** A conversion applied at read time would leave the row and the accounting disagreeing.

- **One command ends an attempt, it takes the caller's transaction, and it opens none.** `src/commands/attempt/end-attempt.ts` exports `endAttempt(dependencies, transaction, input)`, reads `node.ambiguous_used`, classifies, converts, writes `attempt.termination`, increments the counter, and appends one event, all in the transaction it receives. Every caller is already inside one, and `src/commands/outcome/aggregate-initiative.ts:20` — `aggregateInitiative` is the shipped idiom for a nested write. A second `storage.transact` inside a caller's transaction is not a transaction, and a command of its own would give the expiry path — which runs inside `claimNode`'s transaction — no legal caller at all. **Its diagrams therefore hold no `storage.transact` step.**

- **The increment carries no compare and set, because one transaction cannot lose the race.** The read and the update are in one write transaction and SQLite admits one writer at a time, so a zero-row result is unreachable and the restart it guarded is dead logic. The statement is `UPDATE node SET ambiguous_used = COALESCE(ambiguous_used, 0) + 1 WHERE id = ?`, with `COALESCE` because migration `16` adds the column nullable and a historical node holds null. The read applies the same default, so a null counter and a zero counter classify identically. Two endings of one attempt are impossible by the conditional-settlement rule below, and two attempts of one node cannot be open at once — `src/commands/node/release-node.ts:103` — `openAttempts` throws on more than one open attempt of a run.

- **A rejection settles in a transaction its own arm already owns, and no command opens a new one.** Three constraints close this: a daemon rejection is `semantic` and must be recorded — `worker.md:465` — `A daemon rejection`; `reportOutcome` opens one transaction that commits before the git-bearing accept runs — `.agents/plan/epics/051.4-the-acceptance-gate-and-the-report-route.md:40` — `reportOutcome`; and `acceptExecution` opens exactly two and may not open a third — `.agents/plan/epics/051.4-the-acceptance-gate-and-the-report-route.md:36` — `acceptExecution`. `AGENTS.md` also names the two-unjournaled-transactions shape a defect it intends to repair, so a second `reportOutcome` transaction is refused. The placement is therefore per arm:

  | arm                                | the transaction it settles in                                   |
  | ---------------------------------- | --------------------------------------------------------------- |
  | a structural or a review rejection | `reportOutcome`'s prelude transaction, which is still open      |
  | an execution gate rejection        | one transaction of `acceptExecution`, opened on that arm alone  |
  | a contended land                   | `land.settle:contended`, which the journaled write already owns |
  | the worker's own failure member    | `reportOutcome`'s prelude transaction                           |

  **A rejection is a returned value at the accept boundary, never a throw, wherever the write shares the refusal's transaction.** A throw inside `storage.transact` rolls the write back with it. `.agents/plan/epics/051.6-the-post-expiry-reap-on-the-run-operations.md:64` — `disposition` already records that a returned disposition and a thrown refusal are both legal shapes here. `reportOutcome` writes the termination, commits, and then raises the refusal the accept returned.

  **`acceptStructural` and `acceptReview` reach no new transaction, so none of their refusal diagrams moves.** Both take the caller's transaction and open none — `.agents/plan/epics/052.1-the-structural-acceptance.md:33` — `acceptStructural` — so the termination write is one statement after the accept returns, and it appears in `reportOutcome`'s diagram. The nine refusal diagrams of EPIC 052.1 and EPIC 053.1 stay as drawn.

  **The execution arm holds one transaction on a rejection and two on an acceptance**, so the ceiling of the decision above is never crossed. The gate's git-dependent checks run outside every transaction, exactly as they do today, and a nested settlement unit opens the one transaction that records the verdict.

- **The settlement is conditional, and the first writer wins.** The prelude commits before the execution gate runs, so an expiry, a cancellation or a worker switch can end the same attempt in between. The settlement transaction therefore re-reads the run and the attempt, and it writes **only** while that attempt is still open under the presented fence. A closed attempt makes the settlement a no-op: the earlier termination stands, no second `attempt.ended` event is appended, and the gate still refuses with its own code, because the client's request is refused either way. A late write would otherwise replace an `infrastructure` or `ambiguous` termination with a `semantic` one and move the attempt limit for an ending it did not cause.

- **`end-attempt` appends one `attempt.ended` event, and the event is settled here.** `src/domain/event-type.ts:1` — `eventTypes` gains `attempt.ended`. `subjectKind` is `"attempt"` and `subjectId` is the attempt id: `src/domain/event.ts:11` — `subjectKind` is a free string and `src/commands/node/claim-node.ts:426` — `subjectKind` already writes `"run"` that way, and a run subject is provably wrong here, because one cascade close ends the attempts of several runs in one transaction. `actorKind` and `actorId` are the caller's, as at `src/commands/node/claim-node.ts:429` — `actorKind`; a daemon-driven close passes `daemon` and the `instanceId` dependency that ships at `src/commands/outcome/aggregate-initiative.ts:12` — `instanceId`, written at `:78` — `actorId`. The payload is `{ attemptId, runId, nodeId, attemptNo, outcome, termination, evidence, semanticCountAfter, attemptLimit, ambiguousUsedAfter, ambiguousBudget }`. The four counters make the payload the close-time accounting snapshot, which is the only durable record of them: `node.ambiguous_used` resets on an assignment change, a converted ambiguous termination is stored `semantic`, and `attempt.termination` is null on every row migration `16` did not backfill, so no query can reconstruct any of the four for an older attempt. `evidence` is the whole evidence value, not its `kind` alone, because `providerId`, `responseHash` and `ancestorRunId` are the audit-bearing parts of the union. One variant joins `src/http/contract/event-payload.ts`. The event and the termination commit together, and a caller that already appends `run.ended` keeps it: the two answer different questions, and folding the class into five existing payloads would make a reader learn five shapes to find one field.

- **`end-attempt` writes and does not discard, and the caller discards after the settlement commits.** A git write cannot join a SQLite transaction, so the discard cannot be inside the transaction that records the termination. The discard is therefore the caller's, and each path names its owner:

  | path                                                                  | who ends the attempt                           | who discards the candidate ref                        |
  | --------------------------------------------------------------------- | ---------------------------------------------- | ----------------------------------------------------- |
  | rejection in `accept-execution`, `accept-structural`, `accept-review` | `end-attempt`                                  | EPIC 051.4, after the accept transaction commits      |
  | contention in `land-execution`                                        | `end-attempt`                                  | EPIC 051.4, after the land transaction commits        |
  | explicit failure report                                               | `end-attempt`                                  | this epic, after the report transaction commits       |
  | **a run expiry in `expire-runs`**                                     | `end-attempt`, inside the caller's transaction | **EPIC 051.5's post-commit step**                     |
  | human cancellation                                                    | `end-attempt`                                  | this epic, after the cancellation transaction commits |
  | a worker switch with an active run                                    | `end-attempt`, inside the switch transaction   | `switch-worker`, after that transaction commits       |
  | a release in `release-node`                                           | `end-attempt`                                  | nobody until startup — `candidate.sweep`              |
  | a cascade close of a descendant run                                   | `end-attempt`                                  | nobody until startup — `candidate.sweep`              |
  | the startup recovery of an expired run                                | `end-attempt`                                  | nobody until startup — `candidate.sweep`              |

  The last three rows add no discard, and EPIC 051.6 already rules them: `.agents/plan/epics/051.6-the-post-expiry-reap-on-the-run-operations.md:22` — `candidate.sweep` states that a run an operation itself ends is in no expiry list, is reaped by no operation, and leaves its candidate ref until startup. This epic does not widen that set, because the reap's eligibility proof is written for the expiry list alone.

  Every discard calls `candidate.discard` of EPIC 051.1 Story 4 (`04-the-candidate-ref-is-deleted`) and never `git.deleteRef` directly, because `candidate.discard` is the only site that calls it.

  **This epic audits every one of those discards against the six conditions of `AGENTS.md` `### Rules the import matrix cannot express`**: a deletion whose success must sequence with a database effect is a journaled write, not an exempt one. None of these does, and the two conditions a reader cannot check by inspection are established rather than asserted:

  - **Condition 3, committed and monotonic eligibility.** The candidate ref is attempt-scoped — `refs/kanthord/candidate/<runId>/<attemptNo>`, per `worker.md:421` — `refs/kanthord/candidate/` — and a closed attempt never reopens. The eligibility is therefore the committed attempt close, and it holds even while the run is still active, so no discard depends on an in-flight decision.
  - **Condition 5, the guaranteed retry.** `candidate.sweep` enumerates that namespace at startup — `.agents/plan/stories/051.1-the-candidate-and-the-git-primitives/08-the-candidate-namespace-is-enumerated.md:143` — `findings` — so every remnant is temporary.
  - **Condition 6, the settled outcome.** The order is settle, discard, refuse. `worker.md:421` requires the discard on a rejection, and a discard before the termination write would break this condition, which is why the order is stated and not left to the implementer.

  **The reported run's own ref is `candidate.discard` and stays inside the accept; the expired runs' refs are `candidate.reap` and belong to `reportOutcome`.** `.agents/plan/epics/051.6-the-post-expiry-reap-on-the-run-operations.md:29` — `No reap inside` states both, and it changes none of EPIC 051.4's seven diagrams. The five execution refusal diagrams of EPIC 051.4 are therefore still the live prior set at this epic's time, and a reviewer who reads the reap as having moved the discard is reading two calls as one.

- **A worker switch deletes the candidate ref it orphans, and only on the arm that ended an attempt.** EPIC 056 asked this epic to rule the owner, and the ruling is the switch itself, after its transaction commits. It has such a point where the expiry path has none: `worker.md:292` already places the attempt-workspace discard "after that transaction commits". The call is unconditional over the ref, because `candidate.discard` on an absent ref exits `0` — `.agents/plan/stories/051.1-the-candidate-and-the-git-primitives/04-the-candidate-ref-is-deleted.md:196` — `discarding an absent ref resolves` — so a switch before any candidate push and one after it reach the same single step. **The no-run arm calls it zero times**, because it ends no attempt and therefore orphans no attempt-scoped ref. All six conditions hold: no database mutation and no event ride with the deletion; correctness does not need it immediate; eligibility is the committed `state = 'ended'` and the closed attempt the switch transaction wrote, and the ref is attempt-scoped so it can never become active again; a failure leaves an inert ref; `candidate.sweep` discards every ref whose run is not `active` at startup — `.agents/plan/epics/051.1-the-candidate-and-the-git-primitives.md:97` — `candidate.sweep`; and the switch settles its whole outcome in the committed transaction first.

- **A failed cleanup never changes a switch's result.** The assignment, the fence and the run end are committed before the deletion runs, so a deletion that throws still answers success and leaves the ref to `candidate.sweep`. Reporting failure would tell a human the switch did not happen, and their retry would answer `switch-unchanged` over an assignment that had already moved.

- **Every failure path calls `end-attempt`, and none writes a termination itself.** `attempt.show` therefore has no field that no path populates.

- **The path set is the closure over `execution.closeAttempt`, not a list in prose.** `src/services/execution/sqlite.ts:294` — `UPDATE attempt SET outcome` is the one writer of `attempt.outcome`, so the set is every caller of `execution.closeAttempt` that writes an outcome other than `accepted`, plus every path this range adds. A prose list misses a call site, and the epic that preceded this ruling missed five. The set is verified against the tree at authoring time and is currently:

  | call site                                                             | outcome           | evidence kind             |
  | --------------------------------------------------------------------- | ----------------- | ------------------------- |
  | `src/commands/outcome/report-outcome.ts:234` — `closeAttempt`         | the report member | `worker-reported-failure` |
  | `src/commands/node/release-node.ts:124` — `closeAttempt`              | `cancelled`       | `worker-released`         |
  | `src/commands/node/release-node.ts:166` — `closeAttempt`              | `cancelled`       | `worker-released`         |
  | `src/commands/node/release-node.ts:262` — `closeAttempt`              | `cancelled`       | `ancestor-ended`          |
  | `src/commands/startup/recover-expired-leases.ts:113` — `closeAttempt` | `cancelled`       | `run-expired`             |
  | `src/commands/startup/recover-expired-leases.ts:196` — `closeAttempt` | `cancelled`       | `ancestor-ended`          |
  | a daemon rejection in `accept-execution`                              | `rejected`        | `daemon-rejected`         |
  | a daemon rejection in `accept-structural`                             | `rejected`        | `daemon-rejected`         |
  | a daemon rejection in `accept-review`                                 | `rejected`        | `daemon-rejected`         |
  | a contention in `land-execution`                                      | `failed`          | `contended`               |
  | a run expiry in `expire-runs`                                         | `cancelled`       | `run-expired`             |
  | a human cancellation                                                  | `cancelled`       | `human-cancellation`      |
  | a worker switch in `switch-worker`, with an active run                | `cancelled`       | `operator-handoff`        |

  **The stored outcome names the site and never the class.** Each row's kind is a ruling of this epic, taken from what the daemon knows at that site, and `cancelled` carries three different kinds. `src/commands/startup/recover-expired-leases.ts` becomes `recover-expired-runs.ts` in EPIC 050.5 Story 2, per `.agents/plan/epics/050.5-the-lease-table-removal.md:89` — `recover-expired-runs.ts`, and the two rows move with the file.

- **The expiry path is the one that cannot discard for itself, and this is why.** `expireRuns` takes the caller's transaction (`src/commands/run/expire-runs.ts:25 — `expireRuns``) and is synchronous, and its only production caller runs it inside `claimNode`'s transaction (`src/commands/node/claim-node.ts:147 — `expireRuns``). It therefore has no "after the transaction commits" of its own: the transaction belongs to a command that has not finished. `end-attempt` still runs there — it is a database write and it joins that transaction legally. The discard is handed to EPIC 051.5, which carries the ended run ids out of the claim and acts on them after the commit. **Do not make `expireRuns` asynchronous and do not give it a `Git`**; either would put git I/O inside a storage transaction.

- **`accountAttempts` counts semantic terminations, and the limit stops reading the raw counter.** `src/domain/attempt-accounting.ts:3` — `AttemptRecord` gains `termination` and returns `semanticCount`, `ambiguousCount` and `exhausted`, where `exhausted` is `semanticCount >= limit`. An infrastructure failure no longer advances the limit. This is a behaviour change to shipped code, and the shipped cases are updated rather than kept.

- **`caller` and `subject` are derived, never received.** `subject` is `run.worker`, read from the run row. `caller` is the authenticated principal the middleware resolved: today the actor id, from EPIC 055 the grant id, from EPIC 110 the supervisor id. Neither is read from the request body, and the report schema holds no key for either. `worker.md` section 10 separates authorization from attribution, and the test asserts the derivation site, not an inequality.

- **No row is backfilled, and `checkpoint.caller` and `checkpoint.subject` follow the same derivation from this epic on.** `.agents/plan/epics/051.3-the-checkpoint-and-the-land.md:29` — `caller` created both columns nullable and named this epic as their filler, and EPIC 053.1 asked which of a backfill or a null this epic rules. The ruling: **nothing is backfilled, ever.** A checkpoint written before this epic keeps a null caller and a null subject, for the reason the attempt row keeps them — a manufactured value is false audit evidence. From this epic on, every checkpoint writer derives both from the same two sources as the attempt. `.agents/plan/epics/057-non-null-enforcement-and-legacy-removal.md:63` — `migration-0018-enforce.ts` tightens `attempt.caller` and `attempt.subject` alone today, and `.agents/plan/epics/051.3-the-checkpoint-and-the-land.md:98` — `EPIC 057` asks it to tighten the checkpoint pair beside them. This epic rules the derivation and never the enforcement: a row written before this epic holds null under either answer, and the enforcement epic owns its own preflight.

- **A supervisor is a declared interface with a `not-implemented` implementation, and `launch` spawns a process.** `worker.md` section 10 states that the worker runs as a separate process, that the supervisor spawns it and owns its process tree, and that a later worker runs on another machine. `src/services/supervisor/index.ts` declares `launch`, `observe` and `classify`, where `launch` starts a worker process and `observe` returns an `InternalEvidence` from that process's termination. The interface therefore admits a remote worker without a signature change, and EPIC 110's in-process dispatcher is the design that has to move. `src/services/supervisor/not-implemented.ts` throws, mirroring `src/services/agent/not-implemented.ts`.

- **`attempt.show` publishes an exact field list, and redaction is an allowlist.** The response is `{ attemptId, runId, nodeId, attemptNo, outcome, termination, caller, subject, startedAt, endedAt, accountingAfter }`. An unknown attempt id answers `404`. The redaction test asserts the response key set, recursively, is deep-equal to the allowlisted set, rather than scanning for suspicious substrings. It carries no `authority`: EPIC 104 adds that field with the producer, the column and the refusal, because a key that always answers null reserves a contract nobody implemented.

- **The accounting is one nullable object read from the close-time snapshot, and never four fields recomputed at query time.** `accountingAfter` is `{ semanticCount, attemptLimit, ambiguousUsed, ambiguousBudget }` or `null`, and the query reads it from the `attempt.ended` event payload of the shown attempt. Four independent fields would mix three points in time — a historical limit, a prefix count and a live node counter — and a count over `termination = 'semantic'` would price every attempt migration `16` left unclassified at zero. `null` means an open attempt or a row written before this epic, and it is never `0`. **A closed attempt that carries a termination and no `attempt.ended` event is an invariant failure, not a null**: the query refuses `attempt-accounting-missing`, because the event and the termination commit in one transaction, so their disagreement is corruption and a null would hide it as legacy data.

## Stories

1. **Migration 16.** Add `src/services/storage/migration-0016-termination.ts` at version `16`, adding `attempt.termination`, `attempt.caller`, `attempt.subject` and `node.ambiguous_used`, all nullable, with the **two** named CHECK constraints of the Decisions. Register it at `src/services/storage/migrations.ts:13`. Add its test asserting each CHECK by insert and by name, asserting an `accepted` attempt with a termination is refused, asserting a `cancelled` attempt with no termination is **accepted** by this migration, and asserting every existing row is unchanged with the added columns null.

2. **The attempt row.** Extend `attemptRow` at `src/domain/attempt.ts:23` with the four fields and one refine per CHECK, which is two refines. Update `src/domain/attempt.test.ts` with a case per refine.

3. **The evidence union and the classifiers.** Add `src/domain/termination.ts` with `terminations`, `TerminationEvidence`, `InternalEvidence`, `ExternalEvidence`, `classifyInternal` and `classifyExternal`. Add `src/domain/termination.test.ts` asserting every row of the Decisions table by value, asserting each classifier is total over its own union by iterating the kinds, and asserting an external evidence kind is not assignable to `classifyInternal` through a type-level test.

4. **The conversion.** Add `convertOnExhaustion({ termination, ambiguousUsed, ambiguousBudget })` to `src/domain/termination.ts`. Add cases asserting the three boundary values `ambiguousUsed = budget - 1`, `= budget` and `> budget`, asserting `budget = 0` converts the first ambiguous termination, and asserting a semantic termination is unaffected.

5. **Accounting by class.** Extend `src/domain/attempt-accounting.ts:3` — `AttemptRecord` with `termination`, and `src/domain/attempt-accounting.ts:32` — `accountAttempts`, returning `semanticCount`, `ambiguousCount` and an `exhausted` that reads `semanticCount`. Update `src/domain/attempt-accounting.test.ts`: three infrastructure failures under a limit of three leave `exhausted` false; three semantic failures give true; the mixed case is asserted by the full result object; and every shipped case is updated rather than kept.

6. **End attempt.** Add `src/commands/attempt/end-attempt.ts` exporting `endAttempt(dependencies, transaction, input)`, performing the read, the classification, the conversion, the write, the increment and the `attempt.ended` append in the transaction it receives. Add its test asserting: the stored value after a conversion is `semantic`; the command opens no transaction of its own, asserted by a storage double recording zero spans; a null `ambiguous_used` increments to one through `COALESCE`; two sequential ambiguous endings leave `ambiguous_used` at exactly two; a settlement over an already-closed attempt writes nothing and appends no event; and a failure injected at the event append leaves the attempt and the counter unchanged.

7. **Every failure path calls it.** Wire `end-attempt` into every row of the closure table of the Decisions: the three accept paths, the explicit failure report, `land-execution` contention, `expire-runs`, human cancellation, the two `release-node` releases, the two cascade closes and the startup recovery of an expired run. Add one case per row asserting the stored `termination` value, so no path writes a class of its own. Add the two release cases the accounting change forces: a run whose attempts are all releases never reports `exhausted`, and a run holding one earlier semantic attempt still reaches the `blocked` write at `src/commands/node/release-node.ts:134` — `attempt-limit`. **The `expire-runs` wiring is the write only**: `end-attempt` joins the caller's transaction there, and the candidate discard for that path belongs to EPIC 051.5, so this story adds no git call to `expire-runs` and no `Git` to `ExpireRunsDependencies`. Add one case asserting a git service double's call count is zero across an expiry pass that ends an attempt.

8. **Caller and subject are derived.** Extend the attempt write path to read `subject` from `run.worker` and `caller` from the authenticated principal. Add cases asserting a request body carrying `caller` or `termination` is refused by the strict schema, asserting `subject` equals `run.worker` for an internal and an external run, and asserting `caller` equals the authenticated principal in both.

9. **The supervisor interface.** Add `src/services/supervisor/index.ts` and `src/services/supervisor/not-implemented.ts`, mirroring `src/services/agent/not-implemented.ts`. Add its test asserting the throw by error code.

10. **Configuration.** Add `ambiguousBudget` to `src/services/config/`, default 2, refusing a negative and a non-integer at startup. Add cases per refusal.

11. **`attempt.show` is routed.** Move the entry from `stubbed` to `routed` with the exact response shape of the Decisions, add `src/queries/attempt/show-attempt.ts`, the handler and the `src/main.ts` binding. Add its test asserting the field list; asserting `accountingAfter` deep-equals the `attempt.ended` payload counters of the shown attempt; asserting `null` for an open attempt and for a row carrying no termination; asserting `attempt-accounting-missing` for a closed attempt whose termination is set and whose event is absent; asserting `404` for an unknown id; and asserting the recursive key set deep-equals the allowlist. Add an integration case asserting the route answers `200` and no longer `501`.

12. **The proposal records classification.** Add `docs/proposal/phase-2/attempts-and-classification.md` stating the three classes, the evidence union with its driver column, the two classifiers, the transport trust boundary, the node-scoped ambiguous budget with its reset rule and its `>=` boundary, the attempt-limit change, the caller and subject derivation, and the close-time accounting snapshot with the reason no query can recompute it.

## Amendments this epic asks of other epics

None is applied here, and a human applies each before dispatch.

- **EPIC 057, its migration story** — that epic is not authored, so it carries no story stem yet, and its story list entry is `.agents/plan/epics/057-non-null-enforcement-and-legacy-removal.md:63` — `migration-0018-enforce.ts`. Migration `18` takes the converse CHECK this epic does not create: `CHECK (outcome IS NULL OR outcome = 'accepted' OR termination IS NOT NULL)`, added to `attempt` in the same rebuild that makes `attempt.caller` and `attempt.subject` `NOT NULL`. Its preflight refuses while a row holds a non-`accepted` outcome and a null termination, which is the shape its other preflight refusals already have. This epic cannot add it: five shipped `execution.closeAttempt` call sites write `outcome: "cancelled"` with no termination, per the Decision above, and their wiring does not fit the epic that holds migration `16`. **The default if no ruling arrives: no CHECK ever states that a non-`accepted` attempt carries a termination**, and the rule lives only in `end-attempt` and in this epic's cases.

- **EPIC 104, its instruction-compiler stories** — that epic is not authored, so it carries no story stem yet, and it holds no migration today: `.agents/plan/epics/104-instruction-compiler.md:24` — `instruction-channel.ts` is where its channel list lives. It takes the whole authority slice this epic drops, and the ask is specific because a vague one hands the seam to build time. It must settle: which component produces each required input, with `role-contract`, `client-skill` and `guideline-block` coming from its own channels; how the bytes or their hashes reach attempt opening, since `src/services/git/index.ts` declares no file read; every attempt-opening writer that must persist the pin, which today is `src/commands/node/claim-node.ts:403` — `openAttempt` alone; the exact point at which a missing required input refuses, and its code; the null semantics of every attempt row written before it; a migration of its own for `attempt.authority_json`; and the `authority` field on `attempt.show` with its schema. **The default if no ruling arrives: no attempt ever records the inputs a human authorised**, and `worker.md` section 10's pin requirement is unmet by the product.

## Verification Gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  src/domain/attempt.test.ts \
  src/domain/termination.test.ts \
  src/domain/attempt-accounting.test.ts \
  src/services/storage/migration-0016-termination.test.ts \
  src/services/supervisor/not-implemented.test.ts \
  src/services/config/config.test.ts \
  src/commands/attempt/end-attempt.test.ts \
  src/commands/checkpoint/land-execution.test.ts \
  src/commands/run/expire-runs.test.ts \
  src/commands/node/release-node.test.ts \
  src/commands/startup/recover-expired-runs.test.ts \
  src/queries/attempt/show-attempt.test.ts \
  && echo "PASS EPIC-054"
```

Hermetic coverage required beyond the Proof:

- Migration `16` leaves every added column nullable. The assertion reads the table info and asserts no added column is `NOT NULL`, so the additive rule of `worker.md` section 13 is proven, not described.
- An `accepted` attempt carrying a termination is refused, and a `cancelled` attempt carrying no termination is accepted. Two cases, so the CHECK is not a null-equivalence rule, and the second is the control that migration `16` states one half only. EPIC 057 proves the converse.
- Each classifier is total over its own union, asserted by iterating the evidence kinds, so an eleventh kind fails the test.
- A `worker-released` and an `ancestor-ended` each classify `infrastructure`, and a run whose every attempt is a release never reports `exhausted`. The control is one earlier semantic attempt of the same run, which still reaches the `blocked` write.
- A `worker-reported-failure` classifies `semantic` and a `provider-quota` classifies `infrastructure`, in one case, so the distinction cannot be lost.
- A request body carrying `termination` is refused by the strict transport schema, asserted over the real route. A type-level test does not stand in for this.
- A request body carrying `caller` is refused the same way.
- `convertOnExhaustion` is asserted at `ambiguousUsed = budget - 1`, `= budget` and `> budget`, and at `budget = 0`.
- After a conversion the stored `attempt.termination` is `semantic`, read from the row, not `ambiguous`.
- Two sequential ambiguous endings leave `node.ambiguous_used` at exactly two, and a node whose counter is null reaches one. `end-attempt` opens no transaction span of its own, asserted by the storage double, which is the control that it is a nested write.
- A settlement over an attempt another operation already closed writes no `attempt.termination`, appends no second `attempt.ended`, and leaves the earlier termination byte-identical, while the gate still answers its own refusal code. The control is the same case with the attempt still open, which writes both.
- One `attempt.ended` event is appended per ended attempt, its `subjectKind` is `attempt` and its `subjectId` is the attempt id, and its payload deep-equals the stated value with the whole evidence object, `providerId` and `responseHash` included for a `provider-quota` case and `ancestorRunId` for a cascade case.
- The transaction span count per arm is asserted by the storage double: a structural rejection and a review rejection add none, an execution gate rejection adds exactly one, and a contended land adds none beyond the journaled two.
- The ambiguous counter survives the run that produced it. The case ends run one by expiry, opens run two by a new claim, ends it by expiry, and asserts the counter is two.
- Three infrastructure failures under an attempt limit of three leave `exhausted` false. Three semantic failures give true.
- A contended land writes `termination = 'infrastructure'` and leaves `semanticCount` unchanged, in one case.
- Every row of the closure table writes a termination through `end-attempt`. One case each, asserting the stored value. The closure itself is asserted: `execution.closeAttempt` has exactly the enumerated production callers, deep-equal against that literal, so a caller a later epic adds fails the test rather than shipping with no class.
- `end-attempt` deletes **no** candidate ref, asserted against the loopback fixture by reading the ref after the call and finding it present. The control is the caller's own discard after the transaction commits, which deletes it in the same case, so the absence is not vacuous. The `## Decisions` ruling that `end-attempt` writes and does not discard is what this row proves.
- The expiry path reaches no discard of its own, asserted by a `candidate` double whose call count is zero across an `expireRuns` pass that ends a run carrying a candidate ref. EPIC 051.5 owns the deletion and proves it.
- `subject` equals `run.worker` and `caller` equals the authenticated principal, for an internal and an external run. Four assertions across two cases.
- The `attempt.show` response key set, computed recursively, deep-equals the allowlist. A substring scan is not sufficient, and the absence of an `authority` key is asserted by that equality.
- `accountingAfter` deep-equals the four counters of the shown attempt's `attempt.ended` payload, and it is `null` for an open attempt. The control is the closed attempt of the same fixture, which returns the object.
- A closed attempt carrying a termination and no `attempt.ended` event refuses `attempt-accounting-missing`, asserted by error code. The control is the same fixture with the event present, which answers `200`.
- A worker switch with an active run reaches `candidate.discard` exactly once after its transaction commits, and a switch with no active run reaches it zero times. Both in one case set, so the arm distinction is proven in both directions.
- A `candidate.discard` that throws after the switch transaction commits leaves the operation successful, with the assignment, the fence and the run end all committed, asserted by value.
