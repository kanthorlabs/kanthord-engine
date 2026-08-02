# Execution

Reviewer: runtime or backend engineer. Conventions are [README.md](README.md). The decisions are `../phase-2/agents-and-workers.md` and `../phase-2/gates-and-approval.md`.

Starting work, stopping it, and reading what an attempt did. These are the routes P1-E1 asserts answer `not-implemented`.

## Routes

| operationId     | Method and path            | introducedIn | status  | Source                                    |
| --------------- | -------------------------- | ------------ | ------- | ----------------------------------------- |
| `run.start`     | `POST /v1/project/:id/run` | phase-2      | stubbed | P1-E1, `kanthord run`                     |
| `run.cancel`    | `POST /v1/run/:id/cancel`  | phase-2      | stubbed | agents-and-workers.md, cancellation       |
| `run.list`      | `GET /v1/run`              | phase-2      | stubbed | domain.md, `run` table                    |
| `run.show`      | `GET /v1/run/:id`          | phase-2      | stubbed | domain.md, `run` table                    |
| `node.attempts` | `GET /v1/node/:id/attempt` | phase-2      | stubbed | P2-E2, "the attempt record"               |
| `attempt.show`  | `GET /v1/attempt/:id`      | phase-2      | stubbed | agents-and-workers.md, inspection         |
| `node.checks`   | `GET /v1/node/:id/check`   | phase-2      | stubbed | gates-and-approval.md, diagnostic results |
| `worker.list`   | `GET /v1/worker`           | phase-2      | stubbed | domain.md, worker kinds                   |

## `run.start`

Starts a scheduler pass over the project. The daemon runs one worker loop, and concurrency between objectives is deferred, so a second call while a run is active returns `409 lease-held` and names the run.

In phase 1 this route returns `501 not-implemented` and writes no state. P1-E1 asserts `status` is unchanged after the call.

## `run.cancel`

Cancels the run and kills the process tree of the agent, so a test server a command started cannot survive. The node returns to the state the recovery rules give it.

## `node.attempts`

The inspection operation of `../phase-2/agents-and-workers.md`. A blocked task is diagnosed from here, never from the workspace, because the human runs the CLI on another machine and cannot open the clone.

### Scope

The route returns the attempts of the **active task run** by default. `?run=<runId>` selects an earlier one, and `run.list` enumerates them.

A node can hold several task runs: `abandon task` ends a run and a later execution opens a new one, and `../database/run.md` keeps the old row as history. Without a default scope, P2-E2's "exactly three entries" would stop being true the first time a human abandoned and reran, and the oracle would drift from the route.

### Shape

An attempt and a model call are two levels now. `../database/agent_invocation.md` splits them, because one attempt of the `general@1` worker is two calls: the implementer, then `re@1`.

The attempt carries what the try pinned:

- the attempt number, which is what the `attempt-limit` block counts,
- the pinned registration and provider model,
- the timeout,
- the base and head object ids, which attribute its commits,
- the outcome: `accepted`, `rejected`, `failed`, `timed-out` or `cancelled`.

Each invocation under it carries what one call did:

- the agent role and the adapter version,
- the rendered prompt, the tool definitions, the tool trace and the diff, each as a blob hash,
- `sources` — the per-channel provenance, byte counts, budget and dropped channels,
- the `re@1` verdict and its reason per criterion, on a reviewer call only,
- the reported token usage, and the error detail when the call failed.

The large payloads are hashes. `blob.show` serves them, so a client that wants a verdict does not download three rendered prompts to find it.

Credentials are redacted. P2-E2 asserts the redaction and asserts exactly three attempts after an attempt-limit block.

`attempt.show` returns one attempt with its invocations. There is no separate invocations route: the calls of one attempt are two rows of hashes, and a subresource would be a round trip that buys nothing.

## `node.checks`

Returns every check result attributed to the node: the per-task diagnostic runs, and for an objective the unit check against the frozen candidate and against the merge commit. Each result holds the subject kind, the commit id, the check name, the command, the working directory, the sanitized environment identity, the toolchain version, the timeout, the explicit result, the exit status, the pinned profile hash, the convention version, and the captured output as a blob hash.

`result` is explicit and never inferred from the exit status. `running`, `passed`, `failed`, `error`, `timed-out`, `cancelled` and `not-applicable` are seven different facts, and a killed command has no exit code at all.

`authoritative` says whether the result gated anything. A per-task diagnostic is `false`: it is recorded and attributed, and a task still reaches `done` with a failed diagnostic, because `re@1` is the task gate.

`invalidatedAt` is set when the subject stopped existing — a recompute discarded the merge commit the result ran against. The result against a frozen candidate is never invalidated, because a candidate is immutable.

A `profile-gate` result belongs to no node. `profile.verify` returns those directly.

## `run.list`

Filters are `node`, `kind` and `parentRun`. A run is `objective` or `task`, and a task run names the objective run that scheduled it, so one filter walks an objective's task history.

Each row carries the worker kind that actually resolved at execution time, the lease fence that authorized the epoch, the attempt limit in force, the base and head object ids, and the outcome. The worker is the resolved value, not the current default, so a later edit to a project default does not rewrite history.

## `worker.list`

Returns the worker kinds the daemon implements, with the agents each one composes. The MVP returns `general@1` only. It is a query, so a client can tell a valid `worker` frontmatter value from a rejected one before it imports a plan.

## Leases have no route

A lease appears as a field of a node and of a run: the owner, the expiry, and whether it is stale. A separate lease collection would be an internal table promoted to a public resource, and nothing in the proposal asks a human to read one directly. `system.status` reports the stale ones.
