# Phase 2 — epic overview

Status: **ready**. The epic list and the goals are agreed. Each epic file is written and finalised just before `/author` runs on it.

Source: `docs/proposal/phase-2/`, `docs/proposal/api/`, `docs/proposal/database/`.

Phase 2 goal: `pi-coding-agent` produces real reviewed commits that a human approves, and the work reaches remote origin.

Exit criterion: Ulrich registers a provider, authors one objective with two tasks, runs it, reads the attempt record of every task, approves, and sees the work reach remote origin.

## What phase 1 already shipped

These are not in scope here, and each is re-run as a regression.

- `services/crypto` with AES-256-GCM, the `masterKeyFile` configuration, the `provider` table with its payload factory, and `provider.register`, `provider.list` and `provider.show` routed.
- The `services/agent`, `services/verify` and `services/lease` interfaces, each with a `not-implemented` implementation.
- The `attempt`, `attempt-accounting`, `candidate`, `check-result`, `run`, `lease`, `worker`, `agent`, `profile` and `git-operation` domain entities.
- The git primitives: the pinned invocation, the url policy, credential delivery, the supervised spawn, the `refUpdate` compare-and-swap, fetch confinement, and the objective clone.
- Every phase-2 operation declared `stubbed` in `src/http/contract/`.

## Order

Capability layers first, then the execution loop, then integration, then the scenarios. An epic must be verifiable when it closes, so a capability that no route can reach does not close.

| #   | Epic                                         | Stories | Capability at close                                                                    |
| --- | -------------------------------------------- | ------- | -------------------------------------------------------------------------------------- |
| 101 | Credential registry completion               | 10      | The registry is complete, and a removal cannot empty a chain in use.                   |
| 102 | Provider transport on `pi-ai`                | 11      | One model call reaches a real provider through a stored registration.                  |
| 103 | Repository profile and templates             | 10      | A repository carries a profile, canonically hashed, with one template.                 |
| 104 | Instruction compiler                         | 10      | A prompt is composed from typed channels, with provenance and a budget refusal.        |
| 105 | Ambient context channel                      | 8       | Ambient text is one untrusted channel, and it sets no structured field.                |
| 106 | Agents on `pi-coding-agent`                  | 15      | `general@1` and `re@1` run under their tool sets and return complete evidence.         |
| 107 | Verify service                               | 6       | A declared check runs under the operational limits and returns its result.             |
| 108 | Freshness and reconciliation                 | 15      | A base is classified before a clone, and a divergence is reconciled by hand.           |
| 109 | Profile verification                         | 9       | `profile verify` runs gate A and gate B, and blocks nothing.                           |
| 110 | Scheduler, leases and the `general@1` worker | 28      | The daemon does work: a run, a lease, an attempt, a review, a retry, a limit.          |
| 111 | Inspection and manual controls               | 20      | A blocked task is diagnosable from another machine, and a stuck node clears by hand.   |
| 112 | The objective gate and `mr@1`                | 22      | An approved objective lands exactly what the human reviewed.                           |
| 113 | Publish                                      | 14      | The landing branch reaches remote origin against an expected object id, or is refused. |
| 114 | Onboarding CLI                               | 13      | A human onboards from nothing, and onboarding does not finish without a provider.      |
| 115 | Phase-2 end-to-end scenarios                 | 17      | P2-E1, P2-E2, P2-E3 and P2-E4 produce evidence bundles.                                |
| 116 | Phase-2 acceptance run                       | 9       | The scenarios ran once, in order, and one verdict closes the phase.                    |

Total: 219 stories.

## Goals

- **101 — Credential registry completion.** `provider.register` stamps `set_default_at` on the first registration, in the same storage transaction as its event. `provider.rename`, `provider.setDefault` and `provider.remove` ship. A removal is refused while a default stamp or a project binding names the registration, and the refusal lists every blocker. A read returns the public projection only. Startup refuses an absent master key, and a key file that is not mode `0600`.
  **101 is closed, and `.agents/plan/epics/021-provider-contract-and-default-transfer.md` amends two of its decisions before phase 2 starts.** `provider.register` gains a per-kind payload schema, and `provider.setDefault` transfers the default instead of refusing `default-already-set`. EPIC 114 reads 021's Open items before it asserts the onboarding sequence.
