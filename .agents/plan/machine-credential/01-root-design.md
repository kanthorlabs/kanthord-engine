# Plan 01: Root — the design of the machine credential

## Scope

This plan writes the rules of decisions D2 to D15 into the root design set, the root reference pages and ERD 1. The plans 02 to 08b implement these pages (decision D1). Earlier plan sets kept the root design in its own root pull request, for example root pull request #276 of `dogfood-fixes/`. This plan does the same.

Out of scope:

- Every engine file, every apps file and every e2e script. Plans 02 to 08b change them.
- The root `AGENTS.md` e2e text. Plans 08a and 08b change it with the scripts that it describes.
- `docs/brainstorm/HANDOFF.md`. The decisions of this set carry no open item, except the open ruling O3.

## Model

Opus at medium effort. The edits cross the pages of custody, the LLM component, the Worker Service, the Agent component and the dashboard.

## Sources

- `decisions.md` D2 to D15 of this set.
- `docs/brainstorm/custody.md:23-30`, `:39`, `:50`, `:55-56`, `:89-93` — the holder rules of today.
- `docs/brainstorm/custody.impl.md:18-21`, `:39`, `:44`, `:61`, `:81-87`, `:193-220`, `:226-227` — the record, the seal, the handover and the hold.
- `docs/brainstorm/custody.vocabulary.md:59-72` — `holder` and `sealed object`.
- `docs/brainstorm/llm.md:29-36`, `:64-65`, `:72` — the instance copies of the LLM component.
- `docs/brainstorm/llm.impl.md:126-168`, `:206-234`, `:279-297` — the instance copies, their health, the instance login and the OAuth refresh of a check.
- `docs/brainstorm/worker-service.vocabulary.md:20-29` — the term "host" of a worker: `kanthord` or an external harness.
- `docs/brainstorm/worker-service.md:231`, `:271`, `:277`, `:317-340` — the server instance, the leak of an instance key and the instance rules.
- `docs/brainstorm/worker-service.impl.md:148-214`, `:215-373`, `:468-581`, `:582-656`, `:1394-1428` — the worker application, the instance configuration, the copy blocks, the instances, the instance exchange and the handover.
- `docs/brainstorm/agent.impl.md:104-108`, `:170`, `:201`, `:215-216`, `:233-236` — the holder rule and the cooldown.
- `docs/brainstorm/architecture.impl.md:1143-1147`, `:1232-1233`, `:1244`, `:1252-1295`, `:1819-1823` — the credential table, the dashboard and the board rotate sheet.

## Depends on

Nothing. Start from `origin/main` of `kanthorlabs/kanthord`.

## Provides

The approved rules of the machine, the copy holder, the machine copy, the refresh lease and the dashboard screens. Plans 02 to 08b cite them by section.

## Tasks

Each task edits the pages that it names. A task writes the decision and its constraints only, by root `AGENTS.md` "Ruled decisions". It keeps the ASD-STE100 rules of the root pages. After each task, grep the edited pages for sentences that name the same actors. Root `AGENTS.md` "Protocol for one design item" states this check.

### 01.1 Write the worker machine and the machine of an instance

