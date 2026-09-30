import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { background } from "../kernel/context.ts";
import { testHumanIdentity } from "../kernel/test-identity.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import { digest } from "../kernel/json.ts";
import {
  AccessPolicy,
  OperationRegistry,
  type CallerContext,
} from "../kernel/operation.ts";
import { createIdentity, identitySchema } from "../kernel/identity.ts";
import { Diagnostic } from "../kernel/errors.ts";
import { HealthRegistry } from "../kernel/health.ts";
import { HealthStatus } from "../kernel/service.ts";
import {
  IN_MEMORY_DATABASE,
  Store,
  type Transaction,
} from "../kernel/store.ts";
import {
  ActorKind,
  ImportFormat,
  importPreviewSchema,
  exportAnswerSchema,
  type ExportAnswer,
  importResultSchema,
  type ImportApply,
  type ImportResult,
  type ImportEntry,
  type ImportSnapshot,
  MISSION_IDENTITY_PREFIX,
  MISSION_INITIAL_VERSION,
  MISSION_SERVICE_NAME,
  MissionErrorCode,
  missionOperations,
  NODE_IDENTITY_PREFIX,
  NodeKind,
  NodeState,
  EdgeKind,
  RevisionWrite,
  RebindSkipCondition,
  type Rebind,
  TaskChange,
  nodeChangeSchema,
  edgeSchema,
  nodeSchema,
  revisionSchema,
  pageOf,
  type NodeCreate,
  type NodeUpdate,
  type CriterionSet,
  type Move,
  type NodeChange,
  type Retire,
  type RetirePreview,
  type MissionBindings,
  type WorkQueue,
} from "./contract.ts";
import { missionMigrations } from "./migrations.ts";
import { nodeRecord } from "./node-read.ts";
import { importDigest, normalizeImportSnapshot } from "./import.ts";
import { serializePlanFile } from "./export.ts";
import { parsePlanFile } from "./parser.ts";
import { MissionService, humanActor, type Dependencies } from "./service.ts";
import { CONTENT_FIELDS, TASKS_FIELD, ContentField } from "./content.ts";
import { claimableMap, reconcileMission, routeMission } from "./routing.ts";
import {
  insertNode as insertNodeRow,
  readNode,
  readMissionNodes,
  readCurrentRevision,
  updateNodeFilename,
} from "./store.ts";

const UNEXPECTED_COLLABORATION = "unexpected collaboration call";
const MISSION_STOPPED_CODE = "mission.lifecycle.stopped";
const CONSECUTIVE_LOSS_LIMIT = 3;
const TEXT_MAX_BYTES = 32768;
const PROJECT_ID = "project_00000000000000000000000000";
const UNKNOWN_PROJECT_ID = "project_00000000000000000000000001";
const ACCOUNT_ID = "mission-account";
const DISPLAY_NAME = "Mission Operator";
const TOKEN_ID = "mission-token";
const ONE_COMMIT = 1;
const BINDING_ID = "binding_00000000000000000000000000";
const OTHER_BINDING_ID = "binding_00000000000000000000000001";
const UNKNOWN_BINDING_ID = "binding_00000000000000000000000002";
const FIRST_REVISION = 1;
const NEXT_REVISION = 2;
const CREATED_AT = 1000;
const RETIRED_AT = 2000;
const NODE_FILENAME = "node.md";
const NODE_TEXT = "text";
const NO_VERIFICATIONS = "[]";
const REVISION_CHANGE = "{}";
const REVISION_ACTOR = JSON.stringify({
  kind: ActorKind.Human,
  account: "account",
  name: "name",
});
const SQLITE_UNIQUE_CONSTRAINT =
  /UNIQUE constraint failed: mission_mission\.project_id/;
const HUMAN_ACTOR = {
  kind: ActorKind.Human,
  account: "account",
  name: "name",
} as const;

const bindings: MissionBindings = {
  repositoryPolicyOf() {
    throw new Error(UNEXPECTED_COLLABORATION);
  },
  resolveBinding() {
    throw new Error(UNEXPECTED_COLLABORATION);
  },
  getBindingRevision() {
    throw new Error(UNEXPECTED_COLLABORATION);
  },
};
const workQueue: WorkQueue = {
  insert() {
    throw new Error(UNEXPECTED_COLLABORATION);
  },
  delete() {
    throw new Error(UNEXPECTED_COLLABORATION);
  },
  priorityUpdate() {
    throw new Error(UNEXPECTED_COLLABORATION);
  },
};

type Collaborators = Pick<Dependencies, "bindings" | "workQueue"> &
  Partial<
    Pick<Dependencies, "schedulerClaims" | "wakeup" | "executionAttribution">
  >;

function makeService(
  health: HealthRegistry,
  collaborators: Collaborators = { bindings, workQueue },
  textMaxBytes = TEXT_MAX_BYTES,
): MissionService {
  return new MissionService({
    config: {
      consecutiveLossLimit: CONSECUTIVE_LOSS_LIMIT,
      textMaxBytes,
    },
    health,
    schedulerClaims: {
      revoke: () => null,
      settle: () => {},
      liveExecutionOf: () => null,
    },
    wakeup: { wake: () => {} },
    executionAttribution: {
      of: () => {
        throw new Error(UNEXPECTED_COLLABORATION);
      },
    },
    ...collaborators,
  });
}

function fixture(
  t: TestContext,
  collaborators?: Collaborators,
  textMaxBytes?: number,
) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: MISSION_SERVICE_NAME, migrations: missionMigrations },
  ]);
  return {
    store,
    mission: makeService(new HealthRegistry(), collaborators, textMaxBytes),
  };
}

function handlerFixture(
  t: TestContext,
  collaborators?: Collaborators,
  textMaxBytes?: number,
) {
  const { store, mission } = fixture(t, collaborators, textMaxBytes);
  const registry = new OperationRegistry();
  mission.declare(registry);
  let commits = 0;
  const caller: CallerContext = {
    identity: testHumanIdentity(ACCOUNT_ID, DISPLAY_NAME, TOKEN_ID),
    context: background,
    requestId: "request",
    commit: (fn) => {
      commits++;
      return store.transaction(fn);
    },
  };
  function invoke(projectId: string) {
    const operation = missionOperations.get;
    const input = operation.input.parse({
      params: { projectId },
      query: {},
      body: null,
    });
    return operation.output.parse(
      registry.get(operation.id).handler(input, caller),
    );
  }
  return { store, mission, caller, registry, invoke, commits: () => commits };
}

function insertNode(
  tx: Transaction,
  missionId: string,
  state: string | null,
  retiredAt: number | null = null,
): string {
  const nodeId = createIdentity(NODE_IDENTITY_PREFIX);
  tx.database
    .prepare(
      `INSERT INTO mission_node
       (id, mission_id, kind, filename, state, retired_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      nodeId,
      missionId,
      state === null ? NodeKind.Task : NodeKind.Objective,
      `${nodeId}.md`,
      state,
      retiredAt,
      CREATED_AT,
    );
  return nodeId;
}

function insertRevision(
  tx: Transaction,
  nodeId: string,
  revision: number,
  bindings: string[],
): void {
  tx.database
    .prepare(
      `INSERT INTO mission_node_revision
       (node_id, revision, filename, name, requirement, criterion,
        verifications, bindings, change, reason, actor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      nodeId,
      revision,
      NODE_FILENAME,
      NODE_TEXT,
      NODE_TEXT,
      NODE_TEXT,
      NO_VERIFICATIONS,
      JSON.stringify(bindings),
      REVISION_CHANGE,
      NODE_TEXT,
      REVISION_ACTOR,
      CREATED_AT,
    );
}

test("mission.get returns a project's mission through one commit", (t) => {
  const { store, mission, invoke, commits, registry } = handlerFixture(t);
  store.transaction((tx) => mission.createMission(tx, PROJECT_ID, HUMAN_ACTOR));
  const result = invoke(PROJECT_ID);
  assert.ok(
    identitySchema(MISSION_IDENTITY_PREFIX).safeParse(result.id).success,
  );
  assert.deepEqual(result, {
    id: result.id,
    projectId: PROJECT_ID,
    version: MISSION_INITIAL_VERSION,
  });
  assert.equal(
    registry.get(missionOperations.get.id).operation.access,
    AccessPolicy.Human,
  );
  assert.equal(commits(), ONE_COMMIT);
});

test("mission.get maps an unknown project to not found", (t) => {
  const { invoke, commits } = handlerFixture(t);
  assert.throws(
    () => invoke(UNKNOWN_PROJECT_ID),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.NotFound);
      assert.equal(error.code, MissionErrorCode.MissionNotFound);
      return true;
    },
  );
  assert.equal(commits(), ONE_COMMIT);
});

test("humanActor requires minted human provenance and maps account and name", (t) => {
  const { caller } = handlerFixture(t);
  assert.deepEqual(humanActor(caller), {
    kind: ActorKind.Human,
    account: ACCOUNT_ID,
    name: DISPLAY_NAME,
  });
  assert.throws(() => humanActor({ ...caller, identity: undefined }));
  assert.throws(() =>
    humanActor({
      ...caller,
      identity: {
        kind: ActorKind.Human,
        accountId: ACCOUNT_ID,
        name: DISPLAY_NAME,
        jti: TOKEN_ID,
      },
    }),
  );
});

test("MissionService healthcheck follows lifecycle", async () => {
  const health = new HealthRegistry();
  const mission = makeService(health);
  assert.deepEqual(await mission.healthcheck(), {
    operations: HealthStatus.Unavailable,
  });
  assert.equal(await mission.start(), null);
  assert.deepEqual(await mission.healthcheck(), {
    operations: HealthStatus.Healthy,
  });
  assert.equal(await mission.stop(), null);
  assert.deepEqual(await mission.healthcheck(), {
    operations: HealthStatus.Unavailable,
  });
});

test("MissionService registers its operations health probe", async () => {
  const registry = new HealthRegistry();
  const mission = makeService(registry);
  assert.equal(await mission.start(), null);
  const results = await registry.check(background);
  assert.ok(Object.hasOwn(results, MISSION_SERVICE_NAME));
  assert.equal(results[MISSION_SERVICE_NAME]?.operations, HealthStatus.Healthy);
  assert.equal(await mission.stop(), null);
});

test("createMission inserts a version-one mission and preserves duplicate project errors", (t) => {
  const { store, mission } = fixture(t);
  store.transaction((tx) => mission.createMission(tx, PROJECT_ID, HUMAN_ACTOR));
  const rows = store.database
    .prepare("SELECT * FROM mission_mission WHERE project_id = ?")
    .all(PROJECT_ID) as Array<{
    id: string;
    project_id: string;
    version: number;
    created_at: number;
  }>;
  assert.equal(rows.length, FIRST_REVISION);
  assert.ok(
    identitySchema(MISSION_IDENTITY_PREFIX).safeParse(rows[0]?.id).success,
  );
  assert.equal(rows[0]?.project_id, PROJECT_ID);
  assert.equal(rows[0]?.version, MISSION_INITIAL_VERSION);
  assert.ok(Number.isSafeInteger(rows[0]?.created_at));
  assert.throws(
    () =>
      store.transaction((tx) =>
        mission.createMission(tx, PROJECT_ID, HUMAN_ACTOR),
      ),
    SQLITE_UNIQUE_CONSTRAINT,
  );
  assert.equal(
    store.database
      .prepare("SELECT COUNT(*) AS count FROM mission_mission")
      .get()?.count,
    FIRST_REVISION,
  );
});

test("liveNodesPinning checks only the current revision of live nonterminal nodes", (t) => {
  const { store, mission } = fixture(t);
  const { pending, available } = store.transaction((tx) => {
    mission.createMission(tx, PROJECT_ID, HUMAN_ACTOR);
    const missionId = String(
      tx.database.prepare("SELECT id FROM mission_mission").get()?.id,
    );
    const pending = insertNode(tx, missionId, NodeState.Pending);
    insertRevision(tx, pending, FIRST_REVISION, [BINDING_ID]);
    const available = insertNode(tx, missionId, NodeState.Available);
    insertRevision(tx, available, FIRST_REVISION, [OTHER_BINDING_ID]);
    insertRevision(tx, available, NEXT_REVISION, [BINDING_ID]);
    const superseded = insertNode(tx, missionId, NodeState.Pending);
    insertRevision(tx, superseded, FIRST_REVISION, [BINDING_ID]);
    insertRevision(tx, superseded, NEXT_REVISION, [OTHER_BINDING_ID]);
    const retired = insertNode(tx, missionId, NodeState.Available, RETIRED_AT);
    insertRevision(tx, retired, FIRST_REVISION, [BINDING_ID]);
    const completed = insertNode(tx, missionId, NodeState.Completed);
    insertRevision(tx, completed, FIRST_REVISION, [BINDING_ID]);
    const discarded = insertNode(tx, missionId, NodeState.Discarded);
    insertRevision(tx, discarded, FIRST_REVISION, [BINDING_ID]);
    const task = insertNode(tx, missionId, null);
    insertRevision(tx, task, FIRST_REVISION, [BINDING_ID]);
    return { pending, available };
  });
  const pinned = store.transaction((tx) =>
    mission.liveNodesPinning(tx, BINDING_ID),
  );
  assert.deepEqual(pinned, [pending, available].sort());
  assert.deepEqual(
    store.transaction((tx) => mission.liveNodesPinning(tx, UNKNOWN_BINDING_ID)),
    [],
  );
});

const ZERO = 0;
const ONE = 1;
const TWO = 2;
const THREE = 3;
const REPOSITORY_NAME = "api-repo";
const STORAGE_NAME = "bucket";
const WORKER_NAME = "worker";
const UNKNOWN_NAME = "unknown";
const REASON = "Create planned work";
const VERIFICATION = "true";
const INITIATIVE_FILENAME = "initiative.md";
const OBJECTIVE_FILENAME = "objective.md";
const TASK_FILENAME = "task.md";
const OTHER_FILENAME = "other.md";
const NEW_FILENAME = "new.md";
const PARENT_ID_FIELD = "parentId";
const PARENT_REVISION_FIELD = "expectedParentRevision";
const UNKNOWN_NODE_ID = "node_00000000000000000000000000";
const UNKNOWN_MISSION_ID = "mission_00000000000000000000000000";
const IMPORT_PREVIEW_PATH = "/api/mission/:missionId/import/preview";
const PRIORITY = 42;
const NEGATIVE_PRIORITY = -42;
const PRIORITY_PATH = "/api/mission/node/:nodeId/priority";
const QueueAction = { Insert: "insert", Delete: "delete" } as const;
type QueueCall = {
  action: string;
  nodeId: string;
  projectId?: string;
  priority?: number;
};
const bindingMap = new Map([
  [
    REPOSITORY_NAME,
    { bindingId: BINDING_ID, resourceIdentity: "repository:github:o/api" },
  ],
  [
    STORAGE_NAME,
    { bindingId: OTHER_BINDING_ID, resourceIdentity: "storage:s3:host/b" },
  ],
  [
    WORKER_NAME,
    { bindingId: UNKNOWN_BINDING_ID, resourceIdentity: "worker:kanthord:w" },
  ],
]);

function nodeFixture(
  t: TestContext,
  bindingRevision: MissionBindings["getBindingRevision"] = (_tx, id) => {
    const match = [...bindingMap.entries()].find(
      ([, value]) => value.bindingId === id,
    );
    return match === undefined
      ? null
      : {
          ...match[1],
          projectId: PROJECT_ID,
          name: match[0],
          revision: FIRST_REVISION,
          tombstone: false,
          disabled: false,
        };
  },
  textMaxBytes?: number,
) {
  const calls: QueueCall[] = [];
  const queue: WorkQueue = {
    insert(_tx, nodeId, projectId, priority) {
      calls.push({ action: QueueAction.Insert, nodeId, projectId, priority });
    },
    delete(_tx, nodeId) {
      calls.push({ action: QueueAction.Delete, nodeId });
    },
    priorityUpdate() {
      throw new Error(UNEXPECTED_COLLABORATION);
    },
  };
  const f = handlerFixture(
    t,
    {
      workQueue: queue,
      bindings: {
        ...bindings,
        resolveBinding: (_tx, projectId, name) => {
          assert.equal(projectId, PROJECT_ID);
          return bindingMap.get(name) ?? null;
        },
        getBindingRevision: bindingRevision,
      },
    },
    textMaxBytes,
  );
  f.store.transaction((tx) =>
    f.mission.createMission(tx, PROJECT_ID, HUMAN_ACTOR),
  );
  const missionId = f.invoke(PROJECT_ID).id;
  function version() {
    return f.invoke(PROJECT_ID).version;
  }
  function update(nodeId: string, body: NodeUpdate): NodeChange {
    const operation = missionOperations[RevisionWrite.NodeUpdate];
    const input = operation.input.parse({
      params: { nodeId },
      query: {},
      body,
    });
    return nodeChangeSchema.parse(
      f.registry.get(operation.id).handler(input, f.caller),
    );
  }
  function criterionSet(nodeId: string, body: CriterionSet): NodeChange {
    const operation = missionOperations[RevisionWrite.CriterionSet];
    const input = operation.input.parse({
      params: { nodeId },
      query: {},
      body,
    });
    return nodeChangeSchema.parse(
      f.registry.get(operation.id).handler(input, f.caller),
    );
  }
  function create(body: NodeCreate, id = missionId): NodeChange {
    const operation = missionOperations[RevisionWrite.NodeCreate];
    const input = operation.input.parse({
      params: { missionId: id },
      query: {},
      body,
    });
    return nodeChangeSchema.parse(
      f.registry.get(operation.id).handler(input, f.caller),
    );
  }
  function body(
    kind: NodeKind = NodeKind.Initiative,
    parentId?: string,
  ): NodeCreate {
    return {
      kind,
      filename:
        kind === NodeKind.Initiative
          ? INITIATIVE_FILENAME
          : kind === NodeKind.Objective
            ? OBJECTIVE_FILENAME
            : TASK_FILENAME,
      content: {
        name: NODE_TEXT,
        requirement: NODE_TEXT,
        criterion: NODE_TEXT,
        verifications: [VERIFICATION],
        bindings: kind === NodeKind.Objective ? [REPOSITORY_NAME] : [],
      },
      reason: REASON,
      expectedMissionVersion: version(),
      ...(parentId === undefined
        ? {}
        : { parentId, expectedParentRevision: FIRST_REVISION }),
    };
  }
  function initiative() {
    return create(body()).revisions[ZERO]!.nodeId;
  }
  function objective() {
    const parentId = initiative();
    return create(body(NodeKind.Objective, parentId)).revisions[ZERO]!.nodeId;
  }
  function node(id: string) {
    return f.store.transaction((tx) => readNode(tx, id));
  }
  function setState(id: string, state: NodeState) {
    f.store.database
      .prepare("UPDATE mission_node SET state = ? WHERE id = ?")
      .run(state, id);
  }
  function snapshot() {
    return {
      missions: f.store.database
        .prepare("SELECT * FROM mission_mission ORDER BY id")
        .all(),
      nodes: f.store.database
        .prepare("SELECT * FROM mission_node ORDER BY id")
        .all(),
      revisions: f.store.database
        .prepare(
          "SELECT * FROM mission_node_revision ORDER BY node_id, revision",
        )
        .all(),
      dependencies: f.store.database
        .prepare(
          "SELECT * FROM mission_dependency ORDER BY dependent_id, depends_on_id",
        )
        .all(),
      calls: [...calls],
    };
  }
  function refuses(
    body: NodeCreate,
    code: string,
    details: unknown = undefined,
    status: number = HttpStatus.Conflict,
    id = missionId,
  ) {
    const before = snapshot();
    const commits = f.commits();
    assert.throws(
      () => create(body, id),
      (error) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        if (details !== undefined) assert.deepEqual(error.details, details);
        return true;
      },
    );
    assert.equal(f.commits(), commits + ONE_COMMIT);
    assert.deepEqual(snapshot(), before);
  }
  return {
    ...f,
    missionId,
    calls,
    queue,
    version,
    create,
    update,
    criterionSet,
    body,
    initiative,
    objective,
    node,
    setState,
    snapshot,
    refuses,
  };
}

test("node.create initiative stores human attribution, pins, revision one and one version increment in one commit", (t) => {
  const f = nodeFixture(t);
  const body = f.body();
  body.content.bindings = [STORAGE_NAME];
  const commits = f.commits();
  const result = f.create(body);
  assert.equal(f.commits(), commits + ONE_COMMIT);
  assert.equal(result.missionVersion, MISSION_INITIAL_VERSION + ONE);
  assert.equal(f.version(), result.missionVersion);
  const revision = result.revisions[ZERO]!;
  assert.deepEqual(result, {
    missionVersion: NEXT_REVISION,
    revisions: [revision],
    retiredNodeIds: [],
    addedEdges: [],
    removedEdges: [],
    openAttemptsUnchanged: [],
  });
  assert.equal(revision.revision, FIRST_REVISION);
  assert.equal(revision.filename, body.filename);
  assert.equal(revision.reason, REASON);
  assert.deepEqual(revision.actor, humanActor(f.caller));
  assert.deepEqual(revision.content, {
    ...body.content,
    bindings: [OTHER_BINDING_ID],
  });
  assert.deepEqual(revision.change, {
    write: RevisionWrite.NodeCreate,
    previousRevision: null,
    changedFields: CONTENT_FIELDS,
  });
  assert.equal(revision.tasks, undefined);
  assert.equal(f.node(revision.nodeId)?.state, NodeState.Available);
  assert.equal(f.node(revision.nodeId)?.attempt, ZERO);
  assert.equal(f.node(revision.nodeId)?.priority, null);
  assert.deepEqual(f.calls, [
    {
      action: QueueAction.Insert,
      nodeId: revision.nodeId,
      projectId: PROJECT_ID,
      priority: ZERO,
    },
  ]);
  const stored = f.store.transaction((tx) =>
    readCurrentRevision(tx, revision.nodeId),
  );
  assert.ok(stored);
  assert.deepEqual(JSON.parse(stored.actor), humanActor(f.caller));
  assert.equal(stored.tasks, null);
});

