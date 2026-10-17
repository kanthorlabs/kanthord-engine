# Plan 05: Scheduler, Worker, Project and Mission — the match and the coverage

## Scope

This plan delivers:

- `declared_works` on every worker declaration and on the catalog reads. `required_node_format` goes away.
- `traits` on the worker binding configuration with `project.bindings.worker.traits_invalid`, and on `workerBindingOf` and `workerBindingsOf`.
- `claimFacts` and `claimFactsOf` of the Mission Service.
- The match of the Scheduler Service: `admits` in the claim walk, `covered`, `unmatchedClaims`, and no work for an unknown worker.
- The coverage refusals `mission.node.requires_unmatched` and `project.bindings.worker.node_unmatched`, and the unmatched pairs of the import preview.

Out of scope:

- The on-demand request and the eligibility report (decision D23). No code exists for either.
- The dashboard "no taker" view (plan 07).

## Model

Opus at medium effort. The plan wires a collaboration cycle between three services and adds the probe of the import preview.

## Sources

- `docs/brainstorm/scheduler-service.md:101-110`, `:182-193` — the work pull, the declared states and works, and the claim kinds.
- `docs/brainstorm/scheduler-service.md:233-268` — the match, the coverage and the unmatched pair.
- `docs/brainstorm/scheduler-service.impl.md:99-105` — the eligibility report reads no match.
- `docs/brainstorm/scheduler-service.impl.md:149-188` — `admits`, `covered`, `unmatchedClaims` and the collaborations.
- `docs/brainstorm/scheduler-service.impl.md:276-279` — the match tests.
- `docs/brainstorm/scheduler-service.vocabulary.md:33-68` — the declared works, the match and the unmatched pair.
- `docs/brainstorm/mission-service.md:35-38` — the requires list and the node write refusal.
- `docs/brainstorm/mission-service.impl.md:66-68`, `:189`, `:191`, `:311`, `:555`, `:754` — the node write refusal, the import codes, the preview, the proposal refusal, the claim facts and their tests.
- `docs/brainstorm/project-service.md:97-109` — the traits of a worker binding.
- `docs/brainstorm/project-service.impl.md:133`, `:172-173`, `:220`, `:226-228`, `:374-375` — the binding-set write, the traits field, `workerBindingsOf` and the tests.
- `docs/brainstorm/project-service.vocabulary.md:43-75` — the trait.
- `docs/brainstorm/worker-service.md:22`, `:26-32`, `:44`, `:207` — the declarations and the compatibility declarations.
- `docs/brainstorm/worker-service.impl.md:54-55`, `:95` — `declared_works`, `declarationOf` and the catalog item.
- `docs/brainstorm/worker-service.vocabulary.md:274-290` — the compatibility declarations and the declared works.
- `docs/brainstorm/architecture.md:203-205`; `docs/brainstorm/architecture.impl.md:686-689` — the collaborations and the co-location.

## Depends on

- Plan 04 merged.

## Provides

The seams `claimFacts`, `claimFactsOf`, `workerBindingsOf` with `traits`, `workerBindingOf` with `traits`, `declarationOf` with `declared_works`, and `unmatchedClaims` of `00-index.md` "Seams".

## Tasks

### 05.1 Add the traits of a worker binding

- Files: `src/project/contract.ts`, `src/project/service.ts`, `src/project/service.test.ts` (edit)
- Do:
  1. `workerConfigSchema` (`src/project/contract.ts:201-222`) adds `traits: z.array(z.string()).optional()`.
  2. `validateWorker` (`src/project/service.ts:954-999`) refuses a nonlist value, a repeated key and a key that fails `traitKeySchema` of `src/kernel/trait.ts` with 400 `project.bindings.worker.traits_invalid` and `details: { binding, trait }`. Add the code to `ProjectErrorCode` (`src/project/contract.ts:92-113`).
  3. `WorkerBindingRow` (`src/project/contract.ts:829-841`) and `workerBindingOf` (`src/project/service.ts:1175-1200`) answer `traits: config.traits ?? []`. `workerBindingsOf` (`:1201-1225`) answers `traits` on each row (decision D13).
  4. A change of `traits` creates the next revision through the canonical comparison of `classify` (`src/project/store.ts:420-467`). A test asserts the new revision.
