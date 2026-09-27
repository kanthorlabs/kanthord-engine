import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { background } from "../kernel/context.ts";
import { mintHumanIdentity } from "../kernel/caller-mint.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
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
  TaskChange,
  nodeChangeSchema,
  edgeSchema,
  nodeSchema,
  revisionSchema,
  pageOf,
  type NodeCreate,
  type NodeUpdate,
  type Move,
  type NodeChange,
  type MissionBindings,
  type WorkQueue,
} from "./contract.ts";
import { missionMigrations } from "./migrations.ts";
import { MissionService, humanActor, type Dependencies } from "./service.ts";
import { CONTENT_FIELDS, TASKS_FIELD, ContentField } from "./content.ts";
import { claimableMap, reconcileMission, routeMission } from "./routing.ts";
import {
  insertNode as insertNodeRow,
  readNode,
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

type Collaborators = Pick<Dependencies, "bindings" | "workQueue">;

function makeService(
  health: HealthRegistry,
  collaborators: Collaborators = { bindings, workQueue },
): MissionService {
  return new MissionService({
    config: {
      consecutiveLossLimit: CONSECUTIVE_LOSS_LIMIT,
      textMaxBytes: TEXT_MAX_BYTES,
    },
    health,
    ...collaborators,
  });
}

function fixture(t: TestContext, collaborators?: Collaborators) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: MISSION_SERVICE_NAME, migrations: missionMigrations },
  ]);
  return { store, mission: makeService(new HealthRegistry(), collaborators) };
}

function handlerFixture(t: TestContext, collaborators?: Collaborators) {
  const { store, mission } = fixture(t, collaborators);
  const registry = new OperationRegistry();
  mission.declare(registry);
  let commits = 0;
  const caller: CallerContext = {
    identity: mintHumanIdentity(ACCOUNT_ID, DISPLAY_NAME, TOKEN_ID),
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
const PRIORITY = 42;
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

function nodeFixture(t: TestContext) {
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
  const f = handlerFixture(t, {
    workQueue: queue,
    bindings: {
      ...bindings,
      resolveBinding: (_tx, projectId, name) => {
        assert.equal(projectId, PROJECT_ID);
        return bindingMap.get(name) ?? null;
      },
    },
  });
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
      const before = claimableMap(tx, f.missionId);
      routeMission(tx, f.missionId);
      reconcileMission(tx, f.queue, f.missionId, PROJECT_ID, before);
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
  const before = f.store.transaction((tx) => claimableMap(tx, f.missionId));
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
    reconcileMission(tx, f.queue, f.missionId, PROJECT_ID, before);
    const after = claimableMap(tx, f.missionId);
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
    f.store.transaction((tx) => claimableMap(tx, f.missionId)).get(parentId),
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
    const before = claimableMap(tx, f.missionId);
    tx.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(RETIRED_AT, dependency);
    routeMission(tx, f.missionId);
    reconcileMission(tx, f.queue, f.missionId, PROJECT_ID, before);
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

function dependencyFixture(t: TestContext) {
  const f = nodeFixture(t);
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
