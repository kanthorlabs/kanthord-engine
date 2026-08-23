import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createNode } from "./create-node.ts";
import type { CreateNodeInput, CreateNodeResult } from "./create-node.ts";
import { NodeWriteError, nodeWriteRefusalCodes } from "./refusal.ts";
import { canonicalDocumentsJson } from "../../domain/plan-hash.ts";
import type { ActorRow } from "../../domain/actor.ts";
import type {
  AppendEventInput,
  EventLog,
  RecordedEvent,
} from "../../services/event/index.ts";
import type { Transaction } from "../../services/storage/index.ts";
import type { Storage } from "../../services/storage/index.ts";
import type { PlanStore } from "../../services/plan/index.ts";
import type { BlobStore } from "../../services/blob/index.ts";
import type { Graph } from "../../services/graph/index.ts";
import type { IdGenerator } from "../../services/ids/index.ts";
import type { Clock } from "../../services/clock/index.ts";
import type { Revision } from "../../services/revision/index.ts";
import { exportPlan } from "../../queries/plan/export-plan.ts";
import {
  createBlobStore,
  createPlanGraph,
  createPlanStore,
  createReadiness,
  createRecordingPlanStore,
  createRevision,
  nodeBaselineRevision,
  planFixtureBodies,
  planFixtureIdentities,
  reseedBaselineRevision,
  seedPlanFixture,
} from "../../../test/helpers/plan.ts";
import type { RecordedPlanCall } from "../../../test/helpers/plan.ts";
import { createMigratedStorage } from "../../../test/helpers/database.ts";
import { tableCounts } from "../../../test/helpers/database.ts";
import { createMockClock } from "../../../test/helpers/clock.ts";
import { createMockIdGenerator } from "../../../test/helpers/ids.ts";
import { fixtureIds, seedRegistry } from "../../../test/helpers/rows.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CLOCK_START = 1700000000000;

const U_NODE = "01ARZ3NDEKTSV4RRFFQ69G5FC1";
const U_REV = "01BQZ3NDEKTSV4RRFFQ69G5FC2";
const U_NODE_B = "01DRZ3NDEKTSV4RRFFQ69G5FC3";
const U_REV_B = "01ERZ3NDEKTSV4RRFFQ69G5FC4";
const U_NODE_C = "01FQZ3NDEKTSV4RRFFQ69G5FC5";
const U_REV_C = "01GQZ3NDEKTSV4RRFFQ69G5FC6";
const U_EDGE_C1 = "01JQZ3NDEKTSV4RRFFQ69G5FC7";
const U_EDGE_C2 = "01KQZ3NDEKTSV4RRFFQ69G5FC8";
const U_SORT = "01MRZ3NDEKTSV4RRFFQ69G5FC9";
const U_REV_SORT = "01NRZ3NDEKTSV4RRFFQ69G5FCA";
const U_E_SORT1 = "01PRZ3NDEKTSV4RRFFQ69G5FCB";
const U_E_SORT2 = "01QRZ3NDEKTSV4RRFFQ69G5FCC";
const U_E_SORT3 = "01RRZ3NDEKTSV4RRFFQ69G5FCD";
const U_DEDUPE = "01SRZ3NDEKTSV4RRFFQ69G5FCE";
const U_REV_DEDUPE = "01TRZ3NDEKTSV4RRFFQ69G5FCF";
const U_E_DEDUPE = "01VRZ3NDEKTSV4RRFFQ69G5FCG";

const taskTwoId = planFixtureIdentities.taskTwo;
const taskThreeId = "task_01FQZ3NDEKTSV4RRFFQ69G5FAV";

const HARNESS_ACTOR: ActorRow = {
  id: "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQR",
  kind: "harness",
  name: "harness-a",
  tokenSha256: new Uint8Array(32),
  registeredBy: "actor_00000000000000000000000000",
  createdAt: 1720000000000,
  revokedAt: null,
  revokedBy: null,
};

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

type CreateFixture = Readonly<{
  storage: Storage;
  plan: PlanStore;
  blobs: BlobStore;
  revision: Revision;
  graph: Graph;
  ids: IdGenerator;
  clock: Clock;
  events: EventLog;
  recorded: readonly RecordedAppend[];
  calls: readonly RecordedPlanCall[];
  dispose(): void;
}>;

