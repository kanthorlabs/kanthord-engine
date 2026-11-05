# Host credential plan decisions

The plans cite these decisions as D1 to D16. Each decision binds every plan and every task of this set. The open rulings O1 to O3 of `00-index.md` carry a recommendation. Each decision that depends on a ruling states the recommended value and names the ruling.

## D1 — Source and gaps

The pages of the root pull request of plan 01 are the rule for plans 02 to 08. After the merge, the design pages under `docs/brainstorm/` of the root repository are the rule (`engine/AGENTS.md:3-6`). A plan task implements the page as written. A task that meets a gap that no decision below covers writes one `DEBATE:` line in its report with the page line that proves the gap. Aelita brings it to Ulrich as one open item.

## D2 — The worker host

A worker host is one machine that runs `worker` instances. It is a credential holder with its own X25519 key pair. It holds no token, no connection, no binding and no execution.

- The Worker Service owns the host. The table `worker_host` holds one row for each revision: `id` (`worker_host_<ulid>`), `name`, `revision`, `public_key`, `fingerprint`, `created_at` and `ended_at`. `public_key` and `fingerprint` are never null.
- The table holds the unique indexes `id`, `(name, revision)` and `fingerprint`. It holds no other index and no `CHECK`.
- Justification of the table: a host holds a key revision chain and no worker, placement, connection or binding, so the `worker_instance` table cannot hold it.
- The name follows the instance name form (`src/worker/contract.ts:990-994`) and the reserved names of `RESERVED_INSTANCE_NAMES` (`src/worker/contract.ts:968`).
- A host name and an instance name never match. A create of a host refuses a name that a live or an archived instance or host holds. A create of an instance refuses a name that a host holds.
- No two revisions of any instance or any host share one fingerprint.
- The host operations are `worker.host.create`, `worker.host.list`, `worker.host.get`, `worker.host.rotate` and `worker.host.archive`. Plan 01 writes their routes, inputs, answers and error codes on the root pages. Plan 02 implements them.
- `worker.host.create` and `worker.host.rotate` take an optional `public_key`. Without it, the server generates the key pair, keeps only the public key and answers `host_configuration` once with `Cache-Control: no-store`.
- `worker.host.rotate` is the Reset key of the host. It names `expected_revision`, ends the live revision and stores the next revision with the new key.
- `worker.host.archive` names `expected_revision`. It refuses while a live instance names the host with 409 `worker.host.in_use` and `details.instances`. In its transaction it archives every credential copy of the host.

## D3 — The host of an instance

Every instance at the `worker` placement names one live host at its create (ruling O1). The host never changes.

- The column `worker_instance.host` holds the host name. It is null at the `server` and the `container` placements. Justification: the host is a human choice at the create, and no other data computes it.
- `worker.instance.create` takes `host`. At the `worker` placement, an absent value or a value that names no live host answers 400 `worker.instance.host_invalid`. At the `server` and the `container` placements, a `host` answers the same code.
- The instance record adds `host`.
- The instance keeps its own key pair. Its key stays the only machine credential of its identity: the worker token, the connection and the client secrets.

## D4 — Holders and the copy holder of an instance

A holder is `server`, a live host, or a live instance at the `worker` placement. The `credential` table does not change.

- The copy holder of an instance for one credential name is:
  - `server` at the `server` and the `container` placements;
  - at the `worker` placement, the instance name when the `(name, instance)` group holds a live revision;
  - else the host name of the instance.
- Custody owns this rule in one function `copyHolderOf(tx, credentialName, holder)`. A `server` or a host holder answers itself.
- Custody reads the host of an instance through its `InstanceKeys` port (`src/custody/contract.ts:845-848`). The port adds `hostOf(tx, instanceName)`. `keyOf(tx, name)` answers the current key of a live instance at the `worker` placement or of a live host.
- These paths use the copy holder: the holder rule of the Agent component (`copyHeld`), the reads of `CredentialHolds`, the handover, the worker-token reads of the LLM component, the credentials of `worker.instance.get` and the archive dependents.
- The bindings and the claimant keep the instance names (`src/project/contract.ts:337-357`, `src/worker/service.ts:282-286`). Custody resolves each name to its copy holder.

## D5 — The host key on the machine

The host configuration is `{ name, private_key }`. Its value is the unpadded base64url form of its canonical JSON, with no prefix.

