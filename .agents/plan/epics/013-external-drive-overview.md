# Phase 1b — external drive, epic overview

Status: **draft**. The Stories lists are agreed. Each Verification Gate is finalised just before `/author` runs on it.

Source: `docs/proposal/phase-1/`, `docs/proposal/api/`, `docs/proposal/database/`.

## Goal

A harness agent — Claude Code, Codex, or any HTTP client — reads the work, claims a task, reports what it did, and edits the graph. kanthord tracks the work. The harness does the work.

Phase 1 closed with a human driving the daemon. This block adds the second driver. Every phase-1 route and every phase-1 token keeps working, and no phase-1 capability is withdrawn.

**It does change five phase-1 behaviours, and each change is deliberate.** An earlier draft of this file claimed the block changed none, and that claim was false.

| Change                                                                                          | Epic          | Why the block needs it                                                         |
| ----------------------------------------------------------------------------------------------- | ------------- | ------------------------------------------------------------------------------ |
| A human event names the resolved actor rather than a configured name, and the actor kinds widen | 015           | Two harnesses that share one actor name are indistinguishable in the audit log |
| An imported plan holds a `ready` frontier, and import appends `node.ready` events               | 016           | Nothing was claimable, because no code applied readiness                       |
| Import accepts an incomplete graph and reports the finding instead of refusing                  | 017           | A per-node create cannot make a legal first node in an empty project           |
| `plan_revision`, `run`, `attempt` and `lease` each gain a column                                | 015, 017, 018 | An external run holds no workspace, and a per-node write is not an import      |
| `node.unblock` answers a command instead of `501`                                               | 019           | The epic that blocks a task at the attempt limit must route the exit from it   |

The consequence is concrete and it is EPIC 016's to repair: `scripts/e2e/lib/scenario/journey.ts` asserts `tasksAllPending: true`, and `P1-E1`, `P1-E4` and `P1-E5` all call `runJourney`. The regression boundary for this block is an amended phase-1 journey that expects the new frontier, never a replay of the old oracle.

Exit criterion: **two** harness processes on two machines register against one daemon, each receives its own token, and each lists the ready tasks of a project. One claims a task, reports it accepted, and works every sibling task the same way, while the second is refused the same objective and works another. Each harness then attests one combined object id for its objective, and that attestation moves the objective to `awaiting_approval`. A human closes it with the attested object id. A dependent objective becomes `ready`. Every step runs through the real composition root against a daemon in its own network namespace.

Two clients is the exit criterion rather than one, because no phase-1 scenario drives two at once. `scripts/e2e/lib/podman/topology.ts:200-215` already places a client container outside the daemon pod, so the second client is a topology change and not new infrastructure.

**"Two machines" means two network namespaces on one host, and the difference matters.** `P1B-E2` proves two actor identities, two namespaces, one daemon, one genuine in-flight claim race with exactly one winner, and simultaneous leases on different objectives. Everything the container run excludes is exactly the part a real deployment gets wrong: the public host authority, the bearer token in cleartext, the reverse proxy, and getting each token onto its machine. `docs/proposal/phase-3/README.md` owns that as `deployment` mode, and this block does not close it. A green `P1B-E2` is evidence that the logic holds, never that the deployment does.

## The decisions this block rests on

Each one was taken before authoring. An epic implements it and never revisits it.

| Decision                                                                     | Consequence                                                                                                                                            |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| A harness runs **beside** the phase-2 worker, and one lease model arbitrates | EPIC 018 owns the lease and the hierarchy rule. `110-scheduler-leases-and-the-general-worker` consumes it rather than defining its own.                |
| A harness **reports an outcome**, and the daemon applies the transition      | No route accepts a state field. `api/graph.md:9` stays true.                                                                                           |
| A write is **per node**, guarded by a revision token                         | Two harnesses editing two tasks never collide.                                                                                                         |
| An actor **registers** and receives its own token                            | `phase-1/transport.md:19` is reversed. Every event names the real actor.                                                                               |
| An objective result is **attested**, and it is never inferred                | EPIC 019's `reportObjective` is the only writer of objective `running → awaiting_approval`. Aggregation computes a projection and transitions nothing. |
| An objective's drive mode is **pinned at its first claim**                   | EPIC 014 holds the pin as contract data. EPIC 018's claim enforces it, and its run reuse refuses an active run of the other driver.                    |
| **One harness per objective**                                                | A task claim takes the objective scope. EPIC 018 acquires the objective lease, then the task lease. Same-owner descendant execution is allowed.        |
| Completeness is enforced **at the claim only**                               | `plan.import` and a per-node write report the finding and commit. EPIC 018 refuses the claim. A structural finding still refuses at every write.       |