- Cite: `project-service.md:98-104`; `project-service.impl.md:172-173`, `:220`, `:226-228`, `:374`.
- Verify: `node --test --test-timeout=30000 src/project/service.test.ts` with the cases of `project-service.impl.md:374`.

### 05.2 Declare the works of each worker

- Files: `src/worker/catalog.ts`, `src/worker/contract.ts`, `src/worker/service.ts`, `src/worker/catalog.test.ts`, `src/worker/service.test.ts` (edit)
- Do:
  1. Delete `REQUIRED_NODE_FORMAT` (`src/worker/catalog.ts:8-14`) and `required_node_format` (`:24`, `:42`, `:51`, `:59`, `:90-97`).
  2. Add `declared_works: [Work.Implement, Work.Examine]` to `coder@1`, `reviewer@1` and `claude-code@1` (`:34-61`).
  3. `catalogItemSchema` (`src/worker/contract.ts:691-696`) and `catalogEntrySchema` (`:746-758`) answer `declared_works`.
  4. `declarationOf` (`src/worker/service.ts:454-462`) answers `null` for a name that the registry does not hold (decision D14).
- Cite: `worker-service.impl.md:54-55`, `:95`; `worker-service.vocabulary.md:280-290`.
- Verify: `node --test --test-timeout=30000 src/worker/catalog.test.ts src/worker/service.test.ts`.

### 05.3 Offer the claim facts of the Mission Service

- Files: `src/mission/claim-facts.ts` (create), `src/mission/claim-facts.test.ts` (create), `src/mission/contract.ts`, `src/mission/service.ts` (edit)
- Do:
  1. `claimFacts(tx, nodeId)` answers `{ work, requires }` at the revision that the open attempt pins, else the current revision, and `null` for an absent, retired or terminal node.
  2. `claimFactsOf(tx, projectId)` answers one row for the current revision of each node that is not terminal and not retired, and one more row when the open attempt pins another revision. `claims` holds `Available` and `Waiting`, and `External.Requested` when `requiredActionsOf` of that revision is nonempty.
  3. Add both to `MissionCollaborations` (`src/mission/contract.ts:83-86`) and to `MissionService` after `liveNodesPinning` (`src/mission/service.ts:890-892`). Neither writes a record.
- Cite: `mission-service.impl.md:555`; `scheduler-service.md:253-258`; `scheduler-service.impl.md:178`, `:184-185`.
- Verify: `node --test --test-timeout=30000 src/mission/claim-facts.test.ts` with "a node with a pull request action claims External.Requested", "an open attempt adds its pinned revision", "a terminal node answers no row".

### 05.4 Implement the match in the Scheduler Service

- Files: `src/scheduler/match.ts` (create), `src/scheduler/match.test.ts` (create), `src/scheduler/contract.ts`, `src/scheduler/claim.ts`, `src/scheduler/service.ts` (edit)
- Do:
  1. `src/scheduler/match.ts` holds `admits` and `covered` exactly as `scheduler-service.impl.md:153-171` states, and `unmatchedClaims(tx, dependencies, projectId)`. It reads `claimFactsOf` and `workerBindingsOf`, resolves each binding through `declarationOf`, skips a `null` declaration and ignores `instance_count`.
  2. `src/scheduler/contract.ts`: delete `NodeFormatField` (`:40-48`). `WorkerDeclarations.declarationOf` (`:305-311`) answers `declared_works`, or `null` for an unknown worker. `WorkerBindings` (`:312-324`) adds `traits` to `workerBindingOf` and adds `workerBindingsOf`. Add `MissionClaimFacts { claimFacts; claimFactsOf }`.
  3. `claimOnce` (`src/scheduler/claim.ts:142-199`): a `null` declaration answers `ClaimOutcome.None` (`:170`). Delete both `required_node_format` asserts (`:54-58`, `:171-175`).
  4. `acquire` (`:88-140`) passes the claimant `{ declared_node_states, declared_works, traits }` to `selectJob`. `selectJob` (`:45-86`) calls `claimFacts` for each job and skips a job that the claimant does not admit, before `transitions.claim` (`:71-82`).
  5. `SchedulerService` offers `unmatchedClaims(tx, projectId)` in its collaboration block (`src/scheduler/service.ts:159-225`). Add `facts: MissionClaimFacts` to `Dependencies` (`:126-138`).