- The host file is `$XDG_CONFIG_HOME/kanthord/hosts/<name>.yaml`, with mode `0600` in a directory with mode `0700`. The environment variable `KANTHORD_HOST_CONFIG` holds the value on a host without a writable configuration.
- `kanthord worker host join [--force]` writes the host file from the value on standard input.
- The `worker` application reads the host key at each use, by the holder name of the item. It reads no host key at its start. A Reset key of the host thus needs no restart of an instance.
- Both sources for one name answer `worker.host.config_conflict`. No source answers `worker.host.config_absent`. A value that fails the schema, or a file whose `name` differs from its file name, answers `worker.host.config_invalid`.
- `childEnvironment` (`src/agent/environment.ts:15-30`) removes `KANTHORD_HOST_CONFIG` from each child process.
- The sealed object of a host copy uses the host name as `holder` and the host fingerprint as `sealed_to` in its additional authenticated data (`custody.impl.md:61`).

## D6 — The credential operations for a host holder

- A human `create` takes host names in `holders`. Custody seals the secret to the current host key.
- A human `rotate`, `get`, `update-metadata`, `revoke` and `archive` take a host name in the query `holder`.
- A worker token acts on the copies of its own instance and of its own host. `create` and `rotate` under a worker token take `holder` equal to the instance or to its host. Another holder answers 403 `llm.credential.instance_forbidden`.
- A worker-token `list` answers the copies that the instance uses: each own copy, and each host copy of a name with no own copy. Each item holds `holder`.
- A worker-token `get`, `llm.credential.sealed` and `llm.credential.report` act on the copy of the copy holder of the instance for the name.
- A holder that names no live instance at the `worker` placement and no live host answers 400 `llm.credential.holder_unknown`. This code replaces `llm.credential.instance_unknown`.
- The CLI seals locally only for an instance holder with an instance file. For a host holder, the CLI sends the plaintext under the human token, and the server seals.
- An instance copy and a host copy skip the pre-save check and the provider check, as an instance copy does today.

## D7 — The login on a host

- `llm.credential.login` takes a host name as `holder`. A connected instance of the host runs the session. It seals the result to the host key.
- The server picks the runner when the login starts: the connected instance of the host with the newest last heartbeat, then the first name in ascending order. A connected instance has a last heartbeat at most 60 s old.
- No connected instance of the host answers 409 `credential.login.instance_unavailable`.
- The session record holds `holder` and `runner`. The work read of the runner lists the session. Each `login_sessions` item adds `holder`.
- Only the runner reports the session. A report of another instance answers 404 `credential.login.not_found`.
- The name conflict, the archive refusal and the stale-key rule of an instance login apply to the `(name, host)` group (`llm.impl.md:211-213` at root `01865e3`).

## D8 — The health of a host copy

- Each live instance of the host checks each host copy that it uses, by the rules of an instance copy (`llm.impl.md:149-168`).
- Each committed write of a host copy raises the `credential_version` of each live instance of the host.
- The server keeps one report for each copy. A report holds the reporter instance. `credentials[].health` adds `reported_by`, the instance name of the report or null.
- `worker.instance.get` answers in `credentials` each copy that the instance uses. Each item adds `holder`.
- `worker.host.get` answers in `credentials` each live copy of the host, with the same item shape.

## D9 — The cooldown of a host copy

- A host copy holds one cooldown on its row of revision 1 (`custody.impl.md:226`). Every instance that uses the copy shares it.
- `holdOf`, `hold` and `release` of `CredentialHolds` resolve the holder through `copyHolderOf`. `listHolds` answers the group holder, which is the host name for a host copy.
- `agent cooldown clear --holder <name>` takes a host name.

## D10 — The archive and its dependents

- The dependents of a host copy are the worker bindings that list an instance of the host whose copy holder for the name is the host, and whose agent configuration names the credential.
- An instance copy has no dependent when the host of the instance holds a live copy of the name sealed to the current host key. Else the dependents of `custody.impl.md:39` apply.
- An archive of a host archives every copy of the host in its transaction. An archive of an instance archives only the copies of the instance.

## D11 — `sealed_current` and the Reset key of a host

