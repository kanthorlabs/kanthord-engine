# Machine credential plan decisions

The plans cite these decisions as D1 to D16. Each decision binds every plan and every task of this set. Ulrich ruled O1, O2 and O3.

## D1 — Source and gaps

The pages of the root pull request of plan 01 are the rule for plans 02 to 08b. After the merge, the design pages under `docs/brainstorm/` of the root repository are the rule (`engine/AGENTS.md:3-6`). A plan task implements the page as written. A task that meets a gap that no decision below covers writes one `DEBATE:` line in its report. The line names the page line that proves the gap. Aelita brings it to Ulrich as one open item.

## D2 — The worker machine

A worker machine is one computer that runs `worker` instances. It is a credential holder with its own X25519 key pair. It holds no token, no connection, no binding and no execution.

- The term "worker machine" is new. The term "host" keeps its meaning of `worker-service.vocabulary.md:20-29`: `kanthord` or an external harness.
- The Worker Service owns the machine. The table `worker_machine` holds one row for each revision.
- The columns are `id` (`worker_machine_<ulid>`), `name`, `revision`, `public_key`, `fingerprint`, `created_at` and `ended_at`. `public_key` and `fingerprint` are never null.
- The table holds the unique indexes `id`, `(name, revision)` and `fingerprint`. It holds no other index and no `CHECK`.
- Justification of the table: a machine holds a key revision chain. It holds no worker, placement, connection or binding, so the `worker_instance` table cannot hold it.
- The name follows the instance name form (`src/worker/contract.ts:990-994`) and `RESERVED_INSTANCE_NAMES` (`src/worker/contract.ts:968`).
- A machine name and an instance name never match. A machine create refuses a name of a live or an archived instance or machine. An instance create refuses a machine name.
- No two revisions of any instance or any machine share one fingerprint.
- The operations are `worker.machine.create`, `worker.machine.list`, `worker.machine.get`, `worker.machine.rotate` and `worker.machine.archive`. Plan 01 writes their contracts on the root pages.
- `worker.machine.create` and `worker.machine.rotate` take an optional `public_key`. Without it, the server generates the key pair and keeps only the public key.
- That answer adds `machine_configuration` once, with `Cache-Control: no-store`.
- `worker.machine.rotate` is the Reset key of the machine. It names `expected_revision`, ends the live revision and stores the next revision with the new key.
- `worker.machine.archive` names `expected_revision`. It refuses with 409 `worker.machine.in_use` and `details.instances` while a live instance names the machine.
- In its transaction, the machine archive archives every credential copy of the machine.

## D3 — The machine of an instance

RULED 2026-11-05 by Ulrich (open item O1): every instance at the `worker` placement names one live machine at its create. The machine never changes.

- The column `worker_instance.machine` holds the machine name. It is null at the `server` and the `container` placements.
- Justification of the column: the machine is a human choice at the create, and no other data computes it.
- `worker.instance.create` takes `machine`. At the `worker` placement, an absent value or a name of no live machine answers 400 `worker.instance.machine_invalid`.
- At the `server` and the `container` placements, a `machine` value answers the same code.
- The instance record adds `machine`. The heartbeat answer of the instance exchange adds `machine`.
- The instance keeps its own key pair. That key stays the only credential of its identity: the worker token, the connection and the client secrets.

## D4 — Holders and the copy holder of an instance

A holder is `server`, a live machine, or a live instance at the `worker` placement. The `credential` table does not change.

- The copy holder of an instance for one credential name is:
  - `server` at the `server` and the `container` placements;
  - at the `worker` placement, the instance name when the `(name, instance)` group holds a live revision;
  - else the machine name of the instance.
- Custody owns this rule in one function `copyHolderOf(tx, credentialName, holder)`. A `server` holder or a machine holder answers itself.
- The custody port `InstanceKeys` (`src/custody/contract.ts:845-848`) adds `machineOf(tx, instanceName)`.
- `keyOf(tx, name)` answers the current key of a live instance at the `worker` placement or of a live machine.
- These paths use the copy holder: `copyHeld` of the Agent holder rule and `holdOf` at the claim. The handover and the worker-token reads of the LLM component also use it.
- The credentials of `worker.instance.get` and the archive dependents also use it.
- The bindings and the claimant keep the instance names (`src/project/contract.ts:337-357`, `src/worker/service.ts:282-286`). Custody resolves each name to its copy holder.

## D5 — The machine key on the machine

The machine configuration is `{ name, private_key }`. Its value is the unpadded base64url form of its canonical JSON, with no prefix.