function build(
  seed: (storage: Storage, plan: PlanStore, blobs: BlobStore) => void,
  ulids: readonly string[],
): CreateFixture {
  const temporary = createMigratedStorage();
  const log = createRecordingEventLog();
  const rawPlan = createPlanStore(createReadiness(log.events, "daemon_test"));
  const blobs = createBlobStore(
    temporary.storage,
    createMockClock({ start: CLOCK_START, step: 1000 }),
  );
  seed(temporary.storage, rawPlan, blobs);
  reseedBaselineRevision(temporary.storage);
  const recording = createRecordingPlanStore(rawPlan);
  return {
    storage: temporary.storage,
    plan: recording.plan,
    blobs,
    revision: createRevision(blobs, recording.plan),
    graph: createPlanGraph(),
    ids: createMockIdGenerator({ ulids }),
    clock: createMockClock({ start: CLOCK_START, step: 1000 }),
    events: log.events,
    recorded: log.recorded,
    calls: recording.calls,
    dispose: temporary.dispose,
  };
}

function seedEmptyProject(storage: Storage): void {
  storage.transact((transaction) => {
    seedRegistry(transaction);
  });
}

function seedSiblingTask(
  storage: Storage,
  plan: PlanStore,
  blobs: BlobStore,
  id: string,
): void {
  storage.transact((transaction) => {
    plan.mutateGraph(transaction, {
      projectId: fixtureIds.project,
      nodes: [
        {
          id,
          projectId: fixtureIds.project,
          kind: "task",
          parentId: planFixtureIdentities.objective,
          title: "Sibling task",
          instructionBlob: blobs.put(
            transaction,
            encoder.encode(planFixtureBodies.taskInstruction),
          ),
          acceptanceBlob: blobs.put(
            transaction,
            encoder.encode(planFixtureBodies.taskAcceptance),
          ),
          worker: null,
          repositoryId: null,
          revision: fixtureIds.planRevision,
          updatedAt: 1,
        },
      ],
      insertEdges: [],
      deleteEdgeIds: [],
      nodeDeletes: [],
      at: 1,
      cause: { revision: fixtureIds.planRevision, importId: null },
    });
  });
}

function runCreate(
  fixture: CreateFixture,
  input: CreateNodeInput,
): CreateNodeResult {
  return createNode(
    {
      storage: fixture.storage,
      plan: fixture.plan,
      blobs: fixture.blobs,
      graph: fixture.graph,
      ids: fixture.ids,
      clock: fixture.clock,
      events: fixture.events,
      revision: fixture.revision,
    },
    input,
  );
}

function createInput(
  fromRevision: string | null,
  node: CreateNodeInput["node"],
): CreateNodeInput {
  return {
    projectId: fixtureIds.project,
    fromRevision,
    node,
    actor: HARNESS_ACTOR,
  };
}

function structuralRefusal(
  fixture: CreateFixture,
  input: CreateNodeInput,
  code: string,
): void {
  const before = tableCounts(fixture.storage);
  let caught: unknown;
  try {
    runCreate(fixture, input);
  } catch (error) {
    caught = error;
  }
  assert.ok(
    caught instanceof NodeWriteError,
    `expected a NodeWriteError, got ${String(caught)}`,
  );
  assert.equal(caught.refusal, "plan-invalid");
  const findings = (
    caught.details as Readonly<{
      findings: readonly Readonly<{ code: string }>[];
    }>
  ).findings;
  assert.ok(
    findings.some((finding) => finding.code === code),
    `missing ${code} in ${JSON.stringify(findings)}`,
  );
  const after = tableCounts(fixture.storage);
  assert.equal(after.node, before.node);
  assert.equal(after.edge, before.edge);
  assert.equal(after.plan_revision, before.plan_revision);
}

