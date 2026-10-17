# Plan 03: Mission Service — flat nodes with work and requires

## Scope

This plan delivers:

- `mission_node` without `kind` and `parent_id`. `mission_node_revision` with non-null `work`, `requires` and `tasks`.
- `Work` (`implement`, `examine`) and `requires` in `Content`. The node read answers both at the claim revision.
- No containment edge, no `node move`, no `NodeKind`, no `EdgeKind`, no descendant retirement, no parent create rule.
- The node file and task file grammar, the import and the export of both formats.
- The binding rule table by work with no binding from the project (R11). An `implement` node names exactly one repository binding until plan 09 (decision D28). An `examine` node names zero or more. Every node names zero or more storage bindings as an ordered list.
- The storage grant over that ordered list: the first enabled binding that the signing call accepts and that holds no failed upload check, the record of a failed upload check, and `mission.evidence.storage_unavailable` (R8, R10, decision D29).
- `mission.node.work_locked`.
- `node list --work`.
- Every `kind`-keyed rule of the release obligation, the frozen action, the evidence, the assessment and the proposal becomes a `work`-keyed rule.
- The worker unit selects its method form from `work` of the pinned revision.

Out of scope:

- The match, the coverage refusals and `traits` (plan 05). `requires` is stored and read here, and no claim reads it yet.
- The worker file and symbol renames (plan 04).
- An `implement` node with two or more repository bindings (plan 09).

## Model

Opus at medium effort. The plan replaces the kind model in about forty files, and the storage failover is new code.

## Sources

- `docs/brainstorm/mission-service.md:15-38` — the mission, the node, the work, the requires list and the work lock.
- `docs/brainstorm/mission-service.md:40-46` — the tasks of an `implement` node; an `implement` node with no task is its own single work unit.
- `docs/brainstorm/mission-service.md:73-89` — every node names its bindings, the counts by work and the ordered storage list.
- `docs/brainstorm/mission-service.md:303-307` — the storage grant, the failed upload check and the pinned read and delete.
- `docs/brainstorm/mission-service.md:112`, `:142`, `:161-173` — the human writes the work; a task names its node; the retirement.
- `docs/brainstorm/mission-service.md:201-203` — the revision covers the work, the requires list and the tasks.
- `docs/brainstorm/mission-service.md:250-258` — the verification coverage of an `implement` node; an `examine` node holds no task.
- `docs/brainstorm/mission-service.md:315-320`, `:382-387`, `:409-410`, `:498` — the evidence, the evaluation scope and the start point by work.
- `docs/brainstorm/mission-service.impl.md:36-77` — the node content, the rule table with no project binding and the content codes.
- `docs/brainstorm/mission-service.impl.md:363-386` — the object evidence grant and the upload check.
- `docs/brainstorm/mission-service.impl.md:108` — an `examine` node requires no external action.
- `docs/brainstorm/mission-service.impl.md:125-150` — the plan file grammar.
- `docs/brainstorm/mission-service.impl.md:165-191` — the export, the import stages and the import codes.
- `docs/brainstorm/mission-service.impl.md:194-209` — the node API admission.
- `docs/brainstorm/mission-service.impl.md:229-230`, `:256`, `:263`, `:306`, `:317`, `:354-358` — the verification coverage, the rationale, the proposal dependency, the copy of `requires`, the release obligation and the repository address by work.
- `docs/brainstorm/mission-service.impl.md:493-498` — the node read.
- `docs/brainstorm/mission-service.impl.md:551`, `:561` — the rebind revision and the retirement set.
- `docs/brainstorm/mission-service.impl.md:613-617` — the revision change and `changed_fields`.
- `docs/brainstorm/mission-service.impl.md:745-826` — the grammar, rule-table, work-lock and content tests.
- `docs/brainstorm/mission-service.vocabulary.md:11-31`, `:77-105`, `:606-666` — the rule table, the work, the requires list and the plan file example.
- `docs/brainstorm/project-service.md:42-43` — a node names every binding, and the storage list.
- `docs/brainstorm/project-service.md:101` — the trait key form.
- `docs/brainstorm/worker-service.md:39-40`; `docs/brainstorm/worker-service.impl.md:56`, `:390` — the method form by work and the repositories of the setup read.
- `docs/brainstorm/assets/todoapp/plan/` — the grammar of a real import set.

