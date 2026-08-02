# Phase 2 — Real work on the happy path

## Goal

`pi-coding-agent` produces real reviewed commits that a human approves, and the work reaches remote origin. Daily use starts here, on a good day.

**Blocker removed:** no real agent is connected, so the capacity of KanthorD is unproven.

**Exit criteria:** Ulrich registers a provider, authors one objective with two tasks, runs it from a second machine over the VPN, reads the attempt record of every task, approves, and sees the work reach remote origin.

## Failure on this path is normal

A reviewer rejects, a verification command fails, a call times out. Phase 2 handles all three, because a real agent meets them on the first day. Phase 3 handles the exceptional path: a crash, a dirty tree, a stale base, a lease race.

The human clears every stuck node by hand in this phase. The daemon recovers nothing by itself.

## Files

| File                                                         | Subject                                                           |
| ------------------------------------------------------------ | ----------------------------------------------------------------- |
| [providers-and-credentials.md](providers-and-credentials.md) | registrations, encryption at rest, per-attempt selection          |
| [instructions-and-profiles.md](instructions-and-profiles.md) | prompt compilation, repository profiles, templates, ambient files |
| [agents-and-workers.md](agents-and-workers.md)               | the `general@1` worker, capability, attempts, inspection          |
| [gates-and-approval.md](gates-and-approval.md)               | the task gate, the objective gate, approval evidence              |
| [integration-and-publish.md](integration-and-publish.md)     | freshness, `mr@1`, publish, reconcile, the journal                |

## Deliverables

- Crypto service. The master key comes from configuration. Every credential is encrypted at rest. No rotation.
- Provider registration on `pi-ai`, with `set_default_at` stamped on the first registration.
- Instruction compiler: the typed channels, the append and override rules, the reduced reviewer render, the per-channel budget, and `kanthord instructions resolve`.
- Profile: the schema, one template, markdown import and export, and the profile hash pinned per objective.
- Ambient channel, with `noContextFiles: true` and the fail-closed assertion.
- `general@1` and `re@1` agents on `pi-coding-agent`, each with its role tool set.
- `general@1` worker, composing the two agents with the reject-and-retry route, wired to the scheduler.
- Scheduler, the single worker loop, and objective leases.
- Verify service, with the operational limits of [gates-and-approval.md](gates-and-approval.md). The per-task diagnostic run is recorded and attributed, and never gates a task.
- Freshness before every objective clone: the fetch, the ancestry classification, the safe fast-forward, and the `needs-reconcile` refusal.
- Candidate freeze, the objective unit check against the frozen candidate, the compare-and-swap merge into the landing branch, the second check against a real merge commit, and `mr@1` with its approval evidence.
- Publish: the API that pushes the landing branch to remote origin against an expected object id, chained on approval by default, with the rejection classification and no automatic retry.
- `kanthord repository reconcile`: the scratch merge, the unit check against the merge commit, and the compare-and-swap landing.
- Attempt accounting, timeout, cancellation and the process-tree kill.
- Inspection: `unblock`, `abandon task`, stale-lease clearing by hand, and the attempt record operation.
- Onboarding CLI: register a repository, register one provider with its default model, create a project, instantiate a profile. Onboarding does not finish without a provider.

## Verification

`npm run verify` stays deterministic, because the fake agent and the fake reviewer arrive here as test doubles:

- Contract tests for the provider adapter against a fake transport: request shape, streaming, tool calls, timeout, cancellation, and a truncated response.
- Crypto tests: round trip; tampered ciphertext fails the authentication tag; a missing master key refuses startup.
- Compiler tests, free of model calls: prose appends across scopes and nothing is lost; a scalar overrides and a list appends; a lint reports two contradictory prose fragments; the `re@1` render omits implementation guidance and keeps the acceptance criteria; a channel over its budget refuses the attempt and names the channel; ambient content cannot set a structured field. Golden fixture prompts per role.
- Ambient tests: a workspace nested under a repository that holds its own `AGENTS.md` inherits nothing; an agent that edits `AGENTS.md` inside its workspace does not change its own later attempts in that objective; a symlinked ambient file is refused.
- Worker tests on the fakes: an accept reaches `done`; a rejection routes back and increments the counter; the third rejection moves the task to `blocked` with reason `attempt-limit`; every attempt row holds the registration and the provider_model it used.
- Check tests: the unit check runs against the frozen candidate and not before it; a per-task diagnostic failure is recorded and attributed to that task, and the task still reaches `done`; a check declared as a command that cannot fail is rejected.
- Verify service tests: a command over its timeout is killed with its process tree, and a test server it started does not survive.
- Freshness tests: upstream ahead fast-forwards the landing branch; the landing branch ahead clones unchanged; a divergence refuses the clone and moves the repository to `needs-reconcile`.
- Integration tests: a fast-forward keeps the candidate check result; a real merge commit reruns the check against that merge commit before the ref moves.
- Publish tests: a push carries the expected object id and never forces; a stale `landingOid` is refused; a policy rejection is reported verbatim and triggers no fetch or merge.