- Cite: `scheduler-service.md:235-259`; `scheduler-service.impl.md:149-188`; decision D14; `mission-service.impl.md:66`.
- Verify: `node --test --test-timeout=30000 src/scheduler/match.test.ts src/scheduler/claim.test.ts src/scheduler/work-pull.test.ts` with the tests of `scheduler-service.impl.md:276-279`.

### 05.5 Wire the collaborations

- Files: `src/apps/server/index.ts` (edit)
- Do:
  1. The Scheduler takes `facts.claimFacts` and `facts.claimFactsOf` as closures over `mission` (`src/apps/server/index.ts:246-291`), and `bindings.workerBindingsOf` over `project.workerBindingsOf`.
  2. The Mission Service takes `unmatchedClaims` as a closure over `scheduler` in its scheduler collaborations (`:552-556`).
  3. The Project Service takes `unmatchedClaims` as a closure over `scheduler` (`:571-580`).
  4. The closures resolve the service variables at call time, as `transitions.claim` does today (`:249-254`).
- Cite: `architecture.impl.md:686-689`.
- Verify: `node --test --test-timeout=60000 src/apps/server/scheduler-integration.test.ts`.

### 05.6 Refuse a node write that adds an unmatched pair

- Files: `src/mission/coverage.ts` (create), `src/mission/coverage.test.ts` (create), `src/mission/contract.ts`, `src/mission/service.ts` (edit)
- Do:
  1. Add `MissionErrorCode.RequiresUnmatched = "mission.node.requires_unmatched"` and the dependency type `SchedulerMatch.unmatchedClaims` (`src/mission/contract.ts:88-101`).
  2. `guardCoverage(tx, dependencies, projectId, write)` reads `unmatchedClaims`, runs `write(tx)`, reads `unmatchedClaims` again, and throws 409 `mission.node.requires_unmatched` with `details: { claims }` for each pair of the after read whose `(node_id, claim)` the before read lacks (decision D24; `mission-service.impl.md:66`).
  3. Call it inside the commit closure of `import.apply` (`src/mission/service.ts:591-606`), `node.create` (`:832-846`), `node.update` (`:818-831`), `node.unblock` with a change (`:483-496`) and `proposal.approve` (`:469-482`).
- Cite: `mission-service.md:37-38`; `mission-service.impl.md:66-68`, `:311`, `:754`; `architecture.impl.md:687`.
- Verify: `node --test --test-timeout=30000 src/mission/coverage.test.ts` with "a node create with requires [platform.macos] and no such trait answers mission.node.requires_unmatched and writes nothing" and "an update of a node with an existing unmatched pair succeeds".

### 05.7 Report the unmatched pairs in the import preview

- Files: `src/mission/import.ts`, `src/mission/import-apply.ts`, `src/mission/service.ts`, `src/mission/import.test.ts` (edit)
- Do:
  1. When the three validation stages pass, the preview runs the write steps of `applyImport` (`src/mission/import-apply.ts:271-350`) in a probe transaction that throws to roll back (`mission-service.impl.md:192`).
  2. The preview answers one violation `mission.node.requires_unmatched` for each node with an added pair, with `filename`, `node_id` and `details: { claims }`. The preview writes nothing.
  3. The apply answers 409 `mission.node.requires_unmatched` through task 05.6.
