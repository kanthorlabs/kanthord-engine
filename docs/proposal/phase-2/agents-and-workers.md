# Agents and workers

Reviewer: AI engineer. Phase 2. What an agent is told is `instructions-and-profiles.md`. This file is what runs it.

## An agent is a dedicated unit

An agent holds a role contract and a tool set defined in code. It runs alone, or a worker kind composes it with others. Agents are `general@1`, `swe@1`, `te@1` and `re@1`.

A worker id matches `^[a-z][a-z0-9-]*@[1-9][0-9]*$`. A dot is forbidden so that a harness cannot be smuggled into a name.

The `composition` set is closed:

- `single` is one execution path driving at most one agent.
- `composed` drives multiple agents.
- `self-managed` is an external harness driving its own agents.

The worker registry is:

| `worker`     | `driver` | `agents` | `claims`            | `deliverables`                     | `harness`     | `composition`  |
| ------------ | -------- | -------- | ------------------- | ---------------------------------- | ------------- | -------------- |
| `claude@1`   | external | `[]`     | `objective`, `task` | `test`, `implementation`, `review` | `claude-code` | `self-managed` |
| `opencode@1` | external | `[]`     | `objective`, `task` | `test`, `implementation`, `review` | `opencode`    | `self-managed` |

Every internal worker, `general@1`, `tdd@1`, `poc@1`, `research@1` and `git@1`, is phase-2 work and is absent from the registry.

## Routing

Routing computes the intersection of three eligible sets. The sets obey `capable ⊇ authorized ⊇ available`.

`capable` is derived from the registry alone. `authorized` is supplied by the caller. `available` is supplied by the caller.

Routing takes the first entry of the intersection in registry declaration order. `initiative` and `expansion` are unroutable until an internal worker is registered in the registry.

An empty intersection answers `unroutable` with `failedSet` naming the first set, in the order `capable`, `authorized`, `available`, whose intersection with the previous sets is empty.

## The four actors

One attempt separates four actors, and no actor borrows another's authority.

1. The model produces untrusted output: messages, tool calls, a diff. It holds no lease, no fence and no credential that reaches the graph.
2. The agent adapter starts the session, captures its lifecycle, and returns the result envelope. It reports nothing to the state machine by itself.
3. The worker owns the attempt. It claims the node, prepares the workspace, renders the instructions, runs the adapter, applies verify and `re@1`, and reports exactly one outcome under the fence it holds.
4. The daemon performs the authoritative transition.

A session environment never contains a token that names `node report`. What keeps the verdict honest is not the absence of a credential but the chain below: the daemon pins what it reviews and runs its own checks. Removing the token from the model prevents unauthorized direct mutation by construction; it does not make misreporting impossible, because a model can still author a misleading diff or a weakening test. That is a verification concern, and `gates-and-approval.md` owns it.

## The result envelope

When a session ends, the adapter returns one immutable envelope: the final message, references into the tool trace, the base and head object ids of the workspace, and the termination reason — completion, timeout, or cancellation. The envelope is the only data path from the model to the worker. Verification and review read the snapshot the envelope names, never the live tree, because a tree that changed after capture proves nothing about what was judged.

## Progress is host-observed

Progress comes from what the host observes, never from what the model volunteers. The adapter watches the SDK stream — messages, tool start and end, elapsed time, cancellation — through in-process callbacks, and forwards what it sees to the attempt record. No reporting path depends on the model choosing to call a tool: `general@1` holds `bash`, so any local endpoint a progress tool could call is equally reachable by every subprocess the model spawns, and a channel that `bash` can reach is not a trust boundary. The renew belongs to the worker process, which holds the run authority; the model cannot renew, hold, or surrender one.

## Model commentary is untrusted

A role may carry an in-process custom tool that appends free-text notes to the attempt record. Every note is stored labelled untrusted, append-only and size-capped. A note drives nothing — not the renew, not the attempt counter, not verification, not a transition. A custom tool joins a role only when this file's allow list names it, and its definition pins into the attempt record with every other tool definition; the fail-closed assertion of `Capability` counts it.