- The machine file is `$XDG_CONFIG_HOME/kanthord/machines/<name>.yaml`. It has mode `0600` in a directory with mode `0700`.
- The environment variable `KANTHORD_MACHINE_CONFIG` holds the value on a machine without a writable configuration.
- `kanthord worker machine join [--force]` writes the machine file from the value on standard input.
- The `worker` application reads the machine key at each use, by the holder name of the item. A Reset key of the machine thus needs no restart of an instance.
- When the heartbeat answer names the machine, `kanthord serve worker` also reads the machine configuration. An absent configuration logs `worker.machine.config_absent` once.
- While the configuration is absent, the instance claims no work. It claims work again after a heartbeat that reads the configuration.
- Both sources for one name answer `worker.machine.config_conflict`. No source answers `worker.machine.config_absent`.
- A value that fails the schema, or a file whose `name` differs from its file name, answers `worker.machine.config_invalid`.
- `childEnvironment` (`src/agent/environment.ts:15-30`) removes `KANTHORD_MACHINE_CONFIG` from each child process.
- The additional authenticated data of a machine copy holds the machine name as `holder` and the machine fingerprint as `sealed_to` (`custody.impl.md:61`).

## D6 — The credential operations for a machine holder

- A human `create` takes machine names in `holders`. Custody seals the secret to the current machine key.
- A human `rotate`, `get`, `update-metadata`, `revoke` and `archive` take a machine name in the query `holder`.
- A worker token reads the copies of its own instance and of its own machine.
- `create` and `rotate` under a worker token act only on the copy of its own instance. Another holder answers 403 `llm.credential.instance_forbidden`.
- A worker-token `list` answers the copies that the instance uses: each own copy, and each machine copy of a name with no own copy. Each item holds `holder`.
- A worker-token `get`, `llm.credential.sealed` and `llm.credential.report` act on the copy of the copy holder of the instance for the name.
- A holder that names no live `worker` instance and no live machine answers 400 `llm.credential.holder_unknown`. This code replaces `llm.credential.instance_unknown`.
- The CLI seals locally only for an instance holder with an instance file. For a machine holder, the CLI sends the plaintext under the human token, and the server seals.
- A machine copy skips the pre-save check and the provider check, as an instance copy does.

## D7 — The login on a machine

- `llm.credential.login` takes a machine name as `holder`. A connected instance of the machine runs the session. It seals the result to the machine key.
- The server picks the runner when the login starts. The runner is the connected instance of the machine with the newest last heartbeat, then the first name in alphabetical order.
- A connected instance has a last heartbeat at most 60 s old. No connected instance of the machine answers 409 `credential.login.instance_unavailable`.
- The session record holds `holder` and `runner`. The work read of the runner lists the session. Each `login_sessions` item adds `holder`.
- Only the runner reports the session. A report of another instance answers 404 `credential.login.not_found`.
- The name conflict, the archive refusal and the stale-key rule of an instance login apply to the `(name, machine)` group (root `llm.impl.md:211-213`).

## D8 — The health of a machine copy

- Each live instance of the machine checks each machine copy that it uses, by the rules of an instance copy (root `llm.impl.md:149-168`).
- `CopyHealthBook` keeps one counter for each holder. A committed write of a copy raises the counter of its holder, also for a machine holder.
- These writes are a create, a rotation, a metadata edit, a revoke, an archive, a login completion and a refresh report.
- `versionOf(instance)` answers the counter of the instance plus the counter of its machine, through `machineOf`. The heartbeat answers it as `credential_version`.
- The server keeps one report for each copy. A report holds the reporter instance. `credentials[].health` adds `reported_by`, the instance name of the report or null.
- `worker.instance.get` answers in `credentials` each copy that the instance uses. Each item adds `holder`.
- `worker.machine.get` answers in `credentials` each live copy of the machine, with the same item shape.

## D9 — The cooldown of a machine copy

- A machine copy holds one cooldown on its row of revision 1 (`custody.impl.md:226`). Every instance that uses the copy shares it.
- A stop holds the copy of the row that the execution pins (root `agent.impl.md:201`, `src/agent/service.ts:894-912`). `hold` and `release` take the holder of that row.
- At the claim, `holdOf` resolves the claimant through `copyHolderOf`.
- `listHolds` answers the group holder, which is the machine name for a machine copy. `agent cooldown clear --holder <name>` takes a machine name.

## D10 — The archive and its dependents

- The dependents of a machine copy are the worker bindings that list an instance whose copy holder for the name is the machine. The agent configuration of such a binding names the credential.
- An instance copy has no dependent while its machine holds a live copy of the name sealed to the current machine key. Else the dependents of `custody.impl.md:39` apply.
- An archive of a machine archives every copy of the machine in its transaction. An archive of an instance archives only the copies of the instance.

## D11 — `sealed_current` and the Reset key of a machine

