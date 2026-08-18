# Phase 1 — Bootstrap

## Goal

Every entity, service interface, command and query exists, and a human drives the daemon end to end. No agent is connected.

**Every entity** means one zod row schema for every table of [domain.md](domain.md), the closed worker-kind and agent-kind sets, and every service interface. A table ships in phase 1, so its row schema ships with it. A phase-1 caller is not the test: `profile` carries no phase-1 command and still carries a row schema.

Behaviour is not an entity. A later-phase document schema, a role contract, a tool set and a shipped template each belong to the phase that introduces them. `profile` is the clearest case: phase 1 owns the four columns of [../database/profile.md](../database/profile.md), and phase 2 owns the profile document those columns point at.

**Blocker removed:** there is no skeleton to hang work on, and no bare home to work against.

**Exit criteria:** Ulrich onboards his real repository, imports a two-objective plan, exports it identical, and reads status. Every execution route answers `not-implemented`. A coding agent rehearses every scenario and reports the run green. Ulrich then drives the same journey through the same CLI and the same API, and confirms it. The confirmation is recorded, and the phase does not exit without it.

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
- Exclusive lock on the daemon home, taken at startup and held for the life of the process. A second daemon against one home refuses to start and names the holder. It is a held `BEGIN IMMEDIATE` on a dedicated `daemon.lock.db`, because Node 24 exposes neither `flock` nor `fcntl` and a native addon was refused. SQLite takes the `fcntl` record lock underneath. This is what makes a local ref write safe, per [git-foundation.md](git-foundation.md).
- Storage service on `node:sqlite`, with migrations, `db status`, and every table of [domain.md](domain.md).
- Domain schemas on zod. One row schema per table, the closed worker-kind and agent-kind sets, and the states, transitions and block reasons of [state-machine.md](state-machine.md). The state machine is defined and unit tested here. The scheduler that drives it arrives in phase 2.
- Graph service on graphology. Import, validate, export, the `import_id` idempotency key, and the re-import conflict resolution of [plan-format.md](plan-format.md): a binary choice per node, a suggestion per node from `plan.validate`, and a candidate graph validated as a whole before anything is applied.
- Crypto service on the master key, and `provider.register`, `provider.list` and `provider.show`. The git credential of `repository.register` is what forces them into phase 1, and they carry both kinds the MVP registers, `git` and `llm`, because `kind` dispatches one payload schema and one public projection per kind. See [../api/credential.md](../api/credential.md) and [../database/provider.md](../database/provider.md).
- Event log.
- Git service on the `git` binary: bare home creation from a remote origin URL, the three ref roles, and the three branch fields of [git-foundation.md](git-foundation.md). `git clone --bare` is forbidden, and the fetch refspec plus `--no-tags` confines remote updates to `refs/remotes/origin/*`.
- HTTP surface on koa, with the bind address, the bearer token, the `Origin` rejection and the `Host` allow list of [transport.md](transport.md). Every command and query is routed. An execution route returns `not-implemented`.
- CLI on commander, calling the HTTP API. `db`, `credential register`, `repository register` and `show`, `project create`, `list` and `show`, `plan import`, `plan export`, `status`, and the declared execution commands. `project` ships here rather than with the phase-2 onboarding CLI, because every plan route names a project and import refuses an objective whose repository is not bound to one. The CLI carries a base URL and a token, so it runs on a different machine.

## Verification

`npm run verify` holds the permutations, on `node:test` with supertest and a fixture remote in a temporary directory, served over git smart HTTP on a loopback port, because that is the only way to exercise authentication, the `401` challenge and the push preflight:

- Migration: `db status` reports the applied migrations on a new file, and reports no change on a second run.
- Import: a two-objective plan imports, exports byte-identical to the accepted documents, and re-imports from the same revision. A re-import from a stale revision is rejected. A retry of a committed `import_id` returns the original revision and writes no second revision, and a reordered document array is still a retry. Path-based dependencies resolve to minted identities. Export carries no status field.
- Validation: an objective with no task, an initiative with no objective, and a cycle are each rejected. One document that holds three faults returns three findings, not one.
- Choices: a missing choice and an extra choice are each refused. A choice of `submitted` on a structural edit is refused at every state except `pending`, `blocked` and `ready`, and accepted at those three. A choice of `submitted` on a prose edit is accepted at every state, including `discarded`. Two individually legal choices that build a cycle are refused as one candidate graph, and the suggestion set for that same input is never the combination that gets refused. Topology that moved since validation returns `choices-stale`, and a selected outcome that runtime state invalidated returns `choices-changed`. Each writes nothing.
- Transport: a request with no token is refused. A request with a wrong token is refused, and the comparison is constant time. A request that carries an `Origin` header is refused. A `Host` outside the allow list is refused.
- Bare home: registration against a fixture remote produces `refs/remotes/origin/*` and one landing branch at the detected default, and no `refs/tags/*`. A plain HTTP url is accepted on a loopback host and refused elsewhere. A url carrying a password in its userinfo is refused, and a url carrying only a username is not.
- ssh: registration against a loopback `sshd` fixture succeeds with a confirmed host fingerprint, and is refused when the fingerprint does not match, when the host key later changes, when the key is encrypted, and when the url and the credential disagree on transport. The private key file is mode `0600` while the operation runs, and it is gone after it.
- Preflight: registration proves the credential with a `git-receive-pack` advertisement. A wrong token and a missing token each fail with `auth-failed` and write no row. A read-only credential on a public repository fails the same way, because a fetch would have passed.
- Home lock: a second daemon against one home refuses to start and names the holder from `daemon.lock.identity`. A holder that never published an identity still refuses the contender, with the identity reported as unavailable. A daemon killed with `SIGKILL` leaves the lock released, and the next start takes it with no cleanup step, including when a `daemon.lock.db-journal` survives. The daemon's own database writes normally while the lock is held. A daemon home on a network filesystem is refused at startup where the platform reports a filesystem type, and the refusal covers each denied type of [git-foundation.md](git-foundation.md). A platform that reports no type starts, which is asserted as well, so the scope is a tested rule rather than an omission. The lock is held before the `*.lock` sweep runs.
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
  - The daemon binary with no config file at any discovered location exits non-zero and names the search order it used. A config file at the first discovered location starts the daemon.
  - The daemon binary and the CLI binary report the same version.
  - `kanthord credential register --kind git` exits zero and reports a credential id.
  - `kanthord repository register --url <fixture-remote> --credential <name> --upstream <branch>` exits zero, and `kanthord repository show` reports one landing branch at the fixture default and one tracking namespace.
  - `kanthord project create` exits zero and reports a project id, and the repository binds to that project. Import refuses an objective whose repository is not bound, so the binding is a step of the journey rather than setup.
  - `kanthord plan import` of the two-objective fixture exits zero and reports a plan revision.
  - `kanthord plan export` returns documents byte-identical to the ones the import accepted.
  - A re-import of the exported documents at the same revision exits zero, and every choice is the suggested one. A re-import at the previous revision exits non-zero and names the revision.
  - `kanthord status` lists two objectives and four tasks, two tasks `pending` and two `ready`.
  - `kanthord run` exits non-zero with `not-implemented`, and `kanthord status` is unchanged.
- **Evidence:** the bundle holds every command, its exit status, and the two plan documents.

### P1-E2 — Transport policy under a hostile client

- **Mode:** `deterministic`
- **Why it exists:** the daemon listens on a private network, and the CLI cannot construct the requests that would compromise it.
- **Automation:** `scripts/e2e/run.mjs P1-E2`
- **Human action:** none
- **Oracle:** direct HTTP against the running daemon. No token returns 401. A wrong token returns 401. A valid token with an `Origin` header returns 403. A valid token with a `Host` outside the allow list returns 403. A valid token with an allowed `Host` returns 200. The daemon refuses to start with a non-loopback bind address and no token configured.
- **Evidence:** the request and response line of each case, with the token redacted.

### P1-E4 — Two hosts on one laptop

- **Mode:** `deterministic`
- **Driver:** `podman`. **Profile:** fixture.
- **Why it exists:** the CLI reaches the daemon over HTTP, and the two-host logic must gate every commit. A client that shares a process, a file system and a loopback interface with the daemon proves none of that logic.
- **Automation:** `scripts/e2e/run.mjs P1-E4`
- **Human action:** none
- **Topology:** three containers in two network namespaces. A pod holds the fixture-remote container and the daemon container on one namespace, so the fixture listens on `127.0.0.1` and the daemon reaches it over loopback. The url policy of [git-foundation.md](git-foundation.md) is therefore satisfied rather than relaxed, and the daemon image stays single-purpose. A client container holds the CLI alone, with no daemon volume. The daemon binds `0.0.0.0` behind the stable alias `kanthord-daemon`, never a discovered address, and the `Host` allow list names exactly that alias and port. The daemon home is a named volume; a bind mount from the host reports a FUSE filesystem, which the startup check of [git-foundation.md](git-foundation.md) is entitled to refuse. The containers run Linux, so that check reads a filesystem magic number and the refusal is effective here.
- **Oracle:** P1-E1 runs with the CLI and the daemon in separate network namespaces. The daemon binds a non-loopback address, so a token is mandatory and the startup refusal is exercised across a real network boundary. An allow list that omits the alias returns `403`. The client cannot read the daemon's file system, so ref layout is asserted through `kanthord repository show`. The transport cases of P1-E2 that a separate namespace makes representative run here, from the P1-E2 oracle rather than a second copy of it.
- **Evidence:** the bundle records the driver, both namespace identities, the product artifact digest, the base image digest, the architecture, the Podman version, and the pinned `git` version.