- **102 — Provider transport on `pi-ai`.** One model call reaches a real provider through a stored `kind = 'llm'` registration, behind a service interface, with a fake transport in every test: request shape, streaming, tool calls, timeout, cancellation, and a truncated response. Transport only. The attempt lifecycle belongs to 110.
- **103 — Repository profile and templates.** A repository carries a `kanthord.profile/v1` profile in SQLite: the frontmatter contract, the role-headed body, canonical hashing, markdown import and export, and the `nodejs` template. A named set of vacuous check commands is rejected at import, and 109 gate B owns the general proof. The per-objective pin belongs to 110.
- **104 — Instruction compiler.** An attempt renders from typed channels, never by concatenation. Precedence resolves before rendering, prose and lists append, a scalar overrides, two contradictory prose fragments are reported by a lint at import, `re@1` renders reduced, a channel over its budget refuses the attempt and names the channel, and `instructions.resolve` prints the composed prompt with per-block provenance. Golden fixture prompts per role.
- **105 — Ambient context channel.** Host files load only when the human switches them on, and the default is off. Only the repository root file is read, from the objective's pinned commit. A symlinked ambient file is refused. Ambient content can never set a structured field. The channel reaches `instructions.resolve`, so the epic closes on a route. The event for a budget drop belongs to 110, because a drop happens inside an attempt and a query writes nothing.
- **106 — Agents on `pi-coding-agent`.** `general@1` and `re@1` run, each under the tool allow list of `agents-and-workers.md`, and `agent.list` closes in EPIC 048. EPIC 106 closes on the adapter: the exclusion computation, the assertion that the session exposes exactly the allow list, and the fail-closed behaviour. Every agent is constructed `noContextFiles: true`, and the adapter asserts the loader reported zero context files. A run carries a timeout, and a cancellation kills the process tree. A run **returns** complete evidence — the rendered messages, every source blob by content address, the tool trace, the diff, the verdict per criterion, the adapter version and the tool definitions — and it persists nothing.
- **107 — Verify service.** A declared check runs inside a workspace under a timeout, a process-tree kill so a started test server cannot survive, an output size cap, and a filtered environment. It **returns** a result carrying the command, the working directory, the environment identity, the toolchain version, the timestamps, the exit status and the captured output. The caller persists it.
- **108 — Freshness and reconciliation.** Every objective clone starts from a classified base: fetch and prune, the ancestry classification of the landing tip against the tracking tip, the safe fast-forward under its own `sync` journal row, and the recorded fetched upstream. A divergence refuses the clone and moves the repository to `needs-reconcile`, transition and event in one storage transaction, while the objective stays `ready`. `repository.reconcile` merges upstream in a scratch workspace, runs the unit check against the resulting merge commit, and lands it by compare-and-swap under its own `merge` journal row. A conflict blocks and names the files.
- **109 — Profile verification.** `profile.verify` runs gate A, which is deterministic and needs no model, and gate B, which runs the check at an exact commit, separates a wrong declaration from a red baseline, and applies the negative control. The report names the gate that failed and the reason. It blocks nothing.
- **110 — Scheduler, leases and the `general@1` worker.** One worker loop executes one objective under a lease, behind `run.start`, `run.cancel`, `run.list` and `run.show`. This epic owns the attempt lifecycle: it resolves and pins one registration and one `provider_model` per attempt, pins the profile hash when the objective workspace is created, persists every attempt evidence record, and writes each state transition with its event in one storage transaction. The last task leaves the objective `running`, because the move to `awaiting_approval` records a candidate and 112 owns that. An acceptance reaches the task gate. A rejection routes back to the `general@1` agent and increments the counter. The third rejection moves the task to `blocked` with reason `attempt-limit`. The per-task diagnostic check is recorded and attributed to that task, and it never gates a task.
- **111 — Inspection and manual controls.** `node.attempts`, `attempt.show`, `node.checks` and `worker.list` return the record a human reads from another machine, with every credential redacted. `node.unblock` and `node.abandon` are the manual controls. `abandon` is refused on a live lease, and on an expired one it resets the workspace to the recorded base and moves the task to `blocked` with reason `abandoned`. `status` reports a `running` node whose lease expired as stale.
- **112 — The objective gate and `mr@1`.** The objective moves to `awaiting_approval`, and that transition records the frozen candidate in the same operation. The unit check runs against a clean checkout of that exact commit. The approval evidence carries the projected outcome, every discarded task with its reason, the diff and the commit list, the check results, the `re@1` verdict per task, the attempt history, and the base and head object ids. The request carries the frozen candidate revision, and `acknowledge_partial` when the projection is `partial`. The merge into the landing branch is a compare-and-swap, a real merge commit is re-checked before the ref moves, and a moved base recomputes rather than blocks. Its own `merge` journal rows bracket every git write.
- **113 — Publish.** `repository.publish` asserts the landing ref equals `landingOid`, then pushes to the publish ref, never with force. An approval carries `publish: true` by default, configurable per repository. A stale `landingOid` is refused and pushes nothing. A non-fast-forward rejection reports the ancestry classification, and a policy rejection is reported verbatim. Neither triggers a fetch, a merge or a retry. The `publish` journal row is complete.
- **114 — Onboarding CLI.** One guided sequence registers a repository, registers one provider with its default model, creates a project, and instantiates the profile. Onboarding does not finish without a provider.
- **115 — Phase-2 end-to-end scenarios.** P2-E1, P2-E2, P2-E3 and P2-E4 run through `scripts/e2e/run.mjs` and write evidence bundles. The fake agent and the fake reviewer arrive as test doubles, so `deterministic` mode stays deterministic. P2-E4 is `live`, bounded by a maximum of attempts and provider calls, a per-call token cap and a wall-clock timeout, and judged by a hidden black-box test the agent never sees.
- **116 — Phase-2 acceptance run.** The scenarios ran once, in order, with the product acceptance a machine cannot check, and one verdict closes the phase or opens a fix epic per blocker. It owns no oracle and invents no scenario.