describe("src/commands/node/create-node.test", () => {
  it("nodeWriteRefusalCodes deep-equals the seven shared codes in order", () => {
    assert.deepEqual(nodeWriteRefusalCodes, [
      "project-not-found",
      "node-not-found",
      "kind-mismatch",
      "stale-revision",
      "plan-invalid",
      "illegal-transition",
      "binding-in-use",
    ]);
  });

  it("NodeWriteError carries its name, refusal and details", () => {
    const error = new NodeWriteError(
      "stale-revision",
      "the revision is stale",
      { guard: "project", expected: "revision_1", actual: "revision_0" },
    );
    assert.equal(error.name, "NodeWriteError");
    assert.equal(error.refusal, "stale-revision");
    assert.deepEqual(error.details, {
      guard: "project",
      expected: "revision_1",
      actual: "revision_0",
    });
    assert.ok(error instanceof Error);
  });

  it("NodeWriteError leaves details undefined when omitted", () => {
    const error = new NodeWriteError("node-not-found", "the node is missing");
    assert.equal(error.name, "NodeWriteError");
    assert.equal(error.refusal, "node-not-found");
    assert.equal(error.details, undefined);
  });

  it("creates an initiative in an empty project", (t) => {
    const fixture = build(seedEmptyProject, [U_NODE, U_REV]);
    t.after(() => fixture.dispose());

    const result = runCreate(
      fixture,
      createInput(null, {
        kind: "initiative",
        title: "Ship kanthord",
        instruction: "Bootstrap the daemon.\n",
        worker: null,
        dependsOn: [],
      }),
    );

    assert.equal(result.id, `initiative_${U_NODE}`);
    assert.match(result.revision, /^revision_/);
    assert.deepEqual(
      result.completeness.map((finding) => finding.code),
      ["initiative-without-objective"],
    );
    const revisions = fixture.storage.transact((transaction) =>
      fixture.plan.listRevisions(transaction, fixtureIds.project),
    );
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0]!.origin, "node-write");
    assert.equal(revisions[0]!.importId, null);
    assert.equal(revisions[0]!.submittedBlob, null);
    assert.equal(revisions[0]!.choicesBlob, null);
  });

  it("mints the revision before the node row", (t) => {
    const fixture = build(seedEmptyProject, [U_NODE, U_REV]);
    t.after(() => fixture.dispose());

    const result = runCreate(
      fixture,
      createInput(null, {
        kind: "initiative",
        title: "Ship kanthord",
        instruction: "Bootstrap the daemon.\n",
        worker: null,
        dependsOn: [],
      }),
    );

    const nodeRow = fixture.storage.transact((transaction) =>
      transaction.get("SELECT revision FROM node WHERE id = ?", [result.id]),
    ) as Readonly<{ revision: string }>;
    assert.equal(nodeRow.revision, result.revision);
    const revisionRow = fixture.storage.transact((transaction) =>
      transaction.get("SELECT id FROM plan_revision WHERE id = ?", [
        result.revision,
      ]),
    ) as Readonly<{ id: string }> | undefined;
    assert.equal(revisionRow?.id, result.revision);
  });

  it("takes the project revision as the new parent", (t) => {
    const fixture = build(seedPlanFixture, [U_NODE, U_REV]);
    t.after(() => fixture.dispose());

    const result = runCreate(
      fixture,
      createInput(nodeBaselineRevision, {
        kind: "initiative",
        title: "Ship kanthord",
        instruction: "Bootstrap the daemon.\n",
        worker: null,
        dependsOn: [],
      }),
    );

    const row = fixture.storage.transact((transaction) =>
      transaction.get("SELECT parent_id FROM plan_revision WHERE id = ?", [
        result.revision,
      ]),
    ) as Readonly<{ parent_id: string | null }>;
    assert.equal(row.parent_id, nodeBaselineRevision);
  });

  it("refuses a task whose parent objective is terminal", (t) => {
    const fixture = build(seedPlanFixture, [U_NODE, U_REV]);
    t.after(() => fixture.dispose());

    fixture.storage.transact((transaction) => {
      const steps = [
        { to: "running", trigger: "worker-objective-started" },
        { to: "awaiting_approval", trigger: "object-reported" },
        { to: "done", trigger: "human-close" },
      ] as const;
      for (const step of steps) {
        const state = fixture.plan.readNode(
          transaction,
          planFixtureIdentities.objective,
        )!.state;
        fixture.plan.setNodeState(transaction, {
          id: planFixtureIdentities.objective,
          from: state,
          to: step.to,
          trigger: step.trigger,
          blockReason: null,
          at: 1,
          cause: { revision: nodeBaselineRevision, importId: null },
        });
      }
    });

    let caught: unknown;
    try {
      runCreate(
        fixture,
        createInput(nodeBaselineRevision, {
          kind: "task",
          title: "Zombie task",
          parentId: planFixtureIdentities.objective,
          instruction: "Do it.\n",
          acceptance: "Done.\n",
          worker: null,
          dependsOn: [],
        }),
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof NodeWriteError);
    assert.equal(caught.refusal, "illegal-transition");
    assert.equal(
      caught.message,
      `the ancestor ${planFixtureIdentities.objective} is done, not startable`,
    );
  });

  it("refuses a stale project revision", (t) => {
    const fixture = build(seedPlanFixture, [U_NODE, U_REV]);
    t.after(() => fixture.dispose());
    const before = tableCounts(fixture.storage);

    let caught: unknown;
    try {
      runCreate(
        fixture,
        createInput("revision_stale", {
          kind: "initiative",
          title: "Ship kanthord",
          instruction: "Bootstrap the daemon.\n",
          worker: null,
          dependsOn: [],
        }),
      );
    } catch (error) {
      caught = error;
    }
    assert.ok(caught instanceof NodeWriteError);
    assert.equal(caught.refusal, "stale-revision");
    assert.deepEqual(caught.details, {
      guard: "project",
      expected: nodeBaselineRevision,
      actual: "revision_stale",
    });
    const after = tableCounts(fixture.storage);
    assert.equal(after.node, before.node);
    assert.equal(after.edge, before.edge);
    assert.equal(after.plan_revision, before.plan_revision);
  });

  it("refuses a task under an initiative as parent-missing", (t) => {
    const fixture = build(seedPlanFixture, [U_NODE, U_REV]);
    t.after(() => fixture.dispose());

    structuralRefusal(
      fixture,
      createInput(nodeBaselineRevision, {
        kind: "task",
        title: "Render the manifest",
        parentId: planFixtureIdentities.initiative,
        instruction: "Build the renderer.\n",
        acceptance: "## Acceptance criteria\n- The bytes match.\n",
        worker: null,
        dependsOn: [],
      }),
      "parent-missing",
    );
  });

  it("refuses an unknown worker as worker-unknown", (t) => {
    const fixture = build(seedPlanFixture, [U_NODE, U_REV]);
    t.after(() => fixture.dispose());

    structuralRefusal(
      fixture,
      createInput(nodeBaselineRevision, {
        kind: "task",
        title: "Render the manifest",
        parentId: planFixtureIdentities.objective,
        instruction: "Build the renderer.\n",
        acceptance: "## Acceptance criteria\n- The bytes match.\n",
        worker: "ghost@9",
        dependsOn: [],
      }),
      "worker-unknown",
    );
  });

  it("refuses an unknown repository as repository-unknown", (t) => {
    const fixture = build(seedPlanFixture, [U_NODE, U_REV]);
    t.after(() => fixture.dispose());

    structuralRefusal(
      fixture,
      createInput(nodeBaselineRevision, {
        kind: "objective",
        title: "Harden the verify CLI",
        parentId: planFixtureIdentities.initiative,
        repo: "ghost-repo",
        instruction: "Make it verifiable.\n",
        worker: null,
        dependsOn: [],
      }),
      "repository-unknown",
    );
  });

  it("refuses an unbound repository as repository-unbound", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        storage.transact((transaction) => {
          transaction.run(
            "INSERT INTO repository (id, name, remote_url, credential_id, home_path, branch, publish_on_approval, state, diverged_landing_oid, diverged_upstream_oid, fetched_upstream_oid, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [
              "repo_b",
              "other-repo",
              "https://example.invalid/r2.git",
              fixtureIds.provider,
              "repos/r2.git",
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
      },
      [U_NODE, U_REV],
    );
    t.after(() => fixture.dispose());

    structuralRefusal(
      fixture,
      createInput(nodeBaselineRevision, {
        kind: "objective",
        title: "Harden the verify CLI",
        parentId: planFixtureIdentities.initiative,
        repo: "other-repo",
        instruction: "Make it verifiable.\n",
        worker: null,
        dependsOn: [],
      }),
      "repository-unbound",
    );
  });

  it("refuses an absent dependency target as reference-unresolved", (t) => {
    const fixture = build(seedPlanFixture, [U_NODE, U_REV]);
    t.after(() => fixture.dispose());

    structuralRefusal(
      fixture,
      createInput(nodeBaselineRevision, {
        kind: "task",
        title: "Render the manifest",
        parentId: planFixtureIdentities.objective,
        instruction: "Build the renderer.\n",
        acceptance: "## Acceptance criteria\n- The bytes match.\n",
        worker: null,
        dependsOn: ["task_01ZZZ3NDEKTSV4RRFFQ69G5FAV"],
      }),
      "reference-unresolved",
    );
  });

  it("refuses a dependency across parents as dependency-cross-parent", (t) => {
    const fixture = build(seedPlanFixture, [U_NODE, U_REV]);
    t.after(() => fixture.dispose());

    structuralRefusal(
      fixture,
      createInput(nodeBaselineRevision, {
        kind: "task",
        title: "Render the manifest",
        parentId: planFixtureIdentities.objective,
        instruction: "Build the renderer.\n",
        acceptance: "## Acceptance criteria\n- The bytes match.\n",
        worker: null,
        dependsOn: [planFixtureIdentities.initiative],
      }),
      "dependency-cross-parent",
    );
  });

  it("dependency-self and dependency-cycle are unreachable on a create", (t) => {
    const fixture = build(seedEmptyProject, [
      U_NODE,
      U_REV,
      U_NODE_B,
      U_REV_B,
      U_NODE_C,
      U_REV_C,
      U_EDGE_C1,
      U_EDGE_C2,
    ]);
    t.after(() => fixture.dispose());

    const first = runCreate(
      fixture,
      createInput(null, {
        kind: "initiative",
        title: "First initiative",
        instruction: "One.\n",
        worker: null,
        dependsOn: [],
      }),
    );
    const second = runCreate(
      fixture,
      createInput(first.revision, {
        kind: "initiative",
        title: "Second initiative",
        instruction: "Two.\n",
        worker: null,
        dependsOn: [],
      }),
    );
    const third = runCreate(
      fixture,
      createInput(second.revision, {
        kind: "initiative",
        title: "Third initiative",
        instruction: "Three.\n",
        worker: null,
        dependsOn: [first.id, second.id],
      }),
    );

    assert.equal(third.id, `initiative_${U_NODE_C}`);
    const edges = fixture.storage.transact((transaction) =>
      transaction.all(
        "SELECT from_node, to_node FROM edge ORDER BY to_node ASC",
      ),
    ) as readonly Readonly<{ from_node: string; to_node: string }>[];
    assert.deepEqual(
      edges.map((edge) => edge.to_node),
      [first.id, second.id],
    );
  });

  it("sorts dependsOn bytewise", (t) => {
    const fixture = build(
      (storage, plan, blobs) => {
        seedPlanFixture(storage, plan, blobs);
        seedSiblingTask(storage, plan, blobs, taskTwoId);
        seedSiblingTask(storage, plan, blobs, taskThreeId);
      },
      [U_SORT, U_REV_SORT, U_E_SORT1, U_E_SORT2, U_E_SORT3],
    );
    t.after(() => fixture.dispose());

    const taskOneId = planFixtureIdentities.task;
    const result = runCreate(
      fixture,
      createInput(nodeBaselineRevision, {
        kind: "task",
        title: "Render the manifest",
        parentId: planFixtureIdentities.objective,
        instruction: "Build the renderer.\n",
        acceptance: "## Acceptance criteria\n- The bytes match.\n",
        worker: null,
        dependsOn: [taskThreeId, taskTwoId, taskOneId],
      }),
    );

    const edges = fixture.storage.transact((transaction) =>
      transaction.all(
        "SELECT id, to_node FROM edge WHERE from_node = ? ORDER BY rowid ASC",
        [result.id],
      ),
    ) as readonly Readonly<{ id: string; to_node: string }>[];
    assert.deepEqual(
      edges.map((edge) => edge.to_node),
      [taskOneId, taskTwoId, taskThreeId],
    );
    assert.deepEqual(
      edges.map((edge) => edge.id),
      [`edge_${U_E_SORT1}`, `edge_${U_E_SORT2}`, `edge_${U_E_SORT3}`],
    );
    const stored = fixture.storage.transact((transaction) =>
      fixture.plan.readGraph(transaction, fixtureIds.project),
    );
    const created = stored.nodes.find((node) => node.id === result.id);
    assert.deepEqual(created?.dependencies, [
      taskOneId,
      taskTwoId,
      taskThreeId,
    ]);
  });

  it("deduplicates dependsOn", (t) => {
    const fixture = build(seedPlanFixture, [
      U_DEDUPE,
      U_REV_DEDUPE,
      U_E_DEDUPE,
    ]);
    t.after(() => fixture.dispose());

    const taskOneId = planFixtureIdentities.task;
    const result = runCreate(
      fixture,
      createInput(nodeBaselineRevision, {
        kind: "task",
        title: "Render the manifest",
        parentId: planFixtureIdentities.objective,
        instruction: "Build the renderer.\n",
        acceptance: "## Acceptance criteria\n- The bytes match.\n",
        worker: null,
        dependsOn: [taskOneId, taskOneId],
      }),
    );

    const count = fixture.storage.transact((transaction) =>
      transaction.get("SELECT COUNT(*) AS n FROM edge", []),
    ) as Readonly<{ n: number }>;
    assert.equal(count.n, 1);
    const stored = fixture.storage.transact((transaction) =>
      fixture.plan.readGraph(transaction, fixtureIds.project),
    );
    const created = stored.nodes.find((node) => node.id === result.id);
    assert.deepEqual(created?.dependencies, [taskOneId]);
  });

  it("export bytes equal the accepted blob", (t) => {
    const fixture = build(seedPlanFixture, [U_NODE, U_REV]);
    t.after(() => fixture.dispose());

    const created = runCreate(
      fixture,
      createInput(nodeBaselineRevision, {
        kind: "task",
        title: "Render the manifest",
        parentId: planFixtureIdentities.objective,
        instruction: "Build the renderer.\n",
        acceptance: "## Acceptance criteria\n- The bytes match.\n",
        worker: null,
        dependsOn: [],
      }),
    );

    const exported = exportPlan(
      {
        storage: fixture.storage,
        plan: fixture.plan,
        revision: fixture.revision,
      },
      { projectId: fixtureIds.project },
    );
    assert.equal(exported.revision, created.revision);
    const record = fixture.storage.transact((transaction) =>
      fixture.plan
        .listRevisions(transaction, fixtureIds.project)
        .find((entry) => entry.id === created.revision),
    );
    assert.ok(record !== undefined);
    const blob = fixture.blobs.get(record.acceptedBlob);
    assert.ok(blob !== null);
    const expected = encoder.encode(canonicalDocumentsJson(exported.documents));
    assert.equal(
      Buffer.compare(Buffer.from(expected), Buffer.from(blob.content)),
      0,
    );
  });

  it("a stored objective renders its repository name in the accepted blob", (t) => {
    const fixture = build(seedPlanFixture, [U_NODE, U_REV]);
    t.after(() => fixture.dispose());

    const created = runCreate(
      fixture,
      createInput(nodeBaselineRevision, {
        kind: "task",
        title: "Render the manifest",
        parentId: planFixtureIdentities.objective,
        instruction: "Build the renderer.\n",
        acceptance: "## Acceptance criteria\n- The bytes match.\n",
        worker: null,
        dependsOn: [],
      }),
    );

    const record = fixture.storage.transact((transaction) =>
      fixture.plan
        .listRevisions(transaction, fixtureIds.project)
        .find((entry) => entry.id === created.revision),
    );
    assert.ok(record !== undefined);
    const blob = fixture.blobs.get(record.acceptedBlob);
    assert.ok(blob !== null);
    const text = decoder.decode(blob.content);
    assert.ok(text.includes("kanthord-verify"));
    assert.equal(text.includes("repo_a"), false);
  });

  it("appends one node.created event carrying the resolved actor", (t) => {
    const fixture = build(seedPlanFixture, [U_NODE, U_REV]);
    t.after(() => fixture.dispose());

    const result = runCreate(
      fixture,
      createInput(nodeBaselineRevision, {
        kind: "task",
        title: "Render the manifest",
        parentId: planFixtureIdentities.objective,
        instruction: "Build the renderer.\n",
        acceptance: "## Acceptance criteria\n- The bytes match.\n",
        worker: null,
        dependsOn: [],
      }),
    );

    const created = fixture.recorded.find(
      (append) => append.input.type === "node.created",
    );
    assert.ok(created !== undefined, "no node.created event was appended");
    assert.equal(created.input.subjectKind, "node");
    assert.equal(created.input.subjectId, result.id);
    assert.equal(created.input.actorKind, "harness");
    assert.equal(created.input.actorId, HARNESS_ACTOR.id);
    assert.deepEqual(created.input.payload, {
      kind: "task",
      parentId: planFixtureIdentities.objective,
      revision: result.revision,
    });
  });

  it("calls mutateGraph exactly once and setNodeState never", (t) => {
    const fixture = build(seedPlanFixture, [U_NODE, U_REV]);
    t.after(() => fixture.dispose());

    runCreate(
      fixture,
      createInput(nodeBaselineRevision, {
        kind: "task",
        title: "Render the manifest",
        parentId: planFixtureIdentities.objective,
        instruction: "Build the renderer.\n",
        acceptance: "## Acceptance criteria\n- The bytes match.\n",
        worker: null,
        dependsOn: [],
      }),
    );

    assert.deepEqual(
      fixture.calls.map((call) => call.method),
      ["mutateGraph"],
    );
    assert.equal(
      Object.hasOwn(fixture.calls[0]!.input as object, "trigger"),
      false,
    );
  });

  it("a create with no dependency promotes the node to ready in the same mutation", (t) => {
    const fixture = build(seedPlanFixture, [U_NODE, U_REV]);
    t.after(() => fixture.dispose());

    const result = runCreate(
      fixture,
      createInput(nodeBaselineRevision, {
        kind: "task",
        title: "Render the manifest",
        parentId: planFixtureIdentities.objective,
        instruction: "Build the renderer.\n",
        acceptance: "## Acceptance criteria\n- The bytes match.\n",
        worker: null,
        dependsOn: [],
      }),
    );

    assert.deepEqual(fixture.calls[0]!.transitions, [
      {
        nodeId: result.id,
        from: "pending",
        to: "ready",
        trigger: "readiness-promoted",
      },
    ]);
    const stored = fixture.storage.transact((transaction) =>
      fixture.plan.readNode(transaction, result.id),
    );
    assert.equal(stored?.state, "ready");
  });

  it("one clock read per command", (t) => {
    const fixture = build(seedPlanFixture, [U_NODE, U_REV]);
    t.after(() => fixture.dispose());

    const result = runCreate(
      fixture,
      createInput(nodeBaselineRevision, {
        kind: "task",
        title: "Render the manifest",
        parentId: planFixtureIdentities.objective,
        instruction: "Build the renderer.\n",
        acceptance: "## Acceptance criteria\n- The bytes match.\n",
        worker: null,
        dependsOn: [],
      }),
    );

    const rows = fixture.storage.transact((transaction) =>
      transaction.all("SELECT id, updated_at FROM node ORDER BY id ASC"),
    ) as readonly Readonly<{ id: string; updated_at: number }>[];
    const byId = new Map(rows.map((row) => [row.id, row.updated_at]));
    assert.equal(byId.get(result.id), CLOCK_START);
    assert.deepEqual(
      [...new Set(rows.map((row) => row.updated_at))].sort((a, b) => a - b),
      [1, CLOCK_START],
    );
  });

  it("a create with an unsatisfied dependency leaves the node pending", (t) => {
    const fixture = build(seedPlanFixture, [U_NODE, U_REV, U_E_SORT1]);
    t.after(() => fixture.dispose());

    const result = runCreate(
      fixture,
      createInput(nodeBaselineRevision, {
        kind: "task",
        title: "Render the manifest",
        parentId: planFixtureIdentities.objective,
        instruction: "Build the renderer.\n",
        acceptance: "## Acceptance criteria\n- The bytes match.\n",
        worker: null,
        dependsOn: [planFixtureIdentities.task],
      }),
    );

    assert.deepEqual(fixture.calls[0]!.transitions, []);
    const stored = fixture.storage.transact((transaction) =>
      fixture.plan.readNode(transaction, result.id),
    );
    assert.equal(stored?.state, "pending");
  });

  it("a create changes no other node", (t) => {
    const fixture = build(seedPlanFixture, [U_NODE, U_REV]);
    t.after(() => fixture.dispose());

    const before = fixture.storage.transact((transaction) =>
      fixture.plan.readGraph(transaction, fixtureIds.project),
    );
    const result = runCreate(
      fixture,
      createInput(nodeBaselineRevision, {
        kind: "task",
        title: "Render the manifest",
        parentId: planFixtureIdentities.objective,
        instruction: "Build the renderer.\n",
        acceptance: "## Acceptance criteria\n- The bytes match.\n",
        worker: null,
        dependsOn: [],
      }),
    );

    const after = fixture.storage.transact((transaction) =>
      fixture.plan.readGraph(transaction, fixtureIds.project),
    );
    const beforeById = new Map(before.nodes.map((node) => [node.id, node]));
    const afterById = new Map(after.nodes.map((node) => [node.id, node]));
    assert.deepEqual(
      [...afterById.keys()].filter((id) => id !== result.id).sort(),
      [...beforeById.keys()].sort(),
    );
    for (const [id, node] of beforeById) {
      const changed = afterById.get(id);
      assert.ok(changed !== undefined);
      assert.equal(changed.state, node.state);
      assert.equal(changed.revision, node.revision);
      assert.equal(changed.updatedAt, node.updatedAt);
    }
  });

  it("every readiness transition on node.create carries its matching trigger", (t) => {
    const fixture = build(seedPlanFixture, [U_NODE, U_REV]);
    t.after(() => fixture.dispose());

    runCreate(
      fixture,
      createInput(nodeBaselineRevision, {
        kind: "task",
        title: "Render the manifest",
        parentId: planFixtureIdentities.objective,
        instruction: "Build the renderer.\n",
        acceptance: "## Acceptance criteria\n- The bytes match.\n",
        worker: null,
        dependsOn: [],
      }),
    );

    assertTriggersMatchTransitions(fixture.calls);
  });

  it("a mismatched trigger pair is refused by the store and writes nothing", (t) => {
    const fixture = build(seedPlanFixture, []);
    t.after(() => fixture.dispose());

    assertMismatchedTriggerRefused(fixture, planFixtureIdentities.task);
  });
});

