import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { importPlan } from "./import-plan.ts";
import type {
  ImportPlanError,
  ImportPlanInput,
  ImportPlanResult,
} from "./import-plan.ts";
import { validatePlan } from "../../queries/plan/validate-plan.ts";
import { exportPlan } from "../../queries/plan/export-plan.ts";
import {
  canonicalChoicesJson,
  canonicalDocumentsJson,
} from "../../domain/plan-hash.ts";
import type { Choice } from "../../domain/plan-choice.ts";
import type { IdentityKind } from "../../domain/identity.ts";
import {
  createBlobStore,
  createPlanReader,
  createPlanStore,
  createReadiness,
  createRevision,
} from "../../../test/helpers/plan.ts";
import { createPlanGraph } from "../../../test/helpers/plan.ts";
import {
  planFixtureIdentities,
  seedPlanFixture,
} from "../../../test/helpers/plan.ts";
import {
  createMigratedStorage,
  tableCounts,
} from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { fixtureIds, seedRegistry } from "../../../test/helpers/rows.ts";
import type { Storage, Transaction } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { BlobStore } from "../../services/blob/index.ts";
import type { DocumentReader } from "../../services/document/index.ts";
import type { Graph } from "../../services/graph/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { Revision } from "../../services/revision/index.ts";
import type {
  AppendEventInput,
  EventLog,
  RecordedEvent,
} from "../../services/event/index.ts";
import type { RenderedDocument } from "../../domain/plan-render.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const U_I = "01ARZ3NDEKTSV4RRFFQ69G5FAV";
const U_T1 = "01BQZ3NDEKTSV4RRFFQ69G5FAV";
const U_O1 = "01DRZ3NDEKTSV4RRFFQ69G5FAV";
const U_T2 = "01ERZ3NDEKTSV4RRFFQ69G5FAV";
const U_T3 = "01FQZ3NDEKTSV4RRFFQ69G5FAV";
const U_O2 = "01GQZ3NDEKTSV4RRFFQ69G5FAV";
const U_REV = "01JQZ3NDEKTSV4RRFFQ69G5FAV";
const U_EDGE = "01KQZ3NDEKTSV4RRFFQ69G5FAV";
const U_REV2 = "01KRZ3NDEKTSV4RRFFQ69G5FAV";
const U_NEW = "01MRZ3NDEKTSV4RRFFQ69G5FAV";
const U_T4 = "01WRZ3NDEKTSV4RRFFQ69G5FAV";
const U_EDGE2 = "01KQZ3NDEKTSV4RRFFQ69G5FAW";
const U_SIX_REV = "01KQZ3NDEKTSV4RRFFQ69G5FAX";
const U_SIX_E1 = "01KQZ3NDEKTSV4RRFFQ69G5FAY";
const U_SIX_E2 = "01KQZ3NDEKTSV4RRFFQ69G5FAZ";
const U_SIX_E3 = "01KQZ3NDEKTSV4RRFFQ69G5FB1";
const U_SIX_E4 = "01KQZ3NDEKTSV4RRFFQ69G5FB2";
const U_SIX_E5 = "01KQZ3NDEKTSV4RRFFQ69G5FB3";
const U_SIX_E6 = "01KQZ3NDEKTSV4RRFFQ69G5FB4";

const SIX_ULIDS = {
  run_t: "01ARZ3NDEKTSV4RRFFQ69G5FB5",
  block_t: "01ARZ3NDEKTSV4RRFFQ69G5FB6",
  await_o: "01ARZ3NDEKTSV4RRFFQ69G5FB7",
  done_t: "01ARZ3NDEKTSV4RRFFQ69G5FB8",
  part_o: "01ARZ3NDEKTSV4RRFFQ69G5FB9",
  disc_t: "01ARZ3NDEKTSV4RRFFQ69G5FBA",
  init_main: "01ARZ3NDEKTSV4RRFFQ69G5FBB",
  obj_main: "01ARZ3NDEKTSV4RRFFQ69G5FBC",
  dep_t: "01ARZ3NDEKTSV4RRFFQ69G5FBD",
  dep_o: "01ARZ3NDEKTSV4RRFFQ69G5FBE",
  child_a: "01ARZ3NDEKTSV4RRFFQ69G5FAZ",
  child_p: "01ARZ3NDEKTSV4RRFFQ69G5FAY",
  child_d: "01ARZ3NDEKTSV4RRFFQ69G5FAW",
} as const;

const SIX_IDS = {
  run_t: `task_${SIX_ULIDS.run_t}`,
  block_t: `task_${SIX_ULIDS.block_t}`,
  await_o: `objective_${SIX_ULIDS.await_o}`,
  done_t: `task_${SIX_ULIDS.done_t}`,
  part_o: `objective_${SIX_ULIDS.part_o}`,
  disc_t: `task_${SIX_ULIDS.disc_t}`,
  init_main: `initiative_${SIX_ULIDS.init_main}`,
  obj_main: `objective_${SIX_ULIDS.obj_main}`,
  dep_t: `task_${SIX_ULIDS.dep_t}`,
  dep_o: `objective_${SIX_ULIDS.dep_o}`,
  child_a: `task_${SIX_ULIDS.child_a}`,
  child_p: `task_${SIX_ULIDS.child_p}`,
  child_d: `task_${SIX_ULIDS.child_d}`,
} as const;
const U_A = "01NRZ3NDEKTSV4RRFFQ69G5FAV";
const U_O2NEW = "01PRZ3NDEKTSV4RRFFQ69G5FAV";
const U_IZ = "01QRZ3NDEKTSV4RRFFQ69G5FAV";
const U_TZ = "01RRZ3NDEKTSV4RRFFQ69G5FAV";
const U_OZ = "01SRZ3NDEKTSV4RRFFQ69G5FAV";
const U_IE = "01TRZ3NDEKTSV4RRFFQ69G5FAV";
const U_TE = "01VRZ3NDEKTSV4RRFFQ69G5FAV";
const U_OE = "01ARZ3NDEKTSV4RRFFQ69G5FAX";
const U2_I = "01BQZ3NDEKTSV4RRFFQ69G5FAX";
const U2_T1 = "01DRZ3NDEKTSV4RRFFQ69G5FAX";
const U2_O1 = "01ERZ3NDEKTSV4RRFFQ69G5FAX";
const U2_T2 = "01FQZ3NDEKTSV4RRFFQ69G5FAX";
const U2_T3 = "01GQZ3NDEKTSV4RRFFQ69G5FAX";
const U2_O2 = "01JQZ3NDEKTSV4RRFFQ69G5FAX";
const U2_REV = "01KQZ3NDEKTSV4RRFFQ69G5FAX";
const U2_EDGE = "01MRZ3NDEKTSV4RRFFQ69G5FAX";

const U_HI = "01ARZ3NDEKTSV4RRFFQ69G5FBF";
const U_HT = "01ARZ3NDEKTSV4RRFFQ69G5FBG";
const U_HO = "01ARZ3NDEKTSV4RRFFQ69G5FBH";
const U_HREV = "01ARZ3NDEKTSV4RRFFQ69G5FBI";

const harnessSubmission = [
  {
    path: "plan/i--01/initiative.md",
    content: `---
kind: initiative
title: Harness round trip
---
Test harness kind routing.
`,
  },
  {
    path: "plan/i--01/o--01/objective.md",
    content: `---
kind: objective
title: Harness round trip
repo: kanthord-verify
---
Validate the route.
`,
  },
  {
    path: "plan/i--01/o--01/01-a.md",
    content: `---
kind: task
title: Harness round trip
worker: claude.swe@1
---
Do the task.

## Acceptance criteria

- The kind is preserved.
`,
  },
];

const harnessExpectedDocuments = [
  {
    path: "plan/harness-round-trip--01arz3ndektsv4rrffq69g5fbf/harness-round-trip--01arz3ndektsv4rrffq69g5fbh/01-harness-round-trip--01arz3ndektsv4rrffq69g5fbg.md",
    content: `---\nid: "task_${U_HT}"\nkind: "task"\ntitle: "Harness round trip"\nworker: "claude.swe@1"\n---\nDo the task.\n\n## Acceptance criteria\n\n- The kind is preserved.\n`,
  },
  {
    path: "plan/harness-round-trip--01arz3ndektsv4rrffq69g5fbf/harness-round-trip--01arz3ndektsv4rrffq69g5fbh/objective.md",
    content: `---\nid: "objective_${U_HO}"\nkind: "objective"\ntitle: "Harness round trip"\nrepo: "kanthord-verify"\n---\nValidate the route.\n`,
  },
  {
    path: "plan/harness-round-trip--01arz3ndektsv4rrffq69g5fbf/initiative.md",
    content: `---\nid: "initiative_${U_HI}"\nkind: "initiative"\ntitle: "Harness round trip"\n---\nTest harness kind routing.\n`,
  },
];

const low = (ulid: string): string => ulid.toLowerCase();

const roundTripIdentities = [
  `initiative_${U_I}`,
  `task_${U_T1}`,
  `objective_${U_O1}`,
  `task_${U_T2}`,
  `task_${U_T3}`,
  `objective_${U_O2}`,
] as const;

const initiativePath = `plan/ship-kanthord--${low(U_I)}/initiative.md`;
const objectiveOnePath = `plan/ship-kanthord--${low(U_I)}/harden-the-verify-cli--${low(U_O1)}/objective.md`;
const taskOnePath = `plan/ship-kanthord--${low(U_I)}/harden-the-verify-cli--${low(U_O1)}/01-render-the-manifest--${low(U_T1)}.md`;
const objectiveTwoPath = `plan/ship-kanthord--${low(U_I)}/harden-the-verify-cli--${low(U_O2)}/objective.md`;
const taskTwoPath = `plan/ship-kanthord--${low(U_I)}/harden-the-verify-cli--${low(U_O2)}/01-render-the-manifest--${low(U_T2)}.md`;
const taskThreePath = `plan/ship-kanthord--${low(U_I)}/harden-the-verify-cli--${low(U_O2)}/02-render-the-manifest--${low(U_T3)}.md`;

const roundTripSubmission: readonly Readonly<{
  path: string;
  content: string;
}>[] = [
  {
    path: "plan/i--01/o--02/02-t.md",
    content: `---
kind: task
title: Render the manifest
depends_on:
  - 01-t.md
worker: tdd@1
---
Build the renderer.

## Acceptance criteria

- The bytes match.
`,
  },
  {
    path: "plan/i--01/initiative.md",
    content: `---
kind: initiative
title: Ship kanthord
---
Bootstrap the daemon.
`,
  },
  {
    path: "plan/i--01/o--02/01-t.md",
    content: `---
kind: task
title: Render the manifest
worker: tdd@1
---
Build the renderer.

## Acceptance criteria

- The bytes match.
`,
  },
  {
    path: "plan/i--01/o--02/objective.md",
    content: `---
kind: objective
title: Harden the verify CLI
repo: kanthord-verify
---
Make it verifiable.
`,
  },
  {
    path: "plan/i--01/o--01/01-t.md",
    content: `---
kind: task
title: Render the manifest
worker: tdd@1
---
Build the renderer.

## Acceptance criteria

- The bytes match.
`,
  },
  {
    path: "plan/i--01/o--01/objective.md",
    content: `---
kind: objective
title: Harden the verify CLI
repo: kanthord-verify
---
Make it verifiable.
`,
  },
];

const expectedDocuments: readonly RenderedDocument[] = [
  {
    path: taskOnePath,
    content: `---
id: "task_${U_T1}"
kind: "task"
title: "Render the manifest"
worker: "tdd@1"
---
Build the renderer.

## Acceptance criteria

- The bytes match.
`,
  },
  {
    path: objectiveOnePath,
    content: `---
id: "objective_${U_O1}"
kind: "objective"
title: "Harden the verify CLI"
repo: "kanthord-verify"
---
Make it verifiable.
`,
  },
  {
    path: taskTwoPath,
    content: `---
id: "task_${U_T2}"
kind: "task"
title: "Render the manifest"
worker: "tdd@1"
---
Build the renderer.

## Acceptance criteria

- The bytes match.
`,
  },
  {
    path: taskThreePath,
    content: `---
id: "task_${U_T3}"
kind: "task"
title: "Render the manifest"
depends_on:
  - "task_${U_T2}"
worker: "tdd@1"
---
Build the renderer.

## Acceptance criteria

- The bytes match.
`,
  },
  {
    path: objectiveTwoPath,
    content: `---
id: "objective_${U_O2}"
kind: "objective"
title: "Harden the verify CLI"
repo: "kanthord-verify"
---
Make it verifiable.
`,
  },
  {
    path: initiativePath,
    content: `---
id: "initiative_${U_I}"
kind: "initiative"
title: "Ship kanthord"
---
Bootstrap the daemon.
`,
  },
];

const roundTripChoices: readonly Readonly<{ id: string; take: Choice }>[] =
  roundTripIdentities.map((id) => ({ id, take: "submitted" }));

type RecordedAppend = Readonly<{
  transaction: Transaction;
  input: AppendEventInput;
}>;

function createRecordingEventLog(): Readonly<{
  events: EventLog;
  recorded: readonly RecordedAppend[];
}> {
  const recorded: RecordedAppend[] = [];
  return {
    recorded,
    events: {
      append(transaction: Transaction, input: AppendEventInput): RecordedEvent {
        recorded.push({ transaction, input });
        return {
          id: "event_1",
          subjectKind: input.subjectKind,
          subjectId: input.subjectId,
          type: input.type,
          actorKind: input.actorKind,
          actorId: input.actorId,
          payload: input.payload,
          occurredAt: 0,
        };
      },
      list(): readonly RecordedEvent[] {
        return [];
      },
    },
  };
}

function countingIds(
  ids: IdGenerator,
): Readonly<{ ids: IdGenerator; count(): number }> {
  let calls = 0;
  return {
    count: () => calls,
    ids: {
      mint(kind: IdentityKind): string {
        calls += 1;
        return ids.mint(kind);
      },
    },
  };
}

function countingClock(
  clock: Clock,
): Readonly<{ clock: Clock; count(): number }> {
  let calls = 0;
  return {
    count: () => calls,
    clock: {
      now(): number {
        calls += 1;
        return clock.now();
      },
    },
  };
}

type ImportFixture = Readonly<{
  storage: Storage;
  plan: PlanStore;
  blobs: BlobStore;
  revision: Revision;
  reader: DocumentReader;
  graph: Graph;
  ids: IdGenerator;
  clock: Clock;
  events: EventLog;
  recorded: readonly RecordedAppend[];
  path: string;
  dispose(): void;
}>;

function build(ulids: readonly string[]): ImportFixture {
  const temporary = createMigratedStorage();
  const storage = temporary.storage;
  const log = createRecordingEventLog();
  const plan = createPlanStore(createReadiness(log.events, "daemon_test"));
  const blobs = createBlobStore(
    storage,
    createMockClock({ start: 1700000000000, step: 1000 }),
  );
  return {
    storage,
    plan,
    blobs,
    revision: createRevision(blobs, plan),
    reader: createPlanReader(),
    graph: createPlanGraph(),
    ids: createMockIdGenerator({ ulids }),
    clock: createMockClock({ start: 1700000000000, step: 1000 }),
    events: log.events,
    recorded: log.recorded,
    path: temporary.path,
    dispose: temporary.dispose,
  };
}

