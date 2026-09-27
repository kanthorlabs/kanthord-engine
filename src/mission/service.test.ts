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
  type NodeCreate,
  type NodeChange,
  type MissionBindings,
  type WorkQueue,
} from "./contract.ts";
import { missionMigrations } from "./migrations.ts";
import { MissionService, humanActor, type Dependencies } from "./service.ts";
import { CONTENT_FIELDS, TASKS_FIELD } from "./content.ts";
import { claimableMap, reconcileMission, routeMission } from "./routing.ts";
import {
  insertNode as insertNodeRow,
  readNode,
  readCurrentRevision,
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
    body,
    initiative,
    objective,
    node,
    setState,
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