test("node.create objective routes Available, queues it and removes its initiative job", (t) => {
  const f = nodeFixture(t);
  const parentId = f.initiative();
  f.calls.length = ZERO;
  const result = f.create(f.body(NodeKind.Objective, parentId));
  const revision = result.revisions[ZERO]!;
  assert.equal(result.missionVersion, THREE);
  assert.equal(f.node(revision.nodeId)?.state, NodeState.Available);
  assert.deepEqual(revision.content.bindings, [BINDING_ID]);
  assert.deepEqual(revision.tasks, []);
  assert.deepEqual(revision.change, {
    write: RevisionWrite.NodeCreate,
    previousRevision: null,
    changedFields: [...CONTENT_FIELDS, TASKS_FIELD],
    tasks: [],
  });
  assert.deepEqual(result.addedEdges, [
    { kind: EdgeKind.Containment, parentId, childId: revision.nodeId },
  ]);
  assert.equal(f.calls.length, TWO);
  assert.ok(
    f.calls.some(
      (call) => call.action === QueueAction.Delete && call.nodeId === parentId,
    ),
  );
  assert.ok(
    f.calls.some(
      (call) =>
        call.action === QueueAction.Insert && call.nodeId === revision.nodeId,
    ),
  );
});

test("node.create objective inherits unmet initiative dependencies and has no job", (t) => {
  const f = nodeFixture(t);
  const parentId = f.initiative();
  const dependency = f.create({ ...f.body(), filename: OTHER_FILENAME })
    .revisions[ZERO]!.nodeId;
  f.store.database
    .prepare(
      "INSERT INTO mission_dependency (dependent_id, depends_on_id, mission_id) VALUES (?, ?, ?)",
    )
    .run(parentId, dependency, f.missionId);
  f.calls.length = ZERO;
  const result = f.create(f.body(NodeKind.Objective, parentId));
  const nodeId = result.revisions[ZERO]!.nodeId;
  assert.equal(f.node(nodeId)?.state, NodeState.Pending);
  assert.equal(f.node(parentId)?.state, NodeState.Pending);
  assert.deepEqual(f.calls, [{ action: QueueAction.Delete, nodeId: parentId }]);
});

test("node.create task revises only its objective and stores no task state, attempt or priority", (t) => {
  const f = nodeFixture(t);
  const parentId = f.objective();
  const previous = f.store.transaction((tx) =>
    readCurrentRevision(tx, parentId),
  );
  assert.ok(previous);
  f.calls.length = ZERO;
  const body = f.body(NodeKind.Task, parentId);
  const result = f.create(body);
  const revision = result.revisions[ZERO]!;
  const task = revision.tasks![ZERO]!;
  assert.equal(result.missionVersion, body.expectedMissionVersion + ONE);
  assert.equal(revision.nodeId, parentId);
  assert.equal(revision.revision, NEXT_REVISION);
  assert.deepEqual(task, {
    id: task.id,
    filename: TASK_FILENAME,
    content: body.content,
  });
  assert.equal(revision.filename, previous.filename);
  assert.equal(revision.content.name, previous.name);
  assert.deepEqual(revision.content.bindings, JSON.parse(previous.bindings));
  assert.deepEqual(revision.actor, humanActor(f.caller));
  assert.deepEqual(revision.change, {
    write: RevisionWrite.NodeCreate,
    previousRevision: FIRST_REVISION,
    changedFields: [TASKS_FIELD],
    tasks: [
      {
        id: task.id,
        change: TaskChange.Created,
        changedFields: CONTENT_FIELDS,
      },
    ],
  });
  assert.deepEqual(result.addedEdges, [
    { kind: EdgeKind.Containment, parentId, childId: task.id },
  ]);
  const row = f.node(task.id)!;
  assert.equal(row.state, null);
  assert.equal(row.attempt, null);
  assert.equal(row.priority, null);
  assert.equal(
    f.store.transaction((tx) => readCurrentRevision(tx, task.id)),
    null,
  );
  assert.deepEqual(f.calls, []);
  const next = f.create({
    ...f.body(NodeKind.Task, parentId),
    filename: NEW_FILENAME,
    expectedParentRevision: NEXT_REVISION,
  });
  assert.equal(next.revisions[ZERO]!.tasks!.length, TWO);
  assert.deepEqual(next.revisions[ZERO]!.tasks![ZERO], task);
});

for (const kind of [NodeKind.Objective, NodeKind.Task]) {
  for (const state of Object.values(NodeState)) {
    const admitted = new Set<NodeState>([
      NodeState.Pending,
      NodeState.Available,
      NodeState.Executing,
      NodeState.Blocked,
      NodeState.Paused,
    ]).has(state);
    test(`node.create ${kind} ${admitted ? "admits" : "refuses"} parent ${state}`, (t) => {
      const f = nodeFixture(t);
      const parentId =
        kind === NodeKind.Objective ? f.initiative() : f.objective();
      f.setState(parentId, state);
      const body = f.body(kind, parentId);
      if (!admitted) {
        f.refuses(body, MissionErrorCode.CreateRefused, { state });
        return;
      }
      const result = f.create(body);
      assert.equal(result.missionVersion, body.expectedMissionVersion + ONE);
      assert.equal(result.revisions.length, ONE);
    });
  }
}

test("node.create refuses wrong parent kinds before parent state admission", (t) => {
  const f = nodeFixture(t);
  const objective = f.objective();
  f.refuses(
    f.body(NodeKind.Objective, objective),
    MissionErrorCode.CreateRefused,
    { parentId: objective, parentKind: NodeKind.Objective },
  );
  const task = f.create(f.body(NodeKind.Task, objective)).revisions[ZERO]!
    .tasks![ZERO]!.id;
  f.refuses(
    { ...f.body(NodeKind.Task, task), filename: NEW_FILENAME },
    MissionErrorCode.CreateRefused,
    { parentId: task, parentKind: NodeKind.Task },
  );
  const initiative = f.node(objective)!.parent_id!;
  f.refuses(
    { ...f.body(NodeKind.Task, initiative), filename: NEW_FILENAME },
    MissionErrorCode.CreateRefused,
    { parentId: initiative, parentKind: NodeKind.Initiative },
  );
});

test("node.create refuses a parent in another mission", (t) => {
  const f = nodeFixture(t);
  const parentId = f.initiative();
  f.store.transaction((tx) =>
    f.mission.createMission(tx, UNKNOWN_PROJECT_ID, HUMAN_ACTOR),
  );
  const otherMission = f.invoke(UNKNOWN_PROJECT_ID);
  f.refuses(
    {
      ...f.body(NodeKind.Objective, parentId),
      expectedMissionVersion: otherMission.version,
    },
    MissionErrorCode.CreateRefused,
    { parentId, parentKind: NodeKind.Initiative },
    HttpStatus.Conflict,
    otherMission.id,
  );
});

for (const kind of [NodeKind.Objective, NodeKind.Task]) {
  test(`node.create ${kind} refuses retired parent`, (t) => {
    const f = nodeFixture(t);
    const parentId =
      kind === NodeKind.Objective ? f.initiative() : f.objective();
    f.store.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(RETIRED_AT, parentId);
    f.refuses(f.body(kind, parentId), MissionErrorCode.Retired, {
      nodeId: parentId,
    });
  });
}

test("node.create validates mission and parent existence and version before content", (t) => {
  const f = nodeFixture(t);
  f.refuses(
    f.body(),
    MissionErrorCode.MissionNotFound,
    undefined,
    HttpStatus.NotFound,
    UNKNOWN_MISSION_ID,
  );
  const parentId = f.initiative();
  f.refuses(
    {
      ...f.body(NodeKind.Objective, parentId),
      expectedMissionVersion: FIRST_REVISION,
    },
    MissionErrorCode.VersionConflict,
    { current: NEXT_REVISION },
  );
  f.refuses(
    {
      ...f.body(NodeKind.Objective, parentId),
      expectedParentRevision: NEXT_REVISION,
    },
    MissionErrorCode.RevisionConflict,
    { current: FIRST_REVISION },
  );
  f.refuses(
    f.body(NodeKind.Objective, UNKNOWN_NODE_ID),
    MissionErrorCode.NodeNotFound,
    undefined,
    HttpStatus.NotFound,
  );
});

test("node.create enforces required and forbidden parent fields", (t) => {
  const f = nodeFixture(t);
  f.refuses(
    { ...f.body(), parentId: UNKNOWN_NODE_ID },
    MissionErrorCode.ContentInvalid,
    { field: PARENT_ID_FIELD },
    HttpStatus.BadRequest,
  );
  f.refuses(
    { ...f.body(), expectedParentRevision: FIRST_REVISION },
    MissionErrorCode.ContentInvalid,
    { field: PARENT_ID_FIELD },
    HttpStatus.BadRequest,
  );
  for (const kind of [NodeKind.Objective, NodeKind.Task]) {
    f.refuses(
      f.body(kind),
      MissionErrorCode.ContentInvalid,
      { field: PARENT_ID_FIELD },
      HttpStatus.BadRequest,
    );
    f.refuses(
      { ...f.body(kind, UNKNOWN_NODE_ID), expectedParentRevision: undefined },
      MissionErrorCode.ContentInvalid,
      { field: PARENT_REVISION_FIELD },
      HttpStatus.BadRequest,
    );
  }
});

test("node.create refuses active filename reuse but accepts retired filename reuse", (t) => {
  const f = nodeFixture(t);
  const id = f.initiative();
  f.refuses(f.body(), MissionErrorCode.FilenameConflict, {
    filename: INITIATIVE_FILENAME,
  });
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, id);
  const result = f.create(f.body());
  assert.notEqual(result.revisions[ZERO]!.nodeId, id);
  assert.equal(result.revisions[ZERO]!.filename, INITIATIVE_FILENAME);
});

test("node insert translates only the active filename unique constraint", (t) => {
  const f = nodeFixture(t);
  const id = f.initiative();
  const before = f.version();
  assert.throws(
    () =>
      f.store.transaction((tx) =>
        insertNodeRow(tx, {
          id: createIdentity(NODE_IDENTITY_PREFIX),
          mission_id: f.missionId,
          kind: NodeKind.Initiative,
          filename: INITIATIVE_FILENAME,
          parent_id: null,
          created_at: CREATED_AT,
        }),
      ),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, MissionErrorCode.FilenameConflict);
      assert.deepEqual(error.details, { filename: INITIATIVE_FILENAME });
      return true;
    },
  );
  assert.throws(
    () =>
      f.store.transaction((tx) =>
        insertNodeRow(tx, {
          id,
          mission_id: f.missionId,
          kind: NodeKind.Initiative,
          filename: OTHER_FILENAME,
          parent_id: null,
          created_at: CREATED_AT,
        }),
      ),
    (error) => error instanceof Error && !(error instanceof OperationError),
  );
  assert.equal(f.version(), before);
});

test("node.create refuses unresolved bindings before filename conflicts", (t) => {
  const f = nodeFixture(t);
  f.initiative();
  const body = f.body();
  body.content.bindings = [UNKNOWN_NAME];
  f.refuses(
    body,
    MissionErrorCode.BindingsInvalid,
    { binding: UNKNOWN_NAME },
    HttpStatus.BadRequest,
  );
});

for (const kind of Object.values(NodeKind)) {
  test(`node.create ${kind} enforces the binding rule table`, (t) => {
    const f = nodeFixture(t);
    const parentId =
      kind === NodeKind.Initiative
        ? undefined
        : kind === NodeKind.Objective
          ? f.initiative()
          : f.objective();
    const body = f.body(kind, parentId);
    body.content.bindings = [WORKER_NAME];
    f.refuses(
      body,
      MissionErrorCode.BindingsInvalid,
      undefined,
      HttpStatus.BadRequest,
    );
    body.content.bindings =
      kind === NodeKind.Objective ? [] : [REPOSITORY_NAME];
    f.refuses(
      body,
      MissionErrorCode.BindingsInvalid,
      undefined,
      HttpStatus.BadRequest,
    );
  });
}

test("shared routing requires Completed dependencies, preserves held states, and reconciles priorities once", (t) => {
  const f = nodeFixture(t);
  const parentId = f.initiative();
  const dependency = f.create({ ...f.body(), filename: OTHER_FILENAME })
    .revisions[ZERO]!.nodeId;
  const objective = f.create(f.body(NodeKind.Objective, parentId)).revisions[
    ZERO
  ]!.nodeId;
  f.store.database
    .prepare(
      "INSERT INTO mission_dependency (dependent_id, depends_on_id, mission_id) VALUES (?, ?, ?)",
    )
    .run(parentId, dependency, f.missionId);
  f.store.database
    .prepare("UPDATE mission_node SET priority = ? WHERE id = ?")
    .run(PRIORITY, objective);
  function route() {
    f.store.transaction((tx) => {
      const before = claimableMap(tx, f.missionId, bindings);
      routeMission(tx, f.missionId);
      reconcileMission(tx, f.queue, f.missionId, PROJECT_ID, before, bindings);
    });
  }
  f.setState(dependency, NodeState.Discarded);
  route();
  assert.equal(f.node(objective)?.state, NodeState.Pending);
  f.calls.length = ZERO;
  f.setState(dependency, NodeState.Completed);
  route();
  assert.equal(f.node(objective)?.state, NodeState.Available);
  assert.deepEqual(f.calls, [
    {
      action: QueueAction.Insert,
      nodeId: objective,
      projectId: PROJECT_ID,
      priority: PRIORITY,
    },
  ]);
  f.calls.length = ZERO;
  route();
  assert.deepEqual(f.calls, []);
  f.setState(objective, NodeState.Executing);
  f.setState(dependency, NodeState.Pending);
  route();
  assert.equal(f.node(objective)?.state, NodeState.Executing);
  assert.equal(f.node(parentId)?.state, NodeState.Pending);
});

test("shared claimability ignores retired children, requires every current objective terminal, and excludes tasks", (t) => {
  const f = nodeFixture(t);
  const objective = f.objective();
  const parentId = f.node(objective)!.parent_id!;
  const task = f.create(f.body(NodeKind.Task, objective)).revisions[ZERO]!
    .tasks![ZERO]!.id;
  const other = f.create({
    ...f.body(NodeKind.Objective, parentId),
    filename: OTHER_FILENAME,
  }).revisions[ZERO]!.nodeId;
  f.setState(objective, NodeState.Completed);
  const before = f.store.transaction((tx) =>
    claimableMap(tx, f.missionId, bindings),
  );
  assert.equal(before.get(parentId), false);
  assert.equal(before.get(task), false);
  assert.equal(before.get(objective), false);
  assert.equal(before.get(other), true);
  f.calls.length = ZERO;
  f.store.transaction((tx) => {
    tx.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(RETIRED_AT, other);
    routeMission(tx, f.missionId);
    reconcileMission(tx, f.queue, f.missionId, PROJECT_ID, before, bindings);
    const after = claimableMap(tx, f.missionId, bindings);
    assert.equal(after.get(parentId), true);
    assert.equal(after.get(other), false);
  });
  assert.equal(f.calls.length, TWO);
  assert.ok(
    f.calls.some(
      (call) => call.action === QueueAction.Insert && call.nodeId === parentId,
    ),
  );
  assert.ok(
    f.calls.some(
      (call) => call.action === QueueAction.Delete && call.nodeId === other,
    ),
  );
  f.setState(objective, NodeState.Discarded);
  assert.equal(
    f.store
      .transaction((tx) => claimableMap(tx, f.missionId, bindings))
      .get(parentId),
    true,
  );
});

test("shared routing ignores dependency edges with a retired endpoint", (t) => {
  const f = nodeFixture(t);
  const parentId = f.initiative();
  const dependency = f.create({ ...f.body(), filename: OTHER_FILENAME })
    .revisions[ZERO]!.nodeId;
  f.store.database
    .prepare(
      "INSERT INTO mission_dependency (dependent_id, depends_on_id, mission_id) VALUES (?, ?, ?)",
    )
    .run(parentId, dependency, f.missionId);
  const objective = f.create(f.body(NodeKind.Objective, parentId)).revisions[
    ZERO
  ]!.nodeId;
  assert.equal(f.node(objective)?.state, NodeState.Pending);
  f.calls.length = ZERO;
  f.store.transaction((tx) => {
    const before = claimableMap(tx, f.missionId, bindings);
    tx.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(RETIRED_AT, dependency);
    routeMission(tx, f.missionId);
    reconcileMission(tx, f.queue, f.missionId, PROJECT_ID, before, bindings);
  });
  assert.equal(f.node(objective)?.state, NodeState.Available);
  assert.equal(f.calls.length, TWO);
  assert.ok(
    f.calls.some(
      (call) =>
        call.action === QueueAction.Delete && call.nodeId === dependency,
    ),
  );
  assert.ok(
    f.calls.some(
      (call) => call.action === QueueAction.Insert && call.nodeId === objective,
    ),
  );
});

test("node.create validates content and reason byte limits without writes", (t) => {
  const f = nodeFixture(t);
  const overLimit = NODE_TEXT.repeat(TEXT_MAX_BYTES);
  const reasonField = "reason";
  const nameField = "name";
  f.refuses(
    { ...f.body(), reason: overLimit },
    MissionErrorCode.ContentInvalid,
    { field: reasonField },
    HttpStatus.BadRequest,
  );
  const body = f.body();
  body.content.name = overLimit;
  f.refuses(
    body,
    MissionErrorCode.ContentInvalid,
    { field: nameField },
    HttpStatus.BadRequest,
  );
});

test("node reads map current and retired task snapshots, revisions and pagination", (t) => {
  const f = nodeFixture(t);
  function invoke<
    K extends
      "node.get" | "node.list" | "node.revision.list" | "node.revision.get",
  >(key: K, params: object, query: object = {}) {
    const operation = missionOperations[key];
    const input = operation.input.parse({ params, query, body: null });
    const before = f.commits();
    const result = f.registry.get(operation.id).handler(input, f.caller);
    assert.equal(f.commits(), before + ONE_COMMIT);
    return operation.output.parse(result);
  }
  const initiative = f.initiative();
  const objective = f.create(f.body(NodeKind.Objective, initiative)).revisions[
    ZERO
  ]!.nodeId;
  const taskRevision = f.create(f.body(NodeKind.Task, objective)).revisions[
    ZERO
  ]!;
  const task = taskRevision.tasks![ZERO]!;
  const taskNode = nodeSchema.parse(invoke("node.get", { nodeId: task.id }));
  assert.equal(taskNode.visibleRevision, NEXT_REVISION);
  assert.deepEqual(taskNode.content, task.content);
  assert.equal("state" in taskNode, false);
  const objectiveNode = nodeSchema.parse(
    invoke("node.get", { nodeId: objective }),
  );
  assert.equal(objectiveNode.kind, NodeKind.Objective);
  if (objectiveNode.kind !== NodeKind.Objective)
    throw new Error(UNEXPECTED_COLLABORATION);
  assert.equal(objectiveNode.priority, ZERO);
  assert.deepEqual(objectiveNode.content.bindings, [BINDING_ID]);
  const revision = revisionSchema.parse(
    invoke("node.revision.get", { nodeId: task.id, revision: NEXT_REVISION }),
  );
  assert.equal(revision.nodeId, objective);
  assert.deepEqual(revision, taskRevision);
  const page = pageOf(revisionSchema).parse(
    invoke("node.revision.list", { nodeId: task.id }, { limit: "1" }),
  );
  assert.deepEqual(
    page.items.map((item) => item.revision),
    [NEXT_REVISION],
  );
  assert.ok(page.nextCursor);
  assert.deepEqual(
    pageOf(revisionSchema)
      .parse(
        invoke(
          "node.revision.list",
          { nodeId: objective },
          { limit: "1", cursor: page.nextCursor },
        ),
      )
      .items.map((item) => item.revision),
    [FIRST_REVISION],
  );
  const first = pageOf(nodeSchema).parse(
    invoke("node.list", { missionId: f.missionId }, { limit: "1" }),
  );
  assert.equal(first.items.length, ONE);
  assert.ok(first.nextCursor);
  const second = pageOf(nodeSchema).parse(
    invoke(
      "node.list",
      { missionId: f.missionId },
      { limit: "1", cursor: first.nextCursor },
    ),
  );
  assert.equal(second.items.length, ONE);
  assert.ok(first.items[ZERO]!.id > second.items[ZERO]!.id);
  assert.deepEqual(
    pageOf(nodeSchema)
      .parse(
        invoke(
          "node.list",
          { missionId: f.missionId },
          { kind: NodeKind.Task, parentId: objective },
        ),
      )
      .items.map((item) => item.id),
    [task.id],
  );
  assert.deepEqual(
    pageOf(nodeSchema)
      .parse(
        invoke(
          "node.list",
          { missionId: f.missionId },
          { state: objectiveNode.state },
        ),
      )
      .items.every((item) => item.kind !== NodeKind.Task),
    true,
  );
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, task.id);
  assert.equal(
    pageOf(nodeSchema).parse(
      invoke("node.list", { missionId: f.missionId }, { kind: NodeKind.Task }),
    ).items.length,
    ZERO,
  );
  assert.equal(
    pageOf(nodeSchema).parse(
      invoke(
        "node.list",
        { missionId: f.missionId },
        { kind: NodeKind.Task, includeRetired: "false" },
      ),
    ).items.length,
    ZERO,
  );
  assert.equal(
    pageOf(nodeSchema).parse(
      invoke(
        "node.list",
        { missionId: f.missionId },
        { kind: NodeKind.Task, includeRetired: "true" },
      ),
    ).items.length,
    ONE,
  );
  f.store.database
    .prepare(
      "INSERT INTO mission_node_revision SELECT node_id, revision + 1, filename, name, requirement, criterion, verifications, bindings, '[]', change, reason, actor, created_at FROM mission_node_revision WHERE node_id = ? AND revision = ?",
    )
    .run(objective, NEXT_REVISION);
  const retired = nodeSchema.parse(invoke("node.get", { nodeId: task.id }));
  assert.equal(retired.visibleRevision, THREE);
  assert.deepEqual(retired.content, task.content);
});