- Files: `docs/brainstorm/worker-service.md`, `docs/brainstorm/worker-service.impl.md`, `docs/brainstorm/worker-service.vocabulary.md` (edit)
- Do:
  1. Add the term `worker machine` to `worker-service.vocabulary.md`, after the term of the worker instance. State D2: one computer, a holder with its own key pair, no token, no connection, no binding.
  2. In the same term, state that "host" keeps its meaning of `:20-29`. A worker machine is no host.
  3. In `worker-service.md` "Worker instances" (`:317-340`), add the machine rules of D2 and D3.
  4. Replace `:333` with the rule that a `worker` instance uses its own copy or the copy of its machine.
  5. Keep the Reset key rule of `:335` for the own copies of an instance. Add the Reset key rule of a machine of D11 beside it.
  6. Rewrite `:271` and `:277` by D11. A leaked instance configuration also exposes the machine key. Recovery is a Reset key of the instance and of the machine, then a new sign-in for each machine copy.
  7. In `worker-service.impl.md`, add the section "Worker machines" after "Worker instances" (`:468`). Write the table `worker_machine` with one row for each column and its rule.
  8. In that section, write the indexes, the name rules, the shared name space with instances and the operations table of D2.
  9. Write each error code: `worker.machine.name_invalid`, `worker.machine.key_invalid`, `worker.machine.name_conflict`, `worker.machine.key_conflict`, `worker.machine.not_found`, `worker.machine.archived`, `worker.machine.revision_conflict` and `worker.machine.in_use`.
  10. In "The instance record" (`:472-490`), add the column `machine` with its justification of D3.
  11. In "The operations of an instance" (`:524-554`), add `machine` to the create input and to the instance record. Add 400 `worker.instance.machine_invalid` to "Error codes of an instance".
  12. State that `worker.instance.create` refuses a machine name with 409 `worker.instance.name_conflict`. State that `worker.instance.key_conflict` also covers each machine fingerprint.
  13. In "The instance exchange" (`:582-656`), add `machine` to the heartbeat answer.
  14. After "The instance configuration" (`:193-214`), add the section "The machine configuration" with D5. Write the value, the machine file, `KANTHORD_MACHINE_CONFIG` and `kanthord worker machine join`.
  15. In that section, write the read at each use, the read at a heartbeat, the claim gate, the three codes and the child environment.
  16. In "The copy blocks" (`:215-373`), add the step that writes the machine file with `kanthord worker machine join`. The step runs once for each machine. Each container host kind sets `KANTHORD_MACHINE_CONFIG` instead.
- Cite: D2, D3, D5, D11.
- Verify: `rg -n 'worker machine' docs/brainstorm/worker-service*.md` lists the term, the section and the copy blocks.

### 01.2 Write the copy holder and the machine copy in custody

- Files: `docs/brainstorm/custody.md`, `docs/brainstorm/custody.impl.md`, `docs/brainstorm/custody.vocabulary.md` (edit)
- Do:
  1. Rewrite `custody.vocabulary.md` "holder" (`:59-61`): `server`, a worker machine, or a worker instance at the `worker` placement. Add the term `copy holder` with the rule of D4.
  2. Rewrite `custody.md:23-30` with the three holder kinds and the copy holder. Keep one copy for each holder.
  3. Rewrite `custody.md:55-56` with the dependents of D10 and the archive of a machine.
  4. Rewrite `custody.md:91-93`. At the `worker` placement, the handover carries only the copy of the copy holder of the instance. That copy is sealed to the key of its holder.
  5. In `custody.impl.md:18-21`, name the machine holder. State that the LLM component validates a live instance or a live machine.
  6. In `custody.impl.md:39` and `:44`, write the dependents of a machine copy and the instance-copy exemption of D10. State that the machine archive calls `archiveHeld(tx, machine)`.
  7. In `custody.impl.md:81-87`, add `copyHolderOf`, `InstanceKeys.machineOf` and the `keyOf` scope of D4. State `sealed_current` of a machine copy (D11).
  8. In `custody.impl.md:193-205`, state the pin of the copy holder at the first use and the read of the pinned row afterwards. Add the item field `holder` (D13).
  9. Replace `custody.impl.md:219-220` with the refresh lease of D14. Write the registry, `CREDENTIAL_LEASE_MS`, the answer, the refusals, the renew and the end of a lease.
  10. In `custody.impl.md:226-227`, state D9. `holdOf` at the claim resolves the claimant through `copyHolderOf`. `hold` and `release` of a stop take the holder of the pinned row.
- Cite: D4, D9, D10, D11, D13, D14.
- Verify: `rg -n 'copy holder' docs/brainstorm/custody*.md` lists the vocabulary term and each rule.

### 01.3 Write the machine holder of the LLM component