- `sealed_current` of a machine copy is true when `sealed_to` equals the current fingerprint of the machine.
- After a Reset key of the machine, each machine copy has `sealed_current` false. The handover refuses it with 403 `custody.handover.holder_refused` and `reason` `held_elsewhere`.
- The instances that use such a copy show `holder_mismatch` true.
- Recovery is a new login on the machine for an OAuth copy, or a rotation with a new secret for an API key copy.
- The operator replaces the machine file with `kanthord worker machine join --force`, or replaces the env value.
- The Reset key of an instance keeps its rule for the own copies of the instance (root `worker-service.md:335`).
- A leaked instance configuration on a machine also exposes the machine key. Recovery is then a Reset key of the instance and of the machine.
- After these resets, a human signs in again for each machine copy and rotates each API key at its provider.

## D12 — The per-instance override

- A human gives one instance its own credential: a login or a create of the same name, with the instance as holder.
- The own copy wins while its group holds a live revision.
- A stale own copy, sealed to an ended key of the instance, does not fall back to the machine copy. The handover refuses it, and `holder_mismatch` shows it.
- An archive of the own copy returns the instance to the machine copy. The archive stays final, so the instance takes no new own copy of that name (ruling O3, RULED 2026-11-05 by Ulrich).

## D13 — The Mission Service and the handover

- An agent provider names a credential, and a worker binding lists instances. Neither contract changes.
- At the first use of a name in an execution, the handover pins the newest live row of the copy holder of the instance.
- A later handover of that execution reads the pinned row, whatever the copy holder is then.
- The sealed handover item adds `holder`. The worker unit opens the item with the key of that holder: the instance key, or the machine key of D5.
- The `server` and the `container` placements keep the copy of the holder `server` and the slot channel.
- A server on another computer changes no rule. The machine private key stays on the machine, and the server stores only the public key.

## D14 — The refresh lease

RULED 2026-11-05 by Ulrich (open item O2): one execution at a time refreshes one OAuth revision, at every placement.

- The Worker Service declares `worker.credential.lease`: `POST /api/worker/credential/lease`, policy `client`, secret mutation, live execution.
- The body is `{ execution_id, credential_id }`.
- Custody keeps one in-memory lease for each credential revision: `{ execution_id, expires_at }`.
- `CREDENTIAL_LEASE_MS` is 30000. It covers the OAuth refresh timeout of pi-ai, 15 s, and the report.
- The lease answer is a handover envelope. Its payload is `{ item, expires_at }`.
- `item` is the handover item of the stored value of the revision: plain for the holder `server`, sealed for another holder.
- A lease of another live execution answers 503 `worker.credential.lease_held`. A check refresh in flight on the revision answers the same code (`src/custody/service.ts:1044-1073`).
- The worker application retries `lease_held` with a new key and the backoff of an indeterminate result. The retry ends when the claim expires or the signal of `modify` aborts.
- A lease of the same execution renews the lease.
- A revision that the execution does not pin answers 400 `custody.handover.lease_invalid`. An ended revision answers 409 `credential.revision.revoked`.
- A `worker.credential` report of the lease holder ends the lease after its write. A report of another execution keeps the lease.
- Before each retry of its report, the lease holder renews its lease. The lease ends at the report or at its expiry.
- The digest rule of the report does not change (`src/custody/handover.ts:194-247`).
- `modify` of the execution store takes the lease and adopts the stored value of the answer. It calls the pi-ai function with that value, then sends one report.
- pi-ai calls `modify` only for a token that expires within 5 minutes, so a model call takes no lease.
- The `worker` application keeps the handover key of an execution until `discard()`, and it zeroes the key there. Each lease answer opens with that key.
- The handover does not wait for a lease. A check of a revision under a lease does not refresh, because the lease holder pins the revision.

## D15 — Surfaces

- Engine CLI: `kanthord worker machine create|list|get|rotate|archive|join` and `kanthord worker instance create --machine <name>`.
- Each `--holder` of `kanthord llm credential` and of `kanthord agent cooldown clear` takes a machine name.
- Engine contract: each engine plan that changes an operation regenerates `static/` with `pnpm run build && node bin/kanthord.mjs gateway openapi` (`engine/AGENTS.md:39-40`).
- Engine `docs/cli/`: `worker.md`, `llm.md` and `agent.md` follow each change in the plan that makes it.
- Dashboard: the screens `/machines`, `/machines/new` and `/machines/:machineName` under the sidebar group `Workforce`.
- Dashboard: the `Machine` select of `Add instance` at the `worker` placement, and the credentials of the machine page and of the instance page.
- Dashboard: `Also seal to` with machines, and the `/llm` description line.
- Root: plan 01 writes the design pages, the reference pages and ERD 1 in one root pull request.
- Root: plan 08a moves the e2e scripts to one dev machine. Plan 08b asks for one sign-in for that machine.

## D16 — Schema and orphans

- Each plan edits the `CREATE TABLE` and `CREATE UNIQUE INDEX` text of the one migration of its service in place. It adds no migration and no data move (`engine/AGENTS.md:31-34`).
- A developer discards a local database after the merge.
- A plan removes each field, prop and helper that only fed the code that the plan removes. A plan removes no other dead code. It names other dead code in its pull request body.
