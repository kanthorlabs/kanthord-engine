# EPIC 054 — Attempt classification and the supervisor

Status: **draft**. It follows EPIC 053 by sequence order.

## Goal

A failed attempt carries a class, and the class decides whether it costs a budget:

- `termination` is `semantic`, `infrastructure` or `ambiguous`, and only a failed attempt carries one;
- one command gathers daemon-owned evidence, classifies it, converts on an exhausted budget, and writes the attempt in one transaction;
- a semantic termination consumes an attempt, an infrastructure termination consumes none, and an ambiguous one spends a separate budget that survives a new run;
- a worker never supplies its own class, and the transport schema has no field for one;
- the caller and the subject are derived from authenticated state, never from a request body.

## Non-goals

- **No supervisor process.** The supervisor is a domain contract and a service interface here. Launching a worker process, owning its process tree and delivering its credentials is EPIC 110.
- **No provider quota parsing.** The classifier consumes a provider-quota evidence value. Producing one from a real provider response is EPIC 102.
- **No retry loop.** This epic computes and persists the budget verdict. The loop that acts on it is EPIC 110.
- **No grant.** The external caller is the authenticated principal of today's actor middleware. EPIC 055 replaces it with a grant id, and the derivation site does not change.
- **No non-null constraint.** Every added column is nullable, per `worker.md` section 13. EPIC 057 enforces.
- **No change to `attemptOutcome`.** The five outcomes at `src/domain/attempt.ts:6` stay.

## Decisions

- **Migration `15` is additive and backfills nothing.** `worker.md` section 13 puts non-null enforcement at step 8. `attempt.termination`, `attempt.caller`, `attempt.subject` and `attempt.authority_json` are added nullable. A historical row keeps a null caller and a null subject, because inventing one would manufacture audit evidence for an attempt nobody observed. EPIC 057 enforces them, and it refuses while a row written after this epic still holds a null.

- **Only a failed attempt carries a termination, and the CHECK says exactly that.** `termination` is the class of a failed attempt, per `worker.md` section 9. `accepted` is the one successful outcome of the five at `src/domain/attempt.ts:6`. Migration `15` adds `CHECK (termination IS NULL OR termination IN ('semantic', 'infrastructure', 'ambiguous'))`, `CHECK (outcome <> 'accepted' OR termination IS NULL)` and `CHECK (outcome IS NULL OR outcome = 'accepted' OR termination IS NOT NULL)`. A null-equivalence CHECK would require a payer for a success.

- **Termination evidence is a closed discriminated union, not a bag of booleans.** `src/domain/termination.ts` defines `TerminationEvidence` as a union with one `kind` per case, so two conflicting facts cannot be supplied at once and no precedence rule has to be invented:

  | `kind`                    | driver   | class            |
  | ------------------------- | -------- | ---------------- |
  | `daemon-rejected`         | both     | `semantic`       |
  | `worker-reported-failure` | both     | `semantic`       |
  | `operator-handoff`        | both     | `infrastructure` |
  | `provider-quota`          | internal | `infrastructure` |
  | `contended`               | both     | `infrastructure` |
  | `human-cancellation`      | external | `infrastructure` |
  | `run-expired`             | external | `ambiguous`      |
  | `process-exit`            | internal | `ambiguous`      |

  `provider-quota` carries `{ providerId, responseHash }`, a value the provider transport produces from a signed response. A boolean would be a flag any caller could set.

- **The classifier is two total functions over two evidence types.** `classifyInternal(evidence: InternalEvidence)` and `classifyExternal(evidence: ExternalEvidence)`, where the two types are disjoint subsets of the union above. `worker.md` section 9 states the two sources, and one function with a driver parameter would let an external value reach an internal rule.

- **The trust boundary is the transport schema, not a type signature.** A TypeScript signature is erased at runtime. `node.report` is a `z.strictObject` with no `termination` key and no `caller` key, so an unknown key is refused rather than stripped. An external termination is constructed by the daemon from its own facts: a rejection it produced, an explicit failure report, a cancellation it performed, or an expiry its clock observed. A runtime test posts a body carrying `termination` and asserts the request is refused.