## Depends on

- Plan 02 merged.

## Provides

| Seam or shape                                                | Signature                                                             | Owner file                        | Consumer plans |
| ------------------------------------------------------------ | --------------------------------------------------------------------- | --------------------------------- | -------------- |
| `Work`, `workSchema`                                         | `{ Implement: "implement", Examine: "examine" }`                      | `src/mission/contract.ts`         | 04, 05, 07     |
| `TRAIT_KEY_PATTERN`, `TRAIT_KEY_MAX_BYTES`, `traitKeySchema` | `/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)*$/`, `64`                       | `src/kernel/trait.ts`             | 05             |
| `storageBindingIdsOf`                                        | `(tx, bindings, revision): string[]` in write order                   | `src/mission/evidence-content.ts` | 09             |
| `Node.work`, `Node.requires`                                 | at the revision that the open attempt pins, else the current revision | `src/mission/contract.ts`         | 05, 07         |
| `MissionErrorCode.WorkLocked`                                | `mission.node.work_locked`                                            | `src/mission/contract.ts`         | 07             |

## Tasks

### 03.1 Rewrite the node and revision tables

- Files: `src/mission/migrations.ts`, `src/apps/server/migrations.test.ts` (edit)
- Do:
  1. In `createMissionTables` (`src/mission/migrations.ts:11-38`) delete `kind TEXT NOT NULL` and `parent_id TEXT REFERENCES mission_node(id)`. Add `work TEXT NOT NULL` and `requires TEXT NOT NULL` to `mission_node_revision`. Change `tasks TEXT` to `tasks TEXT NOT NULL`.
  2. In `src/apps/server/migrations.test.ts` delete the column `kind` of the raw insert (`:534`) and assert the new columns through `PRAGMA table_info`.
- Cite: decision D2; `mission-service.md:203`.
- Verify: `node --test --test-timeout=30000 src/apps/server/migrations.test.ts`.

### 03.2 Declare the work, the requires list and the trait key form

- Files: `src/kernel/trait.ts` (create), `src/kernel/trait.test.ts` (create), `src/mission/contract.ts`, `src/mission/contract.test.ts` (edit)
- Do:
  1. Create `src/kernel/trait.ts` with `TRAIT_KEY_PATTERN`, `TRAIT_KEY_MAX_BYTES = 64` and `traitKeySchema` (a string that matches the pattern and holds at most 64 UTF-8 bytes).
  2. In `src/mission/contract.ts` add `Work = { Implement: "implement", Examine: "examine" }` and `workSchema`. Delete `NodeKind` (`:295-299`, `:446-447`) and `EdgeKind` (`:337-340`, `:454`).
  3. `contentSchema` (`:461-467`) adds `work: workSchema` and `requires: z.array(traitKeySchema)` with a uniqueness refine and the default `[]`. `taskBodySchema` keeps the five fields of decision D4.
  4. `nodeCreateSchema` (`:472-480`) drops `kind`, `parent_id` and `expected_parent_revision`. Delete `moveSchema` (`:490-498`), `RevisionWrite.NodeMove` (`:318`) and the operation `node.move` (`:2098-2110`).
  5. `edgeSchema` (`:588-599`) becomes `{ dependent_id, depends_on_id }` (decision D6).
  6. `importEntrySchema` (`:624-635`) and `exportEntrySchema` (`:637-648`) become the unions of decision D7.
  7. `nodeSchema` (`:1023-1038`) becomes one strict object: `nodeBase` without `parent_id`, the runnable fields, `work` and `requires` (decision D4).
  8. The `node.list` query (`:1989-1991`) replaces `kind` and `parent_id` by `work: workSchema.optional()`. The `edge.list` query (`:1954`) drops `kind`.
  9. Add `MissionErrorCode.WorkLocked = "mission.node.work_locked"`. Delete `CreateRefused` (`:258`) and `KindChanged` (`:269`).
  10. Rewrite the descriptions that name a descendant, an initiative or an objective (`:2055`, `:2083`, `:2096`).