### P1-E5 — Onboarding a real repository

- **Mode:** `integration`
- **Driver:** `local`. **Profile:** real.
- **Why it exists:** a fixture remote answers exactly what the harness taught it to answer. A real git forge negotiates its own capabilities, names its own default branch, and refuses its own way. Nothing proves that the product onboards a repository Ulrich cares about until it onboards one.
- **Automation:** `scripts/e2e/run.mjs P1-E5`
- **Human action:** none
- **Inputs:** the throwaway repository, the branch and the credential of `.env.e2e`, and a hand-authored two-objective plan against that repository. Fixture object ids and the fixture default branch do not transfer, so the fixture plan is not reused.
- **Oracle:** P1-E1 runs against the real repository and the real credential. Registration proves the credential with a `git-receive-pack` advertisement, the landing branch lands at the branch the forge reports, and the tracking namespace holds `refs/remotes/origin/*` and no tag. Every assertion is made through the public surface, and ref layout is asserted through `kanthord repository show`. No phase-1 operation writes a ref on the remote, so the run leaves the forge unchanged.
- **Evidence:** the bundle records the repository, the detected default branch, the object ids involved, and the credential name with the secret redacted.

P1-E4 and P1-E5 divide the matrix and neither substitutes for the other. P1-E4 proves the two-host logic against a fixture the harness controls. P1-E5 proves real-forge behaviour on one machine. The phase exits by pointing at a P1-E5 bundle.

No phase-1 scenario crosses the VPN. Routing, binding across two machines and token distribution are proved once, in phase 3, by [../phase-3/README.md](../phase-3/README.md). Phase 1 exits on the product, never on a network.

### P1B-E1 — The single-harness loop

- **Mode:** `deterministic`
- **Driver:** `local`. **Profile:** fixture. **Plan:** `three-objective`.
- **Why it exists:** one registered harness must complete the claim, report, attestation and close loop through the packaged daemon.
- **Automation:** `scripts/e2e/run.mjs P1B-E1`
- **Human action:** none
- **Oracle:** one registered harness lists the ready frontier; each alpha task claims with attempt number 1, heartbeats, and reports `accepted`; alpha reaches `awaiting_approval` on an attestation; `node show` returns that `attestedObjectId` and the computed `projection`; an attest by the human token is `403 actor-forbidden`; `node close` by the human token moves alpha to `done`; `gamma` still reads `pending` and beta's first task still reads `ready`.
- **Evidence:** every command with its exit status, and the node state of each of the five tasks by identity.

### P1B-E2 — Two harness clients on one daemon

- **Mode:** `deterministic`
- **Driver:** `podman`. **Profile:** fixture. **Plan:** `three-objective`.
- **Why it exists:** two harness clients must exercise independent identities, network namespaces and server-side arbitration against one daemon.
- **Automation:** `scripts/e2e/run.mjs P1B-E2`
- **Human action:** none
- **Topology:** four containers in three network namespaces: the fixture-remote and daemon pod of P1-E4, and two client containers, each with no daemon volume.
- **Oracle:** the ten phases of the exit journey, in order, as Story 15 states them. This is the block's exit criterion.
- **Evidence:** the bundle records the second client identity, the product artifact digest, the base image digest and the architecture.

### P1B-E3 — The stale harness loses its claim

- **Mode:** `deterministic`
- **Driver:** `podman`. **Profile:** fixture. **Plan:** `two-objective`.
- **Why it exists:** a stale harness must lose its lease, and a second harness must take over without accepting the stale report.
- **Automation:** `scripts/e2e/run.mjs P1B-E3`
- **Human action:** none
- **Topology:** the topology of P1B-E2.
- **Oracle:** an unheartbeated lease expires; the second client's first `200` carries a fence greater than the first; a report on the stale fence is `409 lease-held` and changes no node state; exactly one `outcome.reported` event exists for the task, naming the second actor.
- **Evidence:** the bundle records the observed takeover latency, which is diagnostic.
