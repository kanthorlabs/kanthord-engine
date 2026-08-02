# Phase 1 — Bootstrap

## Goal

Every entity, service interface, command and query exists, and a human drives the daemon end to end. No agent is connected.

**Blocker removed:** there is no skeleton to hang work on, and no bare home to work against.

**Exit criteria:** Ulrich onboards his real repository from a second machine over the VPN, imports a two-objective plan, exports it identical, and reads status. Every execution route answers `not-implemented`.

## Files

| File                                   | Subject                                                                      |
| -------------------------------------- | ---------------------------------------------------------------------------- |
| [domain.md](domain.md)                 | entities, service layering, storage tables, dependencies                     |
| [transport.md](transport.md)           | bind address, bearer token, browser defences, CLI parity                     |
| [plan-format.md](plan-format.md)       | the markdown a human authors, import, export, re-import                      |
| [git-foundation.md](git-foundation.md) | three repositories, three ref roles, seeding, branch fields, clone mechanics |
| [state-machine.md](state-machine.md)   | states, the aggregation table, task order, rules                             |

## Deliverables

- Config service on convict. It holds the master key, the HTTP bind address, the HTTP token, the `Host` allow list, and the default attempt limit of 3.
- Storage service on `node:sqlite`, with migrations, `db status`, and every table of [domain.md](domain.md).
- Domain schemas on zod. Entities, and the states, transitions and block reasons of [state-machine.md](state-machine.md). The state machine is defined and unit tested here. The scheduler that drives it arrives in phase 2.
- Graph service on graphology. Import, validate, export, and the staged write-back and re-import reconciliation of [plan-format.md](plan-format.md).
- Event log.
- Git service on simple-git: bare home creation from a remote origin URL, the three ref roles, and the three branch fields of [git-foundation.md](git-foundation.md). `git clone --bare` is forbidden, and the fetch refspec confines remote updates to `refs/remotes/origin/*`.
- HTTP surface on koa, with the bind address, the bearer token, the `Origin` rejection and the `Host` allow list of [transport.md](transport.md). Every command and query is routed. An execution route returns `not-implemented`.
- CLI on commander, calling the HTTP API. `db`, `plan import`, `plan export`, `status`, and the declared execution commands. The CLI carries a base URL and a token, so it runs on a different machine.

## Verification

`npm run verify` holds the permutations, on `node:test` with supertest and a fixture bare repository in a temporary directory:

- Migration: `db status` reports the applied migrations on a new file, and reports no change on a second run.
- Import: a two-objective plan imports, exports byte-identical, and re-imports from the same revision. A re-import from a stale revision is rejected. Path-based dependencies resolve to minted ULIDs.
- Validation: an objective with no task, an initiative with no objective, and a cycle are each rejected.
- Transport: a request with no token is refused. A request with a wrong token is refused, and the comparison is constant time. A request that carries an `Origin` header is refused. A `Host` outside the allow list is refused.
- Bare home: registration against a fixture remote produces `refs/remotes/origin/*` and one landing branch at the detected default. A fetch never writes `refs/heads/*`. A force-push on the fixture remote force-updates the tracking ref and leaves the landing branch untouched.
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
  - `kanthord repository register --url <fixture-remote>` exits zero, and `kanthord repository show` reports one landing branch at the fixture default and one tracking namespace.
  - `kanthord plan import` of the two-objective fixture exits zero and reports a graph revision.
  - `kanthord plan export` returns a document byte-identical to the imported one.
  - A re-import of the exported document at the same revision exits zero. A re-import at the previous revision exits non-zero and names the revision.
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