- Cite: `mission-service.impl.md:187`, `:189`, `:191-192`; `scheduler-service.md:265`.
- Verify: `node --test --test-timeout=30000 src/mission/import.test.ts` with "preview reports the unmatched pairs and leaves the mission version unchanged".

### 05.8 Refuse a binding-set write that adds an unmatched pair

- Files: `src/project/contract.ts`, `src/project/service.ts`, `src/project/service.test.ts` (edit)
- Do:
  1. Add `ProjectErrorCode.WorkerNodeUnmatched = "project.bindings.worker.node_unmatched"` and the dependency `unmatchedClaims` to `Dependencies` (`src/project/service.ts:297-316`).
  2. In `writeBindings` (`:756-793`) read `unmatchedClaims` after `validateBinding` (`:774-775`) and again after `endUnavailableRegistrations` (`:777`). An added pair refuses the write with 409 and `details: { node_ids }` (`mission-service.impl.md:66`). The refusal writes no row.
- Cite: `project-service.md:106-109`; `project-service.impl.md:133`, `:375`.
- Verify: `node --test --test-timeout=30000 src/project/service.test.ts` with "a binding set without the only macOS reviewer answers project.bindings.worker.node_unmatched" and "a write that keeps an earlier unmatched pair succeeds".

### 05.9 Give every colocated test its stand-ins

- Files: `src/mission/test-support.ts`, `src/scheduler/test-support.ts`, `src/project/*.test.ts`, `src/scheduler/claim.test.ts`, `src/scheduler/work-pull.test.ts`, `src/scheduler/settlement.test.ts`, `src/worker/catalog.test.ts` (edit)
- Do:
  1. The default Mission and Project dependencies answer `unmatchedClaims: () => []` (decision D15).
  2. The default Scheduler dependencies answer `claimFacts` with `{ work: "implement", requires: [] }` and `claimFactsOf` with `[]` (`src/scheduler/test-support.ts:68-127`).
  3. The binding fixtures of `claim.test.ts:49-61` and `work-pull.test.ts:43-53` add `traits` and `declared_works` and drop `required_node_format`.
- Cite: decision D15.
- Verify: `node --test --test-timeout=30000 'src/scheduler/*.test.ts' 'src/project/*.test.ts' 'src/worker/*.test.ts' 'src/mission/*.test.ts'`.

### 05.10 Configure the covering worker bindings in the server fixtures

- Files: `src/apps/server/test-support.ts`, `src/apps/server/journey-support.ts`, `src/apps/server/delivery-support.ts`, `src/apps/server/e2e-*.test.ts`, `src/apps/server/*-integration.test.ts` (edit)
- Do:
  1. Export `COVERING_WORKER_BINDINGS` from `src/apps/server/test-support.ts` (decision D15).
  2. Each setup applies them in its binding set before its first node write. A setup that already names `coder@1` and `reviewer@1` bindings keeps its own bindings.
  3. `e2e-worker-registration.test.ts:251` asserts `declared_works` instead of `required_node_format`.
- Cite: `project-service.md:109`; `docs/brainstorm/assets/todoapp/README.md:58`; decision D15.
- Verify: `node --test --test-timeout=60000 'src/apps/server/*.test.ts'`.

### 05.11 Prove the match end to end

- Files: `src/apps/server/e2e-match.test.ts` (create)
- Do: write the rows of the section E2E below.
- Cite: `scheduler-service.vocabulary.md:56-67`; `project-service.vocabulary.md:52-74`.
- Verify: `node --test --test-timeout=60000 src/apps/server/e2e-match.test.ts`.

### 05.12 Regenerate OpenAPI

- Files: `static/openapi.yaml`, `static/openapi/worker/catalog.list.yaml`, `static/openapi/worker/catalog.get.yaml`, `static/openapi/project/bindingSet.get.yaml` (generated), `src/apps/server/openapi-integration.test.ts` (edit)
- Lane: main session (decision D20).
- Do: run `pnpm run build && node bin/kanthord.mjs gateway openapi`.
- Cite: `engine/AGENTS.md:454-463`.
- Verify: `node --test --test-timeout=60000 src/apps/server/openapi-integration.test.ts`.