## Dependencies

```
101 ─> 102 ────────┐
103 ─> 104 ─> 105 ─┴─> 106 ─────────────────────┐
050.6 ─> 107 ─┬─> 108 ──────────────────────────┴─> 110 ─> 111 ─> 112 ─> 113 ─┐
              └─> 109 ───────────────────────────────────────────────────────┤
101, 103 ─> 114 ─────────────────────────────────────────────────────────────┴─> 115 ─> 116
```

- 102 needs 101, because a call resolves a registration and 101 closes the resolution rules.
- 104 needs 103, because the repository profile is one channel and it supplies the `checks` map. 105 needs 104, because the ambient channel is the compiler's last channel and the budget rule decides the drop.
- 106 needs 102, 104 and 105: an agent calls a provider, with a rendered prompt, and with ambient loading disabled.
- 107 needs EPIC 050.6, not 106. EPIC 050.6 extracts the one supervised-run machine out of phase 2 so EPIC 051.2's command gate can consume a working `Verify`, and a second copy of that machine is what the extraction exists to prevent. 107 needs nothing else of 106, and it lands before it.
- 108 needs 107 and 103, because reconciliation runs the unit check against the merge commit, and the `unit` command comes from the repository profile.
- 109 needs 103, 104 and 105 for gate A, because gate A compiles every channel, and 107 for gate B. It needs neither 110 nor a provider account.
- 110 needs 106, 107 and 108: the worker calls the agent, the diagnostic check calls the verify service, and every objective clone starts from a classified base.
- 112 needs 110 for the candidate a run produced, and 107 for the check it runs against that candidate. 113 needs 112, because publish is chained on approval.
- 114 needs 101 and 103 only, so it runs beside the execution work.
- 115 needs every earlier epic, and 116 needs 115.

## Two rules every write epic carries

`AGENTS.md` states both. They are repeated here because 108, 110, 111, 112 and 113 each write, and an epic that closes with a non-atomic transition cannot be repaired by a later sweep.

- **One transaction per transition.** A state transition and its event append sit in one storage transaction. The epic that performs the transition owns that assertion. The transitions are attempt start, failure and completion; task accept, reject and block; run cancel; unblock and abandon; the repository move to `needs-reconcile`; and the objective move to `awaiting_approval` and to its terminal outcome.
- **The journal belongs to the epic that writes git.** Git and SQLite cannot share a transaction, so each git operation runs: persist the intent row, perform the git operation, persist the resulting transition and its event atomically, then mark the row complete. 108 owns its `sync` and `merge` rows, 112 owns its `merge` rows, and 113 owns its `publish` row. The journal covers a durable write to the bare home, which is what the `git_operation` intents of `docs/proposal/phase-2/integration-and-publish.md` name. A mutation inside a disposable objective workspace carries no row, because the workspace is not durable evidence and phase 3 owns its recovery. 110 states that exemption where it commits a task.

## A service returns, and a command persists

106 and 107 are services, and neither writes an attempt row or a check-result row. They return evidence, and 110, 112 and 109 persist it inside their own transactions. The import matrix puts business logic in `commands/`, and an attempt record is the state of a task attempt rather than a fact about a subprocess.

## Decisions taken outside the proposal, then merged into it

| Decision                                                                       | Landed in                                                   |
| ------------------------------------------------------------------------------ | ----------------------------------------------------------- |
| Phase 2 ships one template, `nodejs`, and the human names it                   | `phase-2/instructions-and-profiles.md`, `after-the-mvp.md`  |
| Onboarding template detection is deferred                                      | `phase-2/instructions-and-profiles.md`, `after-the-mvp.md`  |
| `profile verify` ships gate A and gate B in phase 2, and gate C stays deferred | `phase-2/instructions-and-profiles.md`, `phase-2/README.md` |
| The tool set per role is an allow list in code, enumerated per role            | `phase-2/agents-and-workers.md`                             |
| The adapter computes `excludeTools` from the allow list and asserts the result | `phase-2/agents-and-workers.md`, `phase-2/README.md`        |
| P2-E4 must pass for phase 2 to exit                                            | this file, and EPIC 116                                     |

## Deferred out of phase 2, by the proposal

- `tdd@1`, `git@1`, `te@1`, `swe@1`, and agent-level provider binding.
- The ordered provider chain, the chain advance across attempts, and master key rotation.
- Initiative end-to-end detection. An MVP initiative records `not-applicable`.
- `profile verify` gate C, the template library beyond `nodejs`, and onboarding detection.
- `pr@1` and hosted review.
- Startup reconciliation of incomplete journal rows, dirty-tree recovery, and lease races. Those are phase 3.
- Any scenario that crosses the VPN. That is P3-E7.