- **A worker's own claim of quota exhaustion is `worker-reported-failure`.** `worker.md` section 9 states a worker's claim is evidence, never a verdict. Only `provider-quota`, whose `responseHash` names a response the daemon's own transport received, classifies `infrastructure`.

- **Contention is `infrastructure`, and this is a decision taken here.** `worker.md` section 9 lists an operator handoff and a provider-signed quota response as infrastructure sources, and section 8 states contention consumes no attempt and is not a worker failure. The source list is read as non-exhaustive, and contention takes the class whose budget effect the document already assigns it. A fourth class would carry no different behaviour.

- **The ambiguous budget belongs to the node, not to the run, because a crash loop opens a new run each time.** `worker.md` section 9 states the budget bounds a crash loop. An unexplained expiry ends the run, so a per-run counter resets on the very event it must count. Migration `15` adds `node.ambiguous_used INTEGER`, nullable, incremented on every ambiguous termination under the node's current assignment. `ambiguousBudget` is configuration, not a column.

- **The counter resets when the assignment changes, and at nothing else.** A worker switch of EPIC 056 clears `ambiguous_used`, because the budget bounds one worker's crash loop and a new worker starts clean. `node.unblock` does not clear it.

- **The boundary is `>=`, and the conversion is stated for three values.** With `ambiguousBudget = n`: an ambiguous termination is stored `ambiguous` while `ambiguous_used < n`, and stored `semantic` once `ambiguous_used >= n`. `ambiguousBudget = 0` therefore converts the first ambiguous termination. `ambiguousBudget` defaults to 2, refuses a negative value at startup, and refuses a non-integer.

- **The conversion is applied at classification time, and the stored value is what was charged.** A conversion applied at read time would leave the row and the accounting disagreeing.

- **One command ends an attempt, and the read, the conversion and the write are one transaction.** `src/commands/attempt/end-attempt.ts` reads `node.ambiguous_used`, classifies, converts, writes `attempt.termination`, increments the counter conditionally, and appends its event, inside one `storage.transact`. Two concurrent endings would otherwise read the same count and both stay under budget. The increment is `UPDATE node SET ambiguous_used = ambiguous_used + 1 WHERE id = ? AND ambiguous_used = ?`, and a zero-row result restarts the classification.

- **`end-attempt` deletes the candidate ref of the attempt it ends.** EPIC 051 deletes it on acceptance, on rejection and on contention, and EPIC 050 deletes it on an expiry. An operator handoff is the remaining path. The delete happens after the transaction commits, because a git write cannot join a SQLite transaction.

- **Every failure path calls `end-attempt`, and none writes a termination itself.** The paths are: a daemon rejection in `accept-execution`, `accept-structural` and `accept-review`; an explicit failure report; a contention in `land-execution`; a run expiry in `expire-runs`; and a human cancellation. `attempt.show` therefore has no field that no path populates.

- **`accountAttempts` counts semantic terminations, and the limit stops reading the raw counter.** `src/domain/attempt-accounting.ts:32` gains `termination` on `AttemptRecord` and returns `semanticCount`, `ambiguousCount` and `exhausted`, where `exhausted` is `semanticCount >= limit`. An infrastructure failure no longer advances the limit. This is a behaviour change to shipped code, and the shipped cases are updated rather than kept.

- **`caller` and `subject` are derived, never received.** `subject` is `run.worker`, read from the run row. `caller` is the authenticated principal the middleware resolved: today the actor id, from EPIC 055 the grant id, from EPIC 110 the supervisor id. Neither is read from the request body, and the report schema holds no key for either. `worker.md` section 10 separates authorization from attribution, and the test asserts the derivation site, not an inequality.

- **The authority pin is collected when the attempt opens, and a missing input is a refusal.** `worker.md` section 10 states every authority input is pinned by content hash into the attempt record. The required names are `plan-document`, `agents-md`, `role-contract`, `client-skill` and `guideline-block`. Each value is a `services/blob` hash of the bytes the daemon read. `client-skill` and `guideline-block` are optional and absent for an internal worker; the other three are required, and a missing one refuses `authority-input-missing`, naming it. `renderAuthorityPin` emits canonical JSON with keys sorted bytewise. A hash is audit evidence: it names the input a human authorised and detects a substitution, and it proves no execution. The epic states that limit.