- Cite: `mission-service.md:29-35`; `mission-service.impl.md:40-41`, `:64-65`, `:168`, `:173`, `:495`; `project-service.md:101`; decisions D6, D7, D8.
- Verify: `node --test --test-timeout=30000 src/kernel/trait.test.ts src/mission/contract.test.ts` with the cases "a trait key of 64 bytes passes and 65 bytes fails", "`platform.macOS` fails", "a repeated key fails".

### 03.3 Store nodes without kind and edges without containment

- Files: `src/mission/store.ts`, `src/mission/revision.ts`, `src/mission/edge-read.ts` (edit)
- Do:
  1. `NodeRow` (`src/mission/store.ts:24-35`) drops `kind` and `parent_id`. `RevisionRow` adds `work` and `requires`.
  2. `insertNode` (`:132-163`) inserts `id`, `mission_id`, `filename`, `state`, `attempt`, `priority` and `created_at`.
  3. `listNodes` (`:226-255`) filters by `work` at the claim revision: the revision of the open attempt, else the current revision (`mission-service.impl.md:495`).
  4. `insertRevision` (`:305-328`) writes `work`, `requires` as JSON and `tasks` as JSON.
  5. `listEdges` (`:396-437`) reads the dependency rows alone. Delete the containment union (`:405-407`).
  6. `revisionFromRow` (`src/mission/revision.ts:21`) reads `work` and `requires`. `edgeRecord` (`src/mission/edge-read.ts:34-42`) answers the flat edge; `edgeCursor` (`:20-32`) drops the kind.
- Cite: `mission-service.md:27`; `mission-service.impl.md:495`; decision D6.
- Verify: `node --test --test-timeout=30000 src/mission/record-list.test.ts src/mission/service.test.ts`.

### 03.4 Validate the content by work and resolve the bindings

- Files: `src/mission/content.ts`, `src/mission/content.test.ts` (edit)
- Do:
  1. `bindingRules` (`src/mission/content.ts:36-55`) becomes `Record<Work, Record<BindingKind, Range>>` with the table of `mission-service.impl.md:57-61`. The repository range of `implement` is exactly one until plan 09 (decision D28).
  2. `validateNodeContent` (`:86-128`) takes `work`. An `examine` node with a task, an unknown `work`, a nonlist `requires`, a repeated key or a malformed key answer `mission.node.content_invalid` (`mission-service.impl.md:65`).
  3. `checkBindingRuleTable(work, resolved)` (`:153-177`) reads the row of the work.
  4. Add `resolveNodeBindings(tx, bindings, work, named)`. It resolves each named binding to the latest revision of that binding, keeps the write order, and takes no binding from the project (`mission-service.impl.md:52-53`). A repeated name, an absent list and a rule-table violation answer `mission.node.bindings_invalid` (`mission-service.impl.md:75`).
- Cite: `mission-service.md:73-87`; `mission-service.impl.md:48-61`, `:75`, `:788`, `:822`; decision D28.
- Verify: `node --test --test-timeout=30000 src/mission/content.test.ts` covering every cell of the rule table, "an implement node that names no repository binding answers mission.node.bindings_invalid", "an implement node with two repository bindings answers mission.node.bindings_invalid", "an examine node accepts zero, one and two repository bindings", "two storage bindings keep their write order" and "a write takes no binding from the project".

### 03.5 Parse node files and task files

- Files: `src/mission/parser.ts`, `src/mission/parser.test.ts` (edit)
- Do:
  1. `FIELD` (`src/mission/parser.ts:28-29`) drops `Kind` and `Parent` and adds `Work`, `Node` and `Requires`.
  2. `fields()` (`:127-163`) requires exactly one of `work` and `node`. A node file permits `id`, `work`, `depends_on`, `requires`, `bindings` and `verifications`. A task file permits `id`, `node`, `bindings` and `verifications`, and refuses `depends_on`, `requires` and `work`.
  3. A node file `id` takes `node_`; a task file `id` takes `task_`. Another prefix answers `mission.import.plan_invalid` with the file name.
  4. Delete the reasons `KindInvalid`, `ParentRequired`, `ParentForbidden` (`:41-44`) and add a reason for each new refusal.