test("node reads refuse missing identities and malformed cursors", (t) => {
  const f = nodeFixture(t);
  function refuses(
    key: "node.get" | "node.list" | "node.revision.get" | "node.revision.list",
    params: object,
    query: object,
    code: string,
    status: number,
  ) {
    const operation = missionOperations[key];
    const input = operation.input.parse({ params, query, body: null });
    assert.throws(
      () => f.registry.get(operation.id).handler(input, f.caller),
      (error) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.code, code);
        assert.equal(error.status, status);
        return true;
      },
    );
  }
  refuses(
    "node.get",
    { nodeId: UNKNOWN_NODE_ID },
    {},
    MissionErrorCode.NodeNotFound,
    HttpStatus.NotFound,
  );
  refuses(
    "node.list",
    { missionId: UNKNOWN_MISSION_ID },
    {},
    MissionErrorCode.MissionNotFound,
    HttpStatus.NotFound,
  );
  const objective = f.objective();
  refuses(
    "node.revision.get",
    { nodeId: objective, revision: NEXT_REVISION },
    {},
    MissionErrorCode.NodeNotFound,
    HttpStatus.NotFound,
  );
  refuses(
    "node.revision.list",
    { nodeId: UNKNOWN_NODE_ID },
    {},
    MissionErrorCode.NodeNotFound,
    HttpStatus.NotFound,
  );
  refuses(
    "node.list",
    { missionId: f.missionId },
    { cursor: "%%%" },
    MissionErrorCode.CursorInvalid,
    HttpStatus.BadRequest,
  );
  refuses(
    "node.revision.list",
    { nodeId: objective },
    { cursor: "%%%" },
    MissionErrorCode.CursorInvalid,
    HttpStatus.BadRequest,
  );
  assert.equal(
    missionOperations["node.list"].input.safeParse({
      params: { missionId: f.missionId },
      query: { kind: NodeKind.Task, state: NodeState.Pending },
      body: null,
    }).success,
    false,
  );
});

const DependencyOperation = {
  Add: "dependency.add",
  Remove: "dependency.remove",
} as const;
type DependencyOperation =
  (typeof DependencyOperation)[keyof typeof DependencyOperation];
const EndpointReason = {
  Task: "task_endpoint",
  CrossMission: "cross_mission",
} as const;
const CURSOR_ENCODING = "base64url";
const REASON_FIELD = "reason";

function dependencyFixture(
  t: TestContext,
  bindingRevision?: MissionBindings["getBindingRevision"],
  textMaxBytes?: number,
) {
  const f = nodeFixture(t, bindingRevision, textMaxBytes);
  f.store.database.exec(
    "CREATE TABLE test_mission_job (node_id TEXT PRIMARY KEY)",
  );
  const insert = f.queue.insert;
  const remove = f.queue.delete;
  f.queue.insert = (tx, nodeId, projectId, priority) => {
    assert.equal(tx.database, f.store.database);
    assert.equal(readNode(tx, nodeId)?.state, NodeState.Available);
    tx.database.prepare("INSERT INTO test_mission_job VALUES (?)").run(nodeId);
    insert(tx, nodeId, projectId, priority);
  };
  f.queue.delete = (tx, nodeId) => {
    assert.equal(tx.database, f.store.database);
    assert.ok(readNode(tx, nodeId));
    tx.database
      .prepare("DELETE FROM test_mission_job WHERE node_id = ?")
      .run(nodeId);
    remove(tx, nodeId);
  };
  function edit(
    operation: DependencyOperation,
    nodeId: string,
    dependsOnId: string,
    expectedMissionVersion = f.version(),
    reason = REASON,
  ) {
    const declaration = missionOperations[operation];
    const input = declaration.input.parse({
      params: { nodeId, dependsOnId },
      query: {},
      body: { expectedMissionVersion, reason },
    });
    const commits = f.commits();
    try {
      return declaration.output.parse(
        f.registry.get(declaration.id).handler(input, f.caller),
      );
    } finally {
      assert.equal(f.commits(), commits + ONE_COMMIT);
    }
  }
  function jobs() {
    return f.store.database
      .prepare("SELECT node_id FROM test_mission_job ORDER BY node_id")
      .all();
  }
  function refuses(
    operation: DependencyOperation,
    nodeId: string,
    dependsOnId: string,
    code: string,
    details?: unknown,
    expectedMissionVersion = f.version(),
    status: number = HttpStatus.Conflict,
    reason = REASON,
  ) {
    const before = { ...f.snapshot(), jobs: jobs() };
    assert.throws(
      () =>
        edit(operation, nodeId, dependsOnId, expectedMissionVersion, reason),
      (error) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        if (details !== undefined) assert.deepEqual(error.details, details);
        return true;
      },
    );
    assert.deepEqual({ ...f.snapshot(), jobs: jobs() }, before);
  }
  function edges(query: object = {}, missionId = f.missionId) {
    const operation = missionOperations["edge.list"];
    const input = operation.input.parse({
      params: { missionId },
      query,
      body: null,
    });
    const commits = f.commits();
    const result = pageOf(edgeSchema).parse(
      f.registry.get(operation.id).handler(input, f.caller),
    );
    assert.equal(f.commits(), commits + ONE_COMMIT);
    return result;
  }
  function pair() {
    const nodeId = f.objective();
    const dependsOnId = f.create({ ...f.body(), filename: OTHER_FILENAME })
      .revisions[ZERO]!.nodeId;
    f.calls.length = ZERO;
    return { nodeId, dependsOnId };
  }
  return { ...f, edit, refuses, jobs, edges, pair };
}

function emptyChange(missionVersion: number): NodeChange {
  return {
    missionVersion,
    revisions: [],
    retiredNodeIds: [],
    addedEdges: [],
    removedEdges: [],
    openAttemptsUnchanged: [],
  };
}

test("dependency edits reroute objectives and jobs atomically without revisions or actor writes", (t) => {
  const f = dependencyFixture(t);
  const { nodeId, dependsOnId } = f.pair();
  const before = f.snapshot();
  const version = f.version();
  const edge = { kind: EdgeKind.Dependency, dependentId: nodeId, dependsOnId };
  assert.deepEqual(f.edit(DependencyOperation.Add, nodeId, dependsOnId), {
    ...emptyChange(version + ONE),
    addedEdges: [edge],
  });
  assert.equal(f.node(nodeId)?.state, NodeState.Pending);
  assert.equal(
    f.jobs().some((job) => job.node_id === nodeId),
    false,
  );
  assert.deepEqual(f.calls, [{ action: QueueAction.Delete, nodeId }]);
  assert.deepEqual(f.snapshot().revisions, before.revisions);
  f.calls.length = ZERO;
  assert.deepEqual(f.edit(DependencyOperation.Remove, nodeId, dependsOnId), {
    ...emptyChange(version + TWO),
    removedEdges: [edge],
  });
  assert.equal(f.node(nodeId)?.state, NodeState.Available);
  assert.equal(
    f.jobs().some((job) => job.node_id === nodeId),
    true,
  );
  assert.deepEqual(f.calls, [
    {
      action: QueueAction.Insert,
      nodeId,
      projectId: PROJECT_ID,
      priority: ZERO,
    },
  ]);
  assert.deepEqual(f.snapshot().revisions, before.revisions);
  assert.deepEqual(f.snapshot().dependencies, []);
});

test("dependency addition rejects direct, self and inherited ancestor closure cycles without writes", (t) => {
  const f = dependencyFixture(t);
  const { nodeId, dependsOnId } = f.pair();
  f.edit(DependencyOperation.Add, nodeId, dependsOnId);
  f.refuses(
    DependencyOperation.Add,
    dependsOnId,
    nodeId,
    MissionErrorCode.Cycle,
  );
  f.refuses(DependencyOperation.Add, nodeId, nodeId, MissionErrorCode.Cycle);
  f.refuses(
    DependencyOperation.Add,
    f.node(nodeId)!.parent_id!,
    nodeId,
    MissionErrorCode.Cycle,
  );
});

test("dependency addition rejects an objective depending on its own initiative without writes", (t) => {
  const f = dependencyFixture(t);
  const objective = f.objective();
  const initiative = f.node(objective)!.parent_id!;
  f.refuses(
    DependencyOperation.Add,
    objective,
    initiative,
    MissionErrorCode.Cycle,
  );
});

test("dependency addition rejects crossed initiative waits without writes", (t) => {
  const f = dependencyFixture(t);
  const first = f.initiative();
  const objective = f.create(f.body(NodeKind.Objective, first)).revisions[ZERO]!
    .nodeId;
  const second = f.create({ ...f.body(), filename: OTHER_FILENAME }).revisions[
    ZERO
  ]!.nodeId;
  const other = f.create({
    ...f.body(NodeKind.Objective, second),
    filename: "crossed.md",
  }).revisions[ZERO]!.nodeId;
  f.edit(DependencyOperation.Add, objective, second);
  f.refuses(DependencyOperation.Add, other, first, MissionErrorCode.Cycle);
});

test("dependency addition validates task endpoints in either position and cross-mission endpoints", (t) => {
  const f = dependencyFixture(t);
  const { nodeId, dependsOnId } = f.pair();
  const task = f.create(f.body(NodeKind.Task, nodeId)).revisions[ZERO]!.tasks![
    ZERO
  ]!.id;
  for (const [dependent, target] of [
    [task, dependsOnId],
    [nodeId, task],
  ]) {
    f.refuses(
      DependencyOperation.Add,
      dependent!,
      target!,
      MissionErrorCode.EndpointInvalid,
      {
        reason: EndpointReason.Task,
        nodeId: dependent,
        dependsOnId: target,
      },
    );
  }
  f.store.transaction((tx) =>
    f.mission.createMission(tx, UNKNOWN_PROJECT_ID, HUMAN_ACTOR),
  );
  const otherMission = f.invoke(UNKNOWN_PROJECT_ID);
  const other = f.create(
    { ...f.body(), expectedMissionVersion: otherMission.version },
    otherMission.id,
  ).revisions[ZERO]!.nodeId;
  f.refuses(
    DependencyOperation.Add,
    nodeId,
    other,
    MissionErrorCode.EndpointInvalid,
    {
      reason: EndpointReason.CrossMission,
      nodeId,
      dependsOnId: other,
    },
  );
});

for (const operation of Object.values(DependencyOperation)) {
  for (const state of [NodeState.Completed, NodeState.Discarded]) {
    test(`${operation} refuses terminal dependent ${state} before no-op`, (t) => {
      const f = dependencyFixture(t);
      const { nodeId, dependsOnId } = f.pair();
      f.setState(nodeId, state);
      f.refuses(operation, nodeId, dependsOnId, MissionErrorCode.Terminal, {
        nodeId,
      });
    });
  }
  test(`${operation} checks existence, retirement, version, terminal state and reason in order`, (t) => {
    const f = dependencyFixture(t);
    const { nodeId, dependsOnId } = f.pair();
    f.refuses(
      operation,
      UNKNOWN_NODE_ID,
      dependsOnId,
      MissionErrorCode.NodeNotFound,
      undefined,
      FIRST_REVISION,
      HttpStatus.NotFound,
    );
    f.refuses(
      operation,
      nodeId,
      dependsOnId,
      MissionErrorCode.ContentInvalid,
      { field: REASON_FIELD },
      f.version(),
      HttpStatus.BadRequest,
      NODE_TEXT.repeat(TEXT_MAX_BYTES),
    );
    f.setState(nodeId, NodeState.Completed);
    f.refuses(
      operation,
      nodeId,
      dependsOnId,
      MissionErrorCode.VersionConflict,
      { current: f.version() },
      FIRST_REVISION,
    );
    f.store.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(RETIRED_AT, nodeId);
    f.refuses(
      operation,
      nodeId,
      dependsOnId,
      MissionErrorCode.Retired,
      { nodeId },
      FIRST_REVISION,
    );
  });
}

for (const operation of Object.values(DependencyOperation)) {
  test(`${operation} rolls back graph, routing, jobs and version when queue reconciliation fails`, (t) => {
    const f = dependencyFixture(t);
    const { nodeId, dependsOnId } = f.pair();
    if (operation === DependencyOperation.Remove)
      f.edit(DependencyOperation.Add, nodeId, dependsOnId);
    const failure = new Error(UNEXPECTED_COLLABORATION);
    f.queue.delete = (tx, id) => {
      assert.equal(id, nodeId);
      assert.equal(readNode(tx, id)?.state, NodeState.Pending);
      tx.database
        .prepare("DELETE FROM test_mission_job WHERE node_id = ?")
        .run(id);
      throw failure;
    };
    f.queue.insert = (tx, id) => {
      assert.equal(id, nodeId);
      assert.equal(readNode(tx, id)?.state, NodeState.Available);
      tx.database.prepare("INSERT INTO test_mission_job VALUES (?)").run(id);
      throw failure;
    };
    const before = { ...f.snapshot(), jobs: f.jobs() };
    assert.throws(
      () => f.edit(operation, nodeId, dependsOnId),
      (error) => error === failure,
    );
    assert.deepEqual({ ...f.snapshot(), jobs: f.jobs() }, before);
  });
}

test("dependency.add checks both endpoints exist before retirement and target retirement before version", (t) => {
  const f = dependencyFixture(t);
  const { nodeId, dependsOnId } = f.pair();
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, nodeId);
  f.refuses(
    DependencyOperation.Add,
    nodeId,
    UNKNOWN_NODE_ID,
    MissionErrorCode.NodeNotFound,
    undefined,
    FIRST_REVISION,
    HttpStatus.NotFound,
  );
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = NULL WHERE id = ?")
    .run(nodeId);
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, dependsOnId);
  f.refuses(
    DependencyOperation.Add,
    nodeId,
    dependsOnId,
    MissionErrorCode.Retired,
    { nodeId: dependsOnId },
    FIRST_REVISION,
  );
});

test("dependency duplicate addition and absent removal do not write, increment or call the queue", (t) => {
  const f = dependencyFixture(t);
  const { nodeId, dependsOnId } = f.pair();
  f.edit(DependencyOperation.Add, nodeId, dependsOnId);
  f.calls.length = ZERO;
  const before = { ...f.snapshot(), jobs: f.jobs() };
  const changes = f.store.database.prepare("SELECT total_changes() AS count");
  const writes = changes.get()?.count;
  const version = f.version();
  assert.deepEqual(
    f.edit(DependencyOperation.Add, nodeId, dependsOnId),
    emptyChange(version),
  );
  assert.deepEqual(
    f.edit(DependencyOperation.Remove, nodeId, UNKNOWN_NODE_ID),
    emptyChange(version),
  );
  assert.deepEqual({ ...f.snapshot(), jobs: f.jobs() }, before);
  assert.equal(changes.get()?.count, writes);
  f.refuses(
    DependencyOperation.Add,
    nodeId,
    dependsOnId,
    MissionErrorCode.ContentInvalid,
    { field: REASON_FIELD },
    version,
    HttpStatus.BadRequest,
    NODE_TEXT.repeat(TEXT_MAX_BYTES),
  );
  f.refuses(
    DependencyOperation.Remove,
    nodeId,
    UNKNOWN_NODE_ID,
    MissionErrorCode.ContentInvalid,
    { field: REASON_FIELD },
    version,
    HttpStatus.BadRequest,
    NODE_TEXT.repeat(TEXT_MAX_BYTES),
  );
});

test("dependency removal does not validate endpoint pairs or target retirement", (t) => {
  const f = dependencyFixture(t);
  const { nodeId, dependsOnId } = f.pair();
  const task = f.create(f.body(NodeKind.Task, nodeId)).revisions[ZERO]!.tasks![
    ZERO
  ]!.id;
  assert.deepEqual(
    f.edit(DependencyOperation.Remove, task, nodeId),
    emptyChange(f.version()),
  );
  f.edit(DependencyOperation.Add, nodeId, dependsOnId);
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, dependsOnId);
  assert.deepEqual(
    f.edit(DependencyOperation.Remove, nodeId, dependsOnId).removedEdges,
    [{ kind: EdgeKind.Dependency, dependentId: nodeId, dependsOnId }],
  );
});

test("dependency addition on initiative reroutes every child objective and removes their jobs", (t) => {
  const f = dependencyFixture(t);
  const { nodeId, dependsOnId } = f.pair();
  const parentId = f.node(nodeId)!.parent_id!;
  const other = f.create({
    ...f.body(NodeKind.Objective, parentId),
    filename: NEW_FILENAME,
  }).revisions[ZERO]!.nodeId;
  f.calls.length = ZERO;
  f.edit(DependencyOperation.Add, parentId, dependsOnId);
  assert.equal(f.node(parentId)?.state, NodeState.Pending);
  for (const child of [nodeId, other]) {
    assert.equal(f.node(child)?.state, NodeState.Pending);
    assert.equal(
      f.jobs().some((job) => job.node_id === child),
      false,
    );
  }
  assert.deepEqual(
    f.calls.map((call) => call.nodeId).sort(),
    [nodeId, other].sort(),
  );
  assert.ok(f.calls.every((call) => call.action === QueueAction.Delete));
});

test("dependency removal only releases nodes when all remaining dependencies are completed", (t) => {
  const f = dependencyFixture(t);
  const { nodeId, dependsOnId } = f.pair();
  const other = f.create({ ...f.body(), filename: NEW_FILENAME }).revisions[
    ZERO
  ]!.nodeId;
  f.edit(DependencyOperation.Add, nodeId, dependsOnId);
  f.edit(DependencyOperation.Add, nodeId, other);
  f.calls.length = ZERO;
  f.edit(DependencyOperation.Remove, nodeId, dependsOnId);
  assert.equal(f.node(nodeId)?.state, NodeState.Pending);
  assert.deepEqual(f.calls, []);
  f.edit(DependencyOperation.Add, nodeId, dependsOnId);
  f.setState(other, NodeState.Completed);
  f.edit(DependencyOperation.Remove, nodeId, dependsOnId);
  assert.equal(f.node(nodeId)?.state, NodeState.Available);
  assert.equal(
    f.jobs().some((job) => job.node_id === nodeId),
    true,
  );
});

test("edge.list lists only current incident edges, filters kinds and paginates descending keys", (t) => {
  const f = dependencyFixture(t);
  const { nodeId, dependsOnId } = f.pair();
  const parentId = f.node(nodeId)!.parent_id!;
  const task = f.create(f.body(NodeKind.Task, nodeId)).revisions[ZERO]!.tasks![
    ZERO
  ]!.id;
  f.edit(DependencyOperation.Add, nodeId, dependsOnId);
  const dependency = {
    kind: EdgeKind.Dependency,
    dependentId: nodeId,
    dependsOnId,
  };
  const containment = [
    { kind: EdgeKind.Containment, parentId, childId: nodeId },
    { kind: EdgeKind.Containment, parentId: nodeId, childId: task },
  ].sort((a, b) => (a.parentId > b.parentId ? -ONE : ONE));
  const expected = [dependency, ...containment];
  assert.deepEqual(f.edges(), { items: expected, nextCursor: null });
  assert.deepEqual(f.edges({ kind: EdgeKind.Dependency }).items, [dependency]);
  assert.deepEqual(f.edges({ kind: EdgeKind.Containment }).items, containment);
  assert.deepEqual(f.edges({ nodeId }).items, expected);
  assert.deepEqual(f.edges({ nodeId: dependsOnId }).items, [dependency]);
  assert.deepEqual(
    f.edges({ kind: EdgeKind.Containment, nodeId: dependsOnId }).items,
    [],
  );
  assert.deepEqual(f.edges({ nodeId: UNKNOWN_NODE_ID }).items, []);
  let cursor: string | undefined;
  for (const edge of expected) {
    const page = f.edges({ limit: ONE, cursor });
    assert.deepEqual(page.items, [edge]);
    cursor = page.nextCursor ?? undefined;
  }
  assert.equal(cursor, undefined);
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, nodeId);
  assert.deepEqual(f.edges().items, []);
});

test("edge.list refuses unknown missions and malformed cursor encodings, kinds and node identities", (t) => {
  const f = dependencyFixture(t);
  assert.throws(
    () => f.edges({}, UNKNOWN_MISSION_ID),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.NotFound);
      assert.equal(error.code, MissionErrorCode.MissionNotFound);
      return true;
    },
  );
  const cursors = [
    "%%%",
    "",
    Buffer.from(`unknown|${UNKNOWN_NODE_ID}|${UNKNOWN_NODE_ID}`).toString(
      CURSOR_ENCODING,
    ),
    Buffer.from(`${EdgeKind.Dependency}|bad|${UNKNOWN_NODE_ID}`).toString(
      CURSOR_ENCODING,
    ),
    Buffer.from(`${EdgeKind.Dependency}|${UNKNOWN_NODE_ID}|bad`).toString(
      CURSOR_ENCODING,
    ),
    Buffer.from(
      `${EdgeKind.Dependency}|${UNKNOWN_NODE_ID}|${UNKNOWN_NODE_ID}|extra`,
    ).toString(CURSOR_ENCODING),
  ];
  for (const cursor of cursors) {
    assert.throws(
      () => f.edges({ cursor }),
      (error) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.status, HttpStatus.BadRequest);
        assert.equal(error.code, MissionErrorCode.CursorInvalid);
        return true;
      },
    );
  }
});

function updateBody(f: ReturnType<typeof nodeFixture>, id: string): NodeUpdate {
  const node = f.store.transaction((tx) => {
    const row = readNode(tx, id)!;
    const owner = row.kind === NodeKind.Task ? row.parent_id! : id;
    const revision = readCurrentRevision(tx, owner)!;
    const content =
      row.kind === NodeKind.Task
        ? JSON.parse(revision.tasks!).find(
            (task: { id: string }) => task.id === id,
          ).content
        : {
            name: revision.name,
            requirement: revision.requirement,
            criterion: revision.criterion,
            verifications: JSON.parse(revision.verifications),
            bindings: JSON.parse(revision.bindings),
          };
    return {
      filename: row.filename,
      content,
      kind: row.kind,
      expectedRevision: revision.revision,
    };
  });
  return {
    filename: node.filename,
    expectedRevision: node.expectedRevision,
    content: {
      ...node.content,
      bindings: node.kind === NodeKind.Objective ? [REPOSITORY_NAME] : [],
    },
    expectedMissionVersion: f.version(),
    reason: REASON,
  };
}