### 05.13 Update the CLI pages

- Files: `docs/cli/worker.md`, `docs/cli/project.md`, `docs/cli/mission.md`, `docs/cli/scheduler.md` (edit)
- Lane: main session (decision D20).
- Do:
  1. `docs/cli/worker.md:245-262`: the catalog answers `declared_works`; delete the `required_node_format` prose; add the works column to the catalog table.
  2. `docs/cli/project.md`: add `traits` to the worker binding configuration (`:367-418`) and to the example (`:298-307`); add the rows `project.bindings.worker.node_unmatched` and `project.bindings.worker.traits_invalid` after `:670`.
  3. `docs/cli/mission.md`: add the row `mission.node.requires_unmatched` and its preview violation; name the coverage check of import apply, node create, node update, unblock with a change and proposal approve.
  4. `docs/cli/scheduler.md`: the work pull admits a node through the match; an unknown worker answers no work.
- Cite: root `AGENTS.md:107-108`; decision D22.
- Verify: `pnpm exec prettier --check docs/cli/*.md`.

### 05.E Run the gate

- Do: run the gate row 05 of `00-index.md`.
- Verify: every command of the row exits 0, and the `rg` prints nothing.

## E2E

- Test file: `src/apps/server/e2e-match.test.ts`.
- Harness: `gatewayFixture` of `src/apps/server/test-support.ts:316` and `kanthord` of `src/apps/server/cli-support.ts:122`. Setup goes through the CLI alone.

Setup, in order (each command exits 0):

1. `kanthord project create --name atlas` → `projectId`.
2. `kanthord project binding apply <projectId> --file bindings.json` with a repository binding `api-repo` and the worker bindings `linux-coder` (`coder@1`, `traits: []`), `linux-reviewer` (`reviewer@1`, `traits: []`), each with `instance_count: 1`.
3. `kanthord mission get <projectId>` → `missionId`, version `M`.

| Id     | Commands                                                                                                                                                                                  | Exit | Expect                                                                                                   |
| ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------- |
| EF05.1 | `kanthord mission node create <missionId> --file ios.json` with `work: implement`, `requires: ["platform.macos"]`                                                                         | 1    | stderr starts with `mission.node.requires_unmatched:`; `node list` holds no node                         |
| EF05.2 | `binding apply` that adds `macos-coder` (`coder@1`, `traits: ["platform.macos", "toolchain.xcode"]`) and `macos-reviewer` (`reviewer@1`, `traits: ["platform.macos"]`); then EF05.1 again | 0, 0 | the node exists                                                                                          |
| EF05.3 | `binding apply` that omits `macos-reviewer`                                                                                                                                               | 1    | stderr starts with `project.bindings.worker.node_unmatched:`; the binding-set version is unchanged       |
| EF05.4 | `binding apply` with the trait `platform.macOS`                                                                                                                                           | 1    | stderr starts with `project.bindings.worker.traits_invalid:`                                             |
| EF05.5 | A work pull of a `linux-coder` instance                                                                                                                                                   | 0    | `kind` `no-work`; the node stays `Available` with its job                                                |
| EF05.6 | A work pull of a `macos-coder` instance                                                                                                                                                   | 0    | `kind` `claimed`, `execution.node_id` = the node                                                         |
| EF05.7 | `kanthord mission import preview` of an export of the mission with `requires: ["platform.linux"]` on the node                                                                             | 0    | one violation `mission.node.requires_unmatched` with `details.claims`; the mission version stays `M + 1` |
| EF05.8 | `kanthord worker catalog list`                                                                                                                                                            | 0    | each item holds `declared_works` `["implement", "examine"]` and no `required_node_format`                |

## Blockers

None.
