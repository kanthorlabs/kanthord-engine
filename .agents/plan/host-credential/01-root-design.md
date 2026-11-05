# Plan 01: Root — the design of the host credential

## Scope

This plan writes the rules of decisions D2 to D15 into the root design set, the root reference pages and ERD 1. The plans 02 to 08 implement these pages (decision D1). Earlier plan sets kept the root design in its own root pull request, for example root pull request #276 of `dogfood-fixes/`. This plan does the same.

Out of scope:

- Every engine file, every apps file and every e2e script. Plans 02 to 08 change them.
- The root `AGENTS.md` e2e text. Plan 08 changes it with the scripts that it describes.
- `docs/brainstorm/HANDOFF.md`. The decisions of this set carry no open item, except the rulings O1 to O3.

## Model

Opus at medium effort. The edits cross the pages of custody, the LLM component, the Worker Service, the Agent component and the dashboard.

## Sources

- `decisions.md` D2 to D15 of this set.
- `docs/brainstorm/custody.md:23-30`, `:39`, `:50`, `:55-56`, `:89-93` — the holder rules of today.
- `docs/brainstorm/custody.impl.md:18-21`, `:39`, `:44`, `:61`, `:81-87`, `:193-220`, `:226-227` — the record, the seal, the handover and the hold.
- `docs/brainstorm/custody.vocabulary.md:59-72` — `holder` and `sealed object`.
- `docs/brainstorm/llm.md:29-36`, `:64-65`, `:72` and `docs/brainstorm/llm.impl.md:126-168`, `:206-234`, `:279-297` — instance copies, their health, the instance login and the OAuth refresh of a check.
- `docs/brainstorm/worker-service.md:231`, `:271`, `:277`, `:317-340` and `docs/brainstorm/worker-service.impl.md:148-214`, `:215-373`, `:468-581`, `:1394-1428` — the worker application, the instance configuration, the copy blocks, the instances and the handover.
- `docs/brainstorm/agent.impl.md:104-108`, `:170`, `:201`, `:215-216`, `:233-236` — the holder rule and the cooldown.
- `docs/brainstorm/architecture.impl.md:1143-1147`, `:1232-1233`, `:1244`, `:1252-1295` — the credential table and the dashboard.

## Depends on

Nothing. Start from `origin/main` of `kanthorlabs/kanthord`.

## Provides

The approved rules of the host, the copy holder, the host copy, the refresh lease and the dashboard screens. Plans 02 to 08 cite them by section.

## Tasks

Each task edits the pages that it names. A task writes the decision and its constraints only, by root `AGENTS.md` "Ruled decisions". It keeps the ASD-STE100 rules of the root pages. After each task, grep the edited pages for sentences that name the same actors, by root `AGENTS.md` "Protocol for one design item".

### 01.1 Write the worker host and the host of an instance

- Files: `docs/brainstorm/worker-service.md`, `docs/brainstorm/worker-service.impl.md`, `docs/brainstorm/worker-service.vocabulary.md` (edit)
- Do:
  1. Add the term `worker host` to `worker-service.vocabulary.md`, after the term of the worker instance. State D2: one machine, a holder with its own key pair, no token, no connection, no binding.
  2. In `worker-service.md` "Worker instances" (`:317-340`), add the host rules of D2 and D3. Replace `:333` with the rule that a `worker` instance uses its own copy or the copy of its host. Replace the copy sentence of `:335` with the Reset key rule of the host of D11.
  3. In `worker-service.impl.md`, add the section "Worker hosts" after "Worker instances" (`:468`). Write the table `worker_host` with one row for each column and its rule, the indexes, the name rules, the shared name space with instances and the operations table of D2. Write each error code: `worker.host.name_invalid`, `worker.host.key_invalid`, `worker.host.name_conflict`, `worker.host.key_conflict`, `worker.host.not_found`, `worker.host.archived`, `worker.host.revision_conflict` and `worker.host.in_use`.
  4. In "The instance record" (`:472-490`), add the column `host` with its justification of D3. In "The operations of an instance" (`:524-554`), add `host` to the create input and to the instance record, and add 400 `worker.instance.host_invalid` to "Error codes of an instance".
  5. State that `worker.instance.create` refuses a host name with 409 `worker.instance.name_conflict`, and that `worker.instance.key_conflict` also covers each host fingerprint.
  6. After "The instance configuration" (`:193-214`), add the section "The host configuration" with D5: the value, the host file, `KANTHORD_HOST_CONFIG`, `kanthord worker host join`, the read at each use, the three codes and the child environment.
  7. In "The copy blocks" (`:215-373`), add the step that writes the host file with `kanthord worker host join` once for each machine, and the env value `KANTHORD_HOST_CONFIG` for each container host kind.