- **A supervisor is a declared interface with a `not-implemented` implementation, and `launch` spawns a process.** `worker.md` section 10 states that the worker runs as a separate process, that the supervisor spawns it and owns its process tree, and that a later worker runs on another machine. `src/services/supervisor/index.ts` declares `launch`, `observe` and `classify`, where `launch` starts a worker process and `observe` returns an `InternalEvidence` from that process's termination. The interface therefore admits a remote worker without a signature change, and EPIC 110's in-process dispatcher is the design that has to move. `src/services/supervisor/not-implemented.ts` throws, mirroring `src/services/agent/not-implemented.ts`.

- **`attempt.show` publishes an exact field list, and redaction is an allowlist.** The response is `{ attemptId, runId, nodeId, attemptNo, outcome, termination, caller, subject, attemptLimit, semanticCount, ambiguousUsed, ambiguousBudget, startedAt, endedAt, authority }`, where `authority` is the name-to-hash object. The counters are the values **after** the shown attempt. An unknown attempt id answers `404`. The redaction test asserts the response key set, recursively, is deep-equal to the allowlisted set, rather than scanning for suspicious substrings.

## Stories

1. **Migration 16.** Add `src/services/storage/migration-0016-termination.ts` at version `16`, adding `attempt.termination`, `attempt.caller`, `attempt.subject`, `attempt.authority_json` and `node.ambiguous_used`, all nullable, with the three named CHECK constraints of the Decisions. Register it at `src/services/storage/migrations.ts:13`. Add its test asserting each CHECK by insert and by name, asserting an `accepted` attempt with a termination is refused, asserting a `failed` attempt with no termination is refused, and asserting every existing row is unchanged with the added columns null.

2. **The attempt row.** Extend `attemptRow` at `src/domain/attempt.ts:23` with the four fields and one refine per CHECK. Update `src/domain/attempt.test.ts` with a case per refine.

3. **The evidence union and the classifiers.** Add `src/domain/termination.ts` with `terminations`, `TerminationEvidence`, `InternalEvidence`, `ExternalEvidence`, `classifyInternal` and `classifyExternal`. Add `src/domain/termination.test.ts` asserting every row of the Decisions table by value, asserting each classifier is total over its own union by iterating the kinds, and asserting an external evidence kind is not assignable to `classifyInternal` through a type-level test.

4. **The conversion.** Add `convertOnExhaustion({ termination, ambiguousUsed, ambiguousBudget })` to `src/domain/termination.ts`. Add cases asserting the three boundary values `ambiguousUsed = budget - 1`, `= budget` and `> budget`, asserting `budget = 0` converts the first ambiguous termination, and asserting a semantic termination is unaffected.

5. **Accounting by class.** Extend `src/domain/attempt-accounting.ts:32` with `termination` on `AttemptRecord`, returning `semanticCount`, `ambiguousCount` and an `exhausted` that reads `semanticCount`. Update `src/domain/attempt-accounting.test.ts`: three infrastructure failures under a limit of three leave `exhausted` false; three semantic failures give true; the mixed case is asserted by the full result object; and every shipped case is updated rather than kept.

6. **End attempt.** Add `src/commands/attempt/end-attempt.ts` performing the read, the classification, the conversion, the write, the conditional increment and the event in one transaction. Add its test asserting: the stored value after a conversion is `semantic`; the conditional increment restarts on a zero-row result; two sequential ambiguous endings leave `ambiguous_used` at exactly two; and a failure injected at the event append leaves the attempt and the counter unchanged.

7. **Every failure path calls it.** Wire `end-attempt` into `accept-execution`, `accept-structural`, `accept-review`, the explicit failure report, `land-execution` contention, `expire-runs` and human cancellation. Add one case per path asserting the stored `termination` value, so no path writes a class of its own.

8. **Caller and subject are derived.** Extend the attempt write path to read `subject` from `run.worker` and `caller` from the authenticated principal. Add cases asserting a request body carrying `caller` or `termination` is refused by the strict schema, asserting `subject` equals `run.worker` for an internal and an external run, and asserting `caller` equals the authenticated principal in both.