function priorityFixture(t: TestContext) {
  const f = nodeFixture(t);
  const jobs = new Map<string, { id: string; priority: number }>();
  const updates: Array<{ nodeId: string; priority: number }> = [];
  f.queue.insert = (_tx, nodeId, _projectId, priority) => {
    jobs.set(nodeId, { id: createIdentity("job"), priority });
  };
  f.queue.delete = (_tx, nodeId) => {
    jobs.delete(nodeId);
  };
  f.queue.priorityUpdate = (tx, nodeId, priority) => {
    assert.equal(readNode(tx, nodeId)?.priority, priority);
    updates.push({ nodeId, priority });
    const job = jobs.get(nodeId);
    if (job) jobs.set(nodeId, { ...job, priority });
  };
  const operation = missionOperations["node.priority.set"];
  function set(
    nodeId: string,
    value: number,
    expectedMissionVersion = f.version(),
  ) {
    const input = operation.input.parse({
      params: { nodeId },
      query: {},
      body: { value, expectedMissionVersion },
    });
    return nodeSchema.parse(
      f.registry.get(operation.id).handler(input, f.caller),
    );
  }
  function refuses(
    nodeId: string,
    value: number,
    code: string,
    details: unknown,
    status: number = HttpStatus.Conflict,
    expectedMissionVersion = f.version(),
  ) {
    const before = f.snapshot();
    const beforeJobs = [...jobs];
    const commits = f.commits();
    assert.throws(
      () => set(nodeId, value, expectedMissionVersion),
      (error) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.status, status);
        assert.equal(error.code, code);
        if (details !== undefined) assert.deepEqual(error.details, details);
        return true;
      },
    );
    assert.equal(f.commits(), commits + ONE_COMMIT);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual([...jobs], beforeJobs);
  }
  return { ...f, jobs, updates, operation, set, refuses };
}

test("node.priority.set declares a human POST write with a closed safe-integer input", (t) => {
  const f = priorityFixture(t);
  const op = f.operation;
  assert.equal(op.method, HttpMethod.Post);
  assert.equal(op.path, PRIORITY_PATH);
  assert.equal(op.access, AccessPolicy.Human);
  assert.equal(op.mutation, true);
  const valid = {
    params: { nodeId: UNKNOWN_NODE_ID },
    query: {},
    body: { value: ZERO, expectedMissionVersion: ONE },
  };
  assert.equal(op.input.safeParse(valid).success, true);
  for (const value of [
    0.5,
    "42",
    Number.MAX_SAFE_INTEGER + ONE,
    Number.MIN_SAFE_INTEGER - ONE,
  ]) {
    assert.equal(
      op.input.safeParse({ ...valid, body: { ...valid.body, value } }).success,
      false,
    );
  }
  assert.equal(
    op.input.safeParse({ ...valid, body: { ...valid.body, reason: REASON } })
      .success,
    false,
  );
});

test("node.priority.set reads absent priority as zero and overwrites without revision or version change", (t) => {
  const f = priorityFixture(t);
  const id = f.objective();
  const get = missionOperations["node.get"];
  const input = get.input.parse({
    params: { nodeId: id },
    query: {},
    body: null,
  });
  const initial = nodeSchema.parse(
    f.registry.get(get.id).handler(input, f.caller),
  );
  assert.equal(initial.kind, NodeKind.Objective);
  if (initial.kind !== NodeKind.Objective)
    throw new Error(UNEXPECTED_COLLABORATION);
  assert.equal(initial.priority, ZERO);
  const version = f.version();
  const revisions = f.snapshot().revisions;
  const job = f.jobs.get(id);
  assert.ok(job);
  const commits = f.commits();
  const first = f.set(id, PRIORITY, version);
  assert.equal(f.commits(), commits + ONE_COMMIT);
  assert.equal(first.kind, NodeKind.Objective);
  if (first.kind !== NodeKind.Objective)
    throw new Error(UNEXPECTED_COLLABORATION);
  assert.equal(first.priority, PRIORITY);
  assert.equal(f.jobs.get(id)?.id, job.id);
  assert.equal(f.jobs.get(id)?.priority, PRIORITY);
  const second = f.set(id, NEGATIVE_PRIORITY, version);
  assert.equal(second.kind, NodeKind.Objective);
  if (second.kind !== NodeKind.Objective)
    throw new Error(UNEXPECTED_COLLABORATION);
  assert.equal(second.priority, NEGATIVE_PRIORITY);
  assert.equal(f.node(id)?.priority, NEGATIVE_PRIORITY);
  assert.deepEqual(f.updates, [
    { nodeId: id, priority: PRIORITY },
    { nodeId: id, priority: NEGATIVE_PRIORITY },
  ]);
  assert.deepEqual(f.jobs.get(id), { id: job.id, priority: NEGATIVE_PRIORITY });
  assert.equal(f.version(), version);
  assert.deepEqual(f.snapshot().revisions, revisions);
});

test("node.priority.set accepts both signed limits and zero on initiatives and objectives without a job", (t) => {
  const f = priorityFixture(t);
  const initiative = f.initiative();
  const objective = f.create(f.body(NodeKind.Objective, initiative)).revisions[
    ZERO
  ]!.nodeId;
  const version = f.version();
  for (const [id, value] of [
    [initiative, Number.MIN_SAFE_INTEGER],
    [objective, Number.MAX_SAFE_INTEGER],
    [objective, ZERO],
  ] as const) {
    const answer = f.set(id, value, version);
    assert.equal(answer.kind === NodeKind.Task ? null : answer.priority, value);
    assert.equal(f.node(id)?.priority, value);
  }
  assert.equal(f.jobs.has(initiative), false);
  assert.equal(f.version(), version);
});

test("node.priority.set checks existence, retirement, version, task and terminal in order", (t) => {
  const f = priorityFixture(t);
  const id = f.objective();
  const task = f.create(f.body(NodeKind.Task, id)).revisions[ZERO]!.tasks![
    ZERO
  ]!.id;
  const version = f.version();
  f.refuses(
    UNKNOWN_NODE_ID,
    PRIORITY,
    MissionErrorCode.NodeNotFound,
    undefined,
    HttpStatus.NotFound,
  );
  f.refuses(
    id,
    PRIORITY,
    MissionErrorCode.VersionConflict,
    { current: version },
    HttpStatus.Conflict,
    MISSION_INITIAL_VERSION,
  );
  f.refuses(
    task,
    PRIORITY,
    MissionErrorCode.PriorityTask,
    { nodeId: task },
    HttpStatus.BadRequest,
  );
  f.setState(id, NodeState.Completed);
  f.refuses(id, PRIORITY, MissionErrorCode.Terminal, { nodeId: id });
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, id);
  f.refuses(
    id,
    PRIORITY,
    MissionErrorCode.Retired,
    { nodeId: id },
    HttpStatus.Conflict,
    MISSION_INITIAL_VERSION,
  );
});

test("node.priority.set rolls back its node update if the queue fails", (t) => {
  const f = priorityFixture(t);
  const id = f.initiative();
  f.queue.priorityUpdate = () => {
    throw new Error(UNEXPECTED_COLLABORATION);
  };
  const before = f.snapshot();
  assert.throws(
    () => f.set(id, PRIORITY),
    new RegExp(UNEXPECTED_COLLABORATION),
  );
  assert.deepEqual(f.snapshot(), before);
  assert.equal(f.node(id)?.priority, null);
});

test("node.update no-op and changed objective fields preserve version and write exact revisions", (t) => {
  const f = nodeFixture(t);
  const id = f.objective();
  const body = updateBody(f, id);
  const before = f.snapshot();
  const commits = f.commits();
  const noOp = f.update(id, body);
  assert.equal(f.commits(), commits + ONE_COMMIT);
  assert.deepEqual(noOp, {
    missionVersion: body.expectedMissionVersion,
    revisions: [],
    retiredNodeIds: [],
    addedEdges: [],
    removedEdges: [],
    openAttemptsUnchanged: [],
  });
  assert.deepEqual(f.snapshot(), before);
  const changed = f.update(id, {
    ...body,
    filename: NEW_FILENAME,
    content: { ...body.content, name: "updated" },
  });
  assert.equal(changed.missionVersion, body.expectedMissionVersion + ONE);
  assert.equal(f.node(id)?.filename, NEW_FILENAME);
  assert.equal(changed.revisions[ZERO]?.revision, NEXT_REVISION);
  assert.deepEqual(changed.revisions[ZERO]?.change, {
    write: RevisionWrite.NodeUpdate,
    previousRevision: FIRST_REVISION,
    changedFields: ["filename", "name"],
    tasks: [],
  });
  assert.deepEqual(changed.revisions[ZERO]?.actor, humanActor(f.caller));
  assert.equal(f.version(), changed.missionVersion);
});

test("node.update initiative lists only changed content fields in canonical order", (t) => {
  const f = nodeFixture(t);
  const id = f.initiative();
  const body = updateBody(f, id);
  const changed = f.update(id, {
    ...body,
    content: {
      ...body.content,
      criterion: "new criterion",
      verifications: ["new verification"],
      requirement: "new requirement",
      name: "new name",
      bindings: [STORAGE_NAME],
    },
  });
  assert.deepEqual(changed.revisions[ZERO]?.change, {
    write: RevisionWrite.NodeUpdate,
    previousRevision: FIRST_REVISION,
    changedFields: CONTENT_FIELDS.filter(
      (field) => field !== ContentField.Filename,
    ),
  });
  assert.deepEqual(changed.revisions[ZERO]?.content.bindings, [
    OTHER_BINDING_ID,
  ]);
  assert.equal(changed.revisions[ZERO]?.tasks, undefined);
});

test("node.update task no-op leaves objective revision and mission unchanged", (t) => {
  const f = nodeFixture(t);
  const owner = f.objective();
  const task = f.create(f.body(NodeKind.Task, owner)).revisions[ZERO]!.tasks![
    ZERO
  ]!.id;
  const body = updateBody(f, task);
  const before = f.snapshot();
  const commits = f.commits();
  const answer = f.update(task, body);
  assert.equal(f.commits(), commits + ONE_COMMIT);
  assert.deepEqual(answer, {
    missionVersion: body.expectedMissionVersion,
    revisions: [],
    retiredNodeIds: [],
    addedEdges: [],
    removedEdges: [],
    openAttemptsUnchanged: [],
  });
  assert.deepEqual(f.snapshot(), before);
});

test("node filename store maps unique-index failure to filename conflict", (t) => {
  const f = nodeFixture(t);
  const id = f.initiative();
  f.create({ ...f.body(), filename: OTHER_FILENAME });
  assert.throws(
    () =>
      f.store.transaction((tx) => updateNodeFilename(tx, id, OTHER_FILENAME)),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, MissionErrorCode.FilenameConflict);
      assert.deepEqual(error.details, { filename: OTHER_FILENAME });
      return true;
    },
  );
  assert.equal(f.node(id)?.filename, INITIATIVE_FILENAME);
});

test("node.update task revises only its objective and maps filename conflicts", (t) => {
  const f = nodeFixture(t);
  const objectiveId = f.objective();
  const taskId = f.create(f.body(NodeKind.Task, objectiveId)).revisions[ZERO]!
    .tasks![ZERO]!.id;
  const body = updateBody(f, taskId);
  const commits = f.commits();
  const changed = f.update(taskId, {
    ...body,
    filename: NEW_FILENAME,
    content: { ...body.content, name: "task changed" },
  });
  assert.equal(f.commits(), commits + ONE_COMMIT);
  assert.equal(changed.missionVersion, body.expectedMissionVersion + ONE);
  assert.equal(f.node(taskId)?.filename, NEW_FILENAME);
  assert.equal(changed.revisions[ZERO]?.nodeId, objectiveId);
  assert.equal(changed.revisions[ZERO]?.revision, body.expectedRevision + ONE);
  assert.deepEqual(changed.revisions[ZERO]?.change, {
    write: RevisionWrite.NodeUpdate,
    previousRevision: body.expectedRevision,
    changedFields: [TASKS_FIELD],
    tasks: [
      {
        id: taskId,
        change: TaskChange.Updated,
        changedFields: ["filename", "name"],
      },
    ],
  });
  assert.deepEqual(changed.revisions[ZERO]?.tasks?.[ZERO], {
    id: taskId,
    filename: NEW_FILENAME,
    content: { ...body.content, name: "task changed" },
  });
  assert.equal(
    f.store.transaction((tx) => readCurrentRevision(tx, taskId)),
    null,
  );
  assert.equal(f.version(), changed.missionVersion);
  updateRefuses(
    f,
    taskId,
    { ...updateBody(f, taskId), filename: OBJECTIVE_FILENAME },
    MissionErrorCode.FilenameConflict,
    { filename: OBJECTIVE_FILENAME },
  );
});

function updateRefuses(
  f: ReturnType<typeof nodeFixture>,
  id: string,
  body: NodeUpdate,
  code: string,
  details?: unknown,
  status: number = HttpStatus.Conflict,
): void {
  const before = f.snapshot();
  const commits = f.commits();
  assert.throws(
    () => f.update(id, body),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, status);
      assert.equal(error.code, code);
      if (details !== undefined) assert.deepEqual(error.details, details);
      return true;
    },
  );
  assert.equal(f.commits(), commits + ONE_COMMIT);
  assert.deepEqual(f.snapshot(), before);
}

test("node.update checks existence, retirement, version and revision in order", (t) => {
  const f = nodeFixture(t);
  const id = f.initiative();
  const body = updateBody(f, id);
  updateRefuses(
    f,
    UNKNOWN_NODE_ID,
    body,
    MissionErrorCode.NodeNotFound,
    undefined,
    HttpStatus.NotFound,
  );
  updateRefuses(
    f,
    id,
    { ...body, expectedMissionVersion: FIRST_REVISION },
    MissionErrorCode.VersionConflict,
    { current: body.expectedMissionVersion },
  );
  updateRefuses(
    f,
    id,
    { ...body, expectedRevision: NEXT_REVISION },
    MissionErrorCode.RevisionConflict,
    { current: FIRST_REVISION },
  );
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, id);
  updateRefuses(
    f,
    id,
    { ...body, expectedMissionVersion: FIRST_REVISION },
    MissionErrorCode.Retired,
    { nodeId: id },
  );
});

for (const kind of [NodeKind.Initiative, NodeKind.Objective]) {
  test(`node.update refuses terminal ${kind}`, (t) => {
    const f = nodeFixture(t);
    const id = kind === NodeKind.Initiative ? f.initiative() : f.objective();
    const body = updateBody(f, id);
    f.setState(id, NodeState.Completed);
    updateRefuses(f, id, body, MissionErrorCode.Terminal, { nodeId: id });
  });
}

for (const retired of [false, true]) {
  test(`node.update refuses task with ${retired ? "retired" : "terminal"} objective`, (t) => {
    const f = nodeFixture(t);
    const owner = f.objective();
    const task = f.create(f.body(NodeKind.Task, owner)).revisions[ZERO]!.tasks![
      ZERO
    ]!.id;
    const body = updateBody(f, task);
    if (retired)
      f.store.database
        .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
        .run(RETIRED_AT, owner);
    else f.setState(owner, NodeState.Discarded);
    updateRefuses(
      f,
      task,
      body,
      retired ? MissionErrorCode.Retired : MissionErrorCode.Terminal,
      { nodeId: owner },
    );
  });
}

function criterionBody(
  f: ReturnType<typeof nodeFixture>,
  id: string,
): CriterionSet {
  const update = updateBody(f, id);
  return {
    criterion: update.content.criterion,
    verifications: update.content.verifications,
    reason: REASON,
    expectedRevision: update.expectedRevision,
    expectedMissionVersion: update.expectedMissionVersion,
  };
}

function criterionRefuses(
  f: ReturnType<typeof nodeFixture>,
  id: string,
  body: CriterionSet,
  code: string,
  details?: unknown,
  status: number = HttpStatus.Conflict,
): void {
  const before = f.snapshot();
  const commits = f.commits();
  assert.throws(
    () => f.criterionSet(id, body),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, code);
      assert.equal(error.status, status);
      if (details !== undefined) assert.deepEqual(error.details, details);
      return true;
    },
  );
  assert.equal(f.commits(), commits + ONE_COMMIT);
  assert.deepEqual(f.snapshot(), before);
}

test("criterion.set no-op preserves mission and revision; changed criterion preserves other content", (t) => {
  const f = nodeFixture(t);
  const id = f.objective();
  const body = criterionBody(f, id);
  const before = f.snapshot();
  const commits = f.commits();
  assert.deepEqual(
    f.criterionSet(id, body),
    emptyChange(body.expectedMissionVersion),
  );
  assert.equal(f.commits(), commits + ONE_COMMIT);
  assert.deepEqual(f.snapshot(), before);
  const original = updateBody(f, id);
  const changed = f.criterionSet(id, { ...body, criterion: "new criterion" });
  const revision = changed.revisions[ZERO]!;
  assert.equal(changed.missionVersion, body.expectedMissionVersion + ONE);
  assert.equal(f.version(), changed.missionVersion);
  assert.deepEqual(revision.change, {
    write: RevisionWrite.CriterionSet,
    previousRevision: body.expectedRevision,
    changedFields: [ContentField.Criterion],
    tasks: [],
  });
  assert.equal(revision.filename, original.filename);
  assert.deepEqual(revision.content, {
    ...original.content,
    bindings: [BINDING_ID],
    criterion: "new criterion",
  });
  assert.deepEqual(revision.tasks, []);
});

test("criterion.set initiative changes only criterion and verifications", (t) => {
  const f = nodeFixture(t);
  const id = f.initiative();
  const body = criterionBody(f, id);
  const commits = f.commits();
  const result = f.criterionSet(id, {
    ...body,
    criterion: "new criterion",
    verifications: ["new verification"],
  });
  assert.equal(f.commits(), commits + ONE_COMMIT);
  assert.equal(result.missionVersion, body.expectedMissionVersion + ONE);
  assert.deepEqual(result.revisions[ZERO]!.change, {
    write: RevisionWrite.CriterionSet,
    previousRevision: FIRST_REVISION,
    changedFields: [ContentField.Criterion, ContentField.Verifications],
  });
  assert.equal(result.revisions[ZERO]!.tasks, undefined);
});

test("criterion.set task revises objective only and preserves task metadata", (t) => {
  const f = nodeFixture(t);
  const owner = f.objective();
  const task = f.create(f.body(NodeKind.Task, owner)).revisions[ZERO]!.tasks![
    ZERO
  ]!.id;
  const body = criterionBody(f, task);
  const prior = f.store.transaction((tx) => readCurrentRevision(tx, owner));
  assert.ok(prior);
  const changed = f.criterionSet(task, {
    ...body,
    verifications: ["new verification"],
  });
  const revision = changed.revisions[ZERO]!;
  assert.equal(changed.missionVersion, body.expectedMissionVersion + ONE);
  assert.equal(revision.nodeId, owner);
  assert.equal(revision.revision, prior.revision + ONE);
  assert.deepEqual(revision.change, {
    write: RevisionWrite.CriterionSet,
    previousRevision: prior.revision,
    changedFields: [TASKS_FIELD],
    tasks: [
      {
        id: task,
        change: TaskChange.Updated,
        changedFields: [ContentField.Verifications],
      },
    ],
  });
  assert.equal(revision.filename, prior.filename);
  assert.deepEqual(revision.content.bindings, JSON.parse(prior.bindings));
  assert.deepEqual(revision.tasks![ZERO], {
    id: task,
    filename: TASK_FILENAME,
    content: {
      ...f.body(NodeKind.Task, owner).content,
      verifications: ["new verification"],
    },
  });
  assert.equal(
    f.store.transaction((tx) => readCurrentRevision(tx, task)),
    null,
  );
});

test("criterion.set enforces check order, revisions and content validation", (t) => {
  const f = nodeFixture(t);
  const id = f.objective();
  const task = f.create(f.body(NodeKind.Task, id)).revisions[ZERO]!.tasks![
    ZERO
  ]!.id;
  const body = criterionBody(f, id);
  criterionRefuses(
    f,
    UNKNOWN_NODE_ID,
    body,
    MissionErrorCode.NodeNotFound,
    undefined,
    HttpStatus.NotFound,
  );
  criterionRefuses(
    f,
    id,
    { ...body, expectedMissionVersion: FIRST_REVISION },
    MissionErrorCode.VersionConflict,
    { current: f.version() },
  );
  criterionRefuses(
    f,
    id,
    { ...body, expectedRevision: FIRST_REVISION },
    MissionErrorCode.RevisionConflict,
    { current: NEXT_REVISION },
  );
  assert.equal(
    missionOperations[RevisionWrite.CriterionSet].input.safeParse({
      params: { nodeId: id },
      query: {},
      body: { ...body, verifications: [] },
    }).success,
    false,
  );
  criterionRefuses(
    f,
    id,
    { ...body, verifications: ["   "] },
    MissionErrorCode.ContentInvalid,
    { field: ContentField.Verifications },
    HttpStatus.BadRequest,
  );
  criterionRefuses(
    f,
    id,
    { ...body, criterion: "  " },
    MissionErrorCode.ContentInvalid,
    { field: ContentField.Criterion },
    HttpStatus.BadRequest,
  );
  criterionRefuses(
    f,
    id,
    { ...body, reason: NODE_TEXT.repeat(TEXT_MAX_BYTES) },
    MissionErrorCode.ContentInvalid,
    { field: REASON_FIELD },
    HttpStatus.BadRequest,
  );
  f.setState(id, NodeState.Completed);
  criterionRefuses(f, id, body, MissionErrorCode.Terminal, { nodeId: id });
  criterionRefuses(f, task, criterionBody(f, task), MissionErrorCode.Terminal, {
    nodeId: id,
  });
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, id);
  criterionRefuses(f, task, criterionBody(f, task), MissionErrorCode.Retired, {
    nodeId: id,
  });
  criterionRefuses(f, id, body, MissionErrorCode.Retired, { nodeId: id });
});