- Files: `docs/brainstorm/llm.md`, `docs/brainstorm/llm.impl.md`, `docs/brainstorm/llm.vocabulary.md` (edit)
- Do:
  1. Rewrite `llm.md:29-36` with the machine holder, the copy holder and the login on a machine. Rewrite `llm.md:64-65` and `:72` for the copy of the copy holder.
  2. In `llm.impl.md` "Instance copies" (`:126-148`), write D6. Write the holders of a human create and the worker-token reads.
  3. State that a worker-token create and rotate act only on the copy of its own instance.
  4. Write the copy holder of `get`, `sealed` and `report`, `llm.credential.holder_unknown` in place of `llm.credential.instance_unknown`, and the CLI seal rule.
  5. In "The health of an instance copy" (`:149-168`), write D8. Write the checks of each instance that uses a machine copy, the counter of each holder, `versionOf`, `reported_by` and the `holder` of each item.
  6. In "The login of an instance" (`:206-234`), write D7. Write the machine holder, the runner pick, the session fields, the work read field `holder` and the report of the runner only.
  7. Replace `llm.impl.md:234`. One copy no longer has one refresh holder. Name the refresh lease of custody.
  8. Rewrite the session sentence of `llm.vocabulary.md:43` for a machine holder.
- Cite: D6, D7, D8, D14.
- Verify: `rg -n 'llm\.credential\.instance_unknown' docs/brainstorm` prints nothing.

### 01.4 Write the holder rule and the cooldown of the Agent component

- Files: `docs/brainstorm/agent.impl.md` (edit)
- Do:
  1. In "The holder rule" (`:104-108`), state that custody checks the copy of the copy holder of each instance name.
  2. In `:170` and `:215-216`, state that the hold of a claimant at the claim is the hold of its copy holder.
  3. Keep `:201`. A stop holds the copy of the row that the execution pins, so `hold` takes the holder of that row.
  4. In `:233-236`, state that `holder` of the cooldown list is the group holder, and that `--holder` takes a machine name.
- Cite: D4, D9.
- Verify: `rg -n 'copy holder' docs/brainstorm/agent.impl.md` lists the rules of steps 1 and 2.

### 01.5 Write the handover and the refresh lease of the Worker Service

- Files: `docs/brainstorm/worker-service.impl.md` (edit)
- Do:
  1. In "The credential handover" (`:1394-1428`), state the item field `holder` and the open with the key of that holder (D13). Replace "the instance private key" of the open rule.
  2. Add the operation `worker.credential.lease` with its route, policy, body and answer (D14).
  3. Add `worker.credential.lease_held`, `custody.handover.lease_invalid` and the retry of the worker application. The retry ends at the claim expiry or at the abort of `modify`.
  4. State that the execution store takes the lease in `modify` at every placement. State that the handover does not wait for a lease.
  5. State that the worker application keeps the handover key until `discard()`. The lease holder renews its lease before each retry of its report.
  6. Add `worker.machine.config_absent`, `worker.machine.config_conflict` and `worker.machine.config_invalid` to the error table of the worker application.
- Cite: D13, D14, D5.
- Verify: `rg -n 'worker.credential.lease' docs/brainstorm` lists the rule in `worker-service.impl.md` and in `custody.impl.md`.

### 01.6 Write the dashboard screens