- Cite: D2, D3, D5, D11.
- Verify: `rg -n 'worker host' docs/brainstorm/worker-service*.md` lists the term, the section and the copy blocks.

### 01.2 Write the copy holder and the host copy in custody

- Files: `docs/brainstorm/custody.md`, `docs/brainstorm/custody.impl.md`, `docs/brainstorm/custody.vocabulary.md` (edit)
- Do:
  1. Rewrite `custody.vocabulary.md` "holder" (`:59-61`): `server`, a worker host, or a worker instance at the `worker` placement. Add the term `copy holder` with the rule of D4.
  2. Rewrite `custody.md:23-30` with the three holder kinds and the copy holder. Keep one copy for each holder.
  3. Rewrite `custody.md:55-56` with the dependents of D10 and the archive of a host.
  4. Rewrite `custody.md:91-93`: at the `worker` placement, the handover carries only the copy of the copy holder of the instance, sealed to the key of that holder.
  5. In `custody.impl.md:18-21`, name the host holder, and state that the LLM component validates a live instance or a live host.
  6. In `custody.impl.md:39` and `:44`, write the dependents of a host copy, the instance-copy exemption of D10, and the call of `archiveHeld(tx, host)` by the host archive.
  7. In `custody.impl.md:81-87`, add `copyHolderOf`, `InstanceKeys.hostOf` and the `keyOf` scope of D4. State `sealed_current` of a host copy (D11).
  8. In `custody.impl.md:193-205`, state the pin of the copy holder at the first use, the read of the pinned row afterwards, and the item field `holder` (D13).
  9. Replace `custody.impl.md:219-220` with the refresh lease of D14: the registry, `CREDENTIAL_LEASE_MS`, the answer, the refusals and the end at the report.
  10. In `custody.impl.md:226-227`, state that the port functions resolve the holder through `copyHolderOf` (D9).
- Cite: D4, D9, D10, D11, D13, D14.
- Verify: `rg -n 'copy holder' docs/brainstorm/custody*.md` lists the vocabulary term and each rule.

### 01.3 Write the host holder of the LLM component

- Files: `docs/brainstorm/llm.md`, `docs/brainstorm/llm.impl.md`, `docs/brainstorm/llm.vocabulary.md` (edit)
- Do:
  1. Rewrite `llm.md:29-36` with the host holder, the copy holder and the login on a host. Rewrite `llm.md:64-65` and `:72` for the copy of the copy holder.
  2. In `llm.impl.md` "Instance copies" (`:126-148`), write D6: the holders of a create, the worker-token scope, the copy holder of `get`, `sealed` and `report`, `llm.credential.holder_unknown` in place of `llm.credential.instance_unknown`, and the CLI seal rule.
  3. In "The health of an instance copy" (`:149-168`), write D8: the checks of each instance that uses a host copy, the raise for each instance of the host, `reported_by`, and the `holder` of each item.
  4. In "The login of an instance" (`:206-234`), write D7: the host holder, the runner pick, the session fields, the work read field `holder` and the report of the runner only.
  5. Replace `llm.impl.md:234`. One copy no longer has one refresh holder. Name the refresh lease of custody.
  6. Rewrite the session sentence of `llm.vocabulary.md:43` for a host holder.
- Cite: D6, D7, D8, D14.
- Verify: `rg -n 'instance_unknown' docs/brainstorm` prints nothing.

### 01.4 Write the holder rule and the cooldown of the Agent component

- Files: `docs/brainstorm/agent.impl.md` (edit)
- Do:
  1. In "The holder rule" (`:104-108`), state that custody checks the copy of the copy holder of each instance name.
  2. In `:170` and `:215-216`, state that the hold of a claimant is the hold of its copy holder.
  3. In `:233-236`, state that `holder` of the cooldown list is the group holder, and that `--holder` takes a host name.
- Cite: D4, D9.
- Verify: `rg -n 'copy holder' docs/brainstorm/agent.impl.md` lists the three rules.

### 01.5 Write the handover and the refresh lease of the Worker Service

- Files: `docs/brainstorm/worker-service.impl.md` (edit)
- Do:
  1. In "The credential handover" (`:1394-1428`), state the item field `holder` and the open with the key of that holder (D13). Replace "the instance private key" of the open rule.
  2. Add the operation `worker.credential.lease` with its route, policy, body, answer, `worker.credential.lease_held`, `custody.handover.lease_invalid` and the retry of the worker application (D14).
  3. State that the execution store takes the lease in `modify` at every placement, and that the handover does not wait for a lease.
  4. Add `worker.host.config_absent`, `worker.host.config_conflict` and `worker.host.config_invalid` to the error table of the worker application.