## EPIC 014 comes first, and it amends the proposal

`AGENTS.md` makes `docs/proposal/` the source of truth for behaviour, and `000-phase-1-overview.md:58` makes a gap a proposal amendment before it is a story. The external driver is such a gap, and it is not a small one. Five contract statements refuse the exit criterion as written.

| Contract statement                                                                          | Why the external driver breaks it                                                                                                                       |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state-machine.md:80` — an objective reaches `awaiting_approval` on a frozen candidate      | The block freezes no candidate. The harness owns the tree, and it attests the object id.                                                                |
| `state-machine.md:95` — an objective leaves `awaiting_approval` on successful integration   | The block integrates nothing. kanthord never merges.                                                                                                    |
| `state-machine.md:78` — a task moves `running → ready` only on clean expired-lease recovery | An external rejection ends an attempt and returns the task to the pool.                                                                                 |
| `state-machine.md:47` — an objective with no task is invalid, and import rejects it         | A per-node create cannot make a legal first node in an empty project. Completeness moves to the claim, and every write reports the finding and commits. |
| `transport.md:19` — there is no user model, and one token serves one human                  | A harness is a second actor kind, and an event that names the wrong actor is a lie.                                                                     |

014 lands all five in `docs/proposal/` and encodes each one as data in `domain/`. No later epic argues with the matrix; it reads it.

## Order

| #   | Epic                                   | Capability at close                                                                                                                                                                   |
| --- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 014 | External-drive contract and vocabulary | The proposal states the external driver, and `domain/` holds it as data.                                                                                                              |
| 015 | Actor identity and authorization       | A harness holds its own token. An operation declares who may call it.                                                                                                                 |
| 016 | Readiness applied                      | An imported plan holds a `ready` frontier instead of every node in `pending`.                                                                                                         |
| 017 | Per-node graph write                   | A node is created, updated and deleted one at a time, and the plan still exports byte-identical.                                                                                      |
| 018 | Claim, lease and the execution record  | A harness holds a task exclusively, with a fence, an expiry and a persisted attempt.                                                                                                  |
| 019 | Outcome report and aggregation         | A reported outcome moves the task and counts the attempt. An attestation moves the objective, and a human closes it. A human returns a task blocked at the attempt limit to the pool. |
| 020 | Wiring, CLI and the scenarios          | The composition root is complete, the CLI carries every command, and P1B-E1 runs.                                                                                                     |
| 021 | Provider contract and default transfer | `provider.register` declares its payload, every published example is validated, and a human moves the llm default.                                                                    |
| 022 | Project-scoped graph read              | One project's nodes and one atomic topology snapshot are readable without reading every other project.                                                                                |
| 023 | Version compatibility policy           | The daemon states which client versions it serves, and a client reads that answer instead of guessing.                                                                                |
| 024 | Release-bound contract publish         | The published contract comes from a tagged, clean tree, so a client pins an artifact instead of a local generation result.                                                            |
| 025 | External-drive acceptance run          | The scenarios ran once, in order, and one verdict closes the block.                                                                                                                   |

## Dependencies

```
012 ─> 014 ─> 015 ─> 016 ─┬─> 017 ─────────────┐
                          └─> 018 ─> 019 ──────┴─> 020 ─> 022 ─┐
                                                               ├─> 025