function runImport(
  fixture: ImportFixture,
  input: ImportPlanInput,
): ImportPlanResult {
  return importPlan(
    {
      storage: fixture.storage,
      plan: fixture.plan,
      blobs: fixture.blobs,
      reader: fixture.reader,
      graph: fixture.graph,
      ids: fixture.ids,
      clock: fixture.clock,
      events: fixture.events,
    },
    input,
  );
}

function importRefusal(
  fixture: ImportFixture,
  input: ImportPlanInput,
): ImportPlanError {
  let caught: unknown;
  try {
    runImport(fixture, input);
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof Error && "refusal" in caught,
    `expected an ImportPlanError, got ${String(caught)}`,
  );
  return caught as ImportPlanError;
}

function planHash(
  fixture: ImportFixture,
  documents: readonly Readonly<{ path: string; content: string }>[],
  ulids: readonly string[],
): string {
  return validatePlan(
    {
      storage: fixture.storage,
      plan: fixture.plan,
      blobs: fixture.blobs,
      reader: fixture.reader,
      graph: fixture.graph,
      ids: createMockIdGenerator({ ulids }),
    },
    {
      projectId: fixtureIds.project,
      fromRevision: fixtureIds.planRevision,
      documents,
    },
  ).documentsHash;
}

function snapshot(storage: Storage): unknown {
  return storage.transact((transaction) => ({
    node: transaction.all(
      "SELECT id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at FROM node ORDER BY id ASC",
    ),
    edge: transaction.all(
      "SELECT id, from_node, to_node, waived_at FROM edge ORDER BY id ASC",
    ),
    plan_revision: transaction.all(
      "SELECT id, project_id, parent_id, import_id, submitted_blob, choices_blob, accepted_blob FROM plan_revision ORDER BY id ASC",
    ),
    blob: transaction.all(
      "SELECT hash, size, content, created_at FROM blob ORDER BY hash ASC",
    ),
    event: transaction.all(
      "SELECT id, subject_kind, subject_id, type, actor_kind, actor_id, payload_json FROM event ORDER BY id ASC",
    ),
  }));
}

function seedTaskTwo(
  storage: Storage,
  plan: PlanStore,
  blobs: BlobStore,
  withEdge: boolean,
): void {
  storage.transact((transaction) => {
    plan.mutateGraph(transaction, {
      projectId: fixtureIds.project,
      nodes: [
        {
          id: planFixtureIdentities.taskTwo,
          projectId: fixtureIds.project,
          kind: "task",
          parentId: planFixtureIdentities.objective,
          title: "Harden the verify CLI",
          instructionBlob: blobs.put(
            transaction,
            encoder.encode("Do the second task work.\n"),
          ),
          acceptanceBlob: blobs.put(
            transaction,
            encoder.encode("## Acceptance criteria\n- it works\n"),
          ),
          worker: null,
          repositoryId: null,
          revision: fixtureIds.planRevision,
          updatedAt: 1,
        },
      ],
      insertEdges: withEdge
        ? [
            {
              id: "edge_01ZZZ3NDEKTSV4RRFFQ69G5FAV",
              fromNode: planFixtureIdentities.taskTwo,
              toNode: planFixtureIdentities.task,
            },
          ]
        : [],
      deleteEdgeIds: [],
      nodeDeletes: [],
      at: 1,
      cause: { revision: fixtureIds.planRevision, importId: null },
    });
  });
}

function seedRepoB(storage: Storage): void {
  storage.transact((transaction) => {
    transaction.run(
      "INSERT INTO repository (id, name, remote_url, credential_id, home_path, branch, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "repo_b",
        "kanthord-verify-b",
        "https://example.invalid/rb.git",
        fixtureIds.provider,
        "repos/rb.git",
        "main",
        1,
        "ready",
        null,
        null,
        null,
        1,
      ],
    );
  });
}

function bindRepoB(storage: Storage): void {
  storage.transact((transaction) => {
    transaction.run(
      "INSERT INTO project_binding (project_id, kind, target_id, created_at) VALUES (?, ?, ?, ?)",
      [fixtureIds.project, "git", "repo_b", 1],
    );
  });
}

function seedWorkspaceOnTask(storage: Storage): void {
  storage.transact((transaction) => {
    transaction.run(
      "INSERT INTO workspace (id, node_id, repository_id, path, clone_base_oid, upstream_oid_at_clone, profile_blob, convention_version, ambient_blob, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "workspace_import",
        planFixtureIdentities.task,
        fixtureIds.repository,
        "workspaces/import",
        "a".repeat(40),
        "a".repeat(40),
        fixtureIds.profileBlob,
        "coding/v1",
        null,
        "ready",
        1,
      ],
    );
  });
}

function seedAttemptCommitOnTask(storage: Storage): void {
  storage.transact((transaction) => {
    transaction.run(
      "INSERT INTO workspace (id, node_id, repository_id, path, clone_base_oid, upstream_oid_at_clone, profile_blob, convention_version, ambient_blob, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "workspace_att",
        planFixtureIdentities.task,
        fixtureIds.repository,
        "workspaces/att",
        "a".repeat(40),
        "a".repeat(40),
        fixtureIds.profileBlob,
        "coding/v1",
        null,
        "ready",
        1,
      ],
    );
    transaction.run(
      "INSERT INTO workspace (id, node_id, repository_id, path, clone_base_oid, upstream_oid_at_clone, profile_blob, convention_version, ambient_blob, state, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "workspace_att_parent",
        planFixtureIdentities.objective,
        fixtureIds.repository,
        "workspaces/att-parent",
        "a".repeat(40),
        "a".repeat(40),
        fixtureIds.profileBlob,
        "coding/v1",
        null,
        "ready",
        1,
      ],
    );
    transaction.run(
      "INSERT INTO run (id, kind, node_id, driver, workspace_id, worker, fence, attempt_limit, head_oid, judged_oid, graph_revision, agents_json, expires_at, max_lifetime_at, state, outcome, ended_at) VALUES (?, ?, ?, 'internal', ?, ?, ?, ?, NULL, NULL, ?, '[]', 1700300000000, 1700300000000, ?, NULL, NULL)",
      [
        "run_att_parent",
        "structural",
        planFixtureIdentities.objective,
        "workspace_att_parent",
        "general@1",
        1,
        3,
        fixtureIds.planRevision,
        "active",
      ],
    );
    transaction.run(
      "INSERT INTO run (id, kind, node_id, driver, workspace_id, worker, fence, attempt_limit, head_oid, judged_oid, graph_revision, agents_json, expires_at, max_lifetime_at, state, outcome, ended_at) VALUES (?, ?, ?, 'internal', ?, ?, ?, ?, NULL, NULL, ?, '[]', 1700300000000, 1700300000000, ?, NULL, NULL)",
      [
        "run_att",
        "execution",
        planFixtureIdentities.task,
        "workspace_att",
        "general@1",
        1,
        3,
        fixtureIds.planRevision,
        "active",
      ],
    );
    transaction.run(
      "INSERT INTO attempt (id, run_id, driver, attempt_no, provider_id, provider_model, timeout_ms, base_oid, head_oid, outcome, ended_at) VALUES (?, ?, 'internal', ?, ?, ?, ?, ?, ?, ?, ?)",
      [
        "attempt_att",
        "run_att",
        1,
        fixtureIds.provider,
        "claude-opus-5",
        60000,
        "a".repeat(40),
        "b".repeat(40),
        null,
        null,
      ],
    );
  });
}

function seedSecondProject(transaction: Transaction): void {
  transaction.run(
    "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
    ["project_b", "second", null, null, 1],
  );
  transaction.run(
    "INSERT INTO project_binding (project_id, kind, target_id, created_at) VALUES (?, ?, ?, ?)",
    ["project_b", "git", "repo_a", 1],
  );
}

function fixtureDocuments(fixture: ImportFixture): readonly RenderedDocument[] {
  return exportPlan(
    {
      storage: fixture.storage,
      plan: fixture.plan,
      revision: fixture.revision,
    },
    { projectId: fixtureIds.project },
  ).documents;
}

function fixtureTaskDocument(fixture: ImportFixture): RenderedDocument {
  const document = fixtureDocuments(fixture).find((entry) =>
    entry.content.includes(`id: "${planFixtureIdentities.task}"`),
  );
  assert.ok(document);
  return document;
}

function withTaskDependsOn(
  documents: readonly RenderedDocument[],
): readonly RenderedDocument[] {
  return documents.map((document) =>
    document.content.includes("Do the task work.")
      ? {
          ...document,
          content: document.content.replace(
            "---\n",
            `---\ndepends_on:\n  - "${planFixtureIdentities.taskTwo}"\n`,
          ),
        }
      : document,
  );
}

function withObjectiveRepoB(
  documents: readonly RenderedDocument[],
): readonly RenderedDocument[] {
  return documents.map((document) =>
    document.content.includes("Do the objective work.")
      ? {
          ...document,
          content: document.content.replace(
            'repo: "kanthord-verify"',
            'repo: "kanthord-verify-b"',
          ),
        }
      : document,
  );
}

function withTaskTitle(
  documents: readonly RenderedDocument[],
  title: string,
): readonly RenderedDocument[] {
  return documents.map((document) =>
    document.content.includes("Do the task work.")
      ? {
          ...document,
          content: document.content.replace(
            'title: "Harden the verify CLI"',
            `title: "${title}"`,
          ),
        }
      : document,
  );
}

function withObjectiveTitle(
  documents: readonly RenderedDocument[],
  title: string,
): readonly RenderedDocument[] {
  return documents.map((document) =>
    document.content.includes("Do the objective work.")
      ? {
          ...document,
          content: document.content.replace(
            'title: "Harden the verify CLI"',
            `title: "${title}"`,
          ),
        }
      : document,
  );
}

function roundTripInput(
  fixture: ImportFixture,
  overrides: Partial<ImportPlanInput> = {},
): ImportPlanInput {
  return {
    projectId: fixtureIds.project,
    fromRevision: null,
    importId: "imp_roundtrip",
    documents: roundTripSubmission,
    choices: roundTripChoices,
    validatedRevision: null,
    documentsHash: fixture.blobs.hash(
      encoder.encode(canonicalDocumentsJson(expectedDocuments)),
    ),
    actor: "human_1",
    ...overrides,
  };
}

const sixStateNodes: readonly Readonly<{
  id: string;
  kind: "initiative" | "objective" | "task";
  parentId: string;
  state: string;
  blockReason: string | null;
  discardReason: string | null;
}>[] = [
  {
    id: SIX_IDS.run_t,
    kind: "task",
    parentId: SIX_IDS.obj_main,
    state: "running",
    blockReason: null,
    discardReason: null,
  },
  {
    id: SIX_IDS.block_t,
    kind: "task",
    parentId: SIX_IDS.obj_main,
    state: "blocked",
    blockReason: "stale-base",
    discardReason: null,
  },
  {
    id: SIX_IDS.await_o,
    kind: "objective",
    parentId: SIX_IDS.init_main,
    state: "awaiting_approval",
    blockReason: null,
    discardReason: null,
  },
  {
    id: SIX_IDS.done_t,
    kind: "task",
    parentId: SIX_IDS.obj_main,
    state: "done",
    blockReason: null,
    discardReason: null,
  },
  {
    id: SIX_IDS.part_o,
    kind: "objective",
    parentId: SIX_IDS.init_main,
    state: "partial",
    blockReason: null,
    discardReason: null,
  },
  {
    id: SIX_IDS.disc_t,
    kind: "task",
    parentId: SIX_IDS.obj_main,
    state: "discarded",
    blockReason: null,
    discardReason: "wontfix",
  },
];

function seedSixStateProject(
  storage: Storage,
  depState: "done" | "pending",
): void {
  storage.transact((transaction) => {
    seedRegistry(transaction);
    transaction.run(
      "INSERT INTO project (id, name, worker, e2e_json, updated_at) VALUES (?, ?, ?, ?, ?)",
      ["project_b", "six-state", "general@1", null, 1],
    );
    transaction.run(
      "INSERT INTO project_binding (project_id, kind, target_id, created_at) VALUES (?, 'git', ?, ?)",
      ["project_b", fixtureIds.repository, 1],
    );
    transaction.run(
      "INSERT INTO plan_revision (id, project_id, parent_id, origin, import_id, submitted_blob, choices_blob, accepted_blob) VALUES (?, ?, ?, 'import', ?, ?, ?, ?)",
      [
        fixtureIds.planRevision,
        "project_b",
        null,
        "imp_a",
        fixtureIds.instructionBlob,
        fixtureIds.instructionBlob,
        fixtureIds.instructionBlob,
      ],
    );
    const insertNode = (
      id: string,
      kind: string,
      parentId: string | null,
      state: string,
      blockReason: string | null,
      discardReason: string | null,
    ): void => {
      transaction.run(
        "INSERT INTO node (id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        [
          id,
          "project_b",
          kind,
          parentId,
          "six state node",
          fixtureIds.instructionBlob,
          kind === "task" ? fixtureIds.acceptanceBlob : null,
          null,
          kind === "objective" ? fixtureIds.repository : null,
          state,
          blockReason,
          discardReason,
          fixtureIds.planRevision,
          1,
        ],
      );
    };
    insertNode(SIX_IDS.init_main, "initiative", null, "pending", null, null);
    insertNode(
      SIX_IDS.obj_main,
      "objective",
      SIX_IDS.init_main,
      "pending",
      null,
      null,
    );
    for (const row of sixStateNodes) {
      insertNode(
        row.id,
        row.kind,
        row.parentId,
        row.state,
        row.blockReason,
        row.discardReason,
      );
    }
    insertNode(SIX_IDS.dep_t, "task", SIX_IDS.obj_main, depState, null, null);
    insertNode(
      SIX_IDS.dep_o,
      "objective",
      SIX_IDS.init_main,
      depState,
      null,
      null,
    );
    insertNode(SIX_IDS.child_a, "task", SIX_IDS.await_o, "done", null, null);
    insertNode(SIX_IDS.child_p, "task", SIX_IDS.part_o, "done", null, null);
    insertNode(SIX_IDS.child_d, "task", SIX_IDS.dep_o, "done", null, null);
    const insertDependency = (
      id: string,
      subjectId: string,
      dependencyId: string,
    ): void => {
      transaction.run(
        "INSERT INTO edge (id, from_node, to_node, waived_at) VALUES (?, ?, ?, NULL)",
        [id, subjectId, dependencyId],
      );
    };
    insertDependency("edge_run", SIX_IDS.run_t, SIX_IDS.dep_t);
    insertDependency("edge_block", SIX_IDS.block_t, SIX_IDS.dep_t);
    insertDependency("edge_await", SIX_IDS.await_o, SIX_IDS.dep_o);
    insertDependency("edge_done", SIX_IDS.done_t, SIX_IDS.dep_t);
    insertDependency("edge_part", SIX_IDS.part_o, SIX_IDS.dep_o);
    insertDependency("edge_disc", SIX_IDS.disc_t, SIX_IDS.dep_t);
  });
}