- Cite: `mission-service.impl.md:129-148`, `:745-749`.
- Verify: `node --test --test-timeout=30000 src/mission/parser.test.ts` with three inline cases copied from `docs/brainstorm/assets/todoapp/plan/`: `foundation.md` (an `implement` node), `foundation-runtime.md` (a task) and `todo-api.md` (an `examine` node).

### 03.6 Resolve the import set without parents

- Files: `src/mission/import.ts`, `src/mission/import.test.ts` (edit)
- Do:
  1. Delete `REFERENCE.Parent` (`src/mission/import.ts:47`), `parent_id` and `parent_map` (`:69`, `:86`) and the parent rules of `planRules` (`:123-147`).
  2. `resolveReference` (`:280-317`): `node` of a task resolves to a node file with `work: implement`; another target answers `mission.import.reference_kind_invalid`. A `depends_on` name resolves to a node file; a task file answers the same code.
  3. Delete the `KindChanged` refusal of `resolveIdentity` (`:268-275`).
  4. `resolveBindings` (`:319-350`) calls `resolveNodeBindings` of task 03.4 with the work of the entry. A node file with no `bindings` names no binding.
  5. `checkVerificationCoverage` (`:352-373`) runs for each `implement` node with one or more tasks. An `implement` node with no task passes (`mission-service.md:256`).
  6. `resolveGraph` (`:375-423`) checks the cycle over the dependency edges alone. `entryChanged` (`:442`) compares `work`, `requires` and the node of each task. `droppedEdges` (`:448-481`) drops dependency edges alone.
  7. `modifiedNodes` (`:585-617`) propagates a task change to its node and a task move to both nodes. `checkImportCondition` (`:619-660`) reads the condition of each changed node.
- Cite: `mission-service.md:137-144`, `:179-199`; `mission-service.impl.md:182`, `:189-190`, `:750-752`, `:787`.
- Verify: `node --test --test-timeout=30000 src/mission/import.test.ts` with the rows of `kanthord-checks.md:21-28` as unit cases.

### 03.7 Apply the import and export both formats

- Files: `src/mission/import-apply.ts`, `src/mission/import-revisions.ts`, `src/mission/export.ts` (edit)
- Do:
  1. Delete `INSERT_ORDER` by kind (`src/mission/import-apply.ts:46`), the parent mapping (`:99`), the containment edges (`:106-149`) and the parent update (`:174-179`).
  2. `importContent` and `ownerRevision` (`src/mission/import-revisions.ts:25-43`, `:110-154`) write `work`, `requires` and `tasks` on every node revision, `[]` for an `examine` node.
  3. `serializePlanFile` (`src/mission/export.ts:21-33`) writes `work`, `depends_on`, `requires`, `bindings` and `verifications` on a node file, and `node`, `bindings` and `verifications` on a task file. `exportEntry` (`:35-67`) answers the entries of decision D7.
- Cite: `mission-service.impl.md:168-185`, `:769-770`; decision D7.
- Verify: `node --test --test-timeout=30000 src/mission/import.test.ts` with "export and import both formats unchanged" and "a no-op import of a terminal node returns no error".

### 03.8 Create, update and unblock a node with its work

- Files: `src/mission/node-create.ts`, `src/mission/node-update.ts`, `src/mission/control-unblock.ts`, `src/mission/node-rebind.ts`, `src/mission/admission.ts` (edit)
- Do:
  1. Delete `requireParent` (`src/mission/node-create.ts:62-122`) and the containment edge of `createNode` (`:274-284`). Delete `PARENT_CREATE_STATES` and `parentCreateAdmissible` (`src/mission/admission.ts:13-44`). `node create` admits a node at any time (`mission-service.impl.md:206`).
  2. `node update` and an unblock change answer 409 `mission.node.work_locked` with `details: { node_id, attempt }` when `work` changes on a node whose attempt reads 1 or more (`mission-service.impl.md:65`).
  3. Each write resolves its bindings through `resolveNodeBindings`. The write reads no stored binding and no project binding (`mission-service.impl.md:52`).
  4. `node rebind` (`src/mission/node-rebind.ts:140-164`) copies `work`, `requires` and the task snapshot unchanged (`mission-service.impl.md:551`).
  5. `changed_fields` names `work`, `requires` and `tasks` when they differ (`mission-service.impl.md:616`).