test("criterion.set refuses a retired task before stale mission version", (t) => {
  const f = nodeFixture(t);
  const owner = f.objective();
  const task = f.create(f.body(NodeKind.Task, owner)).revisions[ZERO]!.tasks![
    ZERO
  ]!.id;
  const body = criterionBody(f, task);
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, task);
  criterionRefuses(
    f,
    task,
    { ...body, expectedMissionVersion: FIRST_REVISION },
    MissionErrorCode.Retired,
    { nodeId: task },
  );
});

function moveFixture(t: TestContext) {
  const f = dependencyFixture(t);
  function revision(id: string) {
    return (
      f.store.transaction((tx) => readCurrentRevision(tx, id))?.revision ?? ZERO
    );
  }
  function move(
    nodeId: string,
    newParentId: string,
    overrides: Partial<Move> = {},
  ) {
    const oldParentId = f.node(nodeId)?.parent_id;
    const ownerId =
      f.node(nodeId)?.kind === NodeKind.Task ? oldParentId : nodeId;
    const operation = missionOperations[RevisionWrite.NodeMove];
    const input = operation.input.parse({
      params: { nodeId },
      query: {},
      body: {
        newParentId,
        reason: REASON,
        expectedMissionVersion: f.version(),
        expectedRevision: revision(ownerId ?? nodeId),
        expectedOldParentRevision: revision(oldParentId ?? nodeId),
        expectedNewParentRevision: revision(newParentId),
        ...overrides,
      },
    });
    const commits = f.commits();
    try {
      return nodeChangeSchema.parse(
        f.registry.get(operation.id).handler(input, f.caller),
      );
    } finally {
      assert.equal(f.commits(), commits + ONE_COMMIT);
    }
  }
  function refuses(
    nodeId: string,
    parentId: string,
    code: string,
    details?: unknown,
    overrides: Partial<Move> = {},
  ) {
    const before = { ...f.snapshot(), jobs: f.jobs() };
    assert.throws(
      () => move(nodeId, parentId, overrides),
      (error) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.code, code);
        if (details !== undefined) assert.deepEqual(error.details, details);
        return true;
      },
    );
    assert.deepEqual({ ...f.snapshot(), jobs: f.jobs() }, before);
  }
  return { ...f, move, refuses, revision };
}

test("node.move objective changes containment without revisions and reroutes both initiative jobs", (t) => {
  const f = moveFixture(t);
  const oldParent = f.initiative();
  const objective = f.create(f.body(NodeKind.Objective, oldParent)).revisions[
    ZERO
  ]!.nodeId;
  const newParent = f.create({ ...f.body(), filename: OTHER_FILENAME })
    .revisions[ZERO]!.nodeId;
  const dependency = f.create({ ...f.body(), filename: NEW_FILENAME })
    .revisions[ZERO]!.nodeId;
  f.edit(DependencyOperation.Add, newParent, dependency);
  const before = f.snapshot().revisions;
  f.calls.length = ZERO;
  const version = f.version();
  assert.deepEqual(f.move(objective, newParent), {
    ...emptyChange(version + ONE),
    addedEdges: [
      { kind: EdgeKind.Containment, parentId: newParent, childId: objective },
    ],
    removedEdges: [
      { kind: EdgeKind.Containment, parentId: oldParent, childId: objective },
    ],
  });
  assert.equal(f.version(), version + ONE);
  assert.equal(f.node(objective)?.parent_id, newParent);
  assert.equal(f.node(objective)?.state, NodeState.Pending);
  assert.deepEqual(f.snapshot().revisions, before);
  assert.ok(
    f.calls.some(
      (call) => call.action === QueueAction.Delete && call.nodeId === objective,
    ),
  );
  assert.ok(
    f.calls.some(
      (call) => call.action === QueueAction.Insert && call.nodeId === oldParent,
    ),
  );
  f.calls.length = ZERO;
  assert.deepEqual(f.move(objective, newParent), emptyChange(f.version()));
  assert.deepEqual(f.calls, []);
});

test("node.move task revises both owners with exact changes and no-op leaves versions alone", (t) => {
  const f = moveFixture(t);
  const oldParent = f.objective();
  const newParent = f.create({
    ...f.body(NodeKind.Objective, f.node(oldParent)!.parent_id!),
    filename: OTHER_FILENAME,
  }).revisions[ZERO]!.nodeId;
  const task = f.create(f.body(NodeKind.Task, oldParent)).revisions[ZERO]!
    .tasks![ZERO]!.id;
  const version = f.version();
  const result = f.move(task, newParent);
  assert.equal(result.missionVersion, version + ONE);
  assert.equal(result.revisions.length, TWO);
  assert.deepEqual(
    result.revisions.map((item) => item.nodeId),
    [oldParent, newParent],
  );
  assert.deepEqual(
    result.revisions.map((item) => item.change),
    [
      {
        write: RevisionWrite.NodeMove,
        previousRevision: TWO,
        changedFields: [TASKS_FIELD],
        tasks: [{ id: task, change: TaskChange.MovedOut, changedFields: [] }],
      },
      {
        write: RevisionWrite.NodeMove,
        previousRevision: ONE,
        changedFields: [TASKS_FIELD],
        tasks: [
          {
            id: task,
            change: TaskChange.MovedIn,
            changedFields: CONTENT_FIELDS,
          },
        ],
      },
    ],
  );
  assert.deepEqual(
    result.revisions.map((item) => item.tasks?.map((entry) => entry.id)),
    [[], [task]],
  );
  assert.deepEqual(
    result.revisions.map((item) => item.actor),
    [humanActor(f.caller), humanActor(f.caller)],
  );
  assert.deepEqual(result.addedEdges, [
    { kind: EdgeKind.Containment, parentId: newParent, childId: task },
  ]);
  assert.deepEqual(result.removedEdges, [
    { kind: EdgeKind.Containment, parentId: oldParent, childId: task },
  ]);
  assert.equal(f.node(task)?.parent_id, newParent);
  assert.deepEqual(f.move(task, newParent), emptyChange(f.version()));
});

test("node.move checks version, revisions, parents, terminal and retirement before writes", (t) => {
  const f = moveFixture(t);
  const oldParent = f.objective();
  const initiative = f.node(oldParent)!.parent_id!;
  const newParent = f.create({
    ...f.body(NodeKind.Objective, initiative),
    filename: OTHER_FILENAME,
  }).revisions[ZERO]!.nodeId;
  const task = f.create(f.body(NodeKind.Task, oldParent)).revisions[ZERO]!
    .tasks![ZERO]!.id;
  f.refuses(
    task,
    newParent,
    MissionErrorCode.VersionConflict,
    { current: f.version() },
    { expectedMissionVersion: ONE },
  );
  f.refuses(
    task,
    newParent,
    MissionErrorCode.RevisionConflict,
    { current: TWO },
    { expectedRevision: ONE },
  );
  f.refuses(
    task,
    newParent,
    MissionErrorCode.RevisionConflict,
    { current: TWO },
    { expectedOldParentRevision: ONE },
  );
  f.refuses(
    task,
    newParent,
    MissionErrorCode.RevisionConflict,
    { current: ONE },
    { expectedNewParentRevision: TWO },
  );
  f.refuses(task, initiative, MissionErrorCode.CreateRefused, {
    parentId: initiative,
    parentKind: NodeKind.Initiative,
  });
  f.refuses(initiative, newParent, MissionErrorCode.CreateRefused, {
    parentId: newParent,
    parentKind: NodeKind.Objective,
  });
  f.refuses(oldParent, newParent, MissionErrorCode.CreateRefused, {
    parentId: newParent,
    parentKind: NodeKind.Objective,
  });
  f.refuses(task, UNKNOWN_NODE_ID, MissionErrorCode.NodeNotFound, undefined, {
    expectedNewParentRevision: ONE,
  });
  f.setState(newParent, NodeState.Completed);
  f.refuses(task, newParent, MissionErrorCode.Terminal, { nodeId: newParent });
  f.setState(newParent, NodeState.Available);
  f.setState(oldParent, NodeState.Completed);
  f.refuses(task, newParent, MissionErrorCode.Terminal, { nodeId: oldParent });
  f.setState(oldParent, NodeState.Available);
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, newParent);
  f.refuses(task, newParent, MissionErrorCode.Retired, { nodeId: newParent });
});

test("node.move rejects a newly closed dependency cycle and rolls back containment", (t) => {
  const f = moveFixture(t);
  const oldParent = f.initiative();
  const objective = f.create(f.body(NodeKind.Objective, oldParent)).revisions[
    ZERO
  ]!.nodeId;
  const newParent = f.create({ ...f.body(), filename: OTHER_FILENAME })
    .revisions[ZERO]!.nodeId;
  f.edit(DependencyOperation.Add, newParent, objective);
  f.refuses(objective, newParent, MissionErrorCode.Cycle);
});

test("node.move refuses moving an objective under the initiative it depends on", (t) => {
  const f = moveFixture(t);
  const oldParent = f.initiative();
  const objective = f.create(f.body(NodeKind.Objective, oldParent)).revisions[
    ZERO
  ]!.nodeId;
  const newParent = f.create({ ...f.body(), filename: OTHER_FILENAME })
    .revisions[ZERO]!.nodeId;
  f.edit(DependencyOperation.Add, objective, newParent);
  f.refuses(objective, newParent, MissionErrorCode.Cycle);
  assert.equal(f.node(objective)?.parent_id, oldParent);
});

const INVALID_RETIRE_DIGEST = "0".repeat(64);
const RETIRE_QUEUE_FAILURE = "retirement queue failure";
const RETIRE_PREVIEW_PATH = "/api/mission/node/:nodeId/retire/preview";
const RETIRE_PATH = "/api/mission/node/:nodeId/retire";

function retireFixture(t: TestContext) {
  const f = dependencyFixture(t);
  function preview(nodeId: string, query: object = {}): RetirePreview {
    const operation = missionOperations["node.retire.preview"];
    const input = operation.input.parse({
      params: { nodeId },
      query,
      body: null,
    });
    const commits = f.commits();
    try {
      return operation.output.parse(
        f.registry.get(operation.id).handler(input, f.caller),
      );
    } finally {
      assert.equal(f.commits(), commits + ONE_COMMIT);
    }
  }
  function apply(nodeId: string, body: Retire): NodeChange {
    const operation = missionOperations["node.retire"];
    const input = operation.input.parse({
      params: { nodeId },
      query: {},
      body,
    });
    const commits = f.commits();
    try {
      return operation.output.parse(
        f.registry.get(operation.id).handler(input, f.caller),
      );
    } finally {
      assert.equal(f.commits(), commits + ONE_COMMIT);
    }
  }
  function request(plan: RetirePreview): Retire {
    return {
      reason: REASON,
      expectedMissionVersion: plan.missionVersion,
      previewDigest: plan.previewDigest,
      force: plan.force,
    };
  }
  function refuses(
    nodeId: string,
    code: string,
    details?: unknown,
    status: number = HttpStatus.Conflict,
    force = false,
  ) {
    const body: Retire = {
      reason: REASON,
      expectedMissionVersion: f.version(),
      previewDigest: INVALID_RETIRE_DIGEST,
      force,
    };
    const before = { ...f.snapshot(), jobs: f.jobs() };
    for (const invoke of [
      () => preview(nodeId, { force: String(force) }),
      () => apply(nodeId, body),
    ]) {
      assert.throws(invoke, retirementError(code, details, status));
      assert.deepEqual({ ...f.snapshot(), jobs: f.jobs() }, before);
    }
  }
  function task(parentId: string, filename = TASK_FILENAME) {
    const revision = f.store.transaction((tx) =>
      readCurrentRevision(tx, parentId),
    );
    assert.ok(revision);
    const result = f.create({
      ...f.body(NodeKind.Task, parentId),
      filename,
      expectedParentRevision: revision.revision,
    });
    const id = result.revisions[ZERO]!.tasks!.find(
      (item) => item.filename === filename,
    )?.id;
    assert.ok(id);
    return id;
  }
  function get(nodeId: string) {
    const operation = missionOperations["node.get"];
    const input = operation.input.parse({
      params: { nodeId },
      query: {},
      body: null,
    });
    return operation.output.parse(
      f.registry.get(operation.id).handler(input, f.caller),
    );
  }
  return { ...f, preview, apply, request, refuses, task, get };
}

function retirementError(
  code: string,
  details?: unknown,
  status: number = HttpStatus.Conflict,
) {
  return (error: unknown) => {
    assert.ok(error instanceof OperationError);
    assert.equal(error.status, status);
    assert.equal(error.code, code);
    if (details !== undefined) assert.deepEqual(error.details, details);
    return true;
  };
}

test("node.retire operations declare human read preview and write apply with strict force query", (t) => {
  const f = retireFixture(t);
  const id = f.initiative();
  const preview = missionOperations["node.retire.preview"];
  const apply = missionOperations["node.retire"];
  assert.equal(preview.method, HttpMethod.Get);
  assert.equal(preview.path, RETIRE_PREVIEW_PATH);
  assert.equal(preview.access, AccessPolicy.Human);
  assert.equal(preview.mutation, false);
  assert.equal(apply.method, HttpMethod.Post);
  assert.equal(apply.path, RETIRE_PATH);
  assert.equal(apply.access, AccessPolicy.Human);
  assert.equal(apply.mutation, true);
  assert.equal(f.preview(id).force, false);
  assert.equal(f.preview(id, { force: "false" }).force, false);
  assert.equal(f.preview(id, { force: "true" }).force, true);
  for (const force of [
    "",
    "TRUE",
    "False",
    "0",
    "1",
    "yes",
    true,
    false,
    null,
    ["false"],
  ]) {
    assert.equal(
      preview.input.safeParse({
        params: { nodeId: id },
        query: { force },
        body: null,
      }).success,
      false,
    );
  }
});