const sixStateTaskPath = (name: string): string =>
  `plan/six-state-node--${low(SIX_ULIDS.init_main)}/six-state-node--${low(SIX_ULIDS.obj_main)}/${name}.md`;

function sixStateDocuments(): readonly Readonly<{
  path: string;
  content: string;
}>[] {
  return [
    {
      path: sixStateTaskPath("run"),
      content: `---
id: "${SIX_IDS.run_t}"
kind: "task"
title: "Run task"
worker: "tdd@1"
depends_on:
  - "${SIX_IDS.dep_t}"
---
Run task work.

## Acceptance criteria

- It works.
`,
    },
    {
      path: sixStateTaskPath("block"),
      content: `---
id: "${SIX_IDS.block_t}"
kind: "task"
title: "Block task"
worker: "tdd@1"
depends_on:
  - "${SIX_IDS.dep_t}"
---
Block task work.

## Acceptance criteria

- It works.
`,
    },
    {
      path: sixStateTaskPath("done"),
      content: `---
id: "${SIX_IDS.done_t}"
kind: "task"
title: "Done task"
worker: "tdd@1"
depends_on:
  - "${SIX_IDS.dep_t}"
---
Done task work.

## Acceptance criteria

- It works.
`,
    },
    {
      path: sixStateTaskPath("disc"),
      content: `---
id: "${SIX_IDS.disc_t}"
kind: "task"
title: "Disc task"
worker: "tdd@1"
depends_on:
  - "${SIX_IDS.dep_t}"
---
Disc task work.

## Acceptance criteria

- It works.
`,
    },
  ];
}

function sixStateImportInput(
  fixture: ImportFixture,
  documents: readonly Readonly<{ path: string; content: string }>[],
): ImportPlanInput {
  const allIds = [
    SIX_IDS.init_main,
    SIX_IDS.obj_main,
    ...sixStateNodes.map((row) => row.id),
    SIX_IDS.dep_t,
    SIX_IDS.dep_o,
    SIX_IDS.child_a,
    SIX_IDS.child_p,
    SIX_IDS.child_d,
  ];
  const documentsHash = validatePlan(
    {
      storage: fixture.storage,
      plan: fixture.plan,
      blobs: fixture.blobs,
      reader: fixture.reader,
      graph: fixture.graph,
      ids: createMockIdGenerator({ ulids: [] }),
    },
    {
      projectId: "project_b",
      fromRevision: fixtureIds.planRevision,
      documents,
    },
  ).documentsHash;
  return {
    projectId: "project_b",
    fromRevision: fixtureIds.planRevision,
    importId: "imp_six",
    documents,
    choices: allIds.map((id) => ({ id, take: "database" })),
    validatedRevision: fixtureIds.planRevision,
    documentsHash,
    actor: "human_1",
  };
}

function sixStateRows(
  fixture: ImportFixture,
): ReadonlyMap<string, Readonly<Record<string, unknown>>> {
  const rows = fixture.storage.transact((transaction) =>
    transaction.all(
      "SELECT id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at FROM node WHERE project_id = 'project_b' ORDER BY id ASC",
    ),
  ) as readonly Readonly<Record<string, unknown>>[];
  return new Map(rows.map((row) => [row.id as string, { ...row }]));
}

