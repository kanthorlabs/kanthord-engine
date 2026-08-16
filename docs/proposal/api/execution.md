# Execution

Reviewer: runtime or backend engineer. Conventions are [README.md](README.md). The decisions are `../phase-2/agents-and-workers.md` and `../phase-2/gates-and-approval.md`.

Starting work, stopping it, and reading what an attempt did. These are the routes P1-E1 asserts answer `not-implemented`.

## Routes

| operationId      | Method and path               | introducedIn | status  | Source                                      |
| ---------------- | ----------------------------- | ------------ | ------- | ------------------------------------------- |
| `run.start`      | `POST /v1/project/:id/run`    | phase-2      | stubbed | P1-E1, `kanthord run`                       |
| `run.cancel`     | `POST /v1/run/:id/cancel`     | phase-2      | stubbed | agents-and-workers.md, cancellation         |
| `run.list`       | `GET /v1/run`                 | phase-2      | stubbed | domain.md, `run` table                      |
| `run.show`       | `GET /v1/run/:id`             | phase-2      | stubbed | domain.md, `run` table                      |
| `node.attempts`  | `GET /v1/node/:id/attempt`    | phase-2      | stubbed | P2-E2, "the attempt record"                 |
| `attempt.show`   | `GET /v1/attempt/:id`         | phase-2      | stubbed | agents-and-workers.md, inspection           |
| `node.checks`    | `GET /v1/node/:id/check`      | phase-2      | stubbed | gates-and-approval.md, diagnostic results   |
| `worker.list`    | `GET /v1/worker`              | phase-2      | stubbed | domain.md, worker kinds                     |
| `node.claim`     | `POST /v1/node/:id/claim`     | phase-1      | routed  | `013-external-drive-overview.md`, the claim |
| `node.heartbeat` | `POST /v1/node/:id/heartbeat` | phase-1      | routed  | `013-external-drive-overview.md`, the claim |
| `node.release`   | `POST /v1/node/:id/release`   | phase-1      | routed  | `013-external-drive-overview.md`, the claim |

## `run.start`

Starts a scheduler pass over the project. The daemon runs one worker loop, and concurrency between objectives is deferred, so a second call while a run is active returns `409 lease-held` and names the run.

In phase 1 this route returns `501 not-implemented` and writes no state. P1-E1 asserts `status` is unchanged after the call.

## `run.cancel`

Cancels the run and kills the process tree of the agent, so a test server a command started cannot survive. The node returns to the state the recovery rules give it.

## `node.attempts`

The inspection operation of `../phase-2/agents-and-workers.md`. A blocked task is diagnosed from here, never from the workspace, because the human runs the CLI on another machine and cannot open the clone.

### Scope

The route returns the attempts of the **active task run** by default, and of the newest ended task run when no run is active. A blocked task holds no active run, and P2-E2 reads exactly that record. A task that never ran answers with an empty attempt list and a null run. `?run=<runId>` selects an earlier one, and `run.list` enumerates them.

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

Credentials are redacted before the evidence is stored, so a payload served inline and a payload served through `blob.show` are both clean. A hash of secret-bearing bytes is indirection, not redaction. P2-E2 asserts the redaction and asserts exactly three attempts after an attempt-limit block.

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

A lease appears as a field of a node and of a run: the owner, the expiry, and whether it is stale. A separate lease collection would be an internal table promoted to a public resource, and nothing in the proposal asks a human to read one directly. `system.status` reports the stale ones. the lease is still not addressable, and a claim, a heartbeat and a release are actions on the node, spelled `POST /v1/node/:id/claim`, `POST /v1/node/:id/heartbeat` and `POST /v1/node/:id/release`.

## The objective scope of a claim

An external claim holds the objective. A task claim holds the objective and the task. Two actors never hold two sibling tasks of one objective.

## node.claim

Claims a node for the authenticated actor. The request body is empty: the TTL is configuration and the owner is the authenticated actor. The response carries the task lease, the objective lease, the task run id and the objective run id, the open attempt id and number, the heartbeat interval and the node view. An objective claim opens no attempt, so `attemptId` and `attemptNo` are null.

The refusals are `404 not-found` for an unknown node, `400 invalid-request` with `refusal: "initiative-not-claimable"` for an initiative, `422 plan-invalid` with the completeness findings, `409 illegal-transition` for a drive-mode pin, a node state that is not claimable or an ancestor that is not startable, and `409 lease-held` when another actor holds the objective, the task or a sibling.

## node.heartbeat

The request body is `{ fence }`, the fence the claim returned. The response carries the renewed task lease, the renewed objective lease and the heartbeat interval. The refusals are `404 not-found` for an unknown node, `400 invalid-request` with `refusal: "initiative-not-claimable"` for an initiative, and `409 lease-held` for a stale fence, another owner, or an absent, free or expired objective lease.

A claim and every heartbeat each write `expires_at = now + leaseTtlMs`, so expiry measures from the latest renewal. `heartbeatIntervalMs` is `Math.floor(leaseTtlMs / 3)`, `100000` under the default, and the claim response and every heartbeat response carry it, so the harness never guesses. The harness adds uniform jitter of at most ten percent of that interval, so a fleet does not synchronise.

On a request timeout or a network partition the harness retries at the same interval, and it stops all work once `leaseTtlMs` has passed since its last successful heartbeat. On `409 lease-held` the harness stops at once, because the claim is gone, and it reports nothing. A daemon restart is not an expiry: the `lease` row is durable, so a heartbeat with a live fence still succeeds.

Every heartbeat carries a fresh `Idempotency-Key`, minted per request, because a repeated key replays the captured body from `src/http/server/idempotency.ts` and would hand the harness an old `expiresAt` while the real lease expires.

EPIC 019 must refuse every report that carries an owner or a fence other than the current live pair, with `409 lease-held`. That refusal is lease safety, and this epic states the requirement. Recovery recovers the claim and never the in-flight work: kanthord cannot inspect, reset or kill a harness process tree, so the old harness may still edit and commit. The protocol rule and that fence check are the whole protection.

## node.release

Gives a claim back. The request body is `{ fence }`, the fence the claim returned. The response carries the node view. A task release frees the task lease only, closes the open attempt and returns the task to the pool; the objective lease stays held and the objective run stays active. An objective release frees the objective lease and ends the objective run, and it is refused while any task lease under it is live.

The refusals are `404 not-found` for an unknown node, `400 invalid-request` with `refusal: "initiative-not-claimable"` for an initiative, `409 lease-held` for a stale fence or a live task lease under a released objective, and `409 illegal-transition` when the node is not in a releasable condition.