- Cite: `mission-service.md:33-34`, `:112`, `:118-128`; `mission-service.impl.md:65`, `:206`, `:551`, `:616`, `:753`.
- Verify: tests in `src/mission/service.test.ts` "node update refuses a work change after the first claim with mission.node.work_locked" and "node update changes work while the attempt reads 0".

### 03.9 Delete the move, the containment and the descendant retirement

- Files: `src/mission/node-move.ts` (delete), `src/mission/node-retire.ts`, `src/mission/dependency.ts`, `src/mission/service.ts` (edit)
- Do:
  1. Delete `src/mission/node-move.ts` and the `node.move` handler (`src/mission/service.ts:790-804`).
  2. `retirementSet` (`src/mission/node-retire.ts:44-78`) holds the named node alone (`mission-service.impl.md:561`).
  3. `validateCycle` (`src/mission/dependency.ts:56-84`) takes no parent map.
  4. The `edge.list` and `node.list` handlers (`src/mission/service.ts:629`, `:682-684`) pass the new queries.
- Cite: `mission-service.md:163`; `mission-service.impl.md:561`, `:777`.
- Verify: `node --test --test-timeout=30000 src/mission/service.test.ts` with "a node API retirement set holds the named node alone".

### 03.10 Key the execution rules on the work

- Files: `src/mission/transitions.ts`, `src/mission/frozen-action.ts`, `src/mission/control-close.ts`, `src/mission/evidence-content.ts`, `src/mission/execution-read.ts`, `src/mission/assessment-admit.ts`, `src/mission/currency.ts`, `src/mission/proposal-approve.ts` (edit)
- Do:
  1. `hasEvidence` (`src/mission/transitions.ts:104-140`): an `implement` node needs one `repository` asset of its one repository binding; an `examine` node needs one `produced` asset (`mission-service.impl.md:317`).
  2. `requiredActionsOf` (`src/mission/frozen-action.ts:21-66`) answers `[]` for an `examine` node (`mission-service.impl.md:108`).
  3. `landedEvidence` (`src/mission/control-close.ts:50-107`) admits a landed commit on an `implement` node; on an `examine` node it answers `mission.evidence.binding_mismatch` (`mission-service.impl.md:358`).
  4. `requireRepositoryAddress`, `repositoryBindingIdsOf`, `requireTestedInput` and `requiredVerifications` (`src/mission/evidence-content.ts:93-269`) read the work. `repositoryBindingIdsOf` of an `examine` node keeps its own bindings of task 02.8.
  5. `currentDependenciesOf` (`src/mission/execution-read.ts`) answers a dependency of either work. An `examine` dependency names no repository.
  6. `requireProposals` (`src/mission/assessment-admit.ts:66-106`): the proposer is an `examine` node, and `dependency_id` names a current direct dependency with `work: implement`.
  7. `approveProposal` (`src/mission/proposal-approve.ts:50-149`) creates an `implement` node with no parent and copies `bindings` and `requires` from the node of `dependency_id` (`mission-service.impl.md:306`).
- Cite: `mission-service.impl.md:108`, `:230`, `:263`, `:306`, `:317`, `:354-358`.
- Verify: `node --test --test-timeout=30000 src/mission/transitions.test.ts src/mission/frozen-action.test.ts src/mission/evidence-content.test.ts src/mission/proposal.test.ts`.

### 03.11 Grant an upload on the first working storage binding