test("node.retire preview is read-only and hashes precisely the other five fields; apply increments once", (t) => {
  const f = retireFixture(t);
  const id = f.objective();
  const before = { ...f.snapshot(), jobs: f.jobs() };
  const plan = f.preview(id);
  const { previewDigest, ...fields } = plan;
  assert.equal(previewDigest, digest(fields));
  assert.match(previewDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual({ ...f.snapshot(), jobs: f.jobs() }, before);
  const result = f.apply(id, f.request(plan));
  assert.deepEqual(result, {
    ...emptyChange(plan.missionVersion + ONE),
    retiredNodeIds: [id],
  });
  assert.equal(f.version(), plan.missionVersion + ONE);
  assert.deepEqual(f.snapshot().revisions, before.revisions);
  assert.equal(f.snapshot().nodes.length, before.nodes.length);
  assert.equal(f.node(id)?.state, NodeState.Available);
  assert.ok(f.node(id)?.retired_at);
  f.refuses(id, MissionErrorCode.Retired, { nodeId: id });
});

for (const attempt of [ONE, TWO]) {
  test(`node.retire preview and apply refuse attempt ${attempt}`, (t) => {
    const f = retireFixture(t);
    const id = f.objective();
    f.store.database
      .prepare("UPDATE mission_node SET attempt = ? WHERE id = ?")
      .run(attempt, id);
    f.refuses(id, MissionErrorCode.RetireRefused, {
      nodeId: id,
      state: NodeState.Available,
      attempt,
    });
  });
}

for (const state of [
  NodeState.Executing,
  NodeState.Waiting,
  NodeState.Evaluating,
  NodeState.Blocked,
  NodeState.Paused,
  NodeState.Completed,
  NodeState.Discarded,
  NodeState.ExternalRequested,
  NodeState.ExternalSuccess,
  NodeState.ExternalFailed,
]) {
  test(`node.retire preview and apply refuse ${state}, even with force`, (t) => {
    const f = retireFixture(t);
    const id = f.objective();
    f.setState(id, state);
    f.refuses(id, MissionErrorCode.RetireRefused, {
      nodeId: id,
      state,
      attempt: ZERO,
    });
    f.refuses(
      id,
      MissionErrorCode.RetireRefused,
      { nodeId: id, state, attempt: ZERO },
      HttpStatus.Conflict,
      true,
    );
  });
}

test("node.retire checks a task through its objective outside the retirement set", (t) => {
  const f = retireFixture(t);
  const objective = f.objective();
  const task = f.task(objective);
  f.setState(objective, NodeState.Executing);
  f.refuses(task, MissionErrorCode.RetireRefused, {
    nodeId: objective,
    state: NodeState.Executing,
    attempt: ZERO,
  });
  f.setState(objective, NodeState.Available);
  f.store.database
    .prepare("UPDATE mission_node SET attempt = ? WHERE id = ?")
    .run(ONE, objective);
  f.refuses(task, MissionErrorCode.RetireRefused, {
    nodeId: objective,
    state: NodeState.Available,
    attempt: ONE,
  });
});

test("node.retire checks the named node first, then descendants in identity order", (t) => {
  const f = retireFixture(t);
  const first = f.objective();
  const root = f.node(first)!.parent_id!;
  const second = f.create({
    ...f.body(NodeKind.Objective, root),
    filename: OTHER_FILENAME,
  }).revisions[ZERO]!.nodeId;
  f.setState(root, NodeState.Executing);
  f.setState(first, NodeState.Blocked);
  f.setState(second, NodeState.Paused);
  f.refuses(root, MissionErrorCode.RetireRefused, {
    nodeId: root,
    state: NodeState.Executing,
    attempt: ZERO,
  });
  f.setState(root, NodeState.Available);
  const earliest = [first, second].sort()[ZERO]!;
  f.refuses(root, MissionErrorCode.RetireRefused, {
    nodeId: earliest,
    state: f.node(earliest)!.state,
    attempt: ZERO,
  });
});

test("node.retire refuses sorted unique nonterminal dependents without force, including force=false", (t) => {
  const f = retireFixture(t);
  const first = f.objective();
  const root = f.node(first)!.parent_id!;
  const second = f.create({
    ...f.body(NodeKind.Objective, root),
    filename: OTHER_FILENAME,
  }).revisions[ZERO]!.nodeId;
  const dependent = f.create({ ...f.body(), filename: NEW_FILENAME }).revisions[
    ZERO
  ]!.nodeId;
  const another = f.create({ ...f.body(), filename: "another.md" }).revisions[
    ZERO
  ]!.nodeId;
  f.edit(DependencyOperation.Add, dependent, first);
  f.edit(DependencyOperation.Add, dependent, second);
  f.edit(DependencyOperation.Add, another, first);
  f.refuses(root, MissionErrorCode.RetireHasDependents, {
    dependents: [dependent, another].sort(),
  });
  assert.throws(
    () => f.preview(root, { force: "false" }),
    retirementError(MissionErrorCode.RetireHasDependents, {
      dependents: [dependent, another].sort(),
    }),
  );
  const plan = f.preview(root, { force: "true" });
  const expected = [
    { kind: EdgeKind.Dependency, dependentId: dependent, dependsOnId: first },
    { kind: EdgeKind.Dependency, dependentId: dependent, dependsOnId: second },
    { kind: EdgeKind.Dependency, dependentId: another, dependsOnId: first },
  ].sort(
    (a, b) =>
      a.dependentId.localeCompare(b.dependentId) ||
      a.dependsOnId.localeCompare(b.dependsOnId),
  );
  assert.deepEqual(plan.removedEdges, expected);
  const result = f.apply(root, f.request(plan));
  assert.deepEqual(result.removedEdges, expected);
  assert.equal(f.node(dependent)?.state, NodeState.Available);
  assert.equal(f.node(another)?.state, NodeState.Available);
  assert.deepEqual(
    f.jobs().map((job) => job.node_id),
    [dependent, another].sort(),
  );
  assert.deepEqual(f.snapshot().dependencies, []);
});

for (const state of [NodeState.Completed, NodeState.Discarded]) {
  test(`node.retire preserves ${state} dependent history with and without force`, (t) => {
    const f = retireFixture(t);
    const { nodeId, dependsOnId } = f.pair();
    f.edit(DependencyOperation.Add, nodeId, dependsOnId);
    f.setState(nodeId, state);
    const dependencies = f.snapshot().dependencies;
    assert.deepEqual(f.preview(dependsOnId).removedEdges, []);
    const plan = f.preview(dependsOnId, { force: "true" });
    assert.deepEqual(plan.removedEdges, []);
    f.apply(dependsOnId, f.request(plan));
    assert.deepEqual(f.snapshot().dependencies, dependencies);
    assert.equal(f.node(nodeId)?.state, state);
    assert.equal(
      f.jobs().some((job) => job.node_id === nodeId),
      false,
    );
  });
}

test("node.retire covers all current descendants, keeps internal dependencies and deletes all held jobs in its transaction", (t) => {
  const f = retireFixture(t);
  const first = f.objective();
  const root = f.node(first)!.parent_id!;
  const firstTask = f.task(first);
  const oldTask = f.task(first, "old.md");
  f.apply(oldTask, f.request(f.preview(oldTask)));
  const oldRetirement = f.node(oldTask)!.retired_at;
  const second = f.create({
    ...f.body(NodeKind.Objective, root),
    filename: OTHER_FILENAME,
  }).revisions[ZERO]!.nodeId;
  const secondTask = f.task(second, "second-task.md");
  const third = f.create({
    ...f.body(NodeKind.Objective, root),
    filename: NEW_FILENAME,
  }).revisions[ZERO]!.nodeId;
  f.edit(DependencyOperation.Add, third, first);
  const dependencies = f.snapshot().dependencies;
  const jobs = f.jobs().map((job) => job.node_id);
  assert.deepEqual(jobs, [first, second].sort());
  const deleted: string[] = [];
  const remove = f.queue.delete;
  f.queue.delete = (tx, id) => {
    assert.equal(tx.database, f.store.database);
    assert.ok(readNode(tx, id)?.retired_at);
    assert.equal(
      tx.database
        .prepare("SELECT version FROM mission_mission WHERE id = ?")
        .get(f.missionId)?.version,
      plan.missionVersion,
    );
    deleted.push(id);
    remove(tx, id);
  };
  const plan = f.preview(root);
  assert.deepEqual(
    plan.retiredNodeIds,
    [root, first, firstTask, second, secondTask, third].sort(),
  );
  const result = f.apply(root, f.request(plan));
  assert.deepEqual(result.retiredNodeIds, plan.retiredNodeIds);
  assert.equal(result.missionVersion, plan.missionVersion + ONE);
  assert.deepEqual(result.revisions, []);
  assert.deepEqual(result.removedEdges, []);
  assert.deepEqual(deleted.sort(), jobs);
  assert.deepEqual(f.jobs(), []);
  assert.deepEqual(f.snapshot().dependencies, dependencies);
  assert.equal(f.node(oldTask)?.retired_at, oldRetirement);
  const timestamps = new Set(
    plan.retiredNodeIds.map((id) => f.node(id)!.retired_at),
  );
  assert.equal(timestamps.size, ONE);
  assert.ok(!timestamps.has(null));
});

test("node.retire gives the surviving initiative a job only when its last nonterminal objective retires", (t) => {
  const f = retireFixture(t);
  const first = f.objective();
  const root = f.node(first)!.parent_id!;
  const second = f.create({
    ...f.body(NodeKind.Objective, root),
    filename: OTHER_FILENAME,
  }).revisions[ZERO]!.nodeId;
  f.apply(first, f.request(f.preview(first)));
  assert.deepEqual(
    f.jobs().map((job) => job.node_id),
    [second],
  );
  f.calls.length = ZERO;
  f.apply(second, f.request(f.preview(second)));
  assert.deepEqual(
    f.jobs().map((job) => job.node_id),
    [root],
  );
  assert.ok(
    f.calls.some(
      (call) => call.action === QueueAction.Delete && call.nodeId === second,
    ),
  );
  assert.ok(
    f.calls.some(
      (call) => call.action === QueueAction.Insert && call.nodeId === root,
    ),
  );
  assert.equal(f.node(root)?.retired_at, null);
});

test("node.retire task alone revises its objective with retired change and retains readable task history", (t) => {
  const f = retireFixture(t);
  const objective = f.objective();
  const task = f.task(objective);
  const sibling = f.task(objective, OTHER_FILENAME);
  const before = f.get(task);
  const jobs = f.jobs();
  const previous = f.store.transaction((tx) =>
    readCurrentRevision(tx, objective),
  )!;
  const result = f.apply(task, f.request(f.preview(task)));
  assert.deepEqual(result.retiredNodeIds, [task]);
  assert.equal(result.revisions.length, ONE);
  const revision = result.revisions[ZERO]!;
  assert.equal(revision.nodeId, objective);
  assert.equal(revision.revision, previous.revision + ONE);
  assert.equal(revision.reason, REASON);
  assert.deepEqual(revision.actor, humanActor(f.caller));
  assert.deepEqual(
    revision.tasks!.map((item) => item.id),
    [sibling],
  );
  assert.deepEqual(revision.change, {
    write: RevisionWrite.NodeRetire,
    previousRevision: previous.revision,
    changedFields: [TASKS_FIELD],
    tasks: [{ id: task, change: TaskChange.Retired, changedFields: [] }],
  });
  assert.deepEqual(f.jobs(), jobs);
  assert.equal(f.node(objective)?.retired_at, null);
  assert.deepEqual(f.get(task), {
    ...before,
    retiredAt: f.node(task)!.retired_at,
    visibleRevision: revision.revision,
  });
  const operation = missionOperations["node.revision.get"];
  const input = operation.input.parse({
    params: { nodeId: task, revision: previous.revision },
    query: {},
    body: null,
  });
  const historical = operation.output.parse(
    f.registry.get(operation.id).handler(input, f.caller),
  );
  assert.ok(historical.tasks!.some((item) => item.id === task));
});

test("node.retire keeps retired runnable identity, filename, content and revisions readable", (t) => {
  const f = retireFixture(t);
  const id = f.objective();
  const before = f.get(id);
  const revisions = f.snapshot().revisions;
  f.apply(id, f.request(f.preview(id)));
  assert.deepEqual(f.get(id), { ...before, retiredAt: f.node(id)!.retired_at });
  const operation = missionOperations["node.revision.list"];
  const input = operation.input.parse({
    params: { nodeId: id },
    query: {},
    body: null,
  });
  const result = operation.output.parse(
    f.registry.get(operation.id).handler(input, f.caller),
  );
  assert.equal(result.items.length, ONE);
  assert.equal(result.items[ZERO]!.nodeId, id);
  assert.equal(result.items[ZERO]!.filename, before.filename);
  assert.deepEqual(f.snapshot().revisions, revisions);
});

test("node.retire checks existence, retirement, version, reason, admissibility and digest in order", (t) => {
  const f = retireFixture(t);
  f.refuses(
    UNKNOWN_NODE_ID,
    MissionErrorCode.NodeNotFound,
    undefined,
    HttpStatus.NotFound,
  );
  const id = f.objective();
  const plan = f.preview(id);
  const body = f.request(plan);
  const before = { ...f.snapshot(), jobs: f.jobs() };
  assert.throws(
    () => f.apply(id, { ...body, previewDigest: INVALID_RETIRE_DIGEST }),
    retirementError(MissionErrorCode.RetireMismatch),
  );
  assert.deepEqual({ ...f.snapshot(), jobs: f.jobs() }, before);
  f.setState(id, NodeState.Executing);
  assert.throws(
    () =>
      f.apply(id, {
        ...body,
        expectedMissionVersion: MISSION_INITIAL_VERSION,
        reason: "x".repeat(TEXT_MAX_BYTES + ONE),
      }),
    retirementError(MissionErrorCode.VersionConflict, {
      current: plan.missionVersion,
    }),
  );
  assert.throws(
    () => f.apply(id, { ...body, reason: "x".repeat(TEXT_MAX_BYTES + ONE) }),
    retirementError(
      MissionErrorCode.ContentInvalid,
      undefined,
      HttpStatus.BadRequest,
    ),
  );
  assert.throws(
    () => f.apply(id, body),
    retirementError(MissionErrorCode.RetireRefused, {
      nodeId: id,
      state: NodeState.Executing,
      attempt: ZERO,
    }),
  );
  f.setState(id, NodeState.Available);
  f.apply(id, body);
  assert.throws(
    () => f.apply(id, body),
    retirementError(MissionErrorCode.Retired, { nodeId: id }),
  );
});

test("node.retire detects a changed dependency digest even without a mission version change", (t) => {
  const f = retireFixture(t);
  const { nodeId, dependsOnId } = f.pair();
  const plan = f.preview(dependsOnId, { force: "true" });
  f.store.database
    .prepare(
      "INSERT INTO mission_dependency (mission_id, dependent_id, depends_on_id) VALUES (?, ?, ?)",
    )
    .run(f.missionId, nodeId, dependsOnId);
  const before = { ...f.snapshot(), jobs: f.jobs() };
  const changed = f.preview(dependsOnId, { force: "true" });
  assert.equal(changed.missionVersion, plan.missionVersion);
  assert.notEqual(changed.previewDigest, plan.previewDigest);
  assert.throws(
    () => f.apply(dependsOnId, f.request(plan)),
    retirementError(MissionErrorCode.RetireMismatch),
  );
  assert.deepEqual({ ...f.snapshot(), jobs: f.jobs() }, before);
});

test("node.retire digest binds force and mission version", (t) => {
  const f = retireFixture(t);
  const id = f.initiative();
  const plan = f.preview(id);
  assert.notEqual(
    f.preview(id, { force: "true" }).previewDigest,
    plan.previewDigest,
  );
  assert.throws(
    () => f.apply(id, { ...f.request(plan), force: true }),
    retirementError(MissionErrorCode.RetireMismatch),
  );
  f.create({ ...f.body(), filename: OTHER_FILENAME });
  const before = { ...f.snapshot(), jobs: f.jobs() };
  assert.throws(
    () => f.apply(id, f.request(plan)),
    retirementError(MissionErrorCode.VersionConflict, {
      current: plan.missionVersion + ONE,
    }),
  );
  assert.throws(
    () =>
      f.apply(id, {
        ...f.request(plan),
        expectedMissionVersion: plan.missionVersion + ONE,
      }),
    retirementError(MissionErrorCode.RetireMismatch),
  );
  assert.deepEqual({ ...f.snapshot(), jobs: f.jobs() }, before);
});

test("node.retire rolls back retirement, dependency removal, routing and jobs when queue deletion fails", (t) => {
  const f = retireFixture(t);
  const { nodeId, dependsOnId } = f.pair();
  f.edit(DependencyOperation.Add, nodeId, dependsOnId);
  const plan = f.preview(dependsOnId, { force: "true" });
  const before = f.snapshot();
  const jobs = f.jobs();
  const remove = f.queue.delete;
  f.queue.delete = (tx, id) => {
    remove(tx, id);
    throw new Error(RETIRE_QUEUE_FAILURE);
  };
  assert.throws(() => f.apply(dependsOnId, f.request(plan)), {
    message: RETIRE_QUEUE_FAILURE,
  });
  assert.deepEqual(f.snapshot(), { ...before, calls: f.calls });
  assert.deepEqual(f.jobs(), jobs);
});

function importPreviewFixture(t: TestContext) {
  const f = nodeFixture(t);
  const objectiveId = f.objective();
  const entries: ImportEntry[] = f.store.transaction((tx) => {
    const nodes = readMissionNodes(tx, f.missionId);
    const filenames = new Map(nodes.map((node) => [node.id, node.filename]));
    return nodes.map((node) => ({
      id: node.id,
      filename: node.filename,
      kind: node.kind,
      ...nodeRecord(tx, node, bindings).content,
      bindings: node.kind === NodeKind.Objective ? [REPOSITORY_NAME] : [],
      ...(node.parent_id === null
        ? {}
        : { parent: filenames.get(node.parent_id)! }),
    }));
  });
  const snapshot: Extract<
    ImportSnapshot,
    { format: typeof ImportFormat.Json }
  > = {
    format: ImportFormat.Json,
    missionId: f.missionId,
    missionVersion: f.version(),
    reason: REASON,
    entries,
  };
  function preview(body: ImportSnapshot = snapshot, missionId = f.missionId) {
    const operation = missionOperations["import.preview"];
    const input = operation.input.parse({
      params: { missionId },
      query: {},
      body,
    });
    const before = f.snapshot();
    const writes = f.store.database
      .prepare("SELECT total_changes() AS count")
      .get();
    const commits = f.commits();
    const result = importPreviewSchema.parse(
      f.registry.get(operation.id).handler(input, f.caller),
    );
    assert.equal(f.commits(), commits + ONE_COMMIT);
    assert.deepEqual(f.snapshot(), before);
    assert.deepEqual(
      f.store.database.prepare("SELECT total_changes() AS count").get(),
      writes,
    );
    return result;
  }
  function changed(patch: Partial<ImportEntry>): ImportSnapshot {
    return {
      ...snapshot,
      entries: entries.map((entry) =>
        entry.id === objectiveId ? { ...entry, ...patch } : entry,
      ),
    };
  }
  return {
    ...f,
    entries,
    importSnapshot: snapshot,
    objectiveId,
    preview,
    changed,
  };
}

test("import.preview is a human POST with a read-only body, one commit and schema-valid answer", (t) => {
  const f = importPreviewFixture(t);
  const operation = f.registry.get(
    missionOperations["import.preview"].id,
  ).operation;
  assert.equal(operation.access, AccessPolicy.Human);
  assert.equal(operation.method, HttpMethod.Post);
  assert.equal(operation.path, IMPORT_PREVIEW_PATH);
  assert.equal(operation.body, true);
  assert.equal(operation.mutation, false);
  const result = f.preview();
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.noOps, f.entries.map((entry) => entry.id!).sort());
  assert.deepEqual(
    [result.creates, result.updates, result.retirements, result.removedEdges],
    [[], [], [], []],
  );
});

test("import.preview stage one stops before unknown identity and binding resolution", (t) => {
  const f = importPreviewFixture(t);
  const snapshot = f.changed({
    filename: "../invalid.md",
    id: UNKNOWN_NODE_ID,
    bindings: [UNKNOWN_NAME],
  });
  const result = f.preview(snapshot);
  assert.deepEqual(
    result.violations.map((value) => value.code),
    [MissionErrorCode.ContentInvalid],
  );
  assert.deepEqual(
    [
      result.creates,
      result.updates,
      result.retirements,
      result.removedEdges,
      result.noOps,
    ],
    [[], [], [], [], []],
  );
  assert.equal(
    result.previewDigest,
    importDigest(
      f.missionId,
      snapshot.missionVersion,
      normalizeImportSnapshot(snapshot, f.missionId, TEXT_MAX_BYTES).entries,
      [],
    ),
  );
});

test("import.preview malformed Markdown digest omits refused files and does not resolve references", (t) => {
  const f = importPreviewFixture(t);
  const snapshot: ImportSnapshot = {
    missionId: f.missionId,
    missionVersion: f.importSnapshot.missionVersion,
    reason: REASON,
    format: ImportFormat.Markdown,
    files: [{ filename: NEW_FILENAME, content: "not a plan" }],
  };
  const result = f.preview(snapshot);
  assert.deepEqual(
    result.violations.map((value) => value.code),
    [MissionErrorCode.PlanInvalid],
  );
  assert.equal(
    result.previewDigest,
    importDigest(f.missionId, snapshot.missionVersion, [], []),
  );
  assert.deepEqual(result.retirements, []);
});

for (const [label, patch, code] of [
  ["cycle", { dependsOn: [OBJECTIVE_FILENAME] }, MissionErrorCode.Cycle],
  ["unknown identity", { id: UNKNOWN_NODE_ID }, MissionErrorCode.UnknownId],
  [
    "unresolved binding",
    { bindings: [UNKNOWN_NAME] },
    MissionErrorCode.BindingsInvalid,
  ],
] satisfies Array<[string, Partial<ImportEntry>, string]>) {
  test(`import.preview stage two rejects ${label} without running stage three`, (t) => {
    const f = importPreviewFixture(t);
    f.setState(f.objectiveId, NodeState.Completed);
    const result = f.preview(f.changed(patch));
    assert.deepEqual(
      result.violations.map((value) => value.code),
      [code],
    );
    assert.deepEqual(
      [
        result.creates,
        result.updates,
        result.retirements,
        result.removedEdges,
        result.noOps,
      ],
      [[], [], [], [], []],
    );
    if (code === MissionErrorCode.BindingsInvalid)
      assert.deepEqual(result.violations[ZERO]?.details, {
        binding: UNKNOWN_NAME,
      });
  });
}

test("import.preview stage two rejects a retired identity", (t) => {
  const f = importPreviewFixture(t);
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, f.objectiveId);
  const result = f.preview();
  assert.deepEqual(
    result.violations.map((value) => value.code),
    [MissionErrorCode.RetiredId],
  );
  assert.deepEqual(result.violations[ZERO]?.details, { id: f.objectiveId });
});

for (const [state, attempt] of [
  [NodeState.Executing, ZERO],
  [NodeState.Available, ONE],
] as const) {
  test(`import.preview stage three rejects ${state} at attempt ${attempt}`, (t) => {
    const f = importPreviewFixture(t);
    f.store.database
      .prepare("UPDATE mission_node SET state = ?, attempt = ? WHERE id = ?")
      .run(state, attempt, f.objectiveId);
    const result = f.preview(f.changed({ name: "Changed" }));
    assert.deepEqual(result.updates, [f.objectiveId]);
    assert.deepEqual(
      result.violations.map(({ code, nodeId, details }) => ({
        code,
        nodeId,
        details,
      })),
      [
        {
          code: MissionErrorCode.ConditionFailed,
          nodeId: f.objectiveId,
          details: { state, attempt },
        },
      ],
    );
  });
}

test("import.preview terminal noOps are allowed but changes are terminal_change", (t) => {
  const f = importPreviewFixture(t);
  f.setState(f.objectiveId, NodeState.Completed);
  assert.deepEqual(f.preview().violations, []);
  const result = f.preview(f.changed({ name: "Changed" }));
  assert.deepEqual(
    result.violations.map(({ code, nodeId, details }) => ({
      code,
      nodeId,
      details,
    })),
    [
      {
        code: MissionErrorCode.TerminalChange,
        nodeId: f.objectiveId,
        details: { nodeId: f.objectiveId },
      },
    ],
  );
});

test("import.preview checks mission existence, version and reason before stages", (t) => {
  const f = importPreviewFixture(t);
  const invalid = {
    ...f.importSnapshot,
    missionVersion: MISSION_INITIAL_VERSION,
    reason: "x".repeat(TEXT_MAX_BYTES + ONE),
  };
  const before = f.snapshot();
  const commits = f.commits();
  assert.throws(
    () => f.preview(invalid, UNKNOWN_MISSION_ID),
    retirementError(
      MissionErrorCode.MissionNotFound,
      undefined,
      HttpStatus.NotFound,
    ),
  );
  assert.throws(
    () => f.preview(invalid),
    retirementError(MissionErrorCode.VersionConflict, {
      current: f.importSnapshot.missionVersion,
    }),
  );
  assert.throws(
    () =>
      f.preview({
        ...invalid,
        missionVersion: f.importSnapshot.missionVersion,
      }),
    retirementError(
      MissionErrorCode.ContentInvalid,
      { field: "reason" },
      HttpStatus.BadRequest,
    ),
  );
  assert.equal(f.commits(), commits + THREE);
  assert.deepEqual(f.snapshot(), before);
});

test("import.preview empty set retires every current node without writes or queue calls", (t) => {
  const f = importPreviewFixture(t);
  const result = f.preview({ ...f.importSnapshot, entries: [] });
  assert.deepEqual(
    result.retirements,
    f.entries.map((entry) => entry.id!).sort(),
  );
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.removedEdges, [
    {
      kind: EdgeKind.Containment,
      parentId: f.node(f.objectiveId)!.parent_id,
      childId: f.objectiveId,
    },
  ]);
  assert.equal(
    result.previewDigest,
    importDigest(
      f.missionId,
      f.importSnapshot.missionVersion,
      [],
      result.retirements,
    ),
  );
});

test("import.preview equivalent Markdown and JSON plans have identical classifications and digest", (t) => {
  const f = importPreviewFixture(t);
  const entries = [
    ...f.entries.map((entry) =>
      entry.id === f.objectiveId ? { ...entry, name: "Changed" } : entry,
    ),
    {
      ...f.entries.find((entry) => entry.kind === NodeKind.Initiative)!,
      id: undefined,
      filename: NEW_FILENAME,
    },
  ];
  const json = f.preview({ ...f.importSnapshot, entries });
  const markdown = f.preview({
    format: ImportFormat.Markdown,
    missionId: f.missionId,
    missionVersion: f.importSnapshot.missionVersion,
    reason: REASON,
    files: entries.map(
      ({ filename, name, requirement, criterion, ...frontMatter }) => ({
        filename,
        content: `---\n${JSON.stringify(frontMatter)}\n---\n# ${name}\n## Requirement\n${requirement}\n## Criterion\n${criterion}\n`,
      }),
    ),
  });
  assert.deepEqual(markdown, json);
  assert.deepEqual(json.violations, []);
  assert.deepEqual(json.creates, [NEW_FILENAME]);
  assert.deepEqual(json.updates, [f.objectiveId]);
});

const IMPORT_APPLY_PATH = "/api/mission/:missionId/import";
const IMPORT_QUEUE_FAILURE = "import queue insert failed";
const IMPORT_UPDATED_NAME = "Updated imported content";
const IMPORT_EXTRA_TASK = "extra-task.md";
const IMPORT_NEW_TASK = "new-task.md";
const IMPORT_NEW_PARENT = "new-parent.md";
const IMPORT_NODE_COUNT = 4;

function importApplyFixture(
  t: TestContext,
  bindingRevision?: MissionBindings["getBindingRevision"],
  textMaxBytes?: number,
) {
  const f = dependencyFixture(t, bindingRevision, textMaxBytes);
  function entry(
    filename: string,
    kind: NodeKind,
    parent?: string,
  ): ImportEntry {
    return {
      filename,
      kind,
      name: NODE_TEXT,
      requirement: NODE_TEXT,
      criterion: NODE_TEXT,
      verifications: [VERIFICATION],
      bindings: kind === NodeKind.Objective ? [REPOSITORY_NAME] : [],
      ...(parent === undefined ? {} : { parent }),
    };
  }
  const initial = [
    entry(INITIATIVE_FILENAME, NodeKind.Initiative),
    entry(OBJECTIVE_FILENAME, NodeKind.Objective, INITIATIVE_FILENAME),
    {
      ...entry(OTHER_FILENAME, NodeKind.Objective, INITIATIVE_FILENAME),
      dependsOn: [OBJECTIVE_FILENAME],
    },
    entry(TASK_FILENAME, NodeKind.Task, OBJECTIVE_FILENAME),
  ];
  function snapshot(entries: ImportEntry[] = initial): ImportSnapshot {
    return {
      format: ImportFormat.Json,
      missionId: f.missionId,
      missionVersion: f.version(),
      reason: REASON,
      entries,
    };
  }
  function preview(body: ImportSnapshot) {
    const operation = missionOperations["import.preview"];
    return operation.output.parse(
      f.registry.get(operation.id).handler(
        operation.input.parse({
          params: { missionId: f.missionId },
          query: {},
          body,
        }),
        f.caller,
      ),
    );
  }
  function request(body: ImportSnapshot = snapshot()): ImportApply {
    const plan = preview(body);
    assert.deepEqual(plan.violations, []);
    return {
      ...body,
      previewDigest: plan.previewDigest,
      confirmedRetirements: plan.retirements,
    };
  }
  function apply(body: ImportApply, missionId = f.missionId) {
    const operation = missionOperations["import.apply"];
    const input = operation.input.parse({
      params: { missionId },
      query: {},
      body,
    });
    const commits = f.commits();
    try {
      return importResultSchema.parse(
        f.registry.get(operation.id).handler(input, f.caller),
      );
    } finally {
      assert.equal(f.commits(), commits + ONE_COMMIT);
    }
  }
  function identified(
    result: ImportResult,
    entries: ImportEntry[] = initial,
  ): ImportEntry[] {
    const ids = new Map(
      result.assignedIds.map((item) => [item.filename, item.nodeId]),
    );
    return entries.map((item) => {
      const id = ids.get(item.filename);
      assert.ok(id);
      return { ...item, id };
    });
  }
  function state() {
    const { calls, ...rows } = f.snapshot();
    void calls;
    return { ...rows, jobs: f.jobs() };
  }
  return {
    ...f,
    entry,
    initial,
    importSnapshot: snapshot,
    preview,
    request,
    apply,
    identified,
    state,
  };
}