- Files: `docs/brainstorm/architecture.impl.md` (edit)
- Do:
  1. Rewrite `:1143` and `:1147` with the machine holder.
  2. Replace "Instance credentials live on the worker pages." of `:1232` with "Machine and instance credentials live on the machine and worker pages."
  3. After `:1244`, add the sidebar item `Machines` of the group `Workforce`, with `/machines`, `/machines/new` and `/machines/:machineName`.
  4. Add the section "The machine pages" after "The worker pages" (`:1252-1295`). The list shows each machine with `<name> (v<revision>)`, the short fingerprint and the instance count.
  5. The form sends the name. It shows `machine_configuration` once with `Copy` and the machine copy block.
  6. The machine page shows the header, the instances of the machine with their connection line, the credentials of the machine, and the danger zone.
  7. The danger zone holds `Reset key` and `Archive`. Write their confirmations by the instance rules of `:1287-1293`.
  8. Extend the notice of `:1273` to the machine page. The notice names each project that an instance of the machine serves.
  9. In "The worker pages", add the field `Machine` of `Add instance` at the `worker` placement. It is a required select of the live machines, with the link `Add machine` to `/machines/new`.
  10. The instance page header adds `Machine <name>` with a link to the machine page.
  11. Rewrite section 4 of the instance page (`:1271`). It lists each copy that the instance uses, with the line "Own copy" or "Shared from machine <machine>".
  12. A row of a machine copy links to the machine page for its actions.
  13. Rewrite the Reset key list of `:1288`. The instance Reset key lists only the copies whose `holder` is the instance.
  14. Rewrite `Add credential` of `:1274`. On the instance page, the sheet adds an own copy. It states "The instance uses this copy in place of the copy of machine <machine>."
  15. `Also seal to` lists the live machines first, then the live instances at the `worker` placement, grouped by worker.
  16. Rewrite `Sign in again` of `:1276` for a machine copy. The sign-in panel of the machine page runs on a connected instance of the machine.
  17. State the health line of a machine copy: "<failure reason hint> Reported by <reported_by> at <time>."
  18. Add the rule of each width of `:1295` to the machine pages.
  19. In the board rotate sheet (`:1822-1823`), the OAuth holder line reads "<holder> keeps its own secret. Sign in again on its machine page or its worker instance page."
  20. The holder lines of the board rotate sheet end with "Open machines" and "Open workers".
- Cite: D15, D7, D8, D11, D12.
- Verify: `rg -n '/machines' docs/brainstorm/architecture.impl.md` lists the sidebar item and the machine pages.

### 01.7 Write the reference pages and ERD 1

- Files: `docs/reference/llm/credential.html`, `docs/reference/llm/login.html`, `docs/reference/worker/instance.html`, `docs/reference/worker/handover.html`, `docs/reference/worker/machine.html` (new), `docs/reference/agent/cooldown.html`, `docs/reference/index.html`, `docs/reference/erd/01-setup.html`, `docs/reference/erd/index.html` (edit)
- Do:
  1. Copy the page structure of `docs/reference/worker/instance.html` into `worker/machine.html`. Write the function description, the answers, the API shape and the CLI shape of the five machine operations and `worker machine join`.
  2. Add a row to `docs/reference/index.html` beside the instance row (`:916`).
  3. In `llm/credential.html` "Instance copies", "Health of an instance copy", the failure table and the CLI shape, write D6, D8, D10, D11 and `llm.credential.holder_unknown`.
  4. In `llm/login.html` "Login on a worker instance", the failure table and the CLI shape, write D7.
  5. In `worker/instance.html`, add `machine` to the record, the create body, the heartbeat answer, the CLI option `--machine` and the error table.
  6. In the same page, add `holder` and `health.reported_by` to `credentials[]` of `worker instance get`. Add `holder` to `login_sessions[]` of the work read.
  7. In `worker/handover.html`, add `holder` to the sealed item and the section of `worker.credential.lease`.
  8. In `agent/cooldown.html` (`:62-63`), state that the holder is `server`, a worker machine or a worker instance.
  9. In ERD 1 (`01-setup.html:150`), add the entity `worker_machine` and the column `worker_instance.machine`.
  10. Add the relations `worker_instance }o..o| worker_machine` and `credential }o..o| worker_machine` as names with no foreign key. Add the table `worker_machine` to the map of `erd/index.html`.
- Cite: D2 to D14.
- Verify: `scripts/docs/check.sh` exits 0.

### 01.E Run the gate

- Do:
  1. Run the gate row 01 of `00-index.md`.
  2. Grep the edited pages for `instance holder` and `instance copy`. Each hit that now means "instance or machine" names the holder kind that it means.
  3. Grep the edited pages for `host`. Each hit keeps the meaning of `worker-service.vocabulary.md:20-29` or names a container host kind.
  4. Commit with `docs: design the worker machine and the shared credential copy`. Push the branch and open a pull request to root `main`. Name the open ruling O3 in the pull request body.
- Verify: every command of the row exits 0. Ulrich approves the pull request before plans 02 and 05 start.

## Blockers

None. A ruling of O3 can change the text of task 01.2 and of D12. Apply it before the approval.