- Files: `src/mission/evidence-content.ts`, `src/mission/evidence-submit.ts`, `src/mission/authorization.ts`, `src/mission/evidence-content-read.ts`, `src/mission/evidence-delete.ts` and their tests (edit)
- Do:
  1. `storageBindingIdsOf(tx, bindings, revision)` replaces `storageBindingIdOf` (`src/mission/evidence-content.ts:73-82`). It answers the storage bindings of the revision in write order.
  2. `submitEvidence` (`src/mission/evidence-submit.ts:168-214`) takes, for each `object` asset, the first storage binding of that list that is enabled, that `intake.storage.put` accepts, and that holds no failed upload check of decision D29. A refused signing call moves to the next binding. The commit pins the chosen binding in `storage_binding_id` (`:109-151`).
  3. A node with no storage binding answers 409 `mission.evidence.storage_binding_absent`. A node whose storage bindings all fail the rule answers 409 `mission.evidence.storage_unavailable` (`mission-service.impl.md:374-376`).
  4. `authorizeObjectPut` (`src/mission/authorization.ts:495-528`) admits the binding that the asset names when the storage list of the pinned revision holds it.
  5. A read and a delete of an asset use the binding that the asset pins and move to no other binding (`src/mission/evidence-content-read.ts:150-180`, `src/mission/evidence-delete.ts:105-115`).
- Cite: `mission-service.md:83-85`, `:303-307`; `mission-service.impl.md:53`, `:370-378`, `:791`; decision D29.
- Verify: `node --test --test-timeout=30000 src/mission/evidence-submit.test.ts src/mission/authorization.test.ts src/mission/evidence-content-read.test.ts src/mission/evidence-delete.test.ts` with "a disabled first binding grants the second", "a refused signing call grants the next binding", "no binding left answers mission.evidence.storage_unavailable" and "a read uses the pinned binding".

### 03.12 Record a failed upload check

- Files: `src/mission/migrations.ts`, `src/mission/record-store.ts`, `src/mission/evidence-complete.ts`, `src/apps/server/migrations.test.ts` and their tests (edit)
- Do:
  1. In `createExecutionRecordTables` of `src/mission/migrations.ts` add `mission_evidence_upload_failure (node_id, attempt, storage_binding_id, asset_id, failed_at)` with the primary key `(node_id, attempt, storage_binding_id)` (decisions D2, D29).
  2. `completeEvidence` (`src/mission/evidence-complete.ts:66-110`) writes one failure row when `intake.storage.check` answers `intake.storage.object_mismatch` (`src/intake/storage.ts:119-124`), then answers the refusal. The asset stays unpublished.
  3. The grant of task 03.11 skips a binding that holds a failure row of the same node and attempt.
- Cite: `mission-service.md:304-305`; `mission-service.impl.md:385`; decision D29.
- Verify: `node --test --test-timeout=30000 src/mission/evidence-complete.test.ts src/mission/evidence-submit.test.ts src/apps/server/migrations.test.ts` with "a failed check records the binding, and the next submission of the attempt takes the next binding".

### 03.13 Answer the work and the requires list on the node read

- Files: `src/mission/node-read.ts` (edit)
- Do: `nodeRecord` (`src/mission/node-read.ts:95-142`) answers `work` and `requires` at the revision that the open attempt pins, else at the current revision, and drops `parent_id`.
- Cite: `mission-service.impl.md:493-498`.
- Verify: a test in `src/mission/service.test.ts` "node get answers work and requires of the pinned revision while an attempt is open".

### 03.14 Update the colocated Mission tests

- Files: `src/mission/*.test.ts`, `src/mission/test-support.ts` (edit)
- Do:
  1. `evidenceHarness` and `controlHarness` (`src/mission/test-support.ts:101-219`) insert flat nodes with `work`.
  2. Replace each initiative fixture by an `examine` node and each objective fixture by an `implement` node. Delete the tests of `node move`, of the containment, of `create_refused`, of `kind_changed` and of the descendant retirement.
  3. Add the grammar, rule-table and work-lock tests of `mission-service.impl.md:745-826` that the tasks above do not cover.
- Cite: decision D19.
- Verify: `node --test --test-timeout=30000 'src/mission/*.test.ts'`.

### 03.15 Select the worker method form by work