describe("src/commands/plan/import-plan.test", () => {
  it("refuses identities already bound to another project and writes nothing", (t) => {
    const fixture = build([
      "01MZ3NDEKTSV4RRFFQ69G5FC1",
      "01MZ3NDEKTSV4RRFFQ69G5FC2",
      "01MZ3NDEKTSV4RRFFQ69G5FC3",
    ]);
    t.after(() => fixture.dispose());
    fixture.storage.transact((transaction) => seedRegistry(transaction));

    const identity = "initiative_01JTZ3NDEKTSV4RRFFQ69G5FC1";
    const documents = [
      {
        path: "plan/bound/initiative.md",
        content: `---
id: "${identity}"
kind: initiative
title: Bound initiative
---
Bootstrap.
`,
      },
    ];
    const input = {
      projectId: fixtureIds.project,
      fromRevision: null,
      importId: "imp_bound_one",
      documents,
      choices: [{ id: identity, take: "submitted" as const }],
      validatedRevision: null,
      documentsHash: planHash(fixture, documents, []),
      actor: "human_1",
    };

    runImport(fixture, input);

    const otherProject = "project_01JTZ3NDEKTSV4RRFFQ69G5FC2";
    fixture.storage.transact((transaction) => {
      transaction.run(
        "INSERT INTO project (id, name, updated_at) VALUES (?, ?, ?)",
        [otherProject, "other-project", 1],
      );
    });

    const before = tableCounts(fixture.storage);
    const caught = importRefusal(fixture, {
      ...input,
      projectId: otherProject,
      importId: "imp_bound_two",
    });

    assert.equal(caught.refusal, "plan-invalid");
    assert.equal(
      caught.message,
      "the document identities are bound to another project",
    );
    assert.deepEqual(caught.details, {
      conflicts: [{ id: identity, projectId: fixtureIds.project }],
    });
    assert.deepEqual(tableCounts(fixture.storage), before);
    const rows = fixture.storage.transact((transaction) =>
      transaction.all("SELECT DISTINCT project_id FROM node"),
    ) as readonly Readonly<{ project_id: string }>[];
    assert.deepEqual(
      rows.map((row) => row.project_id),
      [fixtureIds.project],
    );
  });

  describe("the round trip", () => {
    it("a new-shape plan imports with no finding and the deliverable is stored", (t) => {
      const fixture = build([U_NEW]);
      t.after(() => fixture.dispose());
      seedPlanFixture(fixture.storage, fixture.plan, fixture.blobs);

      const task = fixtureTaskDocument(fixture);
      const submitted = {
        path: task.path,
        content: task.content.replace(
          'title: "Harden the verify CLI"\n',
          'title: "Harden the verify CLI"\ndeliverable: "test"\nverify:\n  paths:\n    - "/src/foo.ts"\n  commands:\n    - "! node --test src/foo.test.ts"\n',
        ),
      };
      const result = runImport(fixture, {
        projectId: fixtureIds.project,
        fromRevision: fixtureIds.planRevision,
        importId: "imp_new_shape",
        documents: [submitted],
        choices: [
          { id: planFixtureIdentities.initiative, take: "database" },
          { id: planFixtureIdentities.objective, take: "database" },
          { id: planFixtureIdentities.task, take: "submitted" },
        ],
        validatedRevision: fixtureIds.planRevision,
        documentsHash: planHash(fixture, [submitted], []),
        actor: "human_1",
      });

      assert.deepEqual(result.completeness, []);
      const stored = fixture.storage.transact((transaction) =>
        transaction.get(
          "SELECT deliverable, verify_json FROM node WHERE id = ?",
          [planFixtureIdentities.task],
        ),
      ) as Readonly<{
        deliverable: string | null;
        verify_json: string | null;
      }>;
      assert.equal(stored.deliverable, "test");
      assert.equal(
        stored.verify_json,
        '{"paths":["/src/foo.ts"],"commands":["! node --test src/foo.test.ts"]}',
      );
    });

    it("a legacy plan still imports byte-identically after dual-read", (t) => {
      const fixture = build([U_NEW]);
      t.after(() => fixture.dispose());
      seedPlanFixture(fixture.storage, fixture.plan, fixture.blobs);

      const task = fixtureTaskDocument(fixture);
      const submitted = {
        path: task.path,
        content: task.content.replace(
          'title: "Harden the verify CLI"\n',
          'title: "Harden the verify CLI"\nworker: "claude.swe@1"\n',
        ),
      };
      runImport(fixture, {
        projectId: fixtureIds.project,
        fromRevision: fixtureIds.planRevision,
        importId: "imp_legacy_dual_read",
        documents: [submitted],
        choices: [
          { id: planFixtureIdentities.initiative, take: "database" },
          { id: planFixtureIdentities.objective, take: "database" },
          { id: planFixtureIdentities.task, take: "submitted" },
        ],
        validatedRevision: fixtureIds.planRevision,
        documentsHash: planHash(fixture, [submitted], []),
        actor: "human_1",
      });

      const stored = fixture.storage.transact((transaction) =>
        transaction.get("SELECT deliverable FROM node WHERE id = ?", [
          planFixtureIdentities.task,
        ]),
      ) as Readonly<{ deliverable: string | null }>;
      assert.equal(stored.deliverable, null);
      const exported = fixtureTaskDocument(fixture);
      assert.equal(exported.content, submitted.content);
    });

    it("a new-shape plan can transition to a legacy document and clear stored fields", (t) => {
      const fixture = build(["z-first", "z-second"]);
      t.after(() => fixture.dispose());
      seedPlanFixture(fixture.storage, fixture.plan, fixture.blobs);

      const task = fixtureTaskDocument(fixture);
      const objective = fixtureDocuments(fixture).find((entry) =>
        entry.content.includes(`id: "${planFixtureIdentities.objective}"`),
      );
      assert.ok(objective);
      const newShape = {
        path: task.path,
        content: task.content.replace(
          'title: "Harden the verify CLI"\n',
          'title: "Harden the verify CLI"\ndeliverable: "test"\nverify:\n  paths:\n    - "/src/foo.ts"\n  commands:\n    - "! node --test src/foo.test.ts"\n',
        ),
      };
      const objectiveNewShape = {
        path: objective.path,
        content: objective.content.replace(
          'title: "Harden the verify CLI"\n',
          'title: "Harden the verify CLI"\ndeliverable: "implementation"\nverify:\n  paths:\n    - "/src/objective.ts"\n  commands:\n    - "node --test src/objective.test.ts"\n',
        ),
      };
      const first = runImport(fixture, {
        projectId: fixtureIds.project,
        fromRevision: fixtureIds.planRevision,
        importId: "imp_new_before_legacy",
        documents: [newShape, objectiveNewShape],
        choices: [
          { id: planFixtureIdentities.initiative, take: "database" },
          { id: planFixtureIdentities.objective, take: "submitted" },
          { id: planFixtureIdentities.task, take: "submitted" },
        ],
        validatedRevision: fixtureIds.planRevision,
        documentsHash: planHash(fixture, [newShape, objectiveNewShape], []),
        actor: "human_1",
      });

      const legacy = {
        path: task.path,
        content: task.content.replace(
          'title: "Harden the verify CLI"\n',
          'title: "Harden the verify CLI"\nworker: "claude.swe@1"\n',
        ),
      };
      runImport(fixture, {
        projectId: fixtureIds.project,
        fromRevision: first.revision,
        importId: "imp_new_to_legacy",
        documents: [legacy],
        choices: [
          { id: planFixtureIdentities.initiative, take: "database" },
          { id: planFixtureIdentities.objective, take: "database" },
          { id: planFixtureIdentities.task, take: "submitted" },
        ],
        validatedRevision: first.revision,
        documentsHash: planHash(fixture, [legacy], []),
        actor: "human_1",
      });

      const stored = fixture.storage.transact((transaction) =>
        transaction.get(
          "SELECT deliverable, verify_json FROM node WHERE id = ?",
          [planFixtureIdentities.task],
        ),
      ) as Readonly<{
        deliverable: string | null;
        verify_json: string | null;
      }>;
      assert.equal(stored.deliverable, null);
      assert.equal(stored.verify_json, null);
      const retained = fixture.storage.transact((transaction) =>
        transaction.get(
          "SELECT deliverable, verify_json FROM node WHERE id = ?",
          [planFixtureIdentities.objective],
        ),
      ) as Readonly<{
        deliverable: string | null;
        verify_json: string | null;
      }>;
      assert.equal(retained.deliverable, "implementation");
      assert.equal(
        retained.verify_json,
        '{"paths":["/src/objective.ts"],"commands":["node --test src/objective.test.ts"]}',
      );
      assert.equal(fixtureTaskDocument(fixture).content, legacy.content);
    });

    it("a duplicate submitted verify path is refused as plan-invalid", (t) => {
      const fixture = build([U_NEW]);
      t.after(() => fixture.dispose());
      seedPlanFixture(fixture.storage, fixture.plan, fixture.blobs);

      const task = fixtureTaskDocument(fixture);
      const submitted = {
        path: task.path,
        content: task.content.replace(
          'title: "Harden the verify CLI"\n',
          'title: "Harden the verify CLI"\ndeliverable: "test"\nverify:\n  paths:\n    - "/src/foo.ts"\n    - "/src/foo.ts"\n  commands: []\n',
        ),
      };
      const before = snapshot(fixture.storage);
      const error = importRefusal(fixture, {
        projectId: fixtureIds.project,
        fromRevision: fixtureIds.planRevision,
        importId: "imp_duplicate_verify_path",
        documents: [submitted],
        choices: [
          { id: planFixtureIdentities.initiative, take: "database" },
          { id: planFixtureIdentities.objective, take: "database" },
          { id: planFixtureIdentities.task, take: "submitted" },
        ],
        validatedRevision: fixtureIds.planRevision,
        documentsHash: planHash(fixture, [submitted], []),
        actor: "human_1",
      });

      assert.equal(error.refusal, "plan-invalid");
      const findings = (
        error.details as Readonly<{
          findings: readonly Readonly<{
            code: string;
            path: string | null;
          }>[];
        }>
      ).findings;
      assert.deepEqual(
        findings.map(({ code, path }) => ({ code, path })),
        [{ code: "frontmatter-invalid", path: submitted.path }],
      );
      assert.deepEqual(snapshot(fixture.storage), before);
    });

    it("a two-objective plan imports with every node row asserted field by field", (t) => {
      const fixture = build([U_I, U_T1, U_O1, U_T2, U_T3, U_O2, U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const result = runImport(fixture, roundTripInput(fixture));

      assert.equal(result.revision, `revision_${U_REV}`);
      assert.equal(result.retried, false);
      assert.deepEqual(result.documents, expectedDocuments);
      assert.deepEqual(result.absent, []);

      const nodes = (
        fixture.storage.transact((transaction) =>
          transaction.all(
            "SELECT id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at FROM node ORDER BY id ASC",
          ),
        ) as readonly Record<string, unknown>[]
      ).map((node) => ({ ...node }));
      const taskNode = (
        id: string,
        parentId: string,
        state: string,
      ): Record<string, unknown> => ({
        id,
        project_id: fixtureIds.project,
        kind: "task",
        parent_id: parentId,
        title: "Render the manifest",
        instruction_blob: fixture.blobs.hash(
          encoder.encode("Build the renderer.\n\n"),
        ),
        acceptance_blob: fixture.blobs.hash(
          encoder.encode("## Acceptance criteria\n\n- The bytes match.\n"),
        ),
        worker: "tdd@1",
        repository_id: null,
        state,
        block_reason: null,
        discard_reason: null,
        revision: result.revision,
        updated_at: 1700000000000,
      });
      assert.deepEqual(nodes, [
        {
          id: `initiative_${U_I}`,
          project_id: fixtureIds.project,
          kind: "initiative",
          parent_id: null,
          title: "Ship kanthord",
          instruction_blob: fixture.blobs.hash(
            encoder.encode("Bootstrap the daemon.\n"),
          ),
          acceptance_blob: null,
          worker: null,
          repository_id: null,
          state: "ready",
          block_reason: null,
          discard_reason: null,
          revision: result.revision,
          updated_at: 1700000000000,
        },
        {
          id: `objective_${U_O1}`,
          project_id: fixtureIds.project,
          kind: "objective",
          parent_id: `initiative_${U_I}`,
          title: "Harden the verify CLI",
          instruction_blob: fixture.blobs.hash(
            encoder.encode("Make it verifiable.\n"),
          ),
          acceptance_blob: null,
          worker: null,
          repository_id: "repo_a",
          state: "ready",
          block_reason: null,
          discard_reason: null,
          revision: result.revision,
          updated_at: 1700000000000,
        },
        {
          id: `objective_${U_O2}`,
          project_id: fixtureIds.project,
          kind: "objective",
          parent_id: `initiative_${U_I}`,
          title: "Harden the verify CLI",
          instruction_blob: fixture.blobs.hash(
            encoder.encode("Make it verifiable.\n"),
          ),
          acceptance_blob: null,
          worker: null,
          repository_id: "repo_a",
          state: "ready",
          block_reason: null,
          discard_reason: null,
          revision: result.revision,
          updated_at: 1700000000000,
        },
        taskNode(`task_${U_T1}`, `objective_${U_O1}`, "ready"),
        taskNode(`task_${U_T2}`, `objective_${U_O2}`, "ready"),
        taskNode(`task_${U_T3}`, `objective_${U_O2}`, "pending"),
      ]);

      assert.deepEqual(
        (
          fixture.storage.transact((transaction) =>
            transaction.all(
              "SELECT id, from_node, to_node, waived_at FROM edge ORDER BY id ASC",
            ),
          ) as readonly Record<string, unknown>[]
        ).map((row) => ({ ...row })),
        [
          {
            id: `edge_${U_EDGE}`,
            from_node: `task_${U_T3}`,
            to_node: `task_${U_T2}`,
            waived_at: null,
          },
        ],
      );

      const revisionRow = fixture.storage.transact((transaction) =>
        transaction.get(
          "SELECT id, project_id, parent_id, import_id, submitted_blob, choices_blob, accepted_blob FROM plan_revision WHERE id = ?",
          [result.revision],
        ),
      ) as Readonly<{
        id: string;
        project_id: string;
        parent_id: string | null;
        import_id: string;
        submitted_blob: string;
        choices_blob: string;
        accepted_blob: string;
      }>;
      assert.equal(revisionRow.parent_id, null);
      assert.equal(revisionRow.import_id, "imp_roundtrip");

      assert.deepEqual(
        fixture.recorded.map((entry) => entry.input.type),
        [
          "node.ready",
          "node.ready",
          "node.ready",
          "node.ready",
          "node.ready",
          "node.imported",
          "node.imported",
          "node.imported",
          "node.imported",
          "node.imported",
          "node.imported",
          "plan.imported",
        ],
      );
      const nodeEvents = fixture.recorded.filter(
        (entry) => entry.input.type === "node.imported",
      );
      const planEvent = fixture.recorded.find(
        (entry) => entry.input.type === "plan.imported",
      );
      assert.equal(nodeEvents.length, 6);
      assert.deepEqual(
        [...nodeEvents.map((entry) => entry.input.subjectId)].sort(),
        [...roundTripIdentities].sort(),
      );
      for (const entry of nodeEvents) {
        assert.equal(entry.input.subjectKind, "node");
        assert.equal(entry.input.actorKind, "human");
        assert.equal(entry.input.actorId, "human_1");
        assert.deepEqual(entry.input.payload, {
          revision: result.revision,
          source: "submitted",
        });
      }
      assert.ok(planEvent);
      assert.equal(planEvent.input.subjectKind, "project");
      assert.equal(planEvent.input.actorKind, "human");
      assert.deepEqual(planEvent.input.payload, {
        revision: result.revision,
        importId: "imp_roundtrip",
        nodes: 6,
        absent: [],
      });
    });

    it("export is byte-identical and the accepted blob holds the canonical documents json", (t) => {
      const fixture = build([U_I, U_T1, U_O1, U_T2, U_T3, U_O2, U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const result = runImport(fixture, roundTripInput(fixture));
      const exported = exportPlan(
        {
          storage: fixture.storage,
          plan: fixture.plan,
          revision: fixture.revision,
        },
        { projectId: fixtureIds.project },
      );

      assert.equal(exported.revision, result.revision);
      assert.deepEqual(exported.documents, result.documents);
      const revisionRow = fixture.storage.transact((transaction) =>
        transaction.get(
          "SELECT accepted_blob FROM plan_revision WHERE id = ?",
          [result.revision],
        ),
      ) as Readonly<{ accepted_blob: string }>;
      const accepted = fixture.blobs.get(revisionRow.accepted_blob);
      assert.ok(accepted);
      assert.equal(
        decoder.decode(accepted.content),
        canonicalDocumentsJson(result.documents),
      );
    });

    it("a plan naming claude.swe@1 imports without findings and exports byte-identically", (t) => {
      const fixture = build([U_HI, U_HT, U_HO, U_HREV]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const result = runImport(fixture, {
        projectId: fixtureIds.project,
        fromRevision: null,
        importId: "imp_harness_swe_041",
        documents: harnessSubmission,
        choices: [
          { id: `initiative_${U_HI}`, take: "submitted" },
          { id: `task_${U_HT}`, take: "submitted" },
          { id: `objective_${U_HO}`, take: "submitted" },
        ],
        validatedRevision: null,
        documentsHash: fixture.blobs.hash(
          encoder.encode(canonicalDocumentsJson(harnessExpectedDocuments)),
        ),
        actor: "human_1",
      });

      assert.deepEqual(result.absent, []);
      assert.deepEqual(result.documents, harnessExpectedDocuments);

      const exported = exportPlan(
        {
          storage: fixture.storage,
          plan: fixture.plan,
          revision: fixture.revision,
        },
        { projectId: fixtureIds.project },
      );

      assert.deepEqual(exported.documents, result.documents);
    });

    it("a re-import at the same revision succeeds and moves updated_at", (t) => {
      const fixture = build([
        U_I,
        U_T1,
        U_O1,
        U_T2,
        U_T3,
        U_O2,
        U_REV,
        U_EDGE,
        U_REV2,
      ]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const first = runImport(fixture, roundTripInput(fixture));
      const second = runImport(fixture, {
        projectId: fixtureIds.project,
        fromRevision: first.revision,
        importId: "imp_rt2",
        documents: first.documents,
        choices: roundTripIdentities.map((id) => ({ id, take: "database" })),
        validatedRevision: first.revision,
        documentsHash: fixture.blobs.hash(
          encoder.encode(canonicalDocumentsJson(first.documents)),
        ),
        actor: "human_1",
      });

      assert.equal(second.revision, `revision_${U_REV2}`);
      assert.equal(second.retried, false);
      assert.equal(
        fixture.storage.transact((transaction) =>
          fixture.plan.newestRevision(transaction, fixtureIds.project),
        ),
        second.revision,
      );
      const secondRow = fixture.storage.transact((transaction) =>
        transaction.get("SELECT parent_id FROM plan_revision WHERE id = ?", [
          second.revision,
        ]),
      ) as Readonly<{ parent_id: string | null }>;
      assert.equal(secondRow.parent_id, first.revision);
      const updated = (
        fixture.storage.transact((transaction) =>
          transaction.all("SELECT DISTINCT updated_at FROM node"),
        ) as readonly Record<string, unknown>[]
      ).map((row) => ({ ...row }));
      assert.deepEqual(updated, [{ updated_at: 1700000001000 }]);
    });

    it("a re-import at the previous revision is refused by name", (t) => {
      const fixture = build([U_I, U_T1, U_O1, U_T2, U_T3, U_O2, U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const first = runImport(fixture, roundTripInput(fixture));
      const before = snapshot(fixture.storage);
      const error = importRefusal(
        fixture,
        roundTripInput(fixture, {
          fromRevision: null,
          importId: "imp_stale",
          validatedRevision: null,
        }),
      );

      assert.equal(error.refusal, "stale-revision");
      assert.deepEqual(error.details, {
        guard: "project",
        expected: null,
        actual: first.revision,
      });
      assert.deepEqual(snapshot(fixture.storage), before);
    });

    it("a re-import at a stale non-null revision is refused by name", (t) => {
      const fixture = build([
        U_I,
        U_T1,
        U_O1,
        U_T2,
        U_T3,
        U_O2,
        U_REV,
        U_EDGE,
        U_REV2,
      ]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const first = runImport(fixture, roundTripInput(fixture));
      const second = runImport(fixture, {
        projectId: fixtureIds.project,
        fromRevision: first.revision,
        importId: "imp_rt2",
        documents: first.documents,
        choices: roundTripIdentities.map((id) => ({ id, take: "database" })),
        validatedRevision: first.revision,
        documentsHash: fixture.blobs.hash(
          encoder.encode(canonicalDocumentsJson(first.documents)),
        ),
        actor: "human_1",
      });
      const before = snapshot(fixture.storage);
      const error = importRefusal(
        fixture,
        roundTripInput(fixture, {
          fromRevision: first.revision,
          importId: "imp_stale2",
          validatedRevision: first.revision,
        }),
      );

      assert.equal(error.refusal, "stale-revision");
      assert.deepEqual(error.details, {
        guard: "project",
        expected: first.revision,
        actual: second.revision,
      });
      assert.deepEqual(snapshot(fixture.storage), before);
    });
  });

  describe("the derived frontier", () => {
    it("an import leaves a ready frontier", (t) => {
      const fixture = build([U_I, U_T1, U_O1, U_T2, U_T3, U_O2, U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      runImport(fixture, roundTripInput(fixture));
      const graph = fixture.storage.transact((transaction) =>
        fixture.plan.readGraph(transaction, fixtureIds.project),
      );
      const byId = new Map(graph.nodes.map((node) => [node.id, node.state]));
      assert.equal(byId.get(`initiative_${U_I}`), "ready");
      assert.equal(byId.get(`objective_${U_O1}`), "ready");
      assert.equal(byId.get(`objective_${U_O2}`), "ready");
      assert.equal(byId.get(`task_${U_T1}`), "ready");
      assert.equal(byId.get(`task_${U_T2}`), "ready");
      assert.equal(byId.get(`task_${U_T3}`), "pending");
    });

    it("a task with a sibling dependency stays pending and its dependency is ready", (t) => {
      const fixture = build([U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      seedPlanFixture(fixture.storage, fixture.plan, fixture.blobs);
      seedTaskTwo(fixture.storage, fixture.plan, fixture.blobs, false);

      const documents = withTaskDependsOn(fixtureDocuments(fixture));
      runImport(fixture, {
        projectId: fixtureIds.project,
        fromRevision: fixtureIds.planRevision,
        importId: "imp_sibling",
        documents,
        choices: [
          { id: planFixtureIdentities.initiative, take: "database" },
          { id: planFixtureIdentities.objective, take: "database" },
          { id: planFixtureIdentities.task, take: "submitted" },
          { id: planFixtureIdentities.taskTwo, take: "database" },
        ],
        validatedRevision: fixtureIds.planRevision,
        documentsHash: planHash(fixture, documents, []),
        actor: "human_1",
      });

      const task = fixture.storage.transact((transaction) =>
        fixture.plan.readNode(transaction, planFixtureIdentities.task),
      );
      const taskTwo = fixture.storage.transact((transaction) =>
        fixture.plan.readNode(transaction, planFixtureIdentities.taskTwo),
      );
      assert.ok(task);
      assert.ok(taskTwo);
      assert.equal(task.state, "pending");
      assert.equal(taskTwo.state, "ready");
    });

    it("a re-import that adds an unsatisfied dependency demotes a ready node", (t) => {
      const fixture = build([
        U_I,
        U_T1,
        U_O1,
        U_T2,
        U_T3,
        U_O2,
        U_REV,
        U_EDGE,
        U_T4,
        U_REV2,
        U_EDGE2,
      ]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const first = runImport(fixture, roundTripInput(fixture));
      const taskFourPath = `plan/ship-kanthord--${low(U_I)}/harden-the-verify-cli--${low(U_O2)}/03-render-the-manifest--${low(U_T4)}.md`;
      const secondDocuments = [
        ...first.documents.map((document) =>
          document.content.includes(`id: "task_${U_T2}"`)
            ? {
                ...document,
                content: document.content.replace(
                  "---\n",
                  `---\ndepends_on:\n  - "task_${U_T4}"\n`,
                ),
              }
            : document,
        ),
        {
          path: taskFourPath,
          content: `---
kind: "task"
title: "Render the manifest"
worker: "tdd@1"
---
Build the renderer.

## Acceptance criteria

- The bytes match.
`,
        },
      ];
      const dependentBefore = fixture.storage.transact((transaction) => {
        const row = transaction.get("SELECT * FROM node WHERE id = ?", [
          `task_${U_T3}`,
        ]) as Readonly<Record<string, unknown>>;
        return { ...row };
      });
      const second = runImport(fixture, {
        projectId: fixtureIds.project,
        fromRevision: first.revision,
        importId: "imp_demote",
        documents: secondDocuments,
        choices: [
          ...roundTripIdentities.map((id) =>
            id === `task_${U_T2}`
              ? ({ id, take: "submitted" } as const)
              : ({ id, take: "database" } as const),
          ),
          { id: `task_${U_T4}`, take: "submitted" as const },
        ],
        validatedRevision: first.revision,
        documentsHash: planHash(fixture, secondDocuments, [U_T4]),
        actor: "human_1",
      });

      assert.equal(second.revision, `revision_${U_REV2}`);
      const node = fixture.storage.transact((transaction) =>
        fixture.plan.readNode(transaction, `task_${U_T2}`),
      );
      assert.ok(node);
      assert.equal(node.state, "pending");
      const pendingEvents = fixture.recorded.filter(
        (entry) => entry.input.type === "node.pending",
      );
      assert.equal(pendingEvents.length, 1);
      assert.equal(pendingEvents[0]!.input.subjectId, `task_${U_T2}`);
      assert.deepEqual(pendingEvents[0]!.input.payload, {
        from: "ready",
        to: "pending",
        reason: "dependency-unsatisfied",
        revision: second.revision,
        importId: "imp_demote",
      });
      const dependentAfter = fixture.storage.transact((transaction) => {
        const row = transaction.get("SELECT * FROM node WHERE id = ?", [
          `task_${U_T3}`,
        ]) as Readonly<Record<string, unknown>>;
        return { ...row };
      });
      assert.deepEqual(
        {
          ...dependentAfter,
          revision: dependentBefore.revision,
          updated_at: dependentBefore.updated_at,
        },
        dependentBefore,
        "the dependent keeps every field but the import's revision and timestamp",
      );
      assert.equal(dependentAfter.revision, second.revision);
      assert.equal(dependentAfter.updated_at, 1700000001000);
    });

    it("a retry of a committed importId writes no transition and appends no readiness event", (t) => {
      const fixture = build([U_I, U_T1, U_O1, U_T2, U_T3, U_O2, U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      runImport(fixture, roundTripInput(fixture));
      const before = snapshot(fixture.storage);
      const recordedBefore = fixture.recorded.length;
      const retried = runImport(fixture, roundTripInput(fixture));

      assert.equal(retried.retried, true);
      assert.deepEqual(snapshot(fixture.storage), before);
      const gained = fixture.recorded.slice(recordedBefore);
      assert.equal(
        gained.filter(
          (entry) =>
            entry.input.type === "node.ready" ||
            entry.input.type === "node.pending",
        ).length,
        0,
      );
    });

    it("an import that satisfies a dependency leaves a running, blocked, awaiting_approval, done, partial or discarded node untouched", (t) => {
      const fixture = build([
        U_SIX_REV,
        U_SIX_E1,
        U_SIX_E2,
        U_SIX_E3,
        U_SIX_E4,
        U_SIX_E5,
        U_SIX_E6,
      ]);
      t.after(() => fixture.dispose());
      seedSixStateProject(fixture.storage, "done");

      const before = sixStateRows(fixture);
      const result = runImport(
        fixture,
        sixStateImportInput(fixture, sixStateDocuments()),
      );
      const after = sixStateRows(fixture);

      for (const row of sixStateNodes) {
        const prior = before.get(row.id);
        const current = after.get(row.id);
        assert.ok(prior && current, row.id);
        assert.deepEqual(
          {
            ...current,
            revision: prior.revision,
            updated_at: prior.updated_at,
          },
          prior,
          row.id,
        );
        assert.equal(current.revision, result.revision, row.id);
        assert.equal(current.updated_at, 1700000000000, row.id);
      }
    });

    it("an import that adds an unsatisfied dependency leaves a running, blocked, awaiting_approval, done, partial or discarded node untouched", (t) => {
      const fixture = build([
        U_SIX_REV,
        U_SIX_E1,
        U_SIX_E2,
        U_SIX_E3,
        U_SIX_E4,
        U_SIX_E5,
        U_SIX_E6,
      ]);
      t.after(() => fixture.dispose());
      seedSixStateProject(fixture.storage, "pending");

      const before = sixStateRows(fixture);
      const result = runImport(
        fixture,
        sixStateImportInput(fixture, sixStateDocuments()),
      );
      const after = sixStateRows(fixture);

      for (const row of sixStateNodes) {
        const prior = before.get(row.id);
        const current = after.get(row.id);
        assert.ok(prior && current, row.id);
        assert.deepEqual(
          {
            ...current,
            revision: prior.revision,
            updated_at: prior.updated_at,
          },
          prior,
          row.id,
        );
        assert.equal(current.revision, result.revision, row.id);
        assert.equal(current.updated_at, 1700000000000, row.id);
      }
    });

    it("the readiness event order of one import is bytewise by node identity", (t) => {
      const fixture = build([U_I, U_T1, U_O1, U_T2, U_T3, U_O2, U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      runImport(fixture, roundTripInput(fixture));
      const ready = fixture.recorded.filter(
        (entry) => entry.input.type === "node.ready",
      );
      const subjects = ready.map((entry) => entry.input.subjectId);
      const sorted = [...subjects].sort((left, right) =>
        Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
      );
      assert.deepEqual(subjects, sorted);
      assert.deepEqual(subjects, [
        `initiative_${U_I}`,
        `objective_${U_O1}`,
        `objective_${U_O2}`,
        `task_${U_T1}`,
        `task_${U_T2}`,
      ]);
    });

    it("the readiness events precede the node.imported events", (t) => {
      const fixture = build([U_I, U_T1, U_O1, U_T2, U_T3, U_O2, U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      runImport(fixture, roundTripInput(fixture));
      const types = fixture.recorded.map((entry) => entry.input.type);
      const lastReady = types.lastIndexOf("node.ready");
      const firstImported = types.indexOf("node.imported");
      assert.ok(lastReady !== -1, "a node.ready event exists");
      assert.ok(firstImported !== -1, "a node.imported event exists");
      assert.ok(lastReady < firstImported);
    });

    it("plan.export is byte-identical after readiness lands", (t) => {
      const fixture = build([U_I, U_T1, U_O1, U_T2, U_T3, U_O2, U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      runImport(fixture, roundTripInput(fixture));
      const exported = exportPlan(
        {
          storage: fixture.storage,
          plan: fixture.plan,
          revision: fixture.revision,
        },
        { projectId: fixtureIds.project },
      );

      assert.deepEqual(exported.documents, expectedDocuments);
    });
  });

  describe("idempotency", () => {
    it("a retry returns the original revision and writes no second revision", (t) => {
      const fixture = build([U_I, U_T1, U_O1, U_T2, U_T3, U_O2, U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const first = runImport(fixture, roundTripInput(fixture));
      const retried = runImport(fixture, roundTripInput(fixture));

      assert.equal(retried.retried, true);
      assert.equal(retried.revision, first.revision);
      assert.deepEqual(retried.documents, first.documents);
      assert.deepEqual(retried.absent, []);
      const count = fixture.storage.transact((transaction) =>
        transaction.get("SELECT COUNT(*) AS c FROM plan_revision"),
      ) as { c: number };
      assert.equal(count.c, 1);
    });

    it("a reordered document array is still a retry", (t) => {
      const fixture = build([U_I, U_T1, U_O1, U_T2, U_T3, U_O2, U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      runImport(fixture, roundTripInput(fixture));
      const retried = runImport(
        fixture,
        roundTripInput(fixture, {
          documents: [...roundTripSubmission].reverse(),
        }),
      );

      assert.equal(retried.retried, true);
      assert.equal(retried.revision, `revision_${U_REV}`);
    });

    it("a reordered choice array is still a retry", (t) => {
      const fixture = build([U_I, U_T1, U_O1, U_T2, U_T3, U_O2, U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      runImport(fixture, roundTripInput(fixture));
      const retried = runImport(
        fixture,
        roundTripInput(fixture, {
          choices: [...roundTripChoices].reverse(),
        }),
      );

      assert.equal(retried.retried, true);
      assert.equal(retried.revision, `revision_${U_REV}`);
    });

    it("a different choice set under the same id is idempotency-mismatch naming choices", (t) => {
      const fixture = build([U_I, U_T1, U_O1, U_T2, U_T3, U_O2, U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      runImport(fixture, roundTripInput(fixture));
      const before = snapshot(fixture.storage);
      const changed = roundTripChoices.map((entry) =>
        entry.id === `task_${U_T1}`
          ? { ...entry, take: "database" as const }
          : entry,
      );
      const error = importRefusal(
        fixture,
        roundTripInput(fixture, { choices: changed }),
      );

      assert.equal(error.refusal, "idempotency-mismatch");
      assert.equal((error.details as { differed: string }).differed, "choices");
      assert.deepEqual(snapshot(fixture.storage), before);
    });

    it("a different document content under the same id is idempotency-mismatch naming documents", (t) => {
      const fixture = build([U_I, U_T1, U_O1, U_T2, U_T3, U_O2, U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      runImport(fixture, roundTripInput(fixture));
      const changed = roundTripSubmission.map((document) =>
        document.content.includes("Bootstrap the daemon.")
          ? {
              ...document,
              content: document.content.replace(
                "Bootstrap the daemon.",
                "Bootstrap daemon.",
              ),
            }
          : document,
      );
      const error = importRefusal(
        fixture,
        roundTripInput(fixture, { documents: changed }),
      );

      assert.equal(error.refusal, "idempotency-mismatch");
      assert.equal(
        (error.details as { differed: string }).differed,
        "documents",
      );
    });

    it("a different validatedRevision under the same id is idempotency-mismatch naming validatedRevision", (t) => {
      const fixture = build([U_I, U_T1, U_O1, U_T2, U_T3, U_O2, U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      runImport(fixture, roundTripInput(fixture));
      const error = importRefusal(
        fixture,
        roundTripInput(fixture, { validatedRevision: "revision_x" }),
      );

      assert.equal(error.refusal, "idempotency-mismatch");
      assert.equal(
        (error.details as { differed: string }).differed,
        "validatedRevision",
      );
    });

    it("a different fromRevision under the same id is idempotency-mismatch naming fromRevision", (t) => {
      const fixture = build([U_I, U_T1, U_O1, U_T2, U_T3, U_O2, U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      runImport(fixture, roundTripInput(fixture));
      const error = importRefusal(
        fixture,
        roundTripInput(fixture, { fromRevision: "revision_x" }),
      );

      assert.equal(error.refusal, "idempotency-mismatch");
      assert.equal(
        (error.details as { differed: string }).differed,
        "fromRevision",
      );
    });

    it("a retry mints nothing and a refusal leaves the generator and the clock untouched", (t) => {
      const fixture = build([U_I, U_T1, U_O1, U_T2, U_T3, U_O2, U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const ids = countingIds(fixture.ids);
      const clock = countingClock(fixture.clock);
      const first = importPlan(
        {
          storage: fixture.storage,
          plan: fixture.plan,
          blobs: fixture.blobs,
          reader: fixture.reader,
          graph: fixture.graph,
          ids: ids.ids,
          clock: clock.clock,
          events: fixture.events,
        },
        roundTripInput(fixture),
      );
      assert.equal(ids.count(), 8);
      assert.equal(clock.count(), 1);
      const retried = importPlan(
        {
          storage: fixture.storage,
          plan: fixture.plan,
          blobs: fixture.blobs,
          reader: fixture.reader,
          graph: fixture.graph,
          ids: ids.ids,
          clock: clock.clock,
          events: fixture.events,
        },
        roundTripInput(fixture),
      );
      assert.equal(retried.retried, true);
      assert.equal(retried.revision, first.revision);
      assert.equal(ids.count(), 8, "a retry mints nothing");
      assert.equal(clock.count(), 1, "a retry reads no clock");

      const stale = build([]);
      t.after(() => stale.dispose());
      stale.storage.transact((transaction) => seedRegistry(transaction));
      const staleIds = countingIds(stale.ids);
      const staleClock = countingClock(stale.clock);
      importRefusal(stale, {
        projectId: fixtureIds.project,
        fromRevision: "revision_x",
        importId: "imp_stale",
        documents: roundTripSubmission,
        choices: roundTripChoices,
        validatedRevision: null,
        documentsHash: `sha256:${"0".repeat(64)}`,
        actor: "human_1",
      });
      assert.equal(staleIds.count(), 0, "a refusal mints nothing");
      assert.equal(staleClock.count(), 0, "a refusal reads no clock");
      assert.equal(stale.recorded.length, 0, "a refusal appends no event");
    });

    it("the three revision blobs exist and choices_blob holds the canonical choices json alone", (t) => {
      const fixture = build([U_I, U_T1, U_O1, U_T2, U_T3, U_O2, U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      runImport(fixture, roundTripInput(fixture));
      const revisionRow = fixture.storage.transact((transaction) =>
        transaction.get(
          "SELECT submitted_blob, choices_blob, accepted_blob FROM plan_revision WHERE id = ?",
          [`revision_${U_REV}`],
        ),
      ) as Readonly<{
        submitted_blob: string;
        choices_blob: string;
        accepted_blob: string;
      }>;
      for (const hash of [
        revisionRow.submitted_blob,
        revisionRow.choices_blob,
        revisionRow.accepted_blob,
      ]) {
        assert.ok(fixture.blobs.get(hash), `blob row ${hash} exists`);
      }
      const choicesBlob = fixture.blobs.get(revisionRow.choices_blob);
      assert.ok(choicesBlob);
      const choicesText = decoder.decode(choicesBlob.content);
      assert.equal(choicesText, canonicalChoicesJson(roundTripChoices));
      assert.equal(choicesText.includes("fromRevision"), false);
      assert.equal(choicesText.includes("validatedRevision"), false);
    });

    it("the same importId on a different project is not a retry", (t) => {
      const fixture = build([
        U_I,
        U_T1,
        U_O1,
        U_T2,
        U_T3,
        U_O2,
        U_REV,
        U_EDGE,
        U2_I,
        U2_T1,
        U2_O1,
        U2_T2,
        U2_T3,
        U2_O2,
        U2_REV,
        U2_EDGE,
      ]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => {
        seedRegistry(transaction);
        seedSecondProject(transaction);
      });

      runImport(fixture, roundTripInput(fixture));
      const secondValidation = validatePlan(
        {
          storage: fixture.storage,
          plan: fixture.plan,
          blobs: fixture.blobs,
          reader: fixture.reader,
          graph: fixture.graph,
          ids: createMockIdGenerator({
            ulids: [U2_I, U2_T1, U2_O1, U2_T2, U2_T3, U2_O2],
          }),
        },
        {
          projectId: "project_b",
          fromRevision: null,
          documents: roundTripSubmission,
        },
      );
      const second = runImport(
        fixture,
        roundTripInput(fixture, {
          projectId: "project_b",
          choices: secondValidation.choices.map((entry) => ({
            id: entry.id,
            take: entry.suggested,
          })),
          documentsHash: secondValidation.documentsHash,
        }),
      );

      assert.equal(second.retried, false);
      assert.equal(second.revision, `revision_${U2_REV}`);
      const count = fixture.storage.transact((transaction) =>
        transaction.get("SELECT COUNT(*) AS c FROM plan_revision"),
      ) as { c: number };
      assert.equal(count.c, 2);
    });
  });

  describe("the choice set", () => {
    it("a missing choice throws choice-missing and writes nothing", (t) => {
      const fixture = build([U_I, U_T1, U_O1, U_T2, U_T3, U_O2]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const before = snapshot(fixture.storage);
      const choices = roundTripChoices.filter(
        (entry) => entry.id !== `task_${U_T1}`,
      );
      const error = importRefusal(
        fixture,
        roundTripInput(fixture, { choices }),
      );

      assert.equal(error.refusal, "choice-missing");
      assert.deepEqual((error.details as { ids: string[] }).ids, [
        `task_${U_T1}`,
      ]);
      assert.deepEqual(snapshot(fixture.storage), before);
    });

    it("an extra choice throws choice-extra and writes nothing", (t) => {
      const fixture = build([U_I, U_T1, U_O1, U_T2, U_T3, U_O2]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const before = snapshot(fixture.storage);
      const choices = [
        ...roundTripChoices,
        { id: `task_${U2_T1}`, take: "submitted" as const },
      ];
      const error = importRefusal(
        fixture,
        roundTripInput(fixture, { choices }),
      );

      assert.equal(error.refusal, "choice-extra");
      assert.deepEqual((error.details as { ids: string[] }).ids, [
        `task_${U2_T1}`,
      ]);
      assert.deepEqual(snapshot(fixture.storage), before);
    });

    it("a duplicate choice throws choice-duplicate and writes nothing", (t) => {
      const fixture = build([]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const before = snapshot(fixture.storage);
      const choices = [
        ...roundTripChoices,
        { id: `task_${U_T1}`, take: "database" as const },
      ];
      const error = importRefusal(
        fixture,
        roundTripInput(fixture, { choices }),
      );

      assert.equal(error.refusal, "choice-duplicate");
      assert.deepEqual((error.details as { ids: string[] }).ids, [
        `task_${U_T1}`,
      ]);
      assert.deepEqual(snapshot(fixture.storage), before);
    });
  });

  describe("structural and prose edits, per state", () => {
    it("submitted on a structural edit is refused at running, awaiting_approval, done, partial and discarded", (t) => {
      const cases: ReadonlyArray<readonly [string, string]> = [
        ["running", planFixtureIdentities.task],
        ["done", planFixtureIdentities.task],
        ["discarded", planFixtureIdentities.task],
        ["awaiting_approval", planFixtureIdentities.objective],
        ["partial", planFixtureIdentities.objective],
      ];
      for (const [state, nodeId] of cases) {
        const fixture = build([]);
        t.after(() => fixture.dispose());
        seedPlanFixture(fixture.storage, fixture.plan, fixture.blobs);
        seedTaskTwo(fixture.storage, fixture.plan, fixture.blobs, false);
        if (nodeId === planFixtureIdentities.objective) {
          seedRepoB(fixture.storage);
          bindRepoB(fixture.storage);
        }
        fixture.storage.transact((transaction) => {
          transaction.run("UPDATE node SET state = ? WHERE id = ?", [
            state,
            nodeId,
          ]);
        });
        const exported = fixtureDocuments(fixture);
        const documents =
          nodeId === planFixtureIdentities.task
            ? withTaskDependsOn(exported)
            : withObjectiveRepoB(exported);
        const choices: readonly Readonly<{ id: string; take: Choice }>[] = [
          { id: planFixtureIdentities.initiative, take: "database" },
          {
            id: planFixtureIdentities.objective,
            take:
              nodeId === planFixtureIdentities.objective
                ? "submitted"
                : "database",
          },
          {
            id: planFixtureIdentities.task,
            take:
              nodeId === planFixtureIdentities.task ? "submitted" : "database",
          },
          { id: planFixtureIdentities.taskTwo, take: "database" },
        ];
        const before = snapshot(fixture.storage);
        const error = importRefusal(fixture, {
          projectId: fixtureIds.project,
          fromRevision: fixtureIds.planRevision,
          importId: `imp_${state}`,
          documents,
          choices,
          validatedRevision: fixtureIds.planRevision,
          documentsHash: planHash(fixture, documents, []),
          actor: "human_1",
        });

        assert.equal(error.refusal, "choices-changed", state);
        assert.ok(
          JSON.stringify(error.details).includes(nodeId),
          `${state} names the node`,
        );
        assert.deepEqual(snapshot(fixture.storage), before, state);
      }
    });

    it("submitted on a structural edit is accepted at pending, blocked and ready, and a blocked node keeps its block_reason", (t) => {
      for (const state of ["pending", "blocked", "ready"]) {
        const fixture = build([U_REV, U_EDGE]);
        t.after(() => fixture.dispose());
        seedPlanFixture(fixture.storage, fixture.plan, fixture.blobs);
        seedTaskTwo(fixture.storage, fixture.plan, fixture.blobs, false);
        if (state === "blocked") {
          fixture.storage.transact((transaction) => {
            transaction.run(
              "UPDATE node SET state = 'blocked', block_reason = 'stale-base' WHERE id = ?",
              [planFixtureIdentities.task],
            );
          });
        } else if (state === "ready") {
          fixture.storage.transact((transaction) => {
            transaction.run("UPDATE node SET state = 'ready' WHERE id = ?", [
              planFixtureIdentities.task,
            ]);
          });
        }
        const documents = withTaskDependsOn(fixtureDocuments(fixture));
        const result = runImport(fixture, {
          projectId: fixtureIds.project,
          fromRevision: fixtureIds.planRevision,
          importId: `imp_${state}`,
          documents,
          choices: [
            { id: planFixtureIdentities.initiative, take: "database" },
            { id: planFixtureIdentities.objective, take: "database" },
            { id: planFixtureIdentities.task, take: "submitted" },
            { id: planFixtureIdentities.taskTwo, take: "database" },
          ],
          validatedRevision: fixtureIds.planRevision,
          documentsHash: planHash(fixture, documents, []),
          actor: "human_1",
        });

        assert.equal(result.revision, `revision_${U_REV}`, state);
        const edge = fixture.storage.transact((transaction) =>
          transaction.get(
            "SELECT id, from_node, to_node, waived_at FROM edge WHERE from_node = ? AND to_node = ?",
            [planFixtureIdentities.task, planFixtureIdentities.taskTwo],
          ),
        ) as Readonly<{ id: string; waived_at: number | null }>;
        assert.ok(edge, `${state} commits the new dependency`);
        assert.equal(edge.id, `edge_${U_EDGE}`);
        assert.equal(edge.waived_at, null);
        if (state === "blocked") {
          const node = fixture.storage.transact((transaction) =>
            fixture.plan.readNode(transaction, planFixtureIdentities.task),
          );
          assert.ok(node);
          assert.equal(node.state, "blocked");
          assert.equal(node.blockReason, "stale-base");
        }
      }
    });

    it("a prose edit is accepted at every state and leaves the state and the discard reason untouched", (t) => {
      const cases: ReadonlyArray<
        readonly [string, string, string | null, string | null]
      > = [
        ["pending", planFixtureIdentities.task, null, null],
        ["blocked", planFixtureIdentities.task, "stale-base", null],
        ["ready", planFixtureIdentities.task, null, null],
        ["running", planFixtureIdentities.task, null, null],
        ["awaiting_approval", planFixtureIdentities.objective, null, null],
        ["done", planFixtureIdentities.task, null, null],
        ["partial", planFixtureIdentities.objective, null, null],
        ["discarded", planFixtureIdentities.task, null, "wontfix"],
      ];
      for (const [state, nodeId, blockReason, discardReason] of cases) {
        const fixture = build([U_REV]);
        t.after(() => fixture.dispose());
        seedPlanFixture(fixture.storage, fixture.plan, fixture.blobs);
        if (state === "pending") {
          seedTaskTwo(fixture.storage, fixture.plan, fixture.blobs, false);
          fixture.storage.transact((transaction) => {
            transaction.run(
              "INSERT INTO edge (id, from_node, to_node, waived_at) VALUES (?, ?, ?, NULL)",
              [
                "edge_prose",
                planFixtureIdentities.task,
                planFixtureIdentities.taskTwo,
              ],
            );
          });
        }
        fixture.storage.transact((transaction) => {
          const sets: string[] = ["state = ?"];
          const values: unknown[] = [state];
          if (blockReason !== null) {
            sets.push("block_reason = ?");
            values.push(blockReason);
          }
          if (discardReason !== null) {
            sets.push("discard_reason = ?");
            values.push(discardReason);
          }
          values.push(nodeId);
          transaction.run(
            `UPDATE node SET ${sets.join(", ")} WHERE id = ?`,
            values,
          );
        });
        const exported = fixtureDocuments(fixture);
        const documents =
          nodeId === planFixtureIdentities.task
            ? withTaskTitle(exported, "Renamed task")
            : withObjectiveTitle(exported, "Renamed objective");
        const choices: readonly Readonly<{ id: string; take: Choice }>[] = [
          { id: planFixtureIdentities.initiative, take: "database" },
          {
            id: planFixtureIdentities.objective,
            take:
              nodeId === planFixtureIdentities.objective
                ? "submitted"
                : "database",
          },
          {
            id: planFixtureIdentities.task,
            take:
              nodeId === planFixtureIdentities.task ? "submitted" : "database",
          },
          ...(state === "pending"
            ? [
                {
                  id: planFixtureIdentities.taskTwo,
                  take: "database" as const,
                },
              ]
            : []),
        ];
        const result = runImport(fixture, {
          projectId: fixtureIds.project,
          fromRevision: fixtureIds.planRevision,
          importId: `imp_${state}`,
          documents,
          choices,
          validatedRevision: fixtureIds.planRevision,
          documentsHash: planHash(fixture, documents, []),
          actor: "human_1",
        });

        assert.equal(result.revision, `revision_${U_REV}`, state);
        const node = fixture.storage.transact((transaction) =>
          fixture.plan.readNode(transaction, nodeId),
        );
        assert.ok(node);
        assert.equal(
          node.title,
          nodeId === planFixtureIdentities.task
            ? "Renamed task"
            : "Renamed objective",
          state,
        );
        assert.equal(node.state, state, `${state} keeps its state`);
        assert.equal(
          node.blockReason,
          blockReason,
          `${state} keeps its block reason`,
        );
        assert.equal(
          node.discardReason,
          discardReason,
          `${state} keeps its discard reason`,
        );
      }
    });

    it("a depends_on edit on a pending task holding a workspace is accepted: containment gates parent and repo only", (t) => {
      const fixture = build([U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      seedPlanFixture(fixture.storage, fixture.plan, fixture.blobs);
      seedTaskTwo(fixture.storage, fixture.plan, fixture.blobs, false);
      seedWorkspaceOnTask(fixture.storage);

      const documents = withTaskDependsOn(fixtureDocuments(fixture));
      const result = runImport(fixture, {
        projectId: fixtureIds.project,
        fromRevision: fixtureIds.planRevision,
        importId: "imp_workspace",
        documents,
        choices: [
          { id: planFixtureIdentities.initiative, take: "database" },
          { id: planFixtureIdentities.objective, take: "database" },
          { id: planFixtureIdentities.task, take: "submitted" },
          { id: planFixtureIdentities.taskTwo, take: "database" },
        ],
        validatedRevision: fixtureIds.planRevision,
        documentsHash: planHash(fixture, documents, []),
        actor: "human_1",
      });

      assert.equal(result.revision, `revision_${U_REV}`);
      const edge = fixture.storage.transact((transaction) =>
        transaction.get(
          "SELECT id, from_node, to_node, waived_at FROM edge WHERE from_node = ? AND to_node = ?",
          [planFixtureIdentities.task, planFixtureIdentities.taskTwo],
        ),
      ) as Readonly<{ id: string }> | undefined;
      assert.ok(edge, "the new dependency commits");
      assert.equal(edge.id, `edge_${U_EDGE}`);
    });

    it("an objective whose descendant task holds an attempt commit cannot change repo", (t) => {
      const fixture = build([]);
      t.after(() => fixture.dispose());
      seedPlanFixture(fixture.storage, fixture.plan, fixture.blobs);
      seedRepoB(fixture.storage);
      bindRepoB(fixture.storage);
      seedAttemptCommitOnTask(fixture.storage);

      const documents = withObjectiveRepoB(fixtureDocuments(fixture));
      const before = snapshot(fixture.storage);
      const error = importRefusal(fixture, {
        projectId: fixtureIds.project,
        fromRevision: fixtureIds.planRevision,
        importId: "imp_commit",
        documents,
        choices: [
          { id: planFixtureIdentities.initiative, take: "database" },
          { id: planFixtureIdentities.objective, take: "submitted" },
          { id: planFixtureIdentities.task, take: "database" },
        ],
        validatedRevision: fixtureIds.planRevision,
        documentsHash: planHash(fixture, documents, []),
        actor: "human_1",
      });

      assert.equal(error.refusal, "choices-changed");
      assert.ok(
        JSON.stringify(error.details).includes(planFixtureIdentities.objective),
      );
      assert.ok(JSON.stringify(error.details).includes("workspace"));
      assert.deepEqual(snapshot(fixture.storage), before);
    });
  });

  describe("the cycle", () => {
    it("is choices-invalid, never a silent repair, and validatePlan does not suggest the local combination", (t) => {
      const fixture = build([]);
      t.after(() => fixture.dispose());
      seedPlanFixture(fixture.storage, fixture.plan, fixture.blobs);
      seedTaskTwo(fixture.storage, fixture.plan, fixture.blobs, true);

      const exported = fixtureDocuments(fixture);
      const edited = exported
        .filter(
          (document) => !document.content.includes("Do the second task work."),
        )
        .map((document) =>
          document.content.includes("Do the task work.")
            ? {
                ...document,
                content: document.content.replace(
                  "---\n",
                  `---\ndepends_on:\n  - "${planFixtureIdentities.taskTwo}"\n`,
                ),
              }
            : document,
        );
      const validation = validatePlan(
        {
          storage: fixture.storage,
          plan: fixture.plan,
          blobs: fixture.blobs,
          reader: fixture.reader,
          graph: fixture.graph,
          ids: createMockIdGenerator({ ulids: [] }),
        },
        {
          projectId: fixtureIds.project,
          fromRevision: fixtureIds.planRevision,
          documents: edited,
        },
      );
      const taskEntry = validation.choices.find(
        (entry) => entry.id === planFixtureIdentities.task,
      );
      const taskTwoEntry = validation.choices.find(
        (entry) => entry.id === planFixtureIdentities.taskTwo,
      );
      assert.ok(taskEntry);
      assert.ok(taskTwoEntry);
      assert.notDeepEqual(
        [taskEntry.suggested, taskTwoEntry.suggested],
        ["submitted", "database"],
      );

      const before = snapshot(fixture.storage);
      const error = importRefusal(fixture, {
        projectId: fixtureIds.project,
        fromRevision: fixtureIds.planRevision,
        importId: "imp_cycle",
        documents: edited,
        choices: [
          { id: planFixtureIdentities.initiative, take: "database" },
          { id: planFixtureIdentities.objective, take: "database" },
          { id: planFixtureIdentities.task, take: "submitted" },
          { id: planFixtureIdentities.taskTwo, take: "database" },
        ],
        validatedRevision: fixtureIds.planRevision,
        documentsHash: validation.documentsHash,
        actor: "human_1",
      });

      assert.equal(error.refusal, "choices-invalid");
      const findings = (
        error.details as {
          findings: readonly Readonly<{ code: string }>[];
        }
      ).findings;
      assert.deepEqual(
        findings.map((finding) => finding.code),
        ["dependency-cycle"],
      );
      assert.deepEqual(snapshot(fixture.storage), before);
    });
  });

  describe("the repository binding", () => {
    it("an objective naming a repository that is not bound to its project is refused", (t) => {
      const fixture = build([]);
      t.after(() => fixture.dispose());
      seedPlanFixture(fixture.storage, fixture.plan, fixture.blobs);
      seedRepoB(fixture.storage);

      const documents = withObjectiveRepoB(fixtureDocuments(fixture));
      const before = snapshot(fixture.storage);
      const error = importRefusal(fixture, {
        projectId: fixtureIds.project,
        fromRevision: fixtureIds.planRevision,
        importId: "imp_unbound",
        documents,
        choices: [
          { id: planFixtureIdentities.initiative, take: "database" },
          { id: planFixtureIdentities.objective, take: "database" },
          { id: planFixtureIdentities.task, take: "database" },
          { id: planFixtureIdentities.taskTwo, take: "database" },
        ],
        validatedRevision: fixtureIds.planRevision,
        documentsHash: `sha256:${"0".repeat(64)}`,
        actor: "human_1",
      });

      assert.equal(error.refusal, "plan-invalid");
      const findings = (
        error.details as {
          findings: readonly Readonly<{ code: string }>[];
        }
      ).findings;
      assert.deepEqual(
        findings.map((finding) => finding.code),
        ["repository-unbound"],
      );
      assert.deepEqual(snapshot(fixture.storage), before);
    });

    function namedRepoDocuments(
      repo: string,
    ): readonly Readonly<{ path: string; content: string }>[] {
      return [
        {
          path: "plan/named-repo/initiative.md",
          content: `---
id: "initiative_01ARZ3NDEKTSV4RRFFQ69G5FAY"
kind: "initiative"
title: "Ship kanthord"
---
Bootstrap the daemon.
`,
        },
        {
          path: "plan/named-repo/harden/objective.md",
          content: `---
id: "objective_01ARZ3NDEKTSV4RRFFQ69G5FAZ"
kind: "objective"
title: "Harden the verify CLI"
repo: "${repo}"
---
Make it verifiable.
`,
        },
        {
          path: "plan/named-repo/harden/01-a.md",
          content: `---
id: "task_01ARZ3NDEKTSV4RRFFQ69G5FB2"
kind: "task"
title: "Render the manifest"
worker: "tdd@1"
---
Build the renderer.

## Acceptance criteria

- The bytes match.
`,
        },
      ];
    }

    const namedRepoChoices: readonly Readonly<{ id: string; take: Choice }>[] =
      [
        { id: "initiative_01ARZ3NDEKTSV4RRFFQ69G5FAY", take: "submitted" },
        { id: "objective_01ARZ3NDEKTSV4RRFFQ69G5FAZ", take: "submitted" },
        { id: "task_01ARZ3NDEKTSV4RRFFQ69G5FB2", take: "submitted" },
      ];

    it("an objective naming a registered repository by its name persists the resolved repository id", (t) => {
      const fixture = build(["01ARZ3NDEKTSV4RRFFQ69G5FB3"]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const documents = namedRepoDocuments("kanthord-verify");
      const documentsHash = planHash(fixture, documents, []);

      const result = runImport(fixture, {
        projectId: fixtureIds.project,
        fromRevision: null,
        importId: "imp_named_repo",
        documents,
        choices: namedRepoChoices,
        validatedRevision: null,
        documentsHash,
        actor: "human_1",
      });

      assert.equal(result.revision, "revision_01ARZ3NDEKTSV4RRFFQ69G5FB3");
      const row = fixture.storage.transact((transaction) =>
        transaction.get("SELECT repository_id FROM node WHERE id = ?", [
          "objective_01ARZ3NDEKTSV4RRFFQ69G5FAZ",
        ]),
      ) as Readonly<{ repository_id: string | null }>;
      assert.equal(
        row.repository_id,
        fixtureIds.repository,
        "the node stores the repository's id, not the registered name",
      );
    });

    it("an objective naming an unregistered repository name is repository-unknown carrying the name", (t) => {
      const fixture = build([]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const documents = namedRepoDocuments("does-not-exist");
      const before = snapshot(fixture.storage);
      const error = importRefusal(fixture, {
        projectId: fixtureIds.project,
        fromRevision: null,
        importId: "imp_unknown_repo",
        documents,
        choices: namedRepoChoices,
        validatedRevision: null,
        documentsHash: `sha256:${"0".repeat(64)}`,
        actor: "human_1",
      });

      assert.equal(error.refusal, "plan-invalid");
      const findings = (
        error.details as {
          findings: readonly Readonly<{ code: string; message: string }>[];
        }
      ).findings;
      assert.deepEqual(
        findings.map((finding) => finding.code),
        ["repository-unknown"],
      );
      assert.match(findings[0]!.message, /does-not-exist/);
      assert.deepEqual(snapshot(fixture.storage), before);
    });

    it("throws repository-unknown naming the id when a stored node's repository_id names no repository row", (t) => {
      const fixture = build([]);
      t.after(() => fixture.dispose());
      seedPlanFixture(fixture.storage, fixture.plan, fixture.blobs);
      const raw = new DatabaseSync(fixture.path);
      raw.exec("PRAGMA foreign_keys = OFF");
      raw
        .prepare("UPDATE node SET repository_id = ? WHERE id = ?")
        .run("repo_ghost", planFixtureIdentities.objective);
      raw.close();

      const error = importRefusal(fixture, {
        projectId: fixtureIds.project,
        fromRevision: fixtureIds.planRevision,
        importId: "imp_ghost_repo",
        documents: [],
        choices: [],
        validatedRevision: fixtureIds.planRevision,
        documentsHash: `sha256:${"0".repeat(64)}`,
        actor: "human_1",
      });

      assert.equal(error.refusal, "repository-unknown");
      assert.match(error.message, /repo_ghost/);
    });

    it("the name → id lookup gets its own case: a registered repository row removed after the revision is accepted and before the write is refused naming the unresolved name", (t) => {
      const fixture = build(["01ARZ3NDEKTSV4RRFFQ69G5FB6"]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const documents = namedRepoDocuments("kanthord-verify");
      const documentsHash = planHash(fixture, documents, []);

      const raw = new DatabaseSync(fixture.path);
      raw.exec("PRAGMA foreign_keys = OFF");
      raw.exec(`
        CREATE TRIGGER kanthord_test_drop_repo_after_accept
        AFTER INSERT ON plan_revision
        BEGIN
          DELETE FROM repository WHERE name = 'kanthord-verify';
        END
      `);
      raw.close();

      const error = importRefusal(fixture, {
        projectId: fixtureIds.project,
        fromRevision: null,
        importId: "imp_name_to_id_seam",
        documents,
        choices: namedRepoChoices,
        validatedRevision: null,
        documentsHash,
        actor: "human_1",
      });

      assert.equal(error.refusal, "repository-unknown");
      assert.match(error.message, /kanthord-verify/);
    });
  });

  describe("the rest", () => {
    it("documentsHash altered by one character throws documents-hash-mismatch", (t) => {
      const fixture = build([U_I, U_T1, U_O1, U_T2, U_T3, U_O2]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const before = snapshot(fixture.storage);
      const correct = fixture.blobs.hash(
        encoder.encode(canonicalDocumentsJson(expectedDocuments)),
      );
      const wrong = `${correct.slice(0, -1)}${correct.endsWith("0") ? "1" : "0"}`;
      const error = importRefusal(
        fixture,
        roundTripInput(fixture, { documentsHash: wrong }),
      );

      assert.equal(error.refusal, "documents-hash-mismatch");
      assert.deepEqual(snapshot(fixture.storage), before);
    });

    it("a validatedRevision naming an older revision throws choices-stale carrying the fresh union", (t) => {
      const fixture = build([]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const before = snapshot(fixture.storage);
      const error = importRefusal(
        fixture,
        roundTripInput(fixture, { validatedRevision: "revision_older" }),
      );

      assert.equal(error.refusal, "choices-stale");
      assert.ok(error.details !== undefined);
      const text = JSON.stringify(error.details);
      for (const identity of roundTripIdentities) {
        assert.ok(text.includes(identity), `${identity} is in the fresh union`);
      }
      assert.deepEqual(snapshot(fixture.storage), before);
    });

    it("choices-stale details carry the fresh union and a verdict per identity", (t) => {
      const fixture = build([]);
      t.after(() => fixture.dispose());
      seedPlanFixture(fixture.storage, fixture.plan, fixture.blobs);

      const before = snapshot(fixture.storage);
      const error = importRefusal(
        fixture,
        roundTripInput(fixture, {
          fromRevision: fixtureIds.planRevision,
          validatedRevision: "revision_older",
        }),
      );

      assert.equal(error.refusal, "choices-stale");
      assert.ok(error.details !== undefined);
      const details = error.details as {
        conflicts: readonly Readonly<{ id: string; suggested?: string }>[];
      };
      assert.ok(Array.isArray(details.conflicts));
      const ids = details.conflicts.map((entry) => entry.id);
      for (const identity of roundTripIdentities) {
        assert.ok(ids.includes(identity), `${identity} is in the fresh union`);
      }
      for (const identity of [
        planFixtureIdentities.objective,
        planFixtureIdentities.task,
      ]) {
        assert.ok(
          ids.includes(identity),
          `${identity} is a database-only member of the fresh union`,
        );
      }
      for (const entry of details.conflicts) {
        assert.ok(
          entry.suggested === "submitted" || entry.suggested === "database",
          `each conflict carries the current verdict`,
        );
      }
      assert.deepEqual(snapshot(fixture.storage), before);
    });

    it("a waiver survives a re-import that rewires the same pair", (t) => {
      const fixture = build([
        U_I,
        U_T1,
        U_O1,
        U_T2,
        U_T3,
        U_O2,
        U_REV,
        U_EDGE,
        U_REV2,
      ]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const first = runImport(fixture, roundTripInput(fixture));
      fixture.storage.transact((transaction) => {
        transaction.run("UPDATE edge SET waived_at = 1 WHERE id = ?", [
          `edge_${U_EDGE}`,
        ]);
      });
      const second = runImport(fixture, {
        projectId: fixtureIds.project,
        fromRevision: first.revision,
        importId: "imp_waiver",
        documents: first.documents,
        choices: roundTripIdentities.map((id) => ({ id, take: "database" })),
        validatedRevision: first.revision,
        documentsHash: fixture.blobs.hash(
          encoder.encode(canonicalDocumentsJson(first.documents)),
        ),
        actor: "human_1",
      });

      assert.equal(second.revision, `revision_${U_REV2}`);
      const edge = fixture.storage.transact((transaction) =>
        transaction.get(
          "SELECT id, from_node, to_node, waived_at FROM edge WHERE from_node = ? AND to_node = ?",
          [`task_${U_T3}`, `task_${U_T2}`],
        ),
      ) as Readonly<{ id: string; waived_at: number | null }>;
      assert.ok(edge);
      assert.equal(
        edge.id,
        `edge_${U_EDGE}`,
        "the unchanged pair keeps its id",
      );
      assert.equal(edge.waived_at, 1, "the waiver survives");
    });

    it("absent is reported and nothing is deleted", (t) => {
      const fixture = build([U_REV]);
      t.after(() => fixture.dispose());
      seedPlanFixture(fixture.storage, fixture.plan, fixture.blobs);
      seedTaskTwo(fixture.storage, fixture.plan, fixture.blobs, false);

      const documents = fixtureDocuments(fixture).filter(
        (document) => !document.content.includes("Do the task work."),
      );
      const result = runImport(fixture, {
        projectId: fixtureIds.project,
        fromRevision: fixtureIds.planRevision,
        importId: "imp_absent",
        documents,
        choices: [
          { id: planFixtureIdentities.initiative, take: "database" },
          { id: planFixtureIdentities.objective, take: "database" },
          { id: planFixtureIdentities.task, take: "database" },
          { id: planFixtureIdentities.taskTwo, take: "database" },
        ],
        validatedRevision: fixtureIds.planRevision,
        documentsHash: planHash(fixture, documents, []),
        actor: "human_1",
      });

      assert.deepEqual(result.absent, [planFixtureIdentities.task]);
      const node = fixture.storage.transact((transaction) =>
        fixture.plan.readNode(transaction, planFixtureIdentities.task),
      );
      assert.ok(node, "the omitted node row survives");
      assert.deepEqual(result.documents.length, 4);
    });

    it("a partial re-import resolves a parent that exists only in the database", (t) => {
      const fixture = build([U_REV]);
      t.after(() => fixture.dispose());
      seedPlanFixture(fixture.storage, fixture.plan, fixture.blobs);

      const documents = withTaskTitle(
        fixtureDocuments(fixture),
        "Renamed task",
      ).filter((document) => document.content.includes("Do the task work."));
      assert.equal(documents.length, 1, "only the task document is submitted");

      const result = runImport(fixture, {
        projectId: fixtureIds.project,
        fromRevision: fixtureIds.planRevision,
        importId: "imp_partial",
        documents,
        choices: [
          { id: planFixtureIdentities.initiative, take: "database" },
          { id: planFixtureIdentities.objective, take: "database" },
          { id: planFixtureIdentities.task, take: "submitted" },
        ],
        validatedRevision: fixtureIds.planRevision,
        documentsHash: planHash(fixture, documents, []),
        actor: "human_1",
      });

      assert.equal(result.revision, `revision_${U_REV}`);
      const node = fixture.storage.transact((transaction) =>
        fixture.plan.readNode(transaction, planFixtureIdentities.task),
      );
      assert.ok(node);
      assert.equal(node.title, "Renamed task");
      assert.equal(
        node.parentId,
        planFixtureIdentities.objective,
        "the database objective stays the parent",
      );
      assert.deepEqual(
        result.absent,
        [planFixtureIdentities.initiative, planFixtureIdentities.objective],
        "the unsubmitted ancestors are reported, not deleted",
      );
    });

    it("a document-only node taking database is not inserted", (t) => {
      const fixture = build([U_NEW, U_REV]);
      t.after(() => fixture.dispose());
      seedPlanFixture(fixture.storage, fixture.plan, fixture.blobs);

      const documents = [
        ...fixtureDocuments(fixture).map((document) => {
          if (document.content.includes("Do the initiative work.")) {
            return { ...document, path: "plan/i--01/initiative.md" };
          }
          if (document.content.includes("Do the objective work.")) {
            return { ...document, path: "plan/i--01/o--01/objective.md" };
          }
          return { ...document, path: "plan/i--01/o--01/01-t.md" };
        }),
        {
          path: "plan/i--01/o--01/02-n.md",
          content: `---
kind: task
title: Another task
worker: tdd@1
---
Do the new task work.

## Acceptance criteria

- It works.
`,
        },
      ];
      const result = runImport(fixture, {
        projectId: fixtureIds.project,
        fromRevision: fixtureIds.planRevision,
        importId: "imp_extra_doc",
        documents,
        choices: [
          { id: planFixtureIdentities.initiative, take: "database" },
          { id: planFixtureIdentities.objective, take: "database" },
          { id: planFixtureIdentities.task, take: "database" },
          { id: `task_${U_NEW}`, take: "database" },
        ],
        validatedRevision: fixtureIds.planRevision,
        documentsHash: planHash(fixture, documents, [U_NEW]),
        actor: "human_1",
      });

      assert.equal(result.absent.length, 0);
      assert.equal(
        fixture.storage.transact((transaction) =>
          fixture.plan.readNode(transaction, `task_${U_NEW}`),
        ),
        null,
        "the document-only node taking database is not inserted",
      );
      assert.equal(result.documents.length, 3);
    });

    it("the whole import is deterministic across two fresh databases", (t) => {
      const rowSet = (fixture: ImportFixture): unknown =>
        fixture.storage.transact((transaction) => ({
          plan_revision: transaction.all(
            "SELECT id, project_id, parent_id, import_id, submitted_blob, choices_blob, accepted_blob FROM plan_revision ORDER BY id ASC",
          ),
          node: transaction.all(
            "SELECT id, project_id, kind, parent_id, title, instruction_blob, acceptance_blob, worker, repository_id, state, block_reason, discard_reason, revision, updated_at FROM node ORDER BY id ASC",
          ),
          edge: transaction.all(
            "SELECT id, from_node, to_node, waived_at FROM edge ORDER BY id ASC",
          ),
        }));
      const ulids = [U_I, U_T1, U_O1, U_T2, U_T3, U_O2, U_REV, U_EDGE];
      const first = build(ulids);
      t.after(() => first.dispose());
      const second = build(ulids);
      t.after(() => second.dispose());
      first.storage.transact((transaction) => seedRegistry(transaction));
      second.storage.transact((transaction) => seedRegistry(transaction));

      runImport(first, roundTripInput(first));
      runImport(second, roundTripInput(second));

      assert.deepEqual(rowSet(second), rowSet(first));
    });

    it("the bytewise submitted order puts z before é and the opposite localeCompare sign holds", (t) => {
      const fixture = build([U_IZ, U_TZ, U_OZ, U_IE, U_TE, U_OE, U_REV2]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const zPath = "plan/z--01/initiative.md";
      const ePath = "plan/é--01/initiative.md";
      const submission = [
        {
          path: ePath,
          content: `---
kind: initiative
title: É init
---
Do the é work.
`,
        },
        {
          path: "plan/é--01/o--01/objective.md",
          content: `---
kind: objective
title: É objective
repo: kanthord-verify
---
Make it verifiable.
`,
        },
        {
          path: "plan/é--01/o--01/01-t.md",
          content: `---
kind: task
title: É task
worker: tdd@1
---
Build the renderer.

## Acceptance criteria

- The bytes match.
`,
        },
        {
          path: zPath,
          content: `---
kind: initiative
title: Z init
---
Do the z work.
`,
        },
        {
          path: "plan/z--01/o--01/objective.md",
          content: `---
kind: objective
title: Z objective
repo: kanthord-verify
---
Make it verifiable.
`,
        },
        {
          path: "plan/z--01/o--01/01-t.md",
          content: `---
kind: task
title: Z task
worker: tdd@1
---
Build the renderer.

## Acceptance criteria

- The bytes match.
`,
        },
      ];
      const identities = [
        `initiative_${U_IZ}`,
        `task_${U_TZ}`,
        `objective_${U_OZ}`,
        `initiative_${U_IE}`,
        `task_${U_TE}`,
        `objective_${U_OE}`,
      ];
      const result = runImport(fixture, {
        projectId: fixtureIds.project,
        fromRevision: null,
        importId: "imp_nonascii",
        documents: submission,
        choices: identities.map((id) => ({ id, take: "submitted" })),
        validatedRevision: null,
        documentsHash: planHash(fixture, submission, [
          U_IZ,
          U_TZ,
          U_OZ,
          U_IE,
          U_TE,
          U_OE,
        ]),
        actor: "human_1",
      });

      assert.equal(result.revision, `revision_${U_REV2}`);
      const revisionRow = fixture.storage.transact((transaction) =>
        transaction.get(
          "SELECT submitted_blob FROM plan_revision WHERE id = ?",
          [result.revision],
        ),
      ) as Readonly<{ submitted_blob: string }>;
      const blob = fixture.blobs.get(revisionRow.submitted_blob);
      assert.ok(blob);
      const text = decoder.decode(blob.content);
      assert.ok(
        text.indexOf(zPath) < text.indexOf(ePath),
        "the blob puts z before é bytewise",
      );
      assert.ok(
        zPath.localeCompare(ePath, "en") > 0,
        "the named locale puts é first",
      );
    });

    it("the module contains no UPDATE, INSERT or DELETE", () => {
      const source = readFileSync(
        new URL("./import-plan.ts", import.meta.url),
        "utf8",
      );
      assert.equal(/\b(?:INSERT|UPDATE|DELETE)\b/.test(source), false);
    });

    it("none of the three repository-name translation files falls back with ?? node.repositoryId", () => {
      const paths = [
        new URL("./import-plan.ts", import.meta.url),
        new URL("../../queries/plan/export-plan.ts", import.meta.url),
        new URL("../../queries/plan/validate-plan.ts", import.meta.url),
      ];
      for (const path of paths) {
        const source = readFileSync(path, "utf8");
        assert.equal(
          source.includes("?? node.repositoryId"),
          false,
          path.pathname,
        );
      }
    });

    it("the right containment reader per kind is used", (t) => {
      const fixture = build([U_A, U_O2NEW, U_REV2]);
      t.after(() => fixture.dispose());
      seedPlanFixture(fixture.storage, fixture.plan, fixture.blobs);
      seedRepoB(fixture.storage);
      bindRepoB(fixture.storage);

      const exported = fixtureDocuments(fixture);
      const taskDoc = exported.find((document) =>
        document.content.includes("Do the task work."),
      );
      const objectiveDoc = exported.find((document) =>
        document.content.includes("Do the objective work."),
      );
      const initiativeDoc = exported.find(
        (document) =>
          !document.content.includes("Do the task work.") &&
          !document.content.includes("Do the objective work."),
      );
      assert.ok(taskDoc);
      assert.ok(objectiveDoc);
      assert.ok(initiativeDoc);
      const documents = [
        { ...initiativeDoc, path: "plan/i--01/initiative.md" },
        {
          ...objectiveDoc,
          path: "plan/i--01/o--01/objective.md",
          content: objectiveDoc.content.replace(
            'repo: "kanthord-verify"',
            'repo: "kanthord-verify-b"',
          ),
        },
        {
          ...taskDoc,
          path: "plan/i--01/o--02/01-t.md",
        },
        {
          path: "plan/i--01/o--01/02-a.md",
          content: `---
kind: task
title: Another task
worker: tdd@1
---
Do the other task work.

## Acceptance criteria

- It works.
`,
        },
        {
          path: "plan/i--01/o--02/objective.md",
          content: `---
kind: objective
title: Harden the verify CLI
repo: kanthord-verify
---
Make it verifiable.
`,
        },
      ];

      const calls: string[] = [];
      const recordingPlan: PlanStore = new Proxy(fixture.plan, {
        get(target, property, receiver) {
          if (property === "readContainmentFacts") {
            return (transaction: Transaction, nodeId: string): unknown => {
              calls.push(`facts:${nodeId}`);
              return target.readContainmentFacts(transaction, nodeId);
            };
          }
          if (property === "readSubtreeContainmentFacts") {
            return (transaction: Transaction, nodeId: string): unknown => {
              calls.push(`subtree:${nodeId}`);
              return target.readSubtreeContainmentFacts(transaction, nodeId);
            };
          }
          return Reflect.get(target, property, target);
        },
      });
      const result = importPlan(
        {
          storage: fixture.storage,
          plan: recordingPlan,
          blobs: fixture.blobs,
          reader: fixture.reader,
          graph: fixture.graph,
          ids: fixture.ids,
          clock: fixture.clock,
          events: fixture.events,
        },
        {
          projectId: fixtureIds.project,
          fromRevision: fixtureIds.planRevision,
          importId: "imp_recording",
          documents,
          choices: [
            { id: planFixtureIdentities.initiative, take: "database" },
            { id: planFixtureIdentities.objective, take: "submitted" },
            { id: `objective_${U_O2NEW}`, take: "submitted" },
            { id: planFixtureIdentities.task, take: "submitted" },
            { id: `task_${U_A}`, take: "submitted" },
          ],
          validatedRevision: fixtureIds.planRevision,
          documentsHash: planHash(fixture, documents, [U_A, U_O2NEW]),
          actor: "human_1",
        },
      );

      assert.equal(result.revision, `revision_${U_REV2}`);
      assert.ok(
        calls.includes(`facts:${planFixtureIdentities.task}`),
        "a task is read through readContainmentFacts",
      );
      assert.ok(
        calls.includes(`subtree:${planFixtureIdentities.objective}`),
        "an objective is read through readSubtreeContainmentFacts",
      );
      for (const call of calls) {
        if (call.startsWith("facts:")) {
          assert.ok(
            call.startsWith("facts:task_"),
            `facts reader on a task ${call}`,
          );
        }
        if (call.startsWith("subtree:")) {
          assert.ok(
            !call.startsWith("subtree:task_"),
            `subtree reader never on a task ${call}`,
          );
        }
      }
    });
  });

  describe("completeness findings", () => {
    it("an import of a graph with an empty objective succeeds and reports the finding", (t) => {
      const fixture = build([U_I, U_O1, U_T2, U_T3, U_O2, U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const documents = roundTripSubmission.filter(
        (document) => document.path !== "plan/i--01/o--01/01-t.md",
      );
      const choices = roundTripChoices.filter(
        (entry) => entry.id !== `task_${U_T1}`,
      );
      const result = runImport(
        fixture,
        roundTripInput(fixture, {
          importId: "imp_empty_objective",
          documents,
          choices,
          documentsHash: planHash(fixture, documents, [
            U_I,
            U_O1,
            U_T2,
            U_T3,
            U_O2,
          ]),
        }),
      );

      assert.equal(typeof result.revision, "string");
      assert.equal(result.revision, `revision_${U_REV}`);
      assert.deepEqual(
        result.completeness.map((finding) => finding.code),
        ["objective-without-task"],
      );
    });

    it("an import of a graph with an empty initiative succeeds and reports the finding", (t) => {
      const fixture = build([U_I, U_REV]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const documents = [
        roundTripSubmission.find(
          (document) => document.path === "plan/i--01/initiative.md",
        )!,
      ];
      const result = runImport(
        fixture,
        roundTripInput(fixture, {
          importId: "imp_empty_initiative",
          documents,
          choices: [{ id: `initiative_${U_I}`, take: "submitted" }],
          documentsHash: planHash(fixture, documents, [U_I]),
        }),
      );

      assert.equal(typeof result.revision, "string");
      assert.deepEqual(
        result.completeness.map((finding) => finding.code),
        ["initiative-without-objective"],
      );
    });

    it("an import with a structural finding still refuses", (t) => {
      const fixture = build([U_I, U_O1, U_REV]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const documents: readonly Readonly<{
        path: string;
        content: string;
      }>[] = [
        {
          path: "plan/i--01/initiative.md",
          content: `---
kind: initiative
title: Ship kanthord
---
Bootstrap the daemon.
`,
        },
        {
          path: "plan/i--01/o--01/objective.md",
          content: `---
kind: objective
title: Harden the verify CLI
---
Make it verifiable.
`,
        },
      ];
      const error = importRefusal(
        fixture,
        roundTripInput(fixture, {
          importId: "imp_structural",
          documents,
          choices: [
            { id: `initiative_${U_I}`, take: "submitted" },
            { id: `objective_${U_O1}`, take: "submitted" },
          ],
          documentsHash: planHash(fixture, documents, [U_I, U_O1]),
        }),
      );

      assert.equal(error.refusal, "plan-invalid");
      const findings = (
        error.details as { findings: readonly { code: string }[] }
      ).findings;
      assert.deepEqual(
        findings.map((finding) => finding.code),
        ["repo-missing"],
      );
    });

    it("completeness is sorted and deduplicated", (t) => {
      const fixture = build([U_I, U_IZ, U_O1, U_REV]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const documents: readonly Readonly<{
        path: string;
        content: string;
      }>[] = [
        {
          path: "plan/i--01/initiative.md",
          content: `---
kind: initiative
title: First initiative
---
Bootstrap the daemon.
`,
        },
        {
          path: "plan/i--02/initiative.md",
          content: `---
kind: initiative
title: Second initiative
---
Bootstrap the daemon.
`,
        },
        {
          path: "plan/i--02/o--01/objective.md",
          content: `---
kind: objective
title: Harden the verify CLI
repo: kanthord-verify
---
Make it verifiable.
`,
        },
      ];
      const result = runImport(
        fixture,
        roundTripInput(fixture, {
          importId: "imp_dedup",
          documents,
          choices: [
            { id: `initiative_${U_I}`, take: "submitted" },
            { id: `initiative_${U_IZ}`, take: "submitted" },
            { id: `objective_${U_O1}`, take: "submitted" },
          ],
          documentsHash: planHash(fixture, documents, [U_I, U_IZ, U_O1]),
        }),
      );

      assert.deepEqual(
        result.completeness.map((finding) => finding.code),
        ["initiative-without-objective", "objective-without-task"],
      );
    });

    it("two empty objectives report two findings that share one code", (t) => {
      const fixture = build([U_I, U_O1, U_O2, U_REV]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const documents = roundTripSubmission.filter(
        (document) =>
          document.path !== "plan/i--01/o--01/01-t.md" &&
          document.path !== "plan/i--01/o--02/01-t.md" &&
          document.path !== "plan/i--01/o--02/02-t.md",
      );
      const choices = roundTripChoices.filter(
        (entry) =>
          entry.id !== `task_${U_T1}` &&
          entry.id !== `task_${U_T2}` &&
          entry.id !== `task_${U_T3}`,
      );
      const result = runImport(
        fixture,
        roundTripInput(fixture, {
          importId: "imp_two_empty_objectives",
          documents,
          choices,
          documentsHash: planHash(fixture, documents, [U_I, U_O1, U_O2]),
        }),
      );

      assert.equal(typeof result.revision, "string");
      assert.equal(
        result.completeness.some(
          (finding) => finding.code === "initiative-without-objective",
        ),
        false,
      );
      const objectiveFindings = result.completeness.filter(
        (finding) => finding.code === "objective-without-task",
      );
      assert.equal(objectiveFindings.length, 2);
      assert.equal(
        new Set(
          objectiveFindings.map(
            (finding) => `${finding.path ?? ""}#${finding.id ?? ""}`,
          ),
        ).size,
        2,
        "one finding per empty objective, not one per code",
      );
    });

    it("a retry of a committed incomplete import repeats the completeness report", (t) => {
      const fixture = build([U_I, U_O1, U_T2, U_T3, U_O2, U_REV, U_EDGE]);
      t.after(() => fixture.dispose());
      fixture.storage.transact((transaction) => seedRegistry(transaction));

      const documents = roundTripSubmission.filter(
        (document) => document.path !== "plan/i--01/o--01/01-t.md",
      );
      const choices = roundTripChoices.filter(
        (entry) => entry.id !== `task_${U_T1}`,
      );
      const input = roundTripInput(fixture, {
        importId: "imp_incomplete_retry",
        documents,
        choices,
        documentsHash: planHash(fixture, documents, [
          U_I,
          U_O1,
          U_T2,
          U_T3,
          U_O2,
        ]),
      });

      const first = runImport(fixture, input);
      assert.deepEqual(
        first.completeness.map((finding) => finding.code),
        ["objective-without-task"],
      );
      const retried = runImport(fixture, input);
      assert.equal(retried.retried, true);
      assert.deepEqual(retried.completeness, first.completeness);
    });
  });
});