9. **The authority pin.** Add `src/domain/authority-pin.ts` with the required and optional names and `renderAuthorityPin`. Collect the inputs when the attempt opens and persist `authority_json`. Add cases asserting canonical key order byte-exact, asserting a duplicate name refuses, asserting a missing required name refuses `authority-input-missing` naming it, and asserting an internal attempt omits `client-skill` legally.

10. **The supervisor interface.** Add `src/services/supervisor/index.ts` and `src/services/supervisor/not-implemented.ts`, mirroring `src/services/agent/not-implemented.ts`. Add its test asserting the throw by error code.

11. **Configuration.** Add `ambiguousBudget` to `src/services/config/`, default 2, refusing a negative and a non-integer at startup. Add cases per refusal.

12. **`attempt.show` is routed.** Move the entry from `stubbed` to `routed` with the exact response shape of the Decisions, add `src/queries/attempt/show-attempt.ts`, the handler and the `src/main.ts` binding. Add its test asserting the field list, asserting the counters are post-attempt values, asserting `404` for an unknown id, and asserting the recursive key set deep-equals the allowlist. Add an integration case asserting the route answers `200` and no longer `501`.

13. **The proposal records classification.** Add `docs/proposal/phase-2/attempts-and-classification.md` stating the three classes, the evidence union with its driver column, the two classifiers, the transport trust boundary, the node-scoped ambiguous budget with its reset rule and its `>=` boundary, the attempt-limit change, the caller and subject derivation, and the authority pin with its stated limit.

## Verification Gate

Gates: `pnpm run verify`

Proof:

```bash
node --test \
  src/domain/attempt.test.ts \
  src/domain/termination.test.ts \
  src/domain/attempt-accounting.test.ts \
  src/domain/authority-pin.test.ts \
  src/services/storage/migration-0016-termination.test.ts \
  src/services/supervisor/not-implemented.test.ts \
  src/services/config/config.test.ts \
  src/commands/attempt/end-attempt.test.ts \
  src/commands/checkpoint/land-execution.test.ts \
  src/commands/run/expire-runs.test.ts \
  src/queries/attempt/show-attempt.test.ts \
  && echo "PASS EPIC-054"
```

Hermetic coverage required beyond the Proof:

- Migration `15` leaves every added column nullable. The assertion reads the table info and asserts no added column is `NOT NULL`, so the additive rule of `worker.md` section 13 is proven, not described.
- An `accepted` attempt carrying a termination is refused, and a `failed` attempt carrying none is refused. Two cases, so the CHECK is not a null-equivalence rule.
- Each classifier is total over its own union, asserted by iterating the evidence kinds, so a ninth kind fails the test.
- A `worker-reported-failure` classifies `semantic` and a `provider-quota` classifies `infrastructure`, in one case, so the distinction cannot be lost.
- A request body carrying `termination` is refused by the strict transport schema, asserted over the real route. A type-level test does not stand in for this.
- A request body carrying `caller` is refused the same way.
- `convertOnExhaustion` is asserted at `ambiguousUsed = budget - 1`, `= budget` and `> budget`, and at `budget = 0`.
- After a conversion the stored `attempt.termination` is `semantic`, read from the row, not `ambiguous`.
- Two sequential ambiguous endings leave `node.ambiguous_used` at exactly two, and a conditional increment that finds a changed value restarts the classification.
- The ambiguous counter survives the run that produced it. The case ends run one by expiry, opens run two by a new claim, ends it by expiry, and asserts the counter is two.
- Three infrastructure failures under an attempt limit of three leave `exhausted` false. Three semantic failures give true.
- A contended land writes `termination = 'infrastructure'` and leaves `semanticCount` unchanged, in one case.
- Every one of the seven failure paths writes a termination through `end-attempt`. One case each, asserting the stored value.
- `end-attempt` deletes the candidate ref of the attempt it ends, asserted against the loopback fixture by reading the ref after the call.
- `subject` equals `run.worker` and `caller` equals the authenticated principal, for an internal and an external run. Four assertions across two cases.
- A missing `plan-document`, `agents-md` or `role-contract` refuses `authority-input-missing` naming it, and an internal attempt omitting `client-skill` succeeds.
- `renderAuthorityPin` is byte-exact against a literal and refuses a duplicate name by error code.
- The `attempt.show` response key set, computed recursively, deep-equals the allowlist. A substring scan is not sufficient.