021, 023, 024 ─────────────────────────────────────────────────┘
```

022 needs 020, because it adds one name to two authorization lists that 020 pins.

**021, 023 and 024 depend on nothing in this block, and each one must land before 025.** 021 and 023
add or change `routed` surface, so the acceptance run must certify what the product ships. 024 ships
the mechanism that turns the 025 verdict into a pinnable artifact. Their numbers state a sequence and
not a dependency, so any of the three may land earlier if a client date needs it.

016 comes before 017 and 018 because nothing is claimable until something writes `ready`. Phase 1 defines readiness in `domain/` and no code applies it, so a phase-1 graph holds every node in `pending` for ever. A claim epic on top of that passes every unit test and claims nothing.

017 does not precede 018, and 019 does not depend on 017. A state transition moves no plan revision, so an outcome report and a graph edit are independent. They meet only in 020.

019 depends on 018 rather than the reverse, because the execution record an outcome closes is opened by a claim.

## Why each epic closes on a route

The phase-1 rule holds here: an epic that cannot be driven through a route does not close. Two epics needed moving to satisfy it.

- **016 closes on initial readiness only.** Aggregation from a terminal child has no terminal-child route until 019, so aggregation lands in 019 and not here.
- **018 owns the execution record, not 019.** A claim is what opens a run and an attempt, and an epic that promises a lease and silently invents an attempt table is the defect this ordering exists to prevent.

**Two epics are named exceptions, and there is no third.**

- **014** writes no route, because it ratifies the contract every later epic reads. It is a contract milestone and it does not close like a vertical epic.
- **024** writes no route, because it is release tooling. It closes on a command — `npm run contract:publish` refusing a dirty tree and refusing an untagged commit — and a command is as drivable as a route. An earlier draft of this file claimed 014 was the only exception, and folding the client's E4 made that claim false.

## A schema change lands with its migration, never before it

`src/services/storage/migration-0002-graph-and-plan.test.ts:207` and `migration-0003-execution-and-journal.test.ts:403` compare the SQL of `docs/proposal/database/` verbatim against the applied migration. So a `docs/proposal/database/` amendment written one epic early turns the phase-1 suite red on the day it lands.

Each database document therefore moves with its migration, and 014 holds none of them.

| Document                           | Owning epic |
| ---------------------------------- | ----------- |
| `event.md`                         | 015         |
| `plan_revision.md`                 | 017         |
| `run.md`, `attempt.md`, `lease.md` | 018         |

014 keeps the amendments that no parity test fences: `state-machine.md`, `transport.md`, `plan-format.md`, `api/README.md` and `api/graph.md`. It also keeps every domain-level schema refinement, and each migration-owning epic writes the matching SQL `CHECK` plus a domain-to-DDL parity assertion. A refinement that lives only in zod is a rule the database does not hold.

## Why 020 exists

The same reason 009 and 011 exist. An epic can close with every unit test green and no working program. 020 owns the seams no vertical epic owns: the composition root asserted complete over every operation this block adds, the CLI inventory parity, and the scenario that drives a real harness loop through the real binary. **020 implements no domain behaviour.** A missing route found in 020 is a defect in the epic that owed it.

## Why 025 exists

011 makes a scenario runnable and 012 runs it. 020 and 025 keep that split. A block can hold green scenarios and no decision.

## Why 021 to 024 are in this block

The client of `kanthord-apps` records what it needs from the daemon in `docs/api/blockers.md`. Four of
those asks are open engine work, and each one is a defect or a gap on a surface that already ships.
None of them drives external execution, so **the block's exit criterion does not cover them** and
they widen its scope. That cost is accepted, because the alternative is a second block for four
epics.

| Ask | Epic | What is wrong today                                                                                                              |
| --- | ---- | -------------------------------------------------------------------------------------------------------------------------------- |
| E9  | 021  | `provider.register` declares `payload` as `z.unknown()`, and the published example is invalid against the daemon's own validator |
| D1  | 022  | A project screen reads every node of every project                                                                               |
| E6  | 023  | Nothing states which client and daemon versions pair, so the client guesses                                                      |
| E4  | 024  | `scripts/publish-contract.ts` publishes a dirty working tree and records `dirty: true`                                           |

Three of the four sit after 020 for one reason each. 021 and 022 add `routed` surface, so 025 must
certify them and 020 must have pinned the authorization lists they extend. 023 changes a response
schema that 025 exercises. 024 is different: it ships the mechanism that turns the 025 verdict into a
pinnable artifact, so it lands before the run and the publish itself executes from the accepted tag
after it.

E5 of the same file — a daemon-side `wait` on `event.list` — is **not** in this block. Interval
polling is already correct, the exit criterion does not need it, and it is the first route that would
hold a connection open. `.agents/plan/epics/028-event-long-poll.md` owns it, after the block closes.

## What this block does not do

- **No integration and no git.** The harness owns its working tree, its branches and its merges. kanthord records the object id the harness reports and never produces one. `api/integration.md` stays phase 2.
- **No candidate and no automated gate.** An externally driven objective carries the attested object id in place of a frozen candidate, and a human is the gate. `phase-2/gates-and-approval.md` stays phase 2.
- **No scheduler.** 016 applies readiness inside the transaction of the write that changed it. Nothing runs on a timer, nothing holds a queue, and no background loop exists.
- **No `re@1` and no verify.** The harness attests its own outcome. The daemon records who attested it.
- **No agent role binding.** `agent.list`, `instructions.resolve` and every `profile.*` route stay `501`.
- **No new recovery sweep.** `src/commands/startup/recover-expired-leases.ts` already exists and already sweeps. 018 adapts it for a lease with no daemon workspace rather than adding a second mechanism, because an external claim would otherwise reach `dirty-recovery` on the first daemon restart.

## The deployment this block targets

One daemon on a host, and two or more harness machines that reach it. The audit of the phase-1 code found the transport ready for it and found four things a deployment must satisfy. None of them is new code in this block, and each is stated here so no epic assumes it away.

- **`http.allowedHosts` must name the exact authority each client sends.** `src/services/config/convict.ts:167-171` has no usable default, and `kanthord config generate` writes the two loopback entries only. A client reaching a public name gets `403 host-forbidden`, because `src/http/server/host.ts:20` matches the string including the port. `scripts/e2e/lib/scenario/p1-e4.ts:188-205` already asserts that refusal.
- **The daemon terminates no TLS**, per `docs/proposal/phase-1/transport.md:29`. A bearer token, a git credential and an ssh private key each travel in cleartext. The deployment supplies a private network, or a TLS reverse proxy in front of a loopback bind. This block adds no certificate handling.
- **`kanthord db migrate` runs on the daemon host.** `src/cli/options.ts:118-128` refuses a non-loopback base URL, and `docs/proposal/api/system.md:46` gives the reason. Every other command is remote.
- **A non-loopback bind needs a token**, per `src/services/config/refusals.ts:70-77`. That is already the `P1-E4` configuration.

Two properties of the existing daemon make the block's concurrency safe rather than lucky, and an epic may rely on both. `src/services/storage/connection.ts:90-101` refuses asynchronous work inside a transaction and `node:sqlite` is synchronous, so two transactions never interleave in one process. And `src/http/server/origin.ts:18-22` skips a request with no `Origin` header, so the browser defences never touch a CLI client.

### Two deployment rules belong to a runbook, and to no epic

**The daemon does not classify the network, and it must not pretend to.** A refusal of every bind address outside RFC1918, CGNAT, link-local and unique-local was considered and rejected. Private addressing does not prove privacy — NAT, a routing table, a firewall rule and a published port decide exposure — and a WireGuard or cloud VPN legitimately uses globally routable IPv6. Such a check would block real deployments while admitting a private address exposed by a port forward, which is the worst pair of outcomes. `src/services/config/refusals.ts:70-77` establishes only that a remote bind carries a token, and that is all it can establish.

The runbook therefore carries what the daemon cannot: the client path is confidential and integrity-protected end to end; the daemon binds the VPN interface address rather than a wildcard; the host firewall admits the port only through that interface and only from intended peers; the port is not forwarded or published elsewhere; the configured authority resolves to the VPN address and appears exactly in `http.allowedHosts`; every token file is mode 0600; and the deployment is verified by one successful request through the VPN and one refused request from outside it.

**A migration runs on the daemon host, and that stays true.** `src/cli/options.ts:118-128` refuses a non-loopback base URL for `db migrate`, and an authenticated migration route was considered and rejected: it is unreachable exactly when it is needed, because the daemon refuses to listen against an unapplied migration, and it would turn a bearer token into a database-administration credential. The procedure is stop, back up, migrate on the host, start, then confirm with a remote `kanthord db status`. Losing availability during an upgrade is the accepted cost, and it is preferable to a remote schema mutation.

## The obligations this block creates elsewhere

- `110-scheduler-leases-and-the-general-worker` was authored against a lease that did not exist. It must consume the lease service of EPIC 018, including the hierarchy rule, rather than define one. **It changes in more than the lease.** Its `run` and `attempt` writes must set `driver: internal`, and any uniqueness it declares over an active run must carry a driver predicate, or one long-lived external objective blocks the internal worker daemon-wide.
- `112-objective-gate-and-mr` owns the internally driven objective close. 019 owns the externally driven one. Both read the same amended matrix, and neither branches on the other.
- `114-onboarding-cli` gains the actor commands of 015 in its inventory.

**"Nothing else in `100` to `116` changes" was written before the block was authored, and it is false.** Seven phase-2 epics now conflict with what this block builds. Each one is a planning defect in the phase-2 file, and each is repaired there before that epic runs. None of them is this block's work.

| Phase-2 epic | Conflict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `105`        | Claims migration `0005`, which EPIC 015 now takes. Every later phase-2 migration renumbers with it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `110`        | Declares `ExecutionStore` and `SqliteExecutionStore` with `insertRun` and `activeRun` in the capability EPIC 018 already fills with `Execution`, `SqliteExecution`, `openRun` and `activeRunOfNode`. It also adds a third raw `transitionNode` method to `PlanStore`, which EPIC 016 closed to `mutateGraph` and `setNodeState`. Its own migration number moves twice.                                                                                                                                                                                                                                    |
| `108`        | Claims it implements `SqliteLease` against the old interface. EPIC 018 implements it, with `ownerKind`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `101`, `103` | Still bind `settings.actor` into their handlers. EPIC 015 removes that binding, and the actor comes from authentication.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `114`        | Pins CLI totals that this block's eighteen new commands invalidate, and holds no actor command.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `111`        | Claims it moves `node.unblock` from `stubbed` to `routed` and writes its command, its handler and its CLI leaf. EPIC 019 now routes `node.unblock` for the reason `attempt-limit`, because EPIC 019 is the epic that makes a task reach it. EPIC 111 widens the reason set to four, renames `nodeUnblockDetails` to `nodeControlDetails`, and moves five operations rather than six. Its `node.abandon` work is untouched. `110` and `112` each name EPIC 111 as the owner of `node.unblock` in one non-goal sentence, and each takes the same one-clause repair. All three repairs are applied in place. |

Phase 2 cannot be implemented exactly as written after this block. The repair is small in each file and it is not deferred: an epic whose interface this block took must be re-authored before it is worked.

## What this block does not deliver, and who does

The block delivers the backend. It does not deliver a harness, and it does not deliver a public deployment. Both exclusions are decided, not accidental.

**The harness plugin owns the client side.** Nothing here ships an adapter, a skill, a plugin, an MCP server or an instruction package for Claude Code or for Codex. The harness in `P1B-E1` and `P1B-E2` is a scripted scenario helper that calls claim, heartbeat and report with a supplied object id. It writes no code and it is not a coding agent. A real Claude Code or Codex session reaches this daemon through the client-side loop — read a task, do the work, report it — and a separate plugin deliverable owns that loop, the credential handling on the client machine, and the operator experience of pointing an agent at a daemon.

**The network is internal or a VPN, and that is the whole security model.** The daemon terminates no TLS and it will not, per `docs/proposal/phase-1/transport.md:29`. `transport.md:17` states the rule this rests on: a private network is a network boundary, not an authorization boundary, which is why the bearer token exists as well. This block therefore assumes an operator-supplied private path between every client and the daemon, and it proves none of it. A public-internet deployment is `deployment` mode in `docs/proposal/phase-3/README.md` and it stays there.

Naming both here stops either being discovered at the acceptance run.
