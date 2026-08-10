# Gates and approval

Reviewer: QA lead, and whoever approves merges. Phase 2. This file defines when work is done and what a human sees before saying yes.

Each level is verified differently. This convention serves coding work. Non-coding work may need a different one, and KanthorD ships no mechanism to select between conventions until a second one exists.

| Level      | Authoritative check                   | Runs against                       |
| ---------- | ------------------------------------- | ---------------------------------- |
| Task       | acceptance criteria, judged by `re@1` | the task diff                      |
| Objective  | the unit check                        | the frozen candidate commit        |
| Initiative | the end-to-end check, as detection    | the integrated repository manifest |

## Task

A task reaches `done` when `re@1` accepts its diff against the `## Acceptance criteria` section of its body. `re@1` returns a reason per criterion. A rejection returns the task to the worker until the attempt limit, then `blocked`.

`re@1` cannot see a missing import or an uncompilable tree, and ten tasks share one working tree, so a defect can compound before any suite runs. KanthorD therefore runs the objective's unit check on each attempt as a **diagnostic**. It runs after the attempt produces its diff and before `re@1` reviews it, because `instructions-and-profiles.md` gives the reviewer the verification output. The result is recorded and attributed to that task, and a failure is visible immediately. It is not authoritative: it does not gate the task, and it never marks a task `done` or `blocked` by itself. A rejected attempt therefore carries its own verification output, which is what makes the attempt record of a blocked task diagnosable.

## Objective

The unit check is authoritative, and it runs against an immutable candidate. The order matters:

1. Create the candidate commit.
2. Run the unit check against a clean checkout of that exact commit.
3. Record the commit id, the profile hash, the command, the environment, the timeout and the result.
4. Merge with compare-and-swap.

A check that ran before the candidate was frozen proves nothing about what merges. If the compare-and-swap fails because the landing branch advanced, and a rebase or a conflict resolution produces a new candidate, the recorded result is invalidated and the check runs again. Otherwise KanthorD would merge code that was never tested.

The merge commit is what lands, and its tree is not the tree of the candidate. When the integration is a fast-forward, the result recorded against the candidate stands. When it creates a merge commit, the check runs again against that exact merge commit before the ref moves. A candidate can pass alone and fail against newer work on the landing branch, and that is the case this rule covers. The same rule governs the reconciliation merge of `integration-and-publish.md`.

## Deferred: Initiative

Initiative end-to-end detection is deferred past the MVP, and an MVP initiative always records `not-applicable`. See `../after-the-mvp.md`. The design below is what it becomes.

The end-to-end check runs after every objective of the initiative has integrated. It is **detection, not a gate**: by the time it runs, the work already reached `main`. A failure moves the initiative to `blocked` with reason `e2e-failed`, and the human authors a repair objective. `main` can stay broken until that repair lands, and attribution across objectives is manual. The design states this rather than calling it verification.

The end-to-end check binds at project level, not in a repository profile. An initiative may span several repositories, so no single objective's profile can supply the command, and choosing one would be arbitrary and order-dependent. The binding names a harness and a repository-to-commit manifest, which is what makes "the initiative passed end to end" mean something precise.

An initiative with no end-to-end binding records `not-applicable`. That appears in the evidence and is never reported as a pass. A library whose end-to-end tests live in a consumer repository, or infrastructure verified in a staging environment, is the normal case for this.

## Declaring the checks

A repository profile declares how to run each check. See `instructions-and-profiles.md`. A check that cannot fail is rejected.

The verify service runs a check inside the workspace with:

- a timeout,
- a process-tree kill, so a test server started by the command cannot survive cancellation,
- an output size cap,
- a filtered environment,
- captured output retained as evidence for `re@1` and for the human.

## What import can and cannot prove

Import validates that the configuration is complete: the profile declares a command for every check the level needs, and an initiative that expects an end-to-end run has a binding. Import cannot prove a check is runnable or meaningful — a command may reference a missing script, select zero tests, or need a service that does not exist yet.

Convention and profile hashes pin into the plan and are recorded on every result, so a later profile edit cannot silently change what "verified" meant for work already done.

## Results are auditable, not deterministic

`re@1` judgement is model-dependent. End-to-end runs depend on timing, network services and shared environments. Orchestration tests stay deterministic through fake runners and fixed verdicts; the judgement itself does not. Every check result therefore records the commit or manifest, the profile hash, the command and working directory, the sanitized environment identity, the toolchain version, the timestamps and timeout, the exit status, the logs, and — for `re@1` — the provider, the model and the prompt inputs.

## Approval is visible on HTTP and CLI

HTTP is the surface. The CLI calls it.

## Approval freezes a candidate

The daemon records a candidate revision when an objective enters `awaiting_approval`. The approval endpoint carries that revision. Any change to the workspace invalidates it, and the human must review again.

## A `partial` outcome needs an explicit acknowledgement

The terminal state is known before integration, because every task is already terminal when the objective enters `awaiting_approval`. The candidate therefore declares the projected outcome, `done` or `partial`, and lists every discarded task with its title and the reason it was discarded.

When the projection is `partial`, the approval request must carry `acknowledge_partial`. The daemon refuses the approval without it and returns the discarded tasks again. A human can never integrate an incomplete objective by accident. The CLI prints the discarded tasks and asks for a second confirmation.

## Approval evidence

The approval endpoint returns, for one objective:

- the projected outcome, `done` or `partial`,
- every discarded task with its reason,
- the diff and the commit list,
- the unit check result against the frozen candidate, and the per-task diagnostic results,
- the `re@1` verdict for every task, with a reason per criterion,
- the attempt history,
- the base and head object ids being approved.

The request carries the frozen candidate revision and, when the projection is `partial`, `acknowledge_partial`.