test("import.apply is a human mutation and imports a full graph in one commit and version increment", (t) => {
  const f = importApplyFixture(t);
  const operation = f.registry.get(
    missionOperations["import.apply"].id,
  ).operation;
  assert.equal(operation.method, HttpMethod.Post);
  assert.equal(operation.path, IMPORT_APPLY_PATH);
  assert.equal(operation.access, AccessPolicy.Human);
  assert.equal(operation.mutation, true);
  assert.equal(operation.body, true);
  const body = f.request();
  const result = f.apply(body);
  assert.equal(result.missionVersion, body.missionVersion + ONE);
  assert.equal(result.changes.missionVersion, result.missionVersion);
  assert.equal(f.version(), result.missionVersion);
  assert.equal(result.assignedIds.length, IMPORT_NODE_COUNT);
  assert.deepEqual(
    result.assignedIds.map((item) => item.filename),
    f.initial.map((item) => item.filename).sort(),
  );
  assert.deepEqual(result.actor, humanActor(f.caller));
  assert.ok(result.acceptedAt >= CREATED_AT);
  const ids = new Map(
    result.assignedIds.map((item) => [item.filename, item.nodeId]),
  );
  const objective = ids.get(OBJECTIVE_FILENAME)!;
  const task = ids.get(TASK_FILENAME)!;
  assert.equal(f.node(task)?.parent_id, objective);
  assert.equal(f.node(ids.get(OTHER_FILENAME)!)?.state, NodeState.Pending);
  assert.deepEqual(
    f.jobs().map((job) => job.node_id),
    [objective],
  );
  assert.equal(result.changes.revisions.length, THREE);
  assert.equal(
    f.store.transaction((tx) => readCurrentRevision(tx, task)),
    null,
  );
  const revision = result.changes.revisions.find(
    (item) => item.nodeId === objective,
  )!;
  assert.deepEqual(revision.tasks, [
    {
      id: task,
      filename: TASK_FILENAME,
      content: {
        name: NODE_TEXT,
        requirement: NODE_TEXT,
        criterion: NODE_TEXT,
        verifications: [VERIFICATION],
        bindings: [],
      },
    },
  ]);
  assert.deepEqual(revision.change, {
    write: RevisionWrite.Import,
    previousRevision: null,
    changedFields: [...CONTENT_FIELDS, TASKS_FIELD],
    tasks: [
      {
        id: task,
        change: TaskChange.Created,
        changedFields: [...CONTENT_FIELDS],
      },
    ],
  });
  assert.equal(result.changes.addedEdges.length, IMPORT_NODE_COUNT);
  assert.deepEqual(result.changes.removedEdges, []);
  assert.deepEqual(result.changes.openAttemptsUnchanged, []);
  assert.deepEqual(
    result.changes.revisions.map((item) => item.nodeId),
    result.changes.revisions.map((item) => item.nodeId).sort(),
  );
  for (const revision of result.changes.revisions) {
    assert.equal(revision.revision, FIRST_REVISION);
    assert.equal(revision.change.write, RevisionWrite.Import);
    assert.equal(revision.reason, REASON);
    assert.deepEqual(revision.actor, result.actor);
    assert.equal(revision.createdAt, result.acceptedAt);
  }
});

test("import.apply identical identified set is a no-op with every assigned identity and no database writes", (t) => {
  const f = importApplyFixture(t);
  const first = f.apply(f.request());
  const body = f.request(f.importSnapshot(f.identified(first).reverse()));
  const before = f.state();
  const writes = f.store.database
    .prepare("SELECT total_changes() AS count")
    .get();
  const calls = [...f.calls];
  const result = f.apply(body);
  assert.equal(result.missionVersion, first.missionVersion);
  assert.deepEqual(result.assignedIds, first.assignedIds);
  assert.deepEqual(result.changes, {
    missionVersion: first.missionVersion,
    revisions: [],
    retiredNodeIds: [],
    addedEdges: [],
    removedEdges: [],
    openAttemptsUnchanged: [],
  });
  assert.deepEqual(f.state(), before);
  assert.deepEqual(f.calls, calls);
  assert.deepEqual(
    f.store.database.prepare("SELECT total_changes() AS count").get(),
    writes,
  );
});

test("import.apply stops at the first staged violation before digest checking and preserves its error details", (t) => {
  const f = importApplyFixture(t);
  const snapshot = f.importSnapshot([
    { ...f.initial[ZERO]!, filename: "../invalid.md", id: UNKNOWN_NODE_ID },
    { ...f.initial[ONE]!, bindings: [UNKNOWN_NAME] },
  ]);
  const first = f.preview(snapshot).violations[ZERO]!;
  const before = f.state();
  assert.throws(
    () =>
      f.apply({
        ...snapshot,
        previewDigest: INVALID_RETIRE_DIGEST,
        confirmedRetirements: [],
      }),
    retirementError(
      first.code,
      { field: "filename", filename: first.filename, nodeId: first.nodeId },
      HttpStatus.BadRequest,
    ),
  );
  assert.deepEqual(f.state(), before);
});

for (const [label, patch, code] of [
  ["unknown id", { id: UNKNOWN_NODE_ID }, MissionErrorCode.UnknownId],
  ["binding", { bindings: [UNKNOWN_NAME] }, MissionErrorCode.BindingsInvalid],
  ["reference", { parent: NEW_FILENAME }, MissionErrorCode.UnresolvedReference],
  ["cycle", { dependsOn: [OBJECTIVE_FILENAME] }, MissionErrorCode.Cycle],
] satisfies Array<[string, Partial<ImportEntry>, string]>) {
  test(`import.apply maps resolved ${label} violations to 400 with locators and no effects`, (t) => {
    const f = importApplyFixture(t);
    const snapshot = f.importSnapshot(
      f.initial.map((item) =>
        item.filename === OBJECTIVE_FILENAME ? { ...item, ...patch } : item,
      ),
    );
    const violation = f.preview(snapshot).violations[ZERO]!;
    assert.equal(violation.code, code);
    const before = f.state();
    assert.throws(
      () =>
        f.apply({
          ...snapshot,
          previewDigest: INVALID_RETIRE_DIGEST,
          confirmedRetirements: [],
        }),
      retirementError(
        code,
        {
          ...(violation.details as object),
          filename: violation.filename,
          nodeId: violation.nodeId,
        },
        HttpStatus.BadRequest,
      ),
    );
    assert.deepEqual(f.state(), before);
  });
}

for (const [state, code] of [
  [NodeState.Executing, MissionErrorCode.ConditionFailed],
  [NodeState.Completed, MissionErrorCode.TerminalChange],
] as const) {
  test(`import.apply maps ${state} condition violations to 409 before digest mismatch`, (t) => {
    const f = importApplyFixture(t);
    const first = f.apply(f.request());
    const entries = f.identified(first);
    const objective = entries.find(
      (item) => item.filename === OBJECTIVE_FILENAME,
    )!;
    f.setState(objective.id!, state);
    const snapshot = f.importSnapshot(
      entries.map((item) =>
        item.id === objective.id
          ? { ...item, name: IMPORT_UPDATED_NAME }
          : item,
      ),
    );
    const before = f.state();
    assert.throws(
      () =>
        f.apply({
          ...snapshot,
          previewDigest: INVALID_RETIRE_DIGEST,
          confirmedRetirements: [],
        }),
      retirementError(code, {
        ...(code === MissionErrorCode.ConditionFailed
          ? { state, attempt: ZERO }
          : {}),
        filename: OBJECTIVE_FILENAME,
        nodeId: objective.id,
      }),
    );
    assert.deepEqual(f.state(), before);
  });
}

test("import.apply checks existence then version then reason without changing rows", (t) => {
  const f = importApplyFixture(t);
  const body = f.request();
  f.apply(body);
  const before = f.state();
  const invalid = { ...body, reason: "x".repeat(TEXT_MAX_BYTES + ONE) };
  assert.throws(
    () => f.apply(invalid, UNKNOWN_MISSION_ID),
    retirementError(
      MissionErrorCode.MissionNotFound,
      undefined,
      HttpStatus.NotFound,
    ),
  );
  assert.throws(
    () => f.apply(invalid),
    retirementError(MissionErrorCode.VersionConflict, {
      current: body.missionVersion + ONE,
    }),
  );
  assert.throws(
    () => f.apply({ ...invalid, missionVersion: f.version() }),
    retirementError(
      MissionErrorCode.ContentInvalid,
      { field: "reason" },
      HttpStatus.BadRequest,
    ),
  );
  assert.deepEqual(f.state(), before);
});

test("import.apply refuses changed digest, changed entries and missing or wrong confirmed retirements without effects", (t) => {
  const f = importApplyFixture(t);
  const first = f.apply(f.request());
  const body = f.request(f.importSnapshot([]));
  const before = f.state();
  for (const invalid of [
    { ...body, previewDigest: INVALID_RETIRE_DIGEST },
    { ...body, confirmedRetirements: [] },
    {
      ...body,
      confirmedRetirements: [
        ...body.confirmedRetirements.slice(ONE),
        UNKNOWN_NODE_ID,
      ],
    },
    {
      ...body,
      confirmedRetirements: [...body.confirmedRetirements, UNKNOWN_NODE_ID],
    },
    { ...body, format: ImportFormat.Json, entries: f.identified(first) },
  ]) {
    assert.throws(
      () => f.apply(invalid),
      retirementError(MissionErrorCode.RetirementMismatch),
    );
    assert.deepEqual(f.state(), before);
  }
  const result = f.apply({
    ...body,
    confirmedRetirements: [
      ...body.confirmedRetirements,
      ...body.confirmedRetirements,
    ],
  });
  assert.deepEqual(result.changes.retiredNodeIds, body.confirmedRetirements);
  assert.deepEqual(f.jobs(), []);
});

test("import.apply task rename and move, objective retirement and dependency replacement write import revisions atomically", (t) => {
  const f = importApplyFixture(t);
  const first = f.apply(f.request());
  const entries = f.identified(first);
  const oldObjective = entries.find(
    (item) => item.filename === OBJECTIVE_FILENAME,
  )!.id!;
  const newObjective = entries.find(
    (item) => item.filename === OTHER_FILENAME,
  )!.id!;
  const task = entries.find((item) => item.filename === TASK_FILENAME)!.id!;
  const next = entries
    .filter((item) => item.id !== oldObjective)
    .map((item) => {
      if (item.id === newObjective)
        return {
          ...item,
          dependsOn: [NEW_FILENAME],
          name: IMPORT_UPDATED_NAME,
        };
      if (item.id === task)
        return { ...item, filename: IMPORT_NEW_TASK, parent: OTHER_FILENAME };
      return item;
    });
  next.push(f.entry(NEW_FILENAME, NodeKind.Initiative));
  const body = f.request(f.importSnapshot(next));
  const result = f.apply(body);
  assert.equal(result.missionVersion, first.missionVersion + ONE);
  assert.equal(f.node(oldObjective)?.retired_at, result.acceptedAt);
  assert.equal(f.node(task)?.parent_id, newObjective);
  const oldRevision = result.changes.revisions.find(
    (item) => item.nodeId === oldObjective,
  )!;
  const newRevision = result.changes.revisions.find(
    (item) => item.nodeId === newObjective,
  )!;
  assert.deepEqual(oldRevision.change.tasks, [
    { id: task, change: TaskChange.MovedOut, changedFields: [] },
  ]);
  assert.deepEqual(oldRevision.tasks, []);
  assert.deepEqual(newRevision.change.tasks, [
    {
      id: task,
      change: TaskChange.MovedIn,
      changedFields: [...CONTENT_FIELDS],
    },
  ]);
  assert.deepEqual(newRevision.change.changedFields, [
    ContentField.Name,
    TASKS_FIELD,
  ]);
  assert.equal(newRevision.tasks?.[ZERO]?.filename, IMPORT_NEW_TASK);
  assert.equal(newRevision.revision, NEXT_REVISION);
  assert.ok(
    result.changes.revisions.every(
      (item) => item.change.write === RevisionWrite.Import,
    ),
  );
  assert.deepEqual(result.changes.retiredNodeIds, [oldObjective]);
  const removedContainment = [
    {
      kind: EdgeKind.Containment,
      parentId: entries.find((item) => item.kind === NodeKind.Initiative)!.id!,
      childId: oldObjective,
    },
    { kind: EdgeKind.Containment, parentId: oldObjective, childId: task },
  ].sort(
    (a, b) =>
      a.parentId.localeCompare(b.parentId) ||
      a.childId.localeCompare(b.childId),
  );
  assert.deepEqual(result.changes.removedEdges, [
    ...removedContainment,
    {
      kind: EdgeKind.Dependency,
      dependentId: newObjective,
      dependsOnId: oldObjective,
    },
  ]);
  const created = result.assignedIds.find(
    (item) => item.filename === NEW_FILENAME,
  )!.nodeId;
  assert.deepEqual(
    f.jobs().map((job) => job.node_id),
    [created],
  );
  assert.equal(f.node(newObjective)?.state, NodeState.Pending);
  assert.deepEqual(
    f.state().dependencies.map((edge) => ({ ...edge })),
    [
      {
        mission_id: f.missionId,
        dependent_id: newObjective,
        depends_on_id: created,
      },
    ],
  );
});

test("import.apply retains stored task order, appends creates in set order and coalesces all task changes into one objective revision", (t) => {
  const f = importApplyFixture(t);
  const initial = [
    ...f.initial,
    f.entry(IMPORT_EXTRA_TASK, NodeKind.Task, OBJECTIVE_FILENAME),
  ];
  const first = f.apply(f.request(f.importSnapshot(initial)));
  const entries = f.identified(first, initial);
  const originalTask = entries.find((item) => item.filename === TASK_FILENAME)!;
  const retiredTask = entries.find(
    (item) => item.filename === IMPORT_EXTRA_TASK,
  )!;
  const next = [
    f.entry(IMPORT_NEW_TASK, NodeKind.Task, OBJECTIVE_FILENAME),
    ...entries
      .filter((item) => item.id !== retiredTask.id)
      .reverse()
      .map((item) =>
        item.id === originalTask.id
          ? { ...item, filename: NEW_FILENAME, name: IMPORT_UPDATED_NAME }
          : item,
      ),
    f.entry(IMPORT_EXTRA_TASK, NodeKind.Task, OBJECTIVE_FILENAME),
  ];
  const result = f.apply(f.request(f.importSnapshot(next)));
  assert.equal(result.changes.revisions.length, ONE);
  const revision = result.changes.revisions[ZERO]!;
  assert.deepEqual(
    revision.tasks?.map((item) => item.filename),
    [NEW_FILENAME, IMPORT_NEW_TASK, IMPORT_EXTRA_TASK],
  );
  assert.deepEqual(revision.change.changedFields, [TASKS_FIELD]);
  assert.deepEqual(revision.change.tasks?.slice(ZERO, TWO), [
    {
      id: originalTask.id,
      change: TaskChange.Updated,
      changedFields: [ContentField.Filename, ContentField.Name],
    },
    { id: retiredTask.id, change: TaskChange.Retired, changedFields: [] },
  ]);
  assert.ok(
    revision.change.tasks
      ?.slice(TWO)
      .every((item) => item.change === TaskChange.Created),
  );
  assert.equal(
    f.store.transaction((tx) => readCurrentRevision(tx, originalTask.id!)),
    null,
  );
});

test("import.apply same filename without identity retires and replaces the old node before uniqueness is checked", (t) => {
  const f = importApplyFixture(t);
  const first = f.apply(f.request());
  const entries = f.identified(first);
  const old = entries.find((item) => item.filename === OBJECTIVE_FILENAME)!.id!;
  const next = entries.map((item) =>
    item.id === old ? { ...item, id: undefined } : item,
  );
  const result = f.apply(f.request(f.importSnapshot(next)));
  const replacement = result.assignedIds.find(
    (item) => item.filename === OBJECTIVE_FILENAME,
  )!.nodeId;
  assert.notEqual(replacement, old);
  assert.equal(f.node(old)?.retired_at, result.acceptedAt);
  assert.equal(f.node(replacement)?.retired_at, null);
  assert.deepEqual(
    f.jobs().map((job) => job.node_id),
    [replacement],
  );
  assert.deepEqual(result.changes.retiredNodeIds, [old]);
  assert.deepEqual(
    f.store.database.prepare("PRAGMA foreign_key_check").all(),
    [],
  );
});

test("import.apply rolls back every row including jobs after a late queue insertion failure", (t) => {
  const f = importApplyFixture(t);
  const first = f.apply(f.request());
  const entries = f.identified(first);
  const old = entries.find((item) => item.filename === OBJECTIVE_FILENAME)!.id!;
  const next = entries.map((item) => {
    if (item.id === old)
      return { ...item, id: undefined, name: IMPORT_UPDATED_NAME };
    if (item.filename === TASK_FILENAME)
      return { ...item, filename: IMPORT_NEW_TASK };
    return item;
  });
  const body = f.request(f.importSnapshot(next));
  const before = f.state();
  const insert = f.queue.insert;
  f.queue.insert = (tx, id, projectId, priority) => {
    insert(tx, id, projectId, priority);
    assert.equal(readNode(tx, old)?.retired_at !== null, true);
    assert.ok(f.state().revisions.length > before.revisions.length);
    assert.ok(f.state().nodes.length > before.nodes.length);
    throw new Error(IMPORT_QUEUE_FAILURE);
  };
  assert.throws(() => f.apply(body), { message: IMPORT_QUEUE_FAILURE });
  assert.deepEqual(f.state(), before);
  assert.deepEqual(
    f.store.database.prepare("PRAGMA foreign_key_check").all(),
    [],
  );
  f.queue.insert = insert;
  const result = f.apply(body);
  assert.equal(result.missionVersion, first.missionVersion + ONE);
});

test("import.apply handles filename swaps and new parents without transient uniqueness or foreign key failures", (t) => {
  const f = importApplyFixture(t);
  const first = f.apply(f.request());
  const entries = f.identified(first);
  const next = entries.map((item) => {
    if (item.filename === OBJECTIVE_FILENAME)
      return { ...item, filename: OTHER_FILENAME, parent: IMPORT_NEW_PARENT };
    if (item.filename === OTHER_FILENAME)
      return {
        ...item,
        filename: OBJECTIVE_FILENAME,
        dependsOn: [OTHER_FILENAME],
      };
    if (item.kind === NodeKind.Task) return { ...item, parent: OTHER_FILENAME };
    return item;
  });
  next.push(f.entry(IMPORT_NEW_PARENT, NodeKind.Initiative));
  const result = f.apply(f.request(f.importSnapshot(next)));
  const newParent = result.assignedIds.find(
    (item) => item.filename === IMPORT_NEW_PARENT,
  )!.nodeId;
  const moved = entries.find(
    (item) => item.filename === OBJECTIVE_FILENAME,
  )!.id!;
  assert.equal(f.node(moved)?.parent_id, newParent);
  assert.equal(f.node(moved)?.filename, OTHER_FILENAME);
  assert.deepEqual(
    f.store.database.prepare("PRAGMA foreign_key_check").all(),
    [],
  );
  assert.deepEqual(
    f.preview(f.importSnapshot(f.identified(result, next))).updates,
    [],
  );
});

test("import.apply graph-only changes reroute jobs without writing content revisions", (t) => {
  const f = importApplyFixture(t);
  const first = f.apply(f.request());
  const entries = f.identified(first);
  const other = entries.find((item) => item.filename === OTHER_FILENAME)!;
  const objective = entries.find(
    (item) => item.filename === OBJECTIVE_FILENAME,
  )!;
  const before = f.state().revisions;
  const next = entries.map((item) =>
    item.id === other.id ? { ...item, dependsOn: [] } : item,
  );
  const result = f.apply(f.request(f.importSnapshot(next)));
  assert.equal(result.missionVersion, first.missionVersion + ONE);
  assert.deepEqual(result.changes.revisions, []);
  assert.deepEqual(f.state().revisions, before);
  assert.deepEqual(result.changes.addedEdges, []);
  assert.deepEqual(result.changes.removedEdges, [
    {
      kind: EdgeKind.Dependency,
      dependentId: other.id,
      dependsOnId: objective.id,
    },
  ]);
  assert.deepEqual(
    f.jobs().map((job) => job.node_id),
    [objective.id, other.id].sort(),
  );
});

test("import.apply permits terminal no-ops and an empty mission without writes", (t) => {
  const f = importApplyFixture(t);
  const empty = f.apply(f.request(f.importSnapshot([])));
  assert.equal(empty.missionVersion, MISSION_INITIAL_VERSION);
  assert.deepEqual(empty.assignedIds, []);
  const first = f.apply(f.request());
  const entries = f.identified(first);
  const objective = entries.find(
    (item) => item.filename === OBJECTIVE_FILENAME,
  )!;
  f.setState(objective.id!, NodeState.Completed);
  const body = f.request(f.importSnapshot(entries));
  const before = f.state();
  const result = f.apply(body);
  assert.equal(result.missionVersion, first.missionVersion);
  assert.deepEqual(result.changes.revisions, []);
  assert.deepEqual(f.state(), before);
});

test("import.apply Markdown uses the same digest, revisions, graph and no-op behavior as JSON", (t) => {
  const f = importApplyFixture(t);
  function markdown(entries: ImportEntry[]): ImportSnapshot {
    return {
      format: ImportFormat.Markdown,
      missionId: f.missionId,
      missionVersion: f.version(),
      reason: REASON,
      files: entries.map(
        ({ filename, name, requirement, criterion, ...frontMatter }) => ({
          filename,
          content: `---\n${JSON.stringify(frontMatter)}\n---\n# ${name}\n## Requirement\n${requirement}\n## Criterion\n${criterion}\n`,
        }),
      ),
    };
  }
  const body = f.request(markdown(f.initial));
  assert.equal(body.previewDigest, f.request().previewDigest);
  const result = f.apply(body);
  assert.equal(result.assignedIds.length, IMPORT_NODE_COUNT);
  assert.equal(result.changes.revisions.length, THREE);
  assert.equal(f.jobs().length, ONE);
  const entries = f.identified(result);
  const before = f.state();
  const second = f.apply(f.request(markdown(entries)));
  assert.equal(second.missionVersion, result.missionVersion);
  assert.deepEqual(second.assignedIds, result.assignedIds);
  assert.deepEqual(f.state(), before);
});