- Cite: D13, D14, D5.
- Verify: `rg -n 'worker.credential.lease' docs/brainstorm` lists the rule in `worker-service.impl.md` and in `custody.impl.md`.

### 01.6 Write the dashboard screens

- Files: `docs/brainstorm/architecture.impl.md` (edit)
- Do:
  1. Rewrite `:1143` and `:1147` with the host holder.
  2. Replace "Instance credentials live on the worker pages." of `:1232` with "Host and instance credentials live on the host and worker pages."
  3. After `:1244`, add the sidebar item `Hosts` of the group `Workforce`, with `/hosts`, `/hosts/new` and `/hosts/:hostName`.
  4. Add the section "The host pages" after "The worker pages" (`:1252-1295`). The list shows each host with `<name> (v<revision>)`, the short fingerprint and the instance count. The form sends the name and shows `host_configuration` once with `Copy` and the host copy block. The host page shows the header, the instances of the host with their connection line, the credentials of the host, and the danger zone with `Reset key` and `Archive`. Write the confirmations of Reset key and Archive, by the instance rules of `:1287-1293`.
  5. In "The worker pages", add the field `Host` of `Add instance` at the `worker` placement: a select of the live hosts, required, with the link `Add host` to `/hosts/new`. The instance page header adds `Host <name>` with a link to the host page.
  6. Rewrite section 4 of the instance page (`:1271`): each copy that the instance uses, with the line "Own copy" or "Shared from host <host>". A row of a host copy links to the host page for its actions.
  7. Rewrite `Add credential` of `:1274`. On the instance page, the sheet adds an own copy and states "The instance uses this copy in place of the copy of host <host>." `Also seal to` lists the live hosts first, then the live instances at the `worker` placement, grouped by worker.
  8. Rewrite `Sign in again` of `:1276` for a host copy. The sign-in panel of the host page runs on a connected instance of the host.
  9. State the health line of a host copy: "<failure reason hint> Reported by <reported_by> at <time>."
  10. Add the rule of each width of `:1295` to the host pages.
  11. In the board rotate sheet (`:1822-1823`), the OAuth holder line reads "<holder> keeps its own secret. Sign in again on its host page or its worker instance page." The holder lines end with "Open hosts" and "Open workers".
- Cite: D15, D7, D8, D12.
- Verify: `rg -n '/hosts' docs/brainstorm/architecture.impl.md` lists the sidebar item and the host pages.

### 01.7 Write the reference pages and ERD 1

- Files: `docs/reference/llm/credential.html`, `docs/reference/llm/login.html`, `docs/reference/worker/instance.html`, `docs/reference/worker/handover.html`, `docs/reference/worker/host.html` (new), `docs/reference/agent/cooldown.html`, `docs/reference/index.html`, `docs/reference/erd/01-setup.html`, `docs/reference/erd/index.html` (edit)
- Do:
  1. Copy the page structure of `docs/reference/worker/instance.html` into `worker/host.html`: function description, expected response, API shape and CLI shape of the five host operations and `worker host join`. Add a row to `docs/reference/index.html` beside the instance row (`:916`).
  2. In `llm/credential.html` "Instance copies", "Health of an instance copy", the failure table and the CLI shape, write D6, D8, D10, D11 and `llm.credential.holder_unknown`.
  3. In `llm/login.html` "Login on a worker instance", the failure table and the CLI shape, write D7.
  4. In `worker/instance.html`, add `host` to the record, the create body, the CLI option `--host` and the error table. Add `holder` and `health.reported_by` to `credentials[]` of `worker instance get`. Add `holder` to `login_sessions[]` of the work read.
  5. In `worker/handover.html`, add `holder` to the sealed item and the section of `worker.credential.lease`.
  6. In `agent/cooldown.html` (`:62-63`), state that the holder is `server`, a worker host or a worker instance.
  7. In ERD 1 (`01-setup.html:150`), add the entity `worker_host`, the column `worker_instance.host` and the relations `worker_instance }o..o| worker_host` and `credential }o..o| worker_host`, as names with no foreign key. Add the table `worker_host` to the map of `erd/index.html`.
- Cite: D2 to D14.
- Verify: `scripts/docs/check.sh` exits 0.

### 01.E Run the gate

- Do:
  1. Run the gate row 01 of `00-index.md`.
  2. Grep the edited pages for `instance holder` and `instance copy`. Each hit that now means "instance or host" names the holder kind that it means.
  3. Commit with `docs: design the worker host and the shared credential copy`, push the branch and open a pull request to root `main`. Name the rulings O1 to O3 in the pull request body.
- Verify: every command of the row exits 0. Ulrich approves the pull request before plans 02 and 05 start.

## Blockers

None. The rulings O1 to O3 can change the text of tasks 01.1, 01.2 and 01.5. Apply a ruling before the approval.
