# Phase 1 — Bootstrap

## Goal

Every entity, service interface, command and query exists, and a human drives the daemon end to end. No agent is connected.

**Blocker removed:** there is no skeleton to hang work on, and no bare home to work against.

**Exit criteria:** Ulrich onboards his real repository from a second machine over the VPN, imports a two-objective plan, exports it identical, and reads status. Every execution route answers `not-implemented`.

## Files

| File                                           | Subject                                                                      |
| ---------------------------------------------- | ---------------------------------------------------------------------------- |
| [domain.md](domain.md)                         | entities, service layering, storage tables, dependencies                     |
| [../database/README.md](../database/README.md) | every table at column level, one file per table                              |
| [transport.md](transport.md)                   | bind address, bearer token, browser defences, CLI parity                     |
| [plan-format.md](plan-format.md)               | the markdown a human authors, import, export, re-import                      |
| [git-foundation.md](git-foundation.md)         | three repositories, three ref roles, seeding, branch fields, clone mechanics |
| [state-machine.md](state-machine.md)           | states, the aggregation table, task order, rules                             |

## Deliverables

- Config service on convict. It holds the master key, the HTTP bind address, the HTTP token, the `Host` allow list, and the default attempt limit of 3.
- Exclusive lock on the daemon home, taken at startup and held for the life of the process. A second daemon against one home refuses to start and names the holder. This is what makes a local ref write safe, per [git-foundation.md](git-foundation.md).
- Storage service on `node:sqlite`, with migrations, `db status`, and every table of [domain.md](domain.md).
- Domain schemas on zod. Entities, and the states, transitions and block reasons of [state-machine.md](state-machine.md). The state machine is defined and unit tested here. The scheduler that drives it arrives in phase 2.
- Graph service on graphology. Import, validate, export, the `import_id` idempotency key, and the re-import conflict resolution of [plan-format.md](plan-format.md): a binary choice per node, a suggestion per node from `plan.validate`, and a candidate graph validated as a whole before anything is applied.
- Crypto service on the master key, and the three provider routes phase 1 needs for the git credential of `repository.register`. See [../api/credential.md](../api/credential.md).
- Event log.
- Git service on isomorphic-git: bare home creation from a remote origin URL, the three ref roles, and the three branch fields of [git-foundation.md](git-foundation.md). `git clone --bare` is forbidden, and the fetch refspec confines remote updates to `refs/remotes/origin/*`.
- HTTP surface on koa, with the bind address, the bearer token, the `Origin` rejection and the `Host` allow list of [transport.md](transport.md). Every command and query is routed. An execution route returns `not-implemented`.
- CLI on commander, calling the HTTP API. `db`, `plan import`, `plan export`, `status`, and the declared execution commands. The CLI carries a base URL and a token, so it runs on a different machine.

## Verification

`npm run verify` holds the permutations, on `node:test` with supertest and a fixture remote in a temporary directory, served over git smart HTTP on a loopback port, because `isomorphic-git` has no transport that reads a local path as a remote:

- Migration: `db status` reports the applied migrations on a new file, and reports no change on a second run.
- Import: a two-objective plan imports, exports byte-identical to the accepted documents, and re-imports from the same revision. A re-import from a stale revision is rejected. A retry of a committed `import_id` returns the original revision and writes no second revision, and a reordered document array is still a retry. Path-based dependencies resolve to minted identities. Export carries no status field.
- Validation: an objective with no task, an initiative with no objective, and a cycle are each rejected. One document that holds three faults returns three findings, not one.
- Choices: a missing choice and an extra choice are each refused. A choice of `submitted` on a structural edit is refused at every state except `pending` and `blocked`, and accepted at those two. A choice of `submitted` on a prose edit is accepted at every state, including `discarded`. Two individually legal choices that build a cycle are refused as one candidate graph, and the suggestion set for that same input is never the combination that gets refused. Topology that moved since validation returns `choices-stale`, and a selected outcome that runtime state invalidated returns `choices-changed`. Each writes nothing.
- Transport: a request with no token is refused. A request with a wrong token is refused, and the comparison is constant time. A request that carries an `Origin` header is refused. A `Host` outside the allow list is refused.
- Bare home: registration against a fixture remote produces `refs/remotes/origin/*` and one landing branch at the detected default. An `ssh://` url is refused at registration. A plain HTTP url is accepted on a loopback host and refused elsewhere.
- Preflight: registration proves the credential with a `git-receive-pack` advertisement. A wrong token and a missing token each fail with `auth-failed` and write no row. A read-only credential on a public repository fails the same way, because a fetch would have passed.
- Home lock: a second daemon against one home refuses to start. A killed daemon leaves the lock released, and the next start takes it.
- Ref write: a `refUpdate` against a stale expected oid aborts and returns the observed oid. A `*.lock` file left in a bare home is removed at startup, and never by a running operation.
- Fixture: the loopback remote satisfies the phase 1 rows of the acceptance list in [../README.md](../README.md) — `HEAD` symref discovery, `fetch`, and a `git-receive-pack` advertisement that refuses a wrong token — before any scenario uses it. Accepting a push is phase 2. A fetch never writes `refs/heads/*`. A force-push on the fixture remote force-updates the tracking ref and leaves the landing branch untouched.
- Clone: an objective clone has no configured remote after creation, and the assertion fails the run if one survives.
- Every execution route returns `not-implemented` and writes no state.

## End-to-end scenarios

The convention, the modes and the evidence format are in [../README.md](../README.md).

### P1-E1 — The onboarding journey

- **Mode:** `deterministic`
- **Why it exists:** the packaged binary, the config file, the daemon lifecycle and the CLI-to-HTTP wiring are each unit tested and have never been connected.
- **Automation:** `scripts/e2e/run.mjs P1-E1`
- **Human action:** none
- **Oracle:**
  - `kanthord credential register --kind git` exits zero and reports a credential id.
  - `kanthord repository register --url <fixture-remote> --credential <name> --upstream <branch>` exits zero, and `kanthord repository show` reports one landing branch at the fixture default and one tracking namespace.
  - `kanthord plan import` of the two-objective fixture exits zero and reports a plan revision.
  - `kanthord plan export` returns documents byte-identical to the ones the import accepted.
  - A re-import of the exported documents at the same revision exits zero, and every choice is the suggested one. A re-import at the previous revision exits non-zero and names the revision.
  - `kanthord status` lists two objectives and four tasks, all `pending`.
  - `kanthord run` exits non-zero with `not-implemented`, and `kanthord status` is unchanged.
- **Evidence:** the bundle holds every command, its exit status, and the two plan documents.

### P1-E2 — Transport policy under a hostile client

- **Mode:** `deterministic`
- **Why it exists:** the daemon listens on a private network, and the CLI cannot construct the requests that would compromise it.
- **Automation:** `scripts/e2e/run.mjs P1-E2`
- **Human action:** none
- **Oracle:** direct HTTP against the running daemon. No token returns 401. A wrong token returns 401. A valid token with an `Origin` header returns 403. A valid token with a `Host` outside the allow list returns 403. A valid token with an allowed `Host` returns 200. The daemon refuses to start with a non-loopback bind address and no token configured.
- **Evidence:** the request and response line of each case, with the token redacted.

### P1-E3 — Remote drive over the VPN

- **Mode:** `deployment`
- **Why it exists:** the exit criterion is a human working from a second machine, and nothing local proves that routing, binding and token distribution work.
- **Automation:** `scripts/e2e/run.mjs P1-E3 --daemon-host <a> --client-host <b>`
- **Human action:** none once both hosts are reachable.
- **Oracle:** P1-E1 runs with the CLI on the client host and the daemon on the daemon host. Every assertion is made through the public surface, because the client cannot read the daemon's file system. Ref layout is asserted through `kanthord repository show`, not through the bare home directory.
- **Evidence:** the bundle records both host identities and the bind address.