- Files: `src/worker/unit/node-reads.ts`, `src/worker/unit/native-method.ts`, `src/worker/unit/native-agent.ts`, `src/worker/unit/evaluation.ts`, `src/worker/unit/evaluation-input.ts`, `src/worker/unit/judgement.ts`, `src/worker/unit/test-support.ts` and their tests (edit)
- Do:
  1. Replace `nodeKindOf` (`src/worker/unit/node-reads.ts:58-62`) by `workOf(revision) = revision.content.work`.
  2. `runNativeExecution` (`src/worker/unit/native-method.ts:81-139`) sends an `examine` node to the examine form and an `implement` node to the implement form.
  3. `NativeAgentInput.nodeKind` (`src/worker/unit/native-agent.ts:32-45`) becomes `work`; the repository layer reads one part for each repository binding of either work, as task 02.12 states (`:172-175`).
  4. `evaluation.ts`, `evaluation-input.ts` and `judgement.ts` read `work` instead of the kind (`evaluation.ts:77`, `:118`, `:141`, `:172-173`, `:211-212`; `evaluation-input.ts:97-156`; `judgement.ts:235-257`).
- Cite: `worker-service.md:39-40`; `worker-service.impl.md:56`.
- Verify: `node --test --test-timeout=30000 'src/worker/unit/*.test.ts'`.

### 03.16 Change the Mission CLI leaves

- Files: `src/apps/cli/mission.ts` (edit)
- Do:
  1. Delete `node move` (`src/apps/cli/mission.ts:229-237`, `:688-695`), `MOVE` (`:63`) and `NODE_MOVE_INVALID_NODE_ID` (`:117`).
  2. Replace `--kind` and `--parent` of `node list` (`:168-196`, `:647-660`) by `--work <implement|examine>` with the local code `cli.mission.node.list.invalid_work`. Delete `NODE_LIST_INVALID_KIND` and `NODE_LIST_INVALID_NODE_ID` (`:109-110`).
  3. Delete `--kind` of `edge list` (`:346-364`, `:817-820`) and `EDGE_LIST_INVALID_KIND` (`:126`).
- Cite: decisions D6, D8; `mission-service.impl.md:495`.
- Verify: `node --test --test-timeout=30000 src/apps/cli/index.test.ts src/apps/cli/completeness.test.ts`.

### 03.17 Move the server fixtures to flat nodes

- Files: `src/apps/server/journey-support.ts`, `src/apps/server/delivery-support.ts`, `src/apps/server/test-support.ts`, `src/apps/server/e2e-*.test.ts`, `src/apps/server/*-integration.test.ts`, `src/apps/server/mission-record-transport.test.ts` (edit)
- Do:
  1. `createJourneyNode(cli, projectId, filename, work, bindings, tasks?)` (`src/apps/server/journey-support.ts:63-113`) drops the parent and picks the verifications by work.
  2. `create` and `objective` of `delivery-support.ts:158-295`, `storageNode` and `provisionWorkerProject` of `test-support.ts:1679-1950` create an `implement` node with its tasks and its one named repository binding and, where a report is needed, an `examine` node that depends on it and names its repository bindings. No fixture relies on a project binding.
  3. Replace every initiative and objective of the E2E and integration files of the `00-index.md` match table (`e2e-mission-service`, `e2e-mission-attempts-controls`, `e2e-mission-execution-operations`, `e2e-mission-proposals`, `e2e-external-harness`, `e2e-internal-harness`, `e2e-delivery-admission`, `e2e-scheduler-execution`, `e2e-native-runtime`, `e2e-worker-action-performer`, `e2e-native-methods`, `e2e-worker-host`, `e2e-custody-handover`, `e2e-event-handoff`, `e2e-integration-journey`, `e2e-repository-actions`, `e2e-storage-grants`, `e2e-gateway-server`, `e2e-poll-acquisition`, `scheduler-integration`, `action-performer-integration`, `handover-integration`).
  4. Delete the E2E rows of `node move` and of the containment.
- Cite: decision D19.
- Verify: `node --test --test-timeout=60000 'src/apps/server/*.test.ts'`.

### 03.18 Regenerate OpenAPI