## From envelope to report

An `re@1` acceptance is a judgement about a diff, not a write to the graph. One chain stands between the two, and every step has one owner:

1. The adapter freezes the envelope; the base and head object ids leave the model's reach.
2. Verify runs the objective's diagnostic unit check against that diff and records the output, as `gates-and-approval.md` requires.
3. `re@1` reviews the diff against the acceptance criteria, with the verification output in hand.
4. The worker reads the verdict and reports one outcome through `node report`, idempotent under the lease fence.

Exactly one report ends an attempt, whatever it saw. A crashed adapter leaves no report, and recovery — phase 3 — owns what follows.

## Capability

Capability is enforced in the agent implementation, never in profile data or prose. Each role contract is one record with an agent id, a purpose and `capabilities.tools`.

The full tool set is `read`, `bash`, `edit`, `write`, `grep`, `find` and `ls`.

| `agent`     | `purpose`                                   | `capabilities.tools`                                  |
| ----------- | ------------------------------------------- | ----------------------------------------------------- |
| `general@1` | Does any task end to end.                   | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |
| `swe@1`     | Writes production code. Writes no test.     | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |
| `te@1`      | Writes tests. Writes no production code.    | `read`, `bash`, `edit`, `write`, `grep`, `find`, `ls` |
| `re@1`      | Reviews a diff against acceptance criteria. | `read`, `bash`, `grep`, `find`, `ls`                  |

Role path ownership is not represented. The constraint that `swe@1` and `te@1` differ by paths remains an open gap.

## Harnesses

The harness set is closed:

| `id`          | `denyByDefault` |
| ------------- | --------------- |
| `claude-code` | `true`          |
| `opencode`    | `true`          |
| `pi`          | `false`         |

Generation fails when a harness cannot deny by default.

The `pi-coding-agent` built-ins are `read`, `ls`, `find`, `grep`, `edit`, `write` and `bash`.

The SDK selects tools by exclusion, through `excludeTools`. An exclusion list is not fail-closed: a built-in added by a later SDK version joins every role that did not name it. The adapter therefore computes the exclusion from the allow list, then asserts the constructed session exposes exactly the allow list, and it fails closed on a mismatch. A new built-in stops the daemon rather than reaching `re@1`.

## Attempt accounting

Each rejection increments the attempt counter. Each attempt records the pinned registration and provider_model, the rendered messages, every source blob by content address, the adapter version and the tool definitions. See `instructions-and-profiles.md`.

## Timeout and cancellation

An agent run carries a timeout. Cancellation kills the process tree, so a subprocess an agent started cannot survive it.

## Inspection

A blocked task is diagnosed from its attempt record, not from the workspace. The human may run the daemon on another machine and cannot open the clone, so one operation returns, for a node: the rendered prompt with per-block provenance, the tool trace, the diff, the verification output, the `re@1` reason per criterion, and the provider and model, for every attempt.

`unblock` and `abandon task` are the manual controls. The daemon recovers nothing by itself in this phase. `status` reports a `running` node whose lease expired as stale, and `abandon task` accepts it, resets the workspace to the recorded base and moves the task to `blocked` with reason `abandoned`. `abandon task` on a live lease is refused. Phase 3 replaces this with startup reconciliation and the `dirty-recovery` block.

### Delivery to a working session

The attempt record answers diagnosis after the fact. Delivery while a run executes names its receiver, and correlation between a run and its receiver is by run id:

- A human watching a CLI or TUI subscribes to the event log filtered by run id, or polls it. The CLI is a client of the daemon, so nothing new crosses the transport contract.
- A parent session that handed the task over correlates by run id through a parent-side extension: it awaits the terminal event of the run and injects the summary into its own conversation. The child never writes into a session it cannot name, and a run id passed through model output is untrusted commentary until the receiver matches it against a handoff it made itself.
- An asynchronously scheduled run has no receiver. Durable attempt records are the whole delivery, and notification past them is deferred.

No channel carries a child session's output into a working session without one of these three receivers.
