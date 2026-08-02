# Agents and workers

Reviewer: AI engineer. Phase 2. What an agent is told is `instructions-and-profiles.md`. This file is what runs it.

## An agent is a dedicated unit

An agent holds a role contract and a tool set defined in code. It runs alone, or a worker kind composes it with others. Agents are `general@1`, `swe@1`, `te@1` and `re@1`.

A worker kind executes one objective under a lease. Kinds are `general@1`, `tdd@1` and `git@1`. Worker binding precedence is project, then graph, then node. The most specific binding wins. An objective binds one repository, so a node-level binding changes the worker kind only.

## The MVP ships the `general@1` worker

It composes the `general@1` agent and `re@1`:

1. The `general@1` agent does the task.
2. `re@1` reviews the diff against the `## Acceptance criteria` section of the task body.
3. An acceptance reaches the task gate of `gates-and-approval.md`.
4. A rejection routes back to the `general@1` agent for another attempt.
5. The attempt limit ends the task in `blocked` with reason `attempt-limit`. The default limit is 3, from configuration.

`re@1` is not a component of `tdd@1`. It is the task gate for every worker kind, and it ships here.

## Capability

Capability is enforced in the agent implementation, never in profile data or prose. Each role receives a tool set defined in code: `re@1` gets read-only tools, `te@1` writes tests, `swe@1` writes code, `git@1` uses no model at all. A profile cannot widen a tool set, because it holds no field that names one. An instruction such as "do not access the network" is guidance to a model, not a control, and the daemon never depends on one.

## Attempt accounting

Each rejection increments the attempt counter. Each attempt records the pinned registration and provider_model, the rendered messages, every source blob by content address, the adapter version and the tool definitions. See `instructions-and-profiles.md`.

## Timeout and cancellation

An agent run carries a timeout. Cancellation kills the process tree, so a subprocess an agent started cannot survive it.

## Inspection

A blocked task is diagnosed from its attempt record, not from the workspace. The human may run the daemon on another machine and cannot open the clone, so one operation returns, for a node: the rendered prompt with per-block provenance, the tool trace, the diff, the verification output, the `re@1` reason per criterion, and the provider and model, for every attempt.

`unblock` and `abandon task` are the manual controls. The daemon recovers nothing by itself in this phase. `status` reports a `running` node whose lease expired as stale, and `abandon task` accepts it, resets the workspace to the recorded base and returns the task to `pending`. `abandon task` on a live lease is refused. Phase 3 replaces this with startup reconciliation and the `dirty-recovery` block.

## Deferred: `tdd@1` and `git@1`

`tdd@1` is a worker strategy, not an agent. It drives `te@1`, `swe@1` and `re@1`. `git@1` runs a declared git operation and needs no model; the undo node uses it. KanthorD redesigns the loop of `.claude/commands/*`: it keeps the TDD intent and the review gate, and it does not keep the role sequence.