- Files: `static/openapi.yaml`, `static/openapi/mission/*.yaml` (generated), `src/apps/server/openapi-integration.test.ts` (edit)
- Lane: main session (decision D20).
- Do:
  1. Run `pnpm run build && node bin/kanthord.mjs gateway openapi`. The writer prunes `node.move.yaml`.
  2. `assertBlockedNode` (`src/apps/server/openapi-integration.test.ts:898-915`) asserts the one node shape. Delete the row `mission.node.move` (`:693`) and the `kind` and `parent_id` entries of the required list (`:1061`, `:1066`).
- Cite: `engine/AGENTS.md:454-463`.
- Verify: `node --test --test-timeout=60000 src/apps/server/openapi-integration.test.ts`.

### 03.19 Rewrite the Mission CLI page and the engine map

- Files: `docs/cli/mission.md`, `docs/cli/scheduler.md`, `AGENTS.md` (edit)
- Lane: main session (decision D20).
- Do:
  1. `docs/cli/mission.md`: the scope and the domain (`:35`, `:50`, `:59-79`, `:88`, `:123`), the inventory (`:194`, `:198`, `:201`), the filters (`:212-217`), the node and import sections (`:222-332`), the schema rows (`:719-761`, `:777`, `:819`, `:855-866`, `:904-910`), the binding table by work (`:737-743`) and the error rows (`:977`, `:986`, `:988`, `:991`, `:1059-1060`, `:1077-1078`, `:1082`, `:1085`, `:1090-1091`, `:1102`). Add the rows `mission.node.work_locked` and `cli.mission.node.list.invalid_work`.
  2. `docs/cli/scheduler.md:319`, `:552`: no objective, no parent effect.
  3. `AGENTS.md`: delete the row of `node-move.ts`; add the rows of `graph.ts`, `edge-read.ts` and `src/kernel/trait.ts`; rewrite `:152` as "Readiness, direct-dependency closure, and continuation conditions".
- Cite: root `AGENTS.md:107-108`; decision D22.
- Verify: `pnpm exec prettier --check docs/cli/mission.md docs/cli/scheduler.md AGENTS.md`.

### 03.E Run the gate

- Do: run the gate row 03 of `00-index.md`.
- Verify: every command of the row exits 0, and each `rg` prints nothing.

## E2E

`e2e-mission-service.test.ts` adds these rows. Setup imports the six Markdown files of the import set example (`mission-service.vocabulary.md:579-586`), with the content of the plan file example (`:606-660`).

| Id      | Commands                                                                                                           | Exit | Expect                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------ | ---- | ------------------------------------------------------------------------------------------------------ |
| EF03.1  | `kanthord mission import preview` and `apply` of the set                                                           | 0, 0 | three nodes and three edges; `add-password-reset.md` holds two tasks; `account-recovery.md` holds none |
| EF03.2  | `kanthord mission node list <missionId> --work examine`                                                            | 0    | one item, `work` `examine`, `requires` `[]`                                                            |
| EF03.3  | An import that changes `node:` of a task file to `account-recovery.md`                                             | 1    | stderr starts with `mission.import.reference_kind_invalid:`                                            |
| EF03.4  | `kanthord mission node ready <implementId>`, then `node update` that sets `work: examine`                          | 0, 1 | stderr starts with `mission.node.work_locked:`                                                         |
| EF03.5  | `kanthord mission node list <missionId> --work task`                                                               | 1    | stderr starts with `cli.mission.node.list.invalid_work:`                                               |
| EF03.6  | `kanthord mission export <missionId> --format markdown`                                                            | 0    | each node file holds `work:` and `requires:`, each task file holds `node:`                             |
| EF03.7  | `kanthord mission node create` of an `implement` node with `bindings: []`; then with two repository bindings       | 1, 1 | stderr starts with `mission.node.bindings_invalid:` each time                                          |
| EF03.8  | `kanthord mission node create` of an `examine` node with `bindings: []`                                            | 0    | the revision holds no binding; the project holds one repository binding                                |
| EF03.9  | `e2e-storage-grants.test.ts`: an `implement` node with two storage bindings, the first disabled; `evidence upload` | 0    | the asset pins the second binding                                                                      |
| EF03.10 | the same node with both storage bindings disabled; `evidence upload`                                               | 1    | stderr starts with `mission.evidence.storage_unavailable:`                                             |

## Blockers

None.