function assertTriggersMatchTransitions(
  calls: readonly RecordedPlanCall[],
): void {
  assert.ok(calls.length > 0, "no mutation call was recorded");
  for (const call of calls) {
    for (const transition of call.transitions) {
      if (transition.from === "pending" && transition.to === "ready") {
        assert.equal(transition.trigger, "readiness-promoted");
      } else if (transition.from === "ready" && transition.to === "pending") {
        assert.equal(transition.trigger, "readiness-demoted");
      } else {
        assert.fail(
          `unexpected transition ${transition.from} -> ${transition.to}`,
        );
      }
    }
  }
}

function assertMismatchedTriggerRefused(
  fixture: CreateFixture,
  nodeId: string,
): void {
  const before = fixture.storage.transact((transaction) =>
    fixture.plan.readNode(transaction, nodeId),
  );
  assert.ok(before !== null);
  assert.throws(
    () =>
      fixture.storage.transact((transaction) =>
        fixture.plan.setNodeState(transaction, {
          id: nodeId,
          from: "ready",
          to: "pending",
          trigger: "readiness-promoted",
          blockReason: null,
          at: 1,
          cause: { revision: nodeBaselineRevision, importId: null },
        }),
      ),
    (error: unknown) =>
      error instanceof Error &&
      error.message ===
        "trigger readiness-promoted declares pending -> ready, the write names ready -> pending",
  );
  const after = fixture.storage.transact((transaction) =>
    fixture.plan.readNode(transaction, nodeId),
  );
  assert.deepEqual(after, before);
}