## End-to-end scenarios

The convention, the modes and the evidence format are in [../README.md](../README.md).

### P2-E1 — An objective from import to remote origin

- **Mode:** `deterministic`
- **Why it exists:** this is the whole product loop, and every piece of it is unit tested in isolation against a different boundary.
- **Automation:** `scripts/e2e/run.mjs P2-E1`
- **Human action:** none. The scripted reviewer accepts, and the runner calls the approval endpoint.
- **Oracle:**
  - Two task commits exist on the objective workspace, each attributed to a run and an attempt.
  - The unit check result is recorded against the frozen candidate object id, and the approval evidence names that same object id.
  - The landing branch moved from the recorded base to the recorded head.
  - The fixture remote contains the landed commit, and the `publish` journal row is complete.
- **Evidence:** the object id chain from task commit to remote ref, plus the approval evidence document.

### P2-E2 — A task that cannot pass parks, and stays diagnosable

- **Mode:** `deterministic`
- **Why it exists:** a real agent parks tasks on the first day, and a parked task the human cannot diagnose from another machine ends daily use.
- **Automation:** `scripts/e2e/run.mjs P2-E2`
- **Human action:** none
- **Oracle:** the scripted reviewer rejects every attempt. The task reaches `blocked` with reason `attempt-limit` after exactly 3 attempts. The attempt record returns 3 entries, each holding the rendered prompt with per-block provenance, the tool trace, the verification output and the reviewer reason per criterion. `abandon task` then returns the task to `pending` and the earlier task commits survive.
- **Evidence:** the attempt record, with credentials redacted.

### P2-E3 — Freshness, divergence and publish safety

- **Mode:** `deterministic`
- **Why it exists:** remote origin is shared, so it moves under the daemon constantly, and an unsafe answer either loses work or publishes something nobody reviewed.
- **Automation:** `scripts/e2e/run.mjs P2-E3`
- **Human action:** none
- **Oracle:**
  - Upstream advances on the fixture remote. The next objective clone starts from the new tip, and the landing branch fast-forwarded.
  - The landing branch then holds an unpublished commit and upstream advances again. The next clone is refused, the repository reports `needs-reconcile` with both object ids, and the objective stays `ready`.
  - `kanthord repository reconcile` runs the unit check against the merge commit and lands it. The clone then succeeds.
  - A publish carrying a `landingOid` that no longer matches is refused and pushes nothing.
  - A non-fast-forward rejection reports the ancestry, and the remote ref is unchanged.
- **Evidence:** the ancestry classification at each step, with object ids.

### P2-E4 — Real work, judged by a hidden oracle

- **Mode:** `live`
- **Why it exists:** the phase blocker is that KanthorD's capacity to do real work is unproven, and a commit existing proves plumbing rather than work.
- **Automation:** `KANTHORD_E2E_LIVE=1 scripts/e2e/run.mjs P2-E4`
- **Human action:** none
- **Oracle:** the disposable fixture repository holds a black-box test the agent never sees, and the task asks for the behaviour that test checks. At the landed object id, the hidden test passes. The expected ref moved. The approval evidence and the `re@1` verdict name that same object id. The fixture remote holds the commit.
- **Bounds:** a fixed maximum of attempts and provider calls, a per-call token cap, a wall-clock timeout, and no automatic rerun. A failure is evidence about that run, not automatically a regression.
- **Evidence:** the provider, the model, the usage, the prompt hashes, the run and attempt ids, and the hidden test output.

### P2-E5 — A real run driven over the VPN

- **Mode:** `deployment`
- **Why it exists:** the exit criterion is a human approving real work from a second machine, and neither the local nor the live scenario proves that path.
- **Automation:** `KANTHORD_E2E_LIVE=1 scripts/e2e/run.mjs P2-E5 --daemon-host <a> --client-host <b>`
- **Human action:** the procedure asks for one confirmation before the approval, because this run reaches a real remote.
- **Oracle:** P2-E4 runs with the CLI on the client host. The attempt record is retrieved from the client host and is complete. The approval and the publish are issued from the client host.
- **Evidence:** as P2-E4, plus both host identities and the confirming human.