const EXPORT_PATH = "/api/mission/:missionId/export";

function invokeExport(
  f: ReturnType<typeof importApplyFixture>,
  format: ImportFormat,
  missionId = f.missionId,
): ExportAnswer {
  const operation = missionOperations.export;
  const input = operation.input.parse({
    params: { missionId },
    query: { format },
    body: null,
  });
  const commits = f.commits();
  const answer = exportAnswerSchema.parse(
    f.registry.get(operation.id).handler(input, f.caller),
  );
  assert.equal(f.commits(), commits + ONE_COMMIT);
  return answer;
}

for (const format of [ImportFormat.Json, ImportFormat.Markdown]) {
  test(`mission.export ${format} round-trips through import without writes`, (t) => {
    const f = importApplyFixture(t);
    f.apply(f.request());
    const declaration = missionOperations.export;
    assert.equal(declaration.method, HttpMethod.Get);
    assert.equal(declaration.path, EXPORT_PATH);
    assert.equal(declaration.access, AccessPolicy.Human);
    assert.equal(declaration.mutation, false);
    assert.throws(() =>
      declaration.input.parse({
        params: { missionId: f.missionId },
        query: {},
        body: null,
      }),
    );
    const before = f.state();
    const answer = invokeExport(f, format);
    assert.equal(answer.missionVersion, f.version());
    const payload: ImportSnapshot =
      "entries" in answer
        ? { ...answer, format: ImportFormat.Json, reason: REASON }
        : { ...answer, format: ImportFormat.Markdown, reason: REASON };
    const preview = f.preview(payload);
    assert.deepEqual(preview.violations, []);
    assert.deepEqual(preview.updates, []);
    assert.deepEqual(preview.retirements, []);
    const applied = f.apply({
      ...payload,
      previewDigest: preview.previewDigest,
      confirmedRetirements: [],
    });
    assert.deepEqual(applied.changes.revisions, []);
    assert.equal(applied.missionVersion, answer.missionVersion);
    assert.deepEqual(f.state(), before);
    if ("entries" in answer) {
      assert.deepEqual(
        answer.entries.map((entry) => entry.filename),
        [
          INITIATIVE_FILENAME,
          OBJECTIVE_FILENAME,
          OTHER_FILENAME,
          TASK_FILENAME,
        ],
      );
      const initiative = answer.entries.find(
        (entry) => entry.kind === NodeKind.Initiative,
      )!;
      const objective = answer.entries.find(
        (entry) => entry.filename === OBJECTIVE_FILENAME,
      )!;
      const task = answer.entries.find(
        (entry) => entry.kind === NodeKind.Task,
      )!;
      assert.equal(Object.hasOwn(initiative, "parent"), false);
      assert.deepEqual(initiative.dependsOn, []);
      assert.equal(objective.parent, INITIATIVE_FILENAME);
      assert.deepEqual(objective.bindings, [REPOSITORY_NAME]);
      assert.equal(Object.hasOwn(task, "dependsOn"), false);
      assert.equal(task.parent, OBJECTIVE_FILENAME);
    } else {
      assert.match(
        answer.files.find((file) => file.filename === OBJECTIVE_FILENAME)!
          .content,
        /api-repo/,
      );
      assert.doesNotMatch(
        answer.files.find((file) => file.filename === OBJECTIVE_FILENAME)!
          .content,
        new RegExp(BINDING_ID),
      );
    }
  });
}

test("mission.export excludes retired nodes and refuses an unknown mission", (t) => {
  const f = importApplyFixture(t);
  const result = f.apply(f.request());
  const retired = result.assignedIds.find(
    (item) => item.filename === TASK_FILENAME,
  )!.nodeId;
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, retired);
  for (const format of [ImportFormat.Json, ImportFormat.Markdown]) {
    const answer = invokeExport(f, format);
    const filenames =
      "entries" in answer
        ? answer.entries.map((entry) => entry.filename)
        : answer.files.map((file) => file.filename);
    assert.equal(filenames.includes(TASK_FILENAME), false);
    assert.equal(filenames.length, IMPORT_NODE_COUNT - ONE);
  }
  assert.throws(
    () => invokeExport(f, ImportFormat.Json, UNKNOWN_MISSION_ID),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.NotFound);
      assert.equal(error.code, MissionErrorCode.MissionNotFound);
      return true;
    },
  );
});

test("mission.export refuses a missing pinned binding with a plain error", (t) => {
  const missing: MissionBindings["getBindingRevision"] = () => null;
  const f = importApplyFixture(t, missing);
  f.apply(f.request());
  assert.throws(
    () => invokeExport(f, ImportFormat.Json),
    (error) => {
      assert.ok(error instanceof Error);
      assert.equal(error instanceof OperationError, false);
      assert.match(error.message, /Missing binding revision/);
      return true;
    },
  );
});

const OVERSIZE_REQUIREMENT = "x".repeat(10 * 1024 * 1024);
const LARGE_TEXT_MAX_BYTES = 12 * 1024 * 1024;
test("mission.export enforces the 10 MiB serialized answer bound", (t) => {
  const f = importApplyFixture(t, undefined, LARGE_TEXT_MAX_BYTES);
  const body = f.body();
  body.content.requirement = OVERSIZE_REQUIREMENT;
  f.create(body);
  for (const format of [ImportFormat.Json, ImportFormat.Markdown]) {
    assert.throws(
      () => invokeExport(f, format),
      (error) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.status, HttpStatus.PayloadTooLarge);
        assert.equal(error.code, MissionErrorCode.ExportTooLarge);
        return true;
      },
    );
  }
});

test("serializePlanFile round-trips YAML-special verification strings", () => {
  const entry = exportAnswerSchema.parse({
    missionId: UNKNOWN_MISSION_ID,
    missionVersion: FIRST_REVISION,
    entries: [
      {
        filename: OBJECTIVE_FILENAME,
        id: UNKNOWN_NODE_ID,
        kind: NodeKind.Objective,
        parent: INITIATIVE_FILENAME,
        dependsOn: [],
        bindings: [REPOSITORY_NAME],
        verifications: ["echo key: value", "echo #hash", 'echo "quoted"'],
        name: "Objective",
        requirement: "A requirement",
        criterion: "A criterion",
      },
    ],
  });
  assert.ok("entries" in entry);
  const objective = entry.entries[ZERO]!;
  const parsed = parsePlanFile(
    objective.filename,
    serializePlanFile(objective),
  );
  assert.deepEqual(parsed, objective);
  assert.deepEqual(parsed.verifications, objective.verifications);
});

const REBIND_PATH = "/api/mission/:missionId/rebind";
const NEXT_BINDING_ID = "binding_00000000000000000000000003";
const NEXT_STORAGE_ID = "binding_00000000000000000000000004";
type BindingRevision = NonNullable<
  ReturnType<MissionBindings["getBindingRevision"]>
>;

function rebindFixture(t: TestContext) {
  const table = new Map<string, BindingRevision>(
    [...bindingMap].map(([name, binding]) => [
      binding.bindingId,
      {
        ...binding,
        projectId: PROJECT_ID,
        name,
        revision: FIRST_REVISION,
        tombstone: false,
        disabled: false,
      },
    ]),
  );
  table.set(NEXT_BINDING_ID, {
    ...table.get(BINDING_ID)!,
    bindingId: NEXT_BINDING_ID,
    revision: NEXT_REVISION,
  });
  table.set(NEXT_STORAGE_ID, {
    ...table.get(OTHER_BINDING_ID)!,
    bindingId: NEXT_STORAGE_ID,
    revision: NEXT_REVISION,
  });
  const f = nodeFixture(t, (_tx, id) => table.get(id) ?? null);
  function rebind(overrides: Partial<Rebind> = {}, missionId = f.missionId) {
    const operation = missionOperations[RevisionWrite.NodeRebind];
    const input = operation.input.parse({
      params: { missionId },
      query: {},
      body: {
        bindingId: NEXT_BINDING_ID,
        reason: REASON,
        expectedMissionVersion: f.version(),
        ...overrides,
      },
    });
    const commits = f.commits();
    try {
      return operation.output.parse(
        f.registry.get(operation.id).handler(input, f.caller),
      );
    } finally {
      assert.equal(f.commits(), commits + ONE_COMMIT);
    }
  }
  function refuses(
    overrides: Partial<Rebind>,
    code: string,
    status: number = HttpStatus.Conflict,
    details?: unknown,
    missionId = f.missionId,
  ) {
    const before = f.snapshot();
    assert.throws(
      () => rebind(overrides, missionId),
      (error) => {
        assert.ok(error instanceof OperationError);
        assert.equal(error.code, code);
        assert.equal(error.status, status);
        if (details !== undefined) assert.deepEqual(error.details, details);
        return true;
      },
    );
    assert.deepEqual(f.snapshot(), before);
  }
  return { ...f, table, rebind, refuses };
}

function emptyRebindChange(missionVersion: number): NodeChange {
  return {
    missionVersion,
    revisions: [],
    retiredNodeIds: [],
    addedEdges: [],
    removedEdges: [],
    openAttemptsUnchanged: [],
  };
}

test("mission.node.rebind declares a human write and advances a pin without changing tasks, state or routing", (t) => {
  const f = rebindFixture(t);
  const operation = missionOperations[RevisionWrite.NodeRebind];
  assert.equal(operation.method, HttpMethod.Post);
  assert.equal(operation.path, REBIND_PATH);
  assert.equal(operation.access, AccessPolicy.Human);
  assert.equal(operation.mutation, true);
  assert.equal(operation.body, true);
  const nodeId = f.objective();
  f.create(f.body(NodeKind.Task, nodeId));
  const previous = f.store.transaction((tx) =>
    readCurrentRevision(tx, nodeId),
  )!;
  const before = f.snapshot();
  const version = f.version();
  assert.deepEqual(
    f.store.transaction((tx) => f.mission.liveNodesPinning(tx, BINDING_ID)),
    [nodeId],
  );
  assert.deepEqual(
    f.store.transaction((tx) =>
      f.mission.liveNodesPinning(tx, NEXT_BINDING_ID),
    ),
    [],
  );
  const result = f.rebind({ nodeId });
  assert.equal(result.nodeChange.missionVersion, version + ONE);
  assert.equal(result.nodeChange.revisions.length, ONE);
  const revision = result.nodeChange.revisions[ZERO]!;
  assert.equal(revision.nodeId, nodeId);
  assert.equal(revision.revision, previous.revision + ONE);
  assert.deepEqual(revision.change, {
    write: RevisionWrite.NodeRebind,
    previousRevision: previous.revision,
    changedFields: [ContentField.Bindings],
    tasks: [],
  });
  assert.deepEqual(revision.tasks, JSON.parse(previous.tasks!));
  assert.deepEqual(revision.content, {
    name: previous.name,
    requirement: previous.requirement,
    criterion: previous.criterion,
    verifications: JSON.parse(previous.verifications),
    bindings: [NEXT_BINDING_ID],
  });
  assert.deepEqual(revision.actor, {
    kind: ActorKind.Human,
    account: ACCOUNT_ID,
    name: DISPLAY_NAME,
  });
  assert.equal(revision.reason, REASON);
  assert.deepEqual(revision.pinnedByAttempts, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.nodeChange.openAttemptsUnchanged, []);
  assert.deepEqual(f.snapshot().nodes, before.nodes);
  assert.deepEqual(f.calls, before.calls);
  assert.deepEqual(
    f.store.transaction((tx) => readCurrentRevision(tx, nodeId))?.bindings,
    JSON.stringify([NEXT_BINDING_ID]),
  );
  assert.deepEqual(
    f.store.transaction((tx) => f.mission.liveNodesPinning(tx, BINDING_ID)),
    [],
  );
  assert.deepEqual(
    f.store.transaction((tx) =>
      f.mission.liveNodesPinning(tx, NEXT_BINDING_ID),
    ),
    [nodeId],
  );
  assert.deepEqual(
    f
      .snapshot()
      .revisions.filter(
        (row) => row.node_id === nodeId && row.revision === previous.revision,
      ),
    [previous],
  );
});

test("mission rebind changes initiative and objective once, preserving unrelated pins and objective snapshots", (t) => {
  const f = rebindFixture(t);
  const initiativeBody = f.body();
  initiativeBody.content.bindings = [STORAGE_NAME];
  const initiative = f.create(initiativeBody).revisions[ZERO]!.nodeId;
  const objectiveBody = f.body(NodeKind.Objective, initiative);
  objectiveBody.content.bindings.push(STORAGE_NAME);
  const objective = f.create(objectiveBody).revisions[ZERO]!.nodeId;
  const version = f.version();
  const result = f.rebind({ bindingId: NEXT_STORAGE_ID });
  assert.equal(result.nodeChange.missionVersion, version + ONE);
  assert.equal(result.nodeChange.revisions.length, TWO);
  const initiativeRevision = result.nodeChange.revisions.find(
    (r) => r.nodeId === initiative,
  )!;
  const objectiveRevision = result.nodeChange.revisions.find(
    (r) => r.nodeId === objective,
  )!;
  assert.deepEqual(initiativeRevision.content.bindings, [NEXT_STORAGE_ID]);
  assert.equal(Object.hasOwn(initiativeRevision.change, "tasks"), false);
  assert.equal(Object.hasOwn(initiativeRevision, "tasks"), false);
  assert.deepEqual(objectiveRevision.content.bindings, [
    BINDING_ID,
    NEXT_STORAGE_ID,
  ]);
  assert.deepEqual(objectiveRevision.change.tasks, []);
  assert.deepEqual(objectiveRevision.tasks, []);
  assert.deepEqual(result.skipped, []);
});

test("mission rebind reports only terminal and retired earlier pins and keeps skipped-only acts as no-ops", (t) => {
  const f = rebindFixture(t);
  const parent = f.initiative();
  const conditions = [
    NodeState.Completed,
    NodeState.Discarded,
    NodeState.Available,
  ];
  const expected = conditions.map((state, index) => {
    const body = f.body(NodeKind.Objective, parent);
    body.filename = `node-${index}.md`;
    const nodeId = f.create(body).revisions[ZERO]!.nodeId;
    f.setState(nodeId, state);
    if (state === NodeState.Available)
      f.store.database
        .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
        .run(RETIRED_AT, nodeId);
    return {
      node: f.store.transaction((tx) =>
        nodeRecord(tx, readNode(tx, nodeId)!, bindings),
      ),
      condition:
        state === NodeState.Available
          ? RebindSkipCondition.Retired
          : RebindSkipCondition.Terminal,
    };
  });
  f.setState(parent, NodeState.Completed);
  const before = f.snapshot();
  const result = f.rebind();
  assert.deepEqual(result.nodeChange, emptyRebindChange(f.version()));
  assert.deepEqual(
    result.skipped,
    expected.sort((a, b) => a.node.id.localeCompare(b.node.id)),
  );
  assert.deepEqual(f.snapshot(), before);
  const body = f.body();
  body.filename = NEW_FILENAME;
  const activeParent = f.create(body).revisions[ZERO]!.nodeId;
  const activeBody = f.body(NodeKind.Objective, activeParent);
  activeBody.filename = OTHER_FILENAME;
  const active = f.create(activeBody).revisions[ZERO]!.nodeId;
  const mixed = f.rebind();
  assert.deepEqual(mixed.skipped, expected);
  assert.deepEqual(
    mixed.nodeChange.revisions.map((r) => r.nodeId),
    [active],
  );
});

for (const named of [false, true]) {
  test(`equal target rebind is a no-op with named=${named}`, (t) => {
    const f = rebindFixture(t);
    const nodeId = f.objective();
    f.rebind({ nodeId });
    const version = f.version();
    const before = f.snapshot();
    assert.deepEqual(f.rebind(named ? { nodeId } : {}), {
      nodeChange: emptyRebindChange(version),
      skipped: [],
    });
    assert.deepEqual(f.snapshot(), before);
  });
}

const TargetFailure = {
  Absent: "absent",
  Foreign: "foreign",
  Tombstone: "tombstone",
  Disabled: "disabled",
} as const;
for (const condition of Object.values(TargetFailure)) {
  test(`mission rebind refuses ${condition} target before inspecting candidates`, (t) => {
    const f = rebindFixture(t);
    const target = f.table.get(NEXT_BINDING_ID)!;
    if (condition === TargetFailure.Absent) f.table.delete(NEXT_BINDING_ID);
    if (condition === TargetFailure.Foreign)
      Object.assign(target, {
        projectId: UNKNOWN_PROJECT_ID,
        tombstone: true,
        disabled: true,
      });
    if (condition === TargetFailure.Tombstone)
      Object.assign(target, { tombstone: true, disabled: true });
    if (condition === TargetFailure.Disabled) target.disabled = true;
    const notFound =
      condition === TargetFailure.Absent || condition === TargetFailure.Foreign;
    const code = notFound
      ? MissionErrorCode.BindingNotFound
      : condition === TargetFailure.Tombstone
        ? MissionErrorCode.BindingRemoved
        : MissionErrorCode.BindingDisabled;
    f.refuses(
      { nodeId: UNKNOWN_NODE_ID },
      code,
      notFound ? HttpStatus.NotFound : HttpStatus.Conflict,
    );
  });
}

test("mission rebind validates mission, version and reason before target lookup", (t) => {
  const f = rebindFixture(t);
  f.table.clear();
  f.refuses(
    {},
    MissionErrorCode.MissionNotFound,
    HttpStatus.NotFound,
    undefined,
    UNKNOWN_MISSION_ID,
  );
  f.refuses(
    {
      expectedMissionVersion: NEXT_REVISION,
      reason: "x".repeat(TEXT_MAX_BYTES + ONE),
    },
    MissionErrorCode.VersionConflict,
    HttpStatus.Conflict,
    { current: FIRST_REVISION },
  );
  f.refuses(
    { reason: "x".repeat(TEXT_MAX_BYTES + ONE) },
    MissionErrorCode.ContentInvalid,
    HttpStatus.BadRequest,
    { field: "reason" },
  );
});

for (const condition of Object.values(RebindSkipCondition)) {
  test(`mission rebind refuses a named ${condition} node before binding matching`, (t) => {
    const f = rebindFixture(t);
    const nodeId = f.initiative();
    f.setState(nodeId, NodeState.Completed);
    if (condition === RebindSkipCondition.Retired)
      f.store.database
        .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
        .run(RETIRED_AT, nodeId);
    f.refuses(
      { nodeId },
      condition === RebindSkipCondition.Retired
        ? MissionErrorCode.Retired
        : MissionErrorCode.Terminal,
      HttpStatus.Conflict,
      { nodeId },
    );
  });
}

test("mission rebind refuses missing and foreign named nodes", (t) => {
  const f = rebindFixture(t);
  f.refuses(
    { nodeId: UNKNOWN_NODE_ID },
    MissionErrorCode.NodeNotFound,
    HttpStatus.NotFound,
  );
  const nodeId = f.objective();
  f.store.transaction((tx) =>
    f.mission.createMission(tx, UNKNOWN_PROJECT_ID, HUMAN_ACTOR),
  );
  const foreignMission = f.invoke(UNKNOWN_PROJECT_ID).id;
  f.store.database
    .prepare("UPDATE mission_node SET mission_id = ? WHERE id = ?")
    .run(foreignMission, nodeId);
  f.refuses({ nodeId }, MissionErrorCode.NodeNotFound, HttpStatus.NotFound);
});

for (const kind of [NodeKind.Initiative, NodeKind.Objective, NodeKind.Task]) {
  test(`mission rebind refuses a named ${kind} that pins no matching binding`, (t) => {
    const f = rebindFixture(t);
    let nodeId: string;
    if (kind === NodeKind.Initiative) nodeId = f.initiative();
    else {
      nodeId = f.objective();
      if (kind === NodeKind.Task) {
        const change = f.create(f.body(NodeKind.Task, nodeId));
        nodeId = change.revisions[ZERO]!.tasks![ZERO]!.id;
      }
    }
    const bindingId = NEXT_STORAGE_ID;
    f.refuses(
      { nodeId, bindingId },
      MissionErrorCode.BindingMismatch,
      HttpStatus.Conflict,
      { nodeId, bindingId },
    );
  });
}

const UnmatchedPin = {
  Foreign: "foreign pin",
  Newer: "newer pin",
  Missing: "missing pin",
} as const;
for (const condition of Object.values(UnmatchedPin)) {
  test(`mission rebind ignores a ${condition} and refuses it when named`, (t) => {
    const f = rebindFixture(t);
    const nodeId = f.objective();
    const stored = f.table.get(BINDING_ID)!;
    if (condition === UnmatchedPin.Foreign)
      stored.projectId = UNKNOWN_PROJECT_ID;
    if (condition === UnmatchedPin.Newer) stored.revision = THREE;
    if (condition === UnmatchedPin.Missing) f.table.delete(BINDING_ID);
    const before = f.snapshot();
    assert.deepEqual(f.rebind(), {
      nodeChange: emptyRebindChange(f.version()),
      skipped: [],
    });
    assert.deepEqual(f.snapshot(), before);
    f.refuses(
      { nodeId },
      MissionErrorCode.BindingMismatch,
      HttpStatus.Conflict,
      { nodeId, bindingId: NEXT_BINDING_ID },
    );
  });
}

test("MissionService refuses to restart after stop", async () => {
  const mission = makeService(new HealthRegistry());
  assert.equal(await mission.start(), null);
  assert.equal(await mission.stop(), null);
  const error = await mission.start();
  assert.ok(error instanceof Diagnostic);
  assert.equal(error.code, MISSION_STOPPED_CODE);
  assert.deepEqual(await mission.healthcheck(), {
    operations: HealthStatus.Unavailable,
  });
});