- `sealed_current` of a host copy is true when `sealed_to` equals the current fingerprint of the host.
- After a Reset key of the host, each host copy has `sealed_current` false. The handover refuses it with 403 `custody.handover.holder_refused` and `reason` `held_elsewhere`. The instances that use it show `holder_mismatch` true.
- Recovery is a new login on the host for an OAuth copy, or a rotation with a new secret for an API key copy. The operator replaces the host file with `kanthord worker host join --force`, or replaces the env value.

## D12 — The per-instance override

- A human gives one instance its own credential with a copy of the same name and the holder of the instance: a login, or a create.
- The own copy wins while its group holds a live revision. A stale own copy, sealed to an ended key of the instance, does not fall back to the host copy. The handover refuses it, and `holder_mismatch` shows it.
- An archive of the own copy returns the instance to the host copy. The archive stays final, so the instance takes no new own copy of that name (ruling O3).

## D13 — The Mission Service and the handover

- An agent provider names a credential, and a worker binding lists instances. Neither contract changes.
- At the first use of a name in an execution, the handover pins the newest live row of the copy holder of the instance. A later handover of that execution reads the pinned row, whatever the copy holder is then.
- The sealed handover item adds `holder`. The worker unit opens the item with the key of that holder: the instance key, or the host key of D5.
- The `server` and the `container` placements keep the copy of the holder `server` and the slot channel.
- A server on another machine changes no rule. The host private key stays on the host, and the server stores only the public key.

## D14 — The refresh lease

One execution at a time refreshes one OAuth revision (ruling O2: every OAuth copy at every placement).

- The Worker Service declares `worker.credential.lease`: `POST /api/worker/credential/lease`, policy `client`, secret mutation, live execution. The body is `{ execution_id, credential_id }`.
- Custody keeps one in-memory lease for each credential revision: `{ execution_id, expires_at }`. `CREDENTIAL_LEASE_MS` is 30000. It covers the OAuth refresh timeout of pi-ai, 15 s, and the report.
- The lease answer is a handover envelope. Its payload is `{ item, expires_at }`, where `item` is the handover item of the stored value of the revision: plain for the holder `server`, sealed for another holder.
- A lease of another live execution, or a check refresh in flight on the revision (`src/custody/service.ts:1044-1073`), answers 503 `worker.credential.lease_held`. The worker application retries it with a new key and the backoff of an indeterminate result, until the claim expires.
- A revision that the execution does not pin answers 400 `custody.handover.lease_invalid`. An ended revision answers 409 `credential.revision.revoked`.
- A `worker.credential` report of the lease holder ends the lease after its write. A report of another execution keeps the lease. The digest rule of the report does not change (`src/custody/handover.ts:194-247`).
- `modify` of the execution store takes the lease, adopts the stored value of the answer, calls the pi-ai function with it and then sends one report. pi-ai calls `modify` only for a token that expires within 5 minutes, so a model call takes no lease.
- The handover does not wait for a lease. A check that reads a revision under a lease does not refresh, because the lease holder pins the revision.

## D15 — Surfaces

- Engine CLI: `kanthord worker host create|list|get|rotate|archive|join`, `kanthord worker instance create --host <name>`, and a host name in each `--holder` of `kanthord llm credential` and of `kanthord agent cooldown clear`.
- Engine contract: regenerate `static/` with `pnpm run build && node bin/kanthord.mjs gateway openapi` in each engine plan that changes an operation (`engine/AGENTS.md:39-40`).
- Engine `docs/cli/`: `worker.md`, `llm.md` and `agent.md` follow each change in the plan that makes it.
- Dashboard: the screens `/hosts`, `/hosts/new` and `/hosts/:hostName` under the sidebar group `Workforce`; the `Host` select of `Add instance` at the `worker` placement; the credentials of the host page and of the instance page; `Also seal to` with hosts; the `/llm` description line.
- Root: plan 01 writes the design pages, the reference pages and ERD 1 in one root pull request. Plan 08 moves the e2e scripts and the root `AGENTS.md` e2e text to one dev host.

## D16 — Schema and orphans

- Each plan edits the `CREATE TABLE` and `CREATE UNIQUE INDEX` text of the one migration of its service in place. It adds no migration and no data move (`engine/AGENTS.md:31-34`). A developer discards a local database after the merge.
- A plan removes each field, prop and helper that only fed the code that the plan removes. A plan removes no other dead code. It names other dead code in its pull request body.
