import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import pino from "pino";
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
  type ImportNodeEntry,
  type ImportTaskEntry,
  type ImportSnapshot,
  MISSION_IDENTITY_PREFIX,
  MISSION_INITIAL_VERSION,
  MISSION_SERVICE_NAME,
  MissionErrorCode,
  missionOperations,
  NODE_IDENTITY_PREFIX,
  NodeState,
  RevisionWrite,
  Work,
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
  type Node,
  type NodeChange,
  type Retire,
  type RetirePreview,
  type MissionBindings,
  type WorkQueue,
} from "./contract.ts";
import { missionMigrations } from "./migrations.ts";
import { nodeRecord } from "./node-read.ts";
import { getRevision } from "./node-read.ts";
import {
  openAttempt,
  closeAttempt,
  insertEvidence,
  readOpenAttempt,
} from "./record-store.ts";
import { importDigest, normalizeImportSnapshot } from "./import.ts";
import { serializePlanFile } from "./export.ts";
import { parsePlanFile } from "./parser.ts";
import { MissionService, humanActor, type Dependencies } from "./service.ts";
import {
  CONTENT_FIELDS,
  TASKS_FIELD,
  TASK_CONTENT_FIELDS,
  ContentField,
} from "./content.ts";
import { ControlError } from "./control.ts";
import { unexpectedCollaboration } from "./test-support.ts";
import { claimableMap, reconcileMission, routeMission } from "./routing.ts";
import {
  insertDependency,
  insertNode as insertNodeRow,
  readNode,
  readMissionNodes,
  readCurrentRevision,
  updateNodeFilename,
} from "./store.ts";

const UNEXPECTED_COLLABORATION = "unexpected collaboration call";
test("attempt pins survive edits and a rebind keeps the open revision's binding live", (t) => {
  const f = rebindFixture(t);
  const nodeId = f.implement();
  f.store.transaction((tx) =>
    openAttempt(tx, nodeId, FIRST_REVISION, HUMAN_ACTOR, CREATED_AT),
  );
  const result = f.rebind({ node_id: nodeId });
  assert.deepEqual(result.node_change.open_attempts_unchanged, [
    { node_id: nodeId, attempt: FIRST_REVISION },
  ]);
  assert.deepEqual(
    f.store.transaction((tx) => getRevision(tx, nodeId, FIRST_REVISION))
      .pinned_by_attempts,
    [FIRST_REVISION],
  );
  assert.deepEqual(
    f.store.transaction((tx) => getRevision(tx, nodeId, NEXT_REVISION))
      .pinned_by_attempts,
    [],
  );
  assert.deepEqual(
    f.store.transaction((tx) => f.mission.liveNodesPinning(tx, BINDING_ID)),
    [nodeId],
  );
  assert.deepEqual(
    f.store.transaction((tx) =>
      f.mission.liveNodesPinning(tx, NEXT_BINDING_ID),
    ),
    [nodeId],
  );
  f.store.transaction((tx) =>
    closeAttempt(tx, nodeId, FIRST_REVISION, RETIRED_AT),
  );
  assert.deepEqual(
    f.store.transaction((tx) => f.mission.liveNodesPinning(tx, BINDING_ID)),
    [],
  );
});

test("task creation and content edits report the unchanged open content-owner attempt", (t) => {
  const f = nodeFixture(t);
  const nodeId = f.implement();
  f.store.transaction((tx) =>
    openAttempt(tx, nodeId, FIRST_REVISION, HUMAN_ACTOR, CREATED_AT),
  );
  const created = updateBody(f, nodeId);
  created.tasks = [taskWrite()];
  assert.deepEqual(f.update(nodeId, created).open_attempts_unchanged, [
    { node_id: nodeId, attempt: FIRST_REVISION },
  ]);
  const body = updateBody(f, nodeId);
  body.tasks[FIRST_ELEMENT_INDEX]!.content.name = REASON;
  assert.deepEqual(f.update(nodeId, body).open_attempts_unchanged, [
    { node_id: nodeId, attempt: FIRST_REVISION },
  ]);
  assert.equal(
    f.store.transaction((tx) => readOpenAttempt(tx, nodeId))?.node_revision,
    FIRST_REVISION,
  );
});

test("priority refuses a live claim before changing its node or job", (t) => {
  const executionId = createIdentity("execution");
  const f = priorityFixture(t, {
    schedulerClaims: {
      settle: () => assert.fail(),
      revoke: () => assert.fail(),
      liveExecutionOf: () => ({
        execution_id: executionId,
        runtime_identity: "runtime",
        attempt: 1,
        pinned_revision: 1,
      }),
    },
  });
  const nodeId = f.implement();
  f.refuses(nodeId, ACTIVE_PRIORITY, MissionErrorCode.ClaimLive, {
    node_id: nodeId,
    execution_id: executionId,
  });
});

test("dependency admission settles the dependent before testing its live claim", (t) => {
  const executionId = createIdentity("execution");
  let claimed = "";
  const settled = new Set<string>();
  const f = dependencyFixture(t, undefined, undefined, {
    schedulerClaims: {
      revoke: () => assert.fail(),
      settle: (tx, id) => {
        assert.ok(tx.database.isTransaction);
        settled.add(id);
      },
      liveExecutionOf: (_tx, id) => {
        assert.ok(settled.has(id));
        return id === claimed
          ? {
              execution_id: executionId,
              runtime_identity: "runtime",
              attempt: 1,
              pinned_revision: 1,
            }
          : null;
      },
    },
  });
  const parent = f.examine();
  const child = f.create(f.body(Work.Implement)).revisions[FIRST_ELEMENT_INDEX]!
    .node_id;
  const target = f.create({ ...f.body(), filename: OTHER_FILENAME }).revisions[
    FIRST_ELEMENT_INDEX
  ]!.node_id;
  claimed = child;
  f.edit(DependencyOperation.Add, parent, target);
  assert.ok(!settled.has(child));
  claimed = parent;
  f.refuses(
    DependencyOperation.Add,
    parent,
    child,
    MissionErrorCode.ClaimLive,
    {
      node_id: parent,
      execution_id: executionId,
    },
  );
  assert.ok(settled.has(parent));
});

test("queue writes wake after commit and refused graph writes never wake", (t) => {
  const wakes: string[] = [];
  const f = nodeFixture(t, undefined, undefined, {
    wakeup: {
      wake: (projectId) => {
        assert.equal(f.store.database.isTransaction, false);
        wakes.push(projectId);
      },
    },
  });
  const body = f.body();
  const commit = f.caller.commit;
  f.caller.commit = (write) =>
    commit((tx) => {
      const result = write(tx);
      nodeChangeSchema.parse(result);
      return result;
    });
  f.create(body);
  assert.deepEqual(wakes, [PROJECT_ID]);
  const before = [...wakes];
  assert.throws(() => f.create(body));
  assert.deepEqual(wakes, before);
});
const MISSION_STOPPED_CODE = "mission.lifecycle.stopped";
const CONSECUTIVE_FAILURE_LIMIT = 3;
const FURTHER_WORK_LIMIT = 3;
const REWORK_LIMIT = 2;
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
const OLDER_BINDING_ID = "binding_00000000000000000000000004";
const MISSING_BINDING_ID = "binding_00000000000000000000000005";
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
  storageBindingOf: unexpectedCollaboration,
  repositoryPolicyOf() {
    throw new Error(UNEXPECTED_COLLABORATION);
  },
  resolveBinding() {
    throw new Error(UNEXPECTED_COLLABORATION);
  },
  resolveBindingIdentity() {
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
  store: Store,
  collaborators: Collaborators = { bindings, workQueue },
  text_max_bytes = TEXT_MAX_BYTES,
): MissionService {
  return new MissionService({
    store,
    intakeStorage: {
      put: unexpectedCollaboration,
      check: unexpectedCollaboration,
      get: unexpectedCollaboration,
      executionGet: unexpectedCollaboration,
      delete: unexpectedCollaboration,
    },
    intakeCheck: { check: unexpectedCollaboration },
    decoder: { decode: unexpectedCollaboration },
    config: {
      consecutive_failure_limit: CONSECUTIVE_FAILURE_LIMIT,
      further_work_limit: FURTHER_WORK_LIMIT,
      rework_limit: REWORK_LIMIT,
      text_max_bytes,
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
    logger: pino({ enabled: false }),
    ...collaborators,
  });
}

function fixture(
  t: TestContext,
  collaborators?: Collaborators,
  text_max_bytes?: number,
) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: MISSION_SERVICE_NAME, migrations: missionMigrations },
  ]);
  return {
    store,
    mission: makeService(
      new HealthRegistry(),
      store,
      collaborators,
      text_max_bytes,
    ),
  };
}

function handlerFixture(
  t: TestContext,
  collaborators?: Collaborators,
  text_max_bytes?: number,
) {
  const { store, mission } = fixture(t, collaborators, text_max_bytes);
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
      params: { project_id: projectId },
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
  state: string,
  retiredAt: number | null = null,
): string {
  const nodeId = createIdentity(NODE_IDENTITY_PREFIX);
  tx.database
    .prepare(
      `INSERT INTO mission_node
       (id, mission_id, filename, state, attempt, retired_at, created_at)
       VALUES (?, ?, ?, ?, 0, ?, ?)`,
    )
    .run(nodeId, missionId, `${nodeId}.md`, state, retiredAt, CREATED_AT);
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
        verifications, bindings, work, requires, tasks, change, reason, actor,
        created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, '[]', '[]', ?, ?, ?, ?)`,
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
      Work.Implement,
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
    project_id: PROJECT_ID,
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

test("MissionService healthcheck follows lifecycle", async (t) => {
  const health = new HealthRegistry();
  const { store } = fixture(t);
  const mission = makeService(health, store);
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

test("MissionService registers its operations health probe", async (t) => {
  const registry = new HealthRegistry();
  const { store } = fixture(t);
  const mission = makeService(registry, store);
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

const FIRST_ELEMENT_INDEX = 0;
const EMPTY_CALLS = 0;
const NO_ATTEMPT = 0;
const LOWEST_PRIORITY = 0;
const NO_ITEMS = 0;
const VERSION_INCREMENT = 1;
const SINGLE_ITEM = 1;
const ACTIVE_PRIORITY = 1;
const SECOND_ENTRY_INDEX = 1;
const FIRST_ATTEMPT = 1;
const TWO_REVISIONS = 2;
const SECOND_ATTEMPT = 2;
const TWO_VERSION_STEPS = 2;
const TWO_ITEMS = 2;
const TWO_ROUTING_CALLS = 2;
const THIRD_REVISION = 3;
const THREE_COMMITS = 3;
const THREE_REVISIONS = 3;
const REPOSITORY_NAME = "api-repo";
const STORAGE_NAME = "bucket";
const WORKER_NAME = "worker";
const UNKNOWN_NAME = "unknown";
const REASON = "Create planned work";
const VERIFICATION = "true";
const EXAMINE_FILENAME = "examine.md";
const IMPLEMENT_FILENAME = "implement.md";
const TASK_FILENAME = "task.md";
const OTHER_FILENAME = "other.md";
const NEW_FILENAME = "new.md";
const UNKNOWN_NODE_ID = "node_00000000000000000000000000";
const UNKNOWN_MISSION_ID = "mission_00000000000000000000000000";
const IMPORT_PREVIEW_PATH = "/api/mission/:mission_id/import/preview";
const PRIORITY = 42;
const NEGATIVE_PRIORITY = -42;
const PRIORITY_PATH = "/api/mission/node/:node_id/priority";
const QueueAction = { Insert: "insert", Delete: "delete" } as const;
type QueueCall = {
  action: string;
  node_id: string;
  project_id?: string;
  priority?: number;
};
const bindingMap = new Map([
  [
    REPOSITORY_NAME,
    { binding_id: BINDING_ID, resource_identity: "repository:github:o/api" },
  ],
  [
    STORAGE_NAME,
    { binding_id: OTHER_BINDING_ID, resource_identity: "storage:s3:host/b" },
  ],
  [
    WORKER_NAME,
    { binding_id: UNKNOWN_BINDING_ID, resource_identity: "worker:kanthord:w" },
  ],
]);

function nodeFixture(
  t: TestContext,
  bindingRevision: MissionBindings["getBindingRevision"] = (_tx, id) => {
    const match = [...bindingMap.entries()].find(
      ([, value]) => value.binding_id === id,
    );
    return match === undefined
      ? null
      : {
          ...match[1],
          project_id: PROJECT_ID,
          name: match[0],
          revision: FIRST_REVISION,
          tombstone: false,
          disabled: false,
        };
  },
  text_max_bytes?: number,
  collaborators: Partial<Collaborators> = {},
) {
  const calls: QueueCall[] = [];
  const queue: WorkQueue = {
    insert(_tx, nodeId, projectId, priority) {
      calls.push({
        action: QueueAction.Insert,
        node_id: nodeId,
        project_id: projectId,
        priority,
      });
    },
    delete(_tx, nodeId) {
      calls.push({ action: QueueAction.Delete, node_id: nodeId });
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
        resolveBindingIdentity: (_tx, projectId, id) => {
          assert.equal(projectId, PROJECT_ID);
          const latest = id === OLDER_BINDING_ID ? BINDING_ID : id;
          return (
            [...bindingMap.values()].find(
              (value) => value.binding_id === latest,
            ) ?? null
          );
        },
        getBindingRevision: bindingRevision,
      },
      ...collaborators,
    },
    text_max_bytes,
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
      params: { node_id: nodeId },
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
      params: { node_id: nodeId },
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
      params: { mission_id: id },
      query: {},
      body,
    });
    return nodeChangeSchema.parse(
      f.registry.get(operation.id).handler(input, f.caller),
    );
  }
  function body(work: Work = Work.Examine): NodeCreate {
    return {
      filename: work === Work.Examine ? EXAMINE_FILENAME : IMPLEMENT_FILENAME,
      content: {
        name: NODE_TEXT,
        requirement: NODE_TEXT,
        criterion: NODE_TEXT,
        verifications: [VERIFICATION],
        bindings: work === Work.Implement ? [BINDING_ID] : [],
        work,
        requires: [],
      },
      tasks: [],
      reason: REASON,
      expected_mission_version: version(),
    };
  }
  function examine() {
    return create(body()).revisions[FIRST_ELEMENT_INDEX]!.node_id;
  }
  function implement() {
    return create(body(Work.Implement)).revisions[FIRST_ELEMENT_INDEX]!.node_id;
  }
  function node(id: string) {
    return f.store.transaction((tx) => readNode(tx, id));
  }
  function read(nodeId: string) {
    const operation = missionOperations["node.get"];
    const input = operation.input.parse({
      params: { node_id: nodeId },
      query: {},
      body: null,
    });
    return nodeSchema.parse(
      f.registry.get(operation.id).handler(input, f.caller),
    );
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
    mission_id: missionId,
    calls,
    queue,
    version,
    create,
    update,
    criterionSet,
    body,
    examine,
    implement,
    node,
    read,
    setState,
    snapshot,
    refuses,
  };
}

test("node.create of an examine node stores human attribution, pins, revision one and one version increment in one commit", (t) => {
  const f = nodeFixture(t);
  const body = f.body();
  body.content.bindings = [OTHER_BINDING_ID];
  const commits = f.commits();
  const result = f.create(body);
  assert.equal(f.commits(), commits + ONE_COMMIT);
  assert.equal(
    result.mission_version,
    MISSION_INITIAL_VERSION + VERSION_INCREMENT,
  );
  assert.equal(f.version(), result.mission_version);
  const revision = result.revisions[FIRST_ELEMENT_INDEX]!;
  assert.deepEqual(result, {
    mission_version: NEXT_REVISION,
    revisions: [revision],
    retired_node_ids: [],
    added_edges: [],
    removed_edges: [],
    open_attempts_unchanged: [],
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
    previous_revision: null,
    changed_fields: [...CONTENT_FIELDS, TASKS_FIELD],
    tasks: [],
  });
  assert.deepEqual(revision.tasks, []);
  assert.equal(f.node(revision.node_id)?.state, NodeState.Available);
  assert.equal(f.node(revision.node_id)?.attempt, NO_ATTEMPT);
  assert.equal(f.node(revision.node_id)?.priority, null);
  assert.deepEqual(f.calls, [
    {
      action: QueueAction.Insert,
      node_id: revision.node_id,
      project_id: PROJECT_ID,
      priority: LOWEST_PRIORITY,
    },
  ]);
  const stored = f.store.transaction((tx) =>
    readCurrentRevision(tx, revision.node_id),
  );
  assert.ok(stored);
  assert.deepEqual(JSON.parse(stored.actor), humanActor(f.caller));
  assert.deepEqual(JSON.parse(stored.tasks), []);
});

test("node.create of an implement node routes Available and queues it", (t) => {
  const f = nodeFixture(t);
  f.examine();
  f.calls.length = EMPTY_CALLS;
  const result = f.create(f.body(Work.Implement));
  const revision = result.revisions[FIRST_ELEMENT_INDEX]!;
  assert.equal(result.mission_version, THIRD_REVISION);
  assert.equal(f.node(revision.node_id)?.state, NodeState.Available);
  assert.deepEqual(revision.content.bindings, [BINDING_ID]);
  assert.equal(revision.content.work, Work.Implement);
  assert.deepEqual(revision.content.requires, []);
  assert.deepEqual(revision.tasks, []);
  assert.deepEqual(revision.change, {
    write: RevisionWrite.NodeCreate,
    previous_revision: null,
    changed_fields: [...CONTENT_FIELDS, TASKS_FIELD],
    tasks: [],
  });
  assert.deepEqual(result.added_edges, []);
  assert.deepEqual(f.calls, [
    {
      action: QueueAction.Insert,
      node_id: revision.node_id,
      project_id: PROJECT_ID,
      priority: LOWEST_PRIORITY,
    },
  ]);
});

test("node create mints a task identity for each task and writes it in revision 1", (t) => {
  const f = nodeFixture(t);
  f.calls.length = EMPTY_CALLS;
  const body = {
    ...f.body(Work.Implement),
    tasks: [taskWrite(), taskWrite(NEW_FILENAME)],
  };
  const result = f.create(body);
  const revision = result.revisions[FIRST_ELEMENT_INDEX]!;
  assert.equal(revision.revision, FIRST_REVISION);
  assert.equal(revision.tasks.length, TWO_ITEMS);
  for (const [index, task] of revision.tasks.entries()) {
    assert.ok(identitySchema("task").safeParse(task.id).success);
    assert.deepEqual(task, { id: task.id, ...body.tasks[index] });
  }
  assert.deepEqual(revision.change, {
    write: RevisionWrite.NodeCreate,
    previous_revision: null,
    changed_fields: [...CONTENT_FIELDS, TASKS_FIELD],
    tasks: revision.tasks.map((task) => ({
      id: task.id,
      change: TaskChange.Created,
      changed_fields: TASK_CONTENT_FIELDS,
    })),
  });
  assert.deepEqual(result.added_edges, []);
  for (const task of revision.tasks) assert.equal(f.node(task.id), null);
  assert.deepEqual(f.read(revision.node_id).tasks, revision.tasks);
});

test("node create refuses a named task, a task of an examine node and a used task filename", (t) => {
  const f = nodeFixture(t);
  f.examine();
  f.refuses(
    {
      ...f.body(Work.Implement),
      tasks: [{ ...taskWrite(), id: createIdentity("task") }],
    },
    MissionErrorCode.ContentInvalid,
    { field: TASKS_FIELD },
    HttpStatus.BadRequest,
  );
  f.refuses(
    { ...f.body(), filename: OTHER_FILENAME, tasks: [taskWrite()] },
    MissionErrorCode.ContentInvalid,
    { field: TASKS_FIELD },
    HttpStatus.BadRequest,
  );
  f.refuses(
    {
      ...f.body(Work.Implement),
      tasks: [taskWrite(EXAMINE_FILENAME)],
    },
    MissionErrorCode.FilenameConflict,
    { filename: EXAMINE_FILENAME },
  );
  f.refuses(
    {
      ...f.body(Work.Implement),
      tasks: [taskWrite(), taskWrite()],
    },
    MissionErrorCode.FilenameConflict,
    { filename: TASK_FILENAME },
  );
  f.create({
    ...f.body(Work.Implement),
    tasks: [taskWrite()],
  });
  f.refuses(
    {
      ...f.body(Work.Implement),
      filename: NEW_FILENAME,
      tasks: [taskWrite()],
    },
    MissionErrorCode.FilenameConflict,
    { filename: TASK_FILENAME },
  );
  f.refuses(
    {
      ...f.body(Work.Implement),
      filename: TASK_FILENAME,
    },
    MissionErrorCode.FilenameConflict,
    { filename: TASK_FILENAME },
  );
  f.refuses(
    {
      ...f.body(Work.Implement),
      filename: NEW_FILENAME,
      tasks: [boundTaskWrite(OTHER_FILENAME)],
    },
    MissionErrorCode.BindingsInvalid,
    { filename: OTHER_FILENAME },
    HttpStatus.BadRequest,
  );
});

test("node.create validates mission existence and version before content", (t) => {
  const f = nodeFixture(t);
  f.refuses(
    f.body(),
    MissionErrorCode.MissionNotFound,
    undefined,
    HttpStatus.NotFound,
    UNKNOWN_MISSION_ID,
  );
  f.examine();
  f.refuses(
    { ...f.body(Work.Implement), expected_mission_version: FIRST_REVISION },
    MissionErrorCode.VersionConflict,
    { current: NEXT_REVISION },
  );
});

test("node.create refuses active filename reuse but accepts retired filename reuse", (t) => {
  const f = nodeFixture(t);
  const id = f.examine();
  f.refuses(f.body(), MissionErrorCode.FilenameConflict, {
    filename: EXAMINE_FILENAME,
  });
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, id);
  const result = f.create(f.body());
  assert.notEqual(result.revisions[FIRST_ELEMENT_INDEX]!.node_id, id);
  assert.equal(
    result.revisions[FIRST_ELEMENT_INDEX]!.filename,
    EXAMINE_FILENAME,
  );
});

test("node insert translates only the active filename unique constraint", (t) => {
  const f = nodeFixture(t);
  const id = f.examine();
  const before = f.version();
  assert.throws(
    () =>
      f.store.transaction((tx) =>
        insertNodeRow(tx, {
          id: createIdentity(NODE_IDENTITY_PREFIX),
          mission_id: f.mission_id,
          filename: EXAMINE_FILENAME,
          created_at: CREATED_AT,
        }),
      ),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, MissionErrorCode.FilenameConflict);
      assert.deepEqual(error.details, { filename: EXAMINE_FILENAME });
      return true;
    },
  );
  assert.throws(
    () =>
      f.store.transaction((tx) =>
        insertNodeRow(tx, {
          id,
          mission_id: f.mission_id,
          filename: OTHER_FILENAME,
          created_at: CREATED_AT,
        }),
      ),
    (error) => error instanceof Error && !(error instanceof OperationError),
  );
  assert.equal(f.version(), before);
});

for (const binding of [MISSING_BINDING_ID, STORAGE_NAME]) {
  test(`node.create refuses the unresolved binding identity ${binding} before filename conflicts`, (t) => {
    const f = nodeFixture(t);
    f.examine();
    const body = f.body();
    body.content.bindings = [binding];
    f.refuses(
      body,
      MissionErrorCode.BindingsInvalid,
      { binding },
      HttpStatus.BadRequest,
    );
  });
}

test("node.create pins the latest revision for an older binding revision identity", (t) => {
  const f = nodeFixture(t);
  const body = f.body(Work.Implement);
  body.content.bindings = [OLDER_BINDING_ID];
  const revision = f.create(body).revisions[FIRST_ELEMENT_INDEX]!;
  assert.deepEqual(revision.content.bindings, [BINDING_ID]);
  assert.deepEqual(f.read(revision.node_id).content.bindings, [BINDING_ID]);
});

for (const kind of Object.values(Work)) {
  test(`node.create of an ${kind} node enforces the binding rule table`, (t) => {
    const f = nodeFixture(t);
    const body = f.body(kind);
    body.content.bindings = [UNKNOWN_BINDING_ID];
    f.refuses(
      body,
      MissionErrorCode.BindingsInvalid,
      undefined,
      HttpStatus.BadRequest,
    );
    if (kind === Work.Examine) {
      body.content.bindings = [BINDING_ID];
      assert.deepEqual(
        f.create(body).revisions[FIRST_ELEMENT_INDEX]!.content.bindings,
        [BINDING_ID],
      );
      return;
    }
    body.content.bindings = [];
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
  const parentId = f.examine();
  const dependency = f.create({ ...f.body(), filename: OTHER_FILENAME })
    .revisions[FIRST_ELEMENT_INDEX]!.node_id;
  const implement = f.create(f.body(Work.Implement)).revisions[
    FIRST_ELEMENT_INDEX
  ]!.node_id;
  f.store.database
    .prepare(
      "INSERT INTO mission_dependency (dependent_id, depends_on_id, mission_id) VALUES (?, ?, ?)",
    )
    .run(implement, dependency, f.mission_id);
  f.store.database
    .prepare("UPDATE mission_node SET priority = ? WHERE id = ?")
    .run(PRIORITY, implement);
  function route() {
    f.store.transaction((tx) => {
      const before = claimableMap(tx, f.mission_id, bindings);
      routeMission(tx, f.mission_id);
      reconcileMission(tx, f.queue, f.mission_id, PROJECT_ID, before, bindings);
    });
  }
  f.setState(dependency, NodeState.Discarded);
  route();
  assert.equal(f.node(implement)?.state, NodeState.Pending);
  f.calls.length = EMPTY_CALLS;
  f.setState(dependency, NodeState.Completed);
  route();
  assert.equal(f.node(implement)?.state, NodeState.Available);
  assert.deepEqual(f.calls, [
    {
      action: QueueAction.Insert,
      node_id: implement,
      project_id: PROJECT_ID,
      priority: PRIORITY,
    },
  ]);
  f.calls.length = EMPTY_CALLS;
  route();
  assert.deepEqual(f.calls, []);
  f.setState(implement, NodeState.Executing);
  f.setState(dependency, NodeState.Pending);
  route();
  assert.equal(f.node(implement)?.state, NodeState.Executing);
  assert.equal(f.node(parentId)?.state, NodeState.Available);
});

test("shared routing ignores dependency edges with a retired endpoint", (t) => {
  const f = nodeFixture(t);
  const implement = f.implement();
  const dependency = f.create({ ...f.body(), filename: OTHER_FILENAME })
    .revisions[FIRST_ELEMENT_INDEX]!.node_id;
  f.store.transaction((tx) => {
    insertDependency(tx, f.mission_id, implement, dependency);
    routeMission(tx, f.mission_id);
  });
  assert.equal(f.node(implement)?.state, NodeState.Pending);
  f.calls.length = EMPTY_CALLS;
  f.store.transaction((tx) => {
    const before = claimableMap(tx, f.mission_id, bindings);
    tx.database
      .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
      .run(RETIRED_AT, dependency);
    routeMission(tx, f.mission_id);
    reconcileMission(tx, f.queue, f.mission_id, PROJECT_ID, before, bindings);
  });
  assert.equal(f.node(implement)?.state, NodeState.Available);
  assert.equal(f.calls.length, TWO_ROUTING_CALLS);
  assert.ok(
    f.calls.some(
      (call) =>
        call.action === QueueAction.Delete && call.node_id === dependency,
    ),
  );
  assert.ok(
    f.calls.some(
      (call) =>
        call.action === QueueAction.Insert && call.node_id === implement,
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

test("node get answers the tasks of the visible revision", (t) => {
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
  const examine = f.examine();
  const implement = f.create(f.body(Work.Implement)).revisions[
    FIRST_ELEMENT_INDEX
  ]!.node_id;
  const taskId = addTask(f, implement);
  const implementNode = nodeSchema.parse(
    invoke("node.get", { node_id: implement }),
  );
  assert.equal(implementNode.work, Work.Implement);
  assert.deepEqual(implementNode.requires, []);
  assert.equal(implementNode.visible_revision, NEXT_REVISION);
  assert.deepEqual(implementNode.tasks, [{ id: taskId, ...taskWrite() }]);
  assert.equal(implementNode.priority, LOWEST_PRIORITY);
  assert.deepEqual(implementNode.content.bindings, [BINDING_ID]);
  assert.deepEqual(
    nodeSchema.parse(invoke("node.get", { node_id: examine })).tasks,
    [],
  );
  assert.throws(
    () => invoke("node.get", { node_id: taskId }),
    (error) => error instanceof Error,
  );
  const revision = revisionSchema.parse(
    invoke("node.revision.get", {
      node_id: implement,
      revision: NEXT_REVISION,
    }),
  );
  assert.equal(revision.node_id, implement);
  assert.deepEqual(revision.tasks, implementNode.tasks);
  const page = pageOf(revisionSchema).parse(
    invoke("node.revision.list", { node_id: implement }, { limit: "1" }),
  );
  assert.deepEqual(
    page.items.map((item) => item.revision),
    [NEXT_REVISION],
  );
  assert.ok(page.next_cursor);
  assert.deepEqual(
    pageOf(revisionSchema)
      .parse(
        invoke(
          "node.revision.list",
          { node_id: implement },
          { limit: "1", cursor: page.next_cursor },
        ),
      )
      .items.map((item) => item.revision),
    [FIRST_REVISION],
  );
  const first = pageOf(nodeSchema).parse(
    invoke("node.list", { mission_id: f.mission_id }, { limit: "1" }),
  );
  assert.equal(first.items.length, SINGLE_ITEM);
  assert.ok(first.next_cursor);
  const second = pageOf(nodeSchema).parse(
    invoke(
      "node.list",
      { mission_id: f.mission_id },
      { limit: "1", cursor: first.next_cursor },
    ),
  );
  assert.equal(second.items.length, SINGLE_ITEM);
  assert.ok(
    first.items[FIRST_ELEMENT_INDEX]!.id >
      second.items[FIRST_ELEMENT_INDEX]!.id,
  );
  assert.deepEqual(
    pageOf(nodeSchema)
      .parse(
        invoke(
          "node.list",
          { mission_id: f.mission_id },
          { work: Work.Implement },
        ),
      )
      .items.map((item) => item.id),
    [implement],
  );
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, implement);
  assert.equal(
    pageOf(nodeSchema).parse(
      invoke(
        "node.list",
        { mission_id: f.mission_id },
        { work: Work.Implement },
      ),
    ).items.length,
    NO_ITEMS,
  );
  const retired = pageOf(nodeSchema).parse(
    invoke(
      "node.list",
      { mission_id: f.mission_id },
      { work: Work.Implement, include_retired: "true" },
    ),
  ).items;
  assert.equal(retired.length, SINGLE_ITEM);
  assert.deepEqual(retired[FIRST_ELEMENT_INDEX]!.tasks, implementNode.tasks);
  assert.deepEqual(
    pageOf(nodeSchema)
      .parse(
        invoke(
          "node.list",
          { mission_id: f.mission_id },
          { work: Work.Examine },
        ),
      )
      .items.map((item) => item.id),
    [examine],
  );
});

test("node get answers work and requires of the pinned revision while an attempt is open", (t) => {
  const f = nodeFixture(t);
  const nodeId = f.examine();
  f.store.transaction((tx) =>
    openAttempt(tx, nodeId, FIRST_REVISION, HUMAN_ACTOR, CREATED_AT),
  );
  const body = updateBody(f, nodeId);
  body.content.requires = ["platform.macos"];
  body.tasks = [];
  f.update(nodeId, body);
  const pinned = f.read(nodeId);
  assert.equal(pinned.visible_revision, NEXT_REVISION);
  assert.equal(pinned.work, Work.Examine);
  assert.deepEqual(pinned.requires, []);
  assert.deepEqual(pinned.content.requires, ["platform.macos"]);
  f.store.transaction((tx) =>
    closeAttempt(tx, nodeId, FIRST_REVISION, RETIRED_AT),
  );
  assert.deepEqual(f.read(nodeId).requires, ["platform.macos"]);
});

test("node list filters work on the pinned revision while an attempt is open", (t) => {
  const f = nodeFixture(t);
  const nodeId = f.examine();
  f.store.transaction((tx) => {
    openAttempt(tx, nodeId, FIRST_REVISION, HUMAN_ACTOR, CREATED_AT);
    tx.database
      .prepare(
        `INSERT INTO mission_node_revision
         (node_id, revision, filename, name, requirement, criterion,
          verifications, bindings, work, requires, tasks, change, reason,
          actor, created_at)
         SELECT node_id, ?, filename, name, requirement, criterion,
          verifications, bindings, ?, requires, tasks, change, reason,
          actor, created_at
         FROM mission_node_revision WHERE node_id = ? AND revision = ?`,
      )
      .run(NEXT_REVISION, Work.Implement, nodeId, FIRST_REVISION);
  });
  function list(work: Work): string[] {
    const operation = missionOperations["node.list"];
    const input = operation.input.parse({
      params: { mission_id: f.mission_id },
      query: { work },
      body: null,
    });
    return pageOf(nodeSchema)
      .parse(f.registry.get(operation.id).handler(input, f.caller))
      .items.map((item) => item.id);
  }
  assert.deepEqual(list(Work.Examine), [nodeId]);
  assert.deepEqual(list(Work.Implement), []);
  f.store.transaction((tx) =>
    closeAttempt(tx, nodeId, FIRST_REVISION, RETIRED_AT),
  );
  assert.deepEqual(list(Work.Examine), []);
  assert.deepEqual(list(Work.Implement), [nodeId]);
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
    { node_id: UNKNOWN_NODE_ID },
    {},
    MissionErrorCode.NodeNotFound,
    HttpStatus.NotFound,
  );
  refuses(
    "node.list",
    { mission_id: UNKNOWN_MISSION_ID },
    {},
    MissionErrorCode.MissionNotFound,
    HttpStatus.NotFound,
  );
  const implement = f.implement();
  refuses(
    "node.revision.get",
    { node_id: implement, revision: NEXT_REVISION },
    {},
    MissionErrorCode.NodeNotFound,
    HttpStatus.NotFound,
  );
  refuses(
    "node.revision.list",
    { node_id: UNKNOWN_NODE_ID },
    {},
    MissionErrorCode.NodeNotFound,
    HttpStatus.NotFound,
  );
  refuses(
    "node.list",
    { mission_id: f.mission_id },
    { cursor: "%%%" },
    MissionErrorCode.CursorInvalid,
    HttpStatus.BadRequest,
  );
  refuses(
    "node.revision.list",
    { node_id: implement },
    { cursor: "%%%" },
    MissionErrorCode.CursorInvalid,
    HttpStatus.BadRequest,
  );
  assert.equal(
    missionOperations["node.list"].input.safeParse({
      params: { mission_id: f.mission_id },
      query: { kind: "task", state: NodeState.Pending },
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
  CrossMission: "cross_mission",
} as const;
const CURSOR_ENCODING = "base64url";
const REASON_FIELD = "reason";

function dependencyFixture(
  t: TestContext,
  bindingRevision?: MissionBindings["getBindingRevision"],
  text_max_bytes?: number,
  collaborators: Partial<Collaborators> = {},
) {
  const f = nodeFixture(t, bindingRevision, text_max_bytes, collaborators);
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
      params: { node_id: nodeId, depends_on_id: dependsOnId },
      query: {},
      body: { expected_mission_version: expectedMissionVersion, reason },
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
  function edges(query: object = {}, missionId = f.mission_id) {
    const operation = missionOperations["edge.list"];
    const input = operation.input.parse({
      params: { mission_id: missionId },
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
    const nodeId = f.implement();
    const dependsOnId = f.create({ ...f.body(), filename: OTHER_FILENAME })
      .revisions[FIRST_ELEMENT_INDEX]!.node_id;
    f.calls.length = EMPTY_CALLS;
    return { node_id: nodeId, depends_on_id: dependsOnId };
  }
  return { ...f, edit, refuses, jobs, edges, pair };
}

function dependsOnOf(node: Node): string[] {
  return node.depends_on;
}

function emptyChange(missionVersion: number): NodeChange {
  return {
    mission_version: missionVersion,
    revisions: [],
    retired_node_ids: [],
    added_edges: [],
    removed_edges: [],
    open_attempts_unchanged: [],
  };
}

test("dependency edits reroute implement nodes and jobs atomically without revisions or actor writes", (t) => {
  const f = dependencyFixture(t);
  const { node_id: nodeId, depends_on_id: dependsOnId } = f.pair();
  const before = f.snapshot();
  const version = f.version();
  const edge = {
    dependent_id: nodeId,
    depends_on_id: dependsOnId,
  };
  assert.deepEqual(f.edit(DependencyOperation.Add, nodeId, dependsOnId), {
    ...emptyChange(version + VERSION_INCREMENT),
    added_edges: [edge],
  });
  assert.equal(f.node(nodeId)?.state, NodeState.Pending);
  assert.deepEqual(dependsOnOf(f.read(nodeId)), [dependsOnId]);
  assert.equal(
    f.jobs().some((job) => job.node_id === nodeId),
    false,
  );
  assert.deepEqual(f.calls, [{ action: QueueAction.Delete, node_id: nodeId }]);
  assert.deepEqual(f.snapshot().revisions, before.revisions);
  f.calls.length = EMPTY_CALLS;
  assert.deepEqual(f.edit(DependencyOperation.Remove, nodeId, dependsOnId), {
    ...emptyChange(version + TWO_VERSION_STEPS),
    removed_edges: [edge],
  });
  assert.equal(f.node(nodeId)?.state, NodeState.Available);
  assert.deepEqual(dependsOnOf(f.read(nodeId)), []);
  assert.equal(
    f.jobs().some((job) => job.node_id === nodeId),
    true,
  );
  assert.deepEqual(f.calls, [
    {
      action: QueueAction.Insert,
      node_id: nodeId,
      project_id: PROJECT_ID,
      priority: LOWEST_PRIORITY,
    },
  ]);
  assert.deepEqual(f.snapshot().revisions, before.revisions);
  assert.deepEqual(f.snapshot().dependencies, []);
});

test("node reads answer dependsOn in ascending order on examine and implement nodes", (t) => {
  const f = dependencyFixture(t);
  const implement = f.implement();
  const examine = f.examine();
  const first = f.create({ ...f.body(), filename: OTHER_FILENAME }).revisions[
    FIRST_ELEMENT_INDEX
  ]!.node_id;
  const second = f.create({ ...f.body(), filename: NEW_FILENAME }).revisions[
    FIRST_ELEMENT_INDEX
  ]!.node_id;
  assert.deepEqual(dependsOnOf(f.read(examine)), []);
  f.edit(DependencyOperation.Add, examine, second);
  f.edit(DependencyOperation.Add, examine, first);
  f.edit(DependencyOperation.Add, implement, first);
  assert.deepEqual(dependsOnOf(f.read(examine)), [first, second].sort());
  assert.deepEqual(dependsOnOf(f.read(implement)), [first]);
});

test("dependency addition rejects direct and self cycles without writes", (t) => {
  const f = dependencyFixture(t);
  const { node_id: nodeId, depends_on_id: dependsOnId } = f.pair();
  f.edit(DependencyOperation.Add, nodeId, dependsOnId);
  f.refuses(
    DependencyOperation.Add,
    dependsOnId,
    nodeId,
    MissionErrorCode.Cycle,
  );
  f.refuses(DependencyOperation.Add, nodeId, nodeId, MissionErrorCode.Cycle);
});

test("dependency addition validates cross-mission endpoints", (t) => {
  const f = dependencyFixture(t);
  const { node_id: nodeId } = f.pair();
  f.store.transaction((tx) =>
    f.mission.createMission(tx, UNKNOWN_PROJECT_ID, HUMAN_ACTOR),
  );
  const otherMission = f.invoke(UNKNOWN_PROJECT_ID);
  const other = f.create(
    { ...f.body(), expected_mission_version: otherMission.version },
    otherMission.id,
  ).revisions[FIRST_ELEMENT_INDEX]!.node_id;
  f.refuses(
    DependencyOperation.Add,
    nodeId,
    other,
    MissionErrorCode.EndpointInvalid,
    {
      reason: EndpointReason.CrossMission,
      node_id: nodeId,
      depends_on_id: other,
    },
  );
});

const DEPENDENCY_GUARDED_STATES = [
  NodeState.Waiting,
  NodeState.Evaluating,
  NodeState.ExternalRequested,
  NodeState.ExternalSuccess,
  NodeState.ExternalFailed,
];

function pauseOnRequest(
  f: Pick<ReturnType<typeof dependencyFixture>, "store" | "setState">,
  id: string,
) {
  f.store.transaction((tx) => {
    openAttempt(tx, id, FIRST_REVISION, HUMAN_ACTOR, CREATED_AT);
    insertEvidence(
      tx,
      {
        id: createIdentity("evidence"),
        node_id: id,
        attempt: FIRST_REVISION,
        subject: "Request",
        requirement_key: "repo.pull_request",
        end_state: null,
        verification: null,
        provenance: JSON.stringify(HUMAN_ACTOR),
        created_at: CREATED_AT,
      },
      [],
    );
  });
  f.setState(id, NodeState.Paused);
}

test("dependency add and remove refuse a Waiting, Evaluating and External dependent", (t) => {
  const f = dependencyFixture(t);
  const { node_id: nodeId, depends_on_id: dependsOnId } = f.pair();
  const other = f.create({ ...f.body(), filename: NEW_FILENAME }).revisions[
    FIRST_ELEMENT_INDEX
  ]!.node_id;
  f.edit(DependencyOperation.Add, nodeId, dependsOnId);
  for (const state of DEPENDENCY_GUARDED_STATES) {
    f.setState(nodeId, state);
    const details = { state, attempt: NO_ATTEMPT };
    f.refuses(
      DependencyOperation.Add,
      nodeId,
      other,
      ControlError.StateConflict,
      details,
    );
    f.refuses(
      DependencyOperation.Remove,
      nodeId,
      dependsOnId,
      ControlError.StateConflict,
      details,
    );
  }
});

test("dependency add refuses a Paused dependent with a request evidence", (t) => {
  const f = dependencyFixture(t);
  const { node_id: nodeId, depends_on_id: dependsOnId } = f.pair();
  const other = f.create({ ...f.body(), filename: NEW_FILENAME }).revisions[
    FIRST_ELEMENT_INDEX
  ]!.node_id;
  f.edit(DependencyOperation.Add, nodeId, dependsOnId);
  pauseOnRequest(f, nodeId);
  f.refuses(
    DependencyOperation.Add,
    nodeId,
    other,
    ControlError.StateConflict,
    { state: NodeState.Paused, attempt: FIRST_REVISION },
  );
  f.edit(DependencyOperation.Remove, nodeId, dependsOnId);
});

for (const operation of Object.values(DependencyOperation)) {
  for (const state of [NodeState.Completed, NodeState.Discarded]) {
    test(`${operation} refuses terminal dependent ${state} before no-op`, (t) => {
      const f = dependencyFixture(t);
      const { node_id: nodeId, depends_on_id: dependsOnId } = f.pair();
      f.setState(nodeId, state);
      f.refuses(operation, nodeId, dependsOnId, MissionErrorCode.Terminal, {
        node_id: nodeId,
      });
    });
  }
  test(`${operation} checks existence, retirement, version, terminal state and reason in order`, (t) => {
    const f = dependencyFixture(t);
    const { node_id: nodeId, depends_on_id: dependsOnId } = f.pair();
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
      { node_id: nodeId },
      FIRST_REVISION,
    );
  });
}

for (const operation of Object.values(DependencyOperation)) {
  test(`${operation} rolls back graph, routing, jobs and version when queue reconciliation fails`, (t) => {
    const f = dependencyFixture(t);
    const { node_id: nodeId, depends_on_id: dependsOnId } = f.pair();
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
  const { node_id: nodeId, depends_on_id: dependsOnId } = f.pair();
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
    { node_id: dependsOnId },
    FIRST_REVISION,
  );
});

test("dependency duplicate addition and absent removal do not write, increment or call the queue", (t) => {
  const f = dependencyFixture(t);
  const { node_id: nodeId, depends_on_id: dependsOnId } = f.pair();
  f.edit(DependencyOperation.Add, nodeId, dependsOnId);
  f.calls.length = EMPTY_CALLS;
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
  const { node_id: nodeId, depends_on_id: dependsOnId } = f.pair();
  assert.deepEqual(
    f.edit(DependencyOperation.Remove, dependsOnId, nodeId),
    emptyChange(f.version()),
  );
  f.edit(DependencyOperation.Add, nodeId, dependsOnId);
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, dependsOnId);
  assert.deepEqual(
    f.edit(DependencyOperation.Remove, nodeId, dependsOnId).removed_edges,
    [
      {
        dependent_id: nodeId,
        depends_on_id: dependsOnId,
      },
    ],
  );
});

test("dependency addition on an examine node reroutes the examine node alone", (t) => {
  const f = dependencyFixture(t);
  const { node_id: nodeId, depends_on_id: dependsOnId } = f.pair();
  const parentId = f.create({ ...f.body(), filename: TASK_FILENAME }).revisions[
    FIRST_ELEMENT_INDEX
  ]!.node_id;
  const other = f.create({
    ...f.body(Work.Implement),
    filename: NEW_FILENAME,
  }).revisions[FIRST_ELEMENT_INDEX]!.node_id;
  f.calls.length = EMPTY_CALLS;
  f.edit(DependencyOperation.Add, parentId, dependsOnId);
  assert.equal(f.node(parentId)?.state, NodeState.Pending);
  for (const child of [nodeId, other]) {
    assert.equal(f.node(child)?.state, NodeState.Available);
    assert.equal(
      f.jobs().some((job) => job.node_id === child),
      true,
    );
  }
  assert.deepEqual(f.calls, [
    { action: QueueAction.Delete, node_id: parentId },
  ]);
});

test("dependency removal only releases nodes when all remaining dependencies are completed", (t) => {
  const f = dependencyFixture(t);
  const { node_id: nodeId, depends_on_id: dependsOnId } = f.pair();
  const other = f.create({ ...f.body(), filename: NEW_FILENAME }).revisions[
    FIRST_ELEMENT_INDEX
  ]!.node_id;
  f.edit(DependencyOperation.Add, nodeId, dependsOnId);
  f.edit(DependencyOperation.Add, nodeId, other);
  f.calls.length = EMPTY_CALLS;
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

test("edge.list lists only current incident dependency edges and paginates descending keys", (t) => {
  const f = dependencyFixture(t);
  const { node_id: nodeId, depends_on_id: dependsOnId } = f.pair();
  const third = f.create({ ...f.body(), filename: NEW_FILENAME }).revisions[
    FIRST_ELEMENT_INDEX
  ]!.node_id;
  addTask(f, nodeId);
  f.edit(DependencyOperation.Add, nodeId, dependsOnId);
  f.edit(DependencyOperation.Add, third, nodeId);
  const dependency = {
    dependent_id: nodeId,
    depends_on_id: dependsOnId,
  };
  const dependent = { dependent_id: third, depends_on_id: nodeId };
  const expected = [dependency, dependent].sort((a, b) =>
    `${b.dependent_id}|${b.depends_on_id}`.localeCompare(
      `${a.dependent_id}|${a.depends_on_id}`,
    ),
  );
  assert.deepEqual(f.edges(), { items: expected, next_cursor: null });
  assert.deepEqual(f.edges({ node_id: nodeId }).items, expected);
  assert.deepEqual(f.edges({ node_id: dependsOnId }).items, [dependency]);
  assert.deepEqual(f.edges({ node_id: third }).items, [dependent]);
  assert.deepEqual(f.edges({ node_id: UNKNOWN_NODE_ID }).items, []);
  let cursor: string | undefined;
  for (const edge of expected) {
    const page = f.edges({ limit: SINGLE_ITEM, cursor });
    assert.deepEqual(page.items, [edge]);
    cursor = page.next_cursor ?? undefined;
  }
  assert.equal(cursor, undefined);
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, nodeId);
  assert.deepEqual(f.edges().items, []);
});

test("edge.list refuses unknown missions and malformed cursor encodings and node identities", (t) => {
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
    Buffer.from(`bad|${UNKNOWN_NODE_ID}`).toString(CURSOR_ENCODING),
    Buffer.from(`${UNKNOWN_NODE_ID}|bad`).toString(CURSOR_ENCODING),
    Buffer.from(`${UNKNOWN_NODE_ID}|${UNKNOWN_NODE_ID}|extra`).toString(
      CURSOR_ENCODING,
    ),
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

type TaskFixture = Pick<
  ReturnType<typeof nodeFixture>,
  "store" | "version" | "update"
>;

function updateBody(f: TaskFixture, id: string): NodeUpdate {
  const node = f.store.transaction((tx) => {
    const row = readNode(tx, id)!;
    const revision = readCurrentRevision(tx, id)!;
    return {
      filename: row.filename,
      content: {
        name: revision.name,
        requirement: revision.requirement,
        criterion: revision.criterion,
        verifications: JSON.parse(revision.verifications),
        bindings: JSON.parse(revision.bindings),
        work: revision.work,
        requires: JSON.parse(revision.requires),
      },
      tasks: JSON.parse(revision.tasks),
      expected_revision: revision.revision,
    };
  });
  return {
    filename: node.filename,
    expected_revision: node.expected_revision,
    content: {
      ...node.content,
      bindings: node.content.work === Work.Implement ? [BINDING_ID] : [],
    },
    tasks: node.tasks,
    expected_mission_version: f.version(),
    reason: REASON,
  };
}

function boundTaskWrite(filename: string) {
  const write = taskWrite(filename);
  return { ...write, content: { ...write.content, bindings: [BINDING_ID] } };
}

function taskWrite(filename = TASK_FILENAME) {
  return {
    filename,
    content: {
      name: NODE_TEXT,
      requirement: NODE_TEXT,
      criterion: NODE_TEXT,
      verifications: [VERIFICATION],
      bindings: [],
    },
  };
}

function addTask(
  f: TaskFixture,
  implementId: string,
  filename = TASK_FILENAME,
): string {
  const body = updateBody(f, implementId);
  body.tasks = [...body.tasks, taskWrite(filename)];
  const task = f
    .update(implementId, body)
    .revisions[FIRST_ELEMENT_INDEX]!.tasks.find(
      (item) => item.filename === filename,
    );
  assert.ok(task);
  return task.id;
}

function priorityFixture(
  t: TestContext,
  collaborators: Partial<Collaborators> = {},
) {
  const f = nodeFixture(t, undefined, undefined, collaborators);
  const jobs = new Map<string, { id: string; priority: number }>();
  const updates: Array<{ node_id: string; priority: number }> = [];
  f.queue.insert = (_tx, nodeId, _projectId, priority) => {
    jobs.set(nodeId, { id: createIdentity("job"), priority });
  };
  f.queue.delete = (_tx, nodeId) => {
    jobs.delete(nodeId);
  };
  f.queue.priorityUpdate = (tx, nodeId, priority) => {
    assert.equal(readNode(tx, nodeId)?.priority, priority);
    updates.push({ node_id: nodeId, priority });
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
      params: { node_id: nodeId },
      query: {},
      body: { value, expected_mission_version: expectedMissionVersion },
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
    params: { node_id: UNKNOWN_NODE_ID },
    query: {},
    body: {
      value: LOWEST_PRIORITY,
      expected_mission_version: MISSION_INITIAL_VERSION,
    },
  };
  assert.equal(op.input.safeParse(valid).success, true);
  for (const value of [
    0.5,
    "42",
    Number.MAX_SAFE_INTEGER + VERSION_INCREMENT,
    Number.MIN_SAFE_INTEGER - VERSION_INCREMENT,
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
  const id = f.implement();
  const get = missionOperations["node.get"];
  const input = get.input.parse({
    params: { node_id: id },
    query: {},
    body: null,
  });
  const initial = nodeSchema.parse(
    f.registry.get(get.id).handler(input, f.caller),
  );
  assert.equal(initial.work, Work.Implement);
  assert.equal(initial.priority, LOWEST_PRIORITY);
  const version = f.version();
  const revisions = f.snapshot().revisions;
  const job = f.jobs.get(id);
  assert.ok(job);
  const commits = f.commits();
  const first = f.set(id, PRIORITY, version);
  assert.equal(f.commits(), commits + ONE_COMMIT);
  assert.equal(first.work, Work.Implement);
  assert.equal(first.priority, PRIORITY);
  assert.equal(f.jobs.get(id)?.id, job.id);
  assert.equal(f.jobs.get(id)?.priority, PRIORITY);
  const second = f.set(id, NEGATIVE_PRIORITY, version);
  assert.equal(second.work, Work.Implement);
  assert.equal(second.priority, NEGATIVE_PRIORITY);
  assert.equal(f.node(id)?.priority, NEGATIVE_PRIORITY);
  assert.deepEqual(f.updates, [
    { node_id: id, priority: PRIORITY },
    { node_id: id, priority: NEGATIVE_PRIORITY },
  ]);
  assert.deepEqual(f.jobs.get(id), { id: job.id, priority: NEGATIVE_PRIORITY });
  assert.equal(f.version(), version);
  assert.deepEqual(f.snapshot().revisions, revisions);
});

test("node.priority.set accepts both signed limits and zero on examine and implement nodes", (t) => {
  const f = priorityFixture(t);
  const examine = f.examine();
  const implement = f.create(f.body(Work.Implement)).revisions[
    FIRST_ELEMENT_INDEX
  ]!.node_id;
  const version = f.version();
  for (const [id, value] of [
    [examine, Number.MIN_SAFE_INTEGER],
    [implement, Number.MAX_SAFE_INTEGER],
    [implement, LOWEST_PRIORITY],
  ] as const) {
    const answer = f.set(id, value, version);
    assert.equal(answer.priority, value);
    assert.equal(f.node(id)?.priority, value);
  }
  assert.equal(f.version(), version);
});

test("node.priority.set checks existence, retirement, version and terminal in order", (t) => {
  const f = priorityFixture(t);
  const id = f.implement();
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
  f.setState(id, NodeState.Completed);
  f.refuses(id, PRIORITY, MissionErrorCode.Terminal, { node_id: id });
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, id);
  f.refuses(
    id,
    PRIORITY,
    MissionErrorCode.Retired,
    { node_id: id },
    HttpStatus.Conflict,
    MISSION_INITIAL_VERSION,
  );
});

test("node.priority.set rolls back its node update if the queue fails", (t) => {
  const f = priorityFixture(t);
  const id = f.examine();
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

test("node.update no-op and changed implement fields preserve version and write exact revisions", (t) => {
  const f = nodeFixture(t);
  const id = f.implement();
  const body = updateBody(f, id);
  const before = f.snapshot();
  const commits = f.commits();
  const noOp = f.update(id, body);
  assert.equal(f.commits(), commits + ONE_COMMIT);
  assert.deepEqual(noOp, {
    mission_version: body.expected_mission_version,
    revisions: [],
    retired_node_ids: [],
    added_edges: [],
    removed_edges: [],
    open_attempts_unchanged: [],
  });
  assert.deepEqual(f.snapshot(), before);
  const changed = f.update(id, {
    ...body,
    filename: NEW_FILENAME,
    content: { ...body.content, name: "updated" },
  });
  assert.equal(
    changed.mission_version,
    body.expected_mission_version + VERSION_INCREMENT,
  );
  assert.equal(f.node(id)?.filename, NEW_FILENAME);
  assert.equal(changed.revisions[FIRST_ELEMENT_INDEX]?.revision, NEXT_REVISION);
  assert.deepEqual(changed.revisions[FIRST_ELEMENT_INDEX]?.change, {
    write: RevisionWrite.NodeUpdate,
    previous_revision: FIRST_REVISION,
    changed_fields: ["filename", "name"],
    tasks: [],
  });
  assert.deepEqual(
    changed.revisions[FIRST_ELEMENT_INDEX]?.actor,
    humanActor(f.caller),
  );
  assert.equal(f.version(), changed.mission_version);
});

test("node.update of an examine node lists only changed content fields in canonical order", (t) => {
  const f = nodeFixture(t);
  const id = f.examine();
  const body = updateBody(f, id);
  const changed = f.update(id, {
    ...body,
    content: {
      ...body.content,
      requires: ["platform.macos"],
      criterion: "new criterion",
      verifications: ["new verification"],
      requirement: "new requirement",
      name: "new name",
      bindings: [OTHER_BINDING_ID],
    },
  });
  assert.deepEqual(changed.revisions[FIRST_ELEMENT_INDEX]?.change, {
    write: RevisionWrite.NodeUpdate,
    previous_revision: FIRST_REVISION,
    changed_fields: CONTENT_FIELDS.filter(
      (field) => field !== ContentField.Filename && field !== ContentField.Work,
    ),
    tasks: [],
  });
  assert.deepEqual(changed.revisions[FIRST_ELEMENT_INDEX]?.content.bindings, [
    OTHER_BINDING_ID,
  ]);
  assert.deepEqual(changed.revisions[FIRST_ELEMENT_INDEX]?.tasks, []);
});

test("node.update accepts the binding identities of a node read and refuses a binding name", (t) => {
  const f = nodeFixture(t);
  const id = f.implement();
  const body = updateBody(f, id);
  const read = f.read(id);
  assert.deepEqual(read.content.bindings, [BINDING_ID]);
  const changed = f.update(id, {
    ...body,
    content: { ...read.content, name: "new name" },
  });
  assert.deepEqual(changed.revisions[FIRST_ELEMENT_INDEX]?.content.bindings, [
    BINDING_ID,
  ]);
  const next = updateBody(f, id);
  const before = f.snapshot();
  assert.throws(
    () =>
      f.update(id, {
        ...next,
        content: { ...next.content, bindings: [REPOSITORY_NAME] },
      }),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.status, HttpStatus.BadRequest);
      assert.equal(error.code, MissionErrorCode.BindingsInvalid);
      assert.deepEqual(error.details, { binding: REPOSITORY_NAME });
      return true;
    },
  );
  assert.deepEqual(f.snapshot(), before);
});

test("node.update task no-op leaves implement revision and mission unchanged", (t) => {
  const f = nodeFixture(t);
  const owner = f.implement();
  addTask(f, owner);
  const body = updateBody(f, owner);
  const before = f.snapshot();
  const commits = f.commits();
  const answer = f.update(owner, body);
  assert.equal(f.commits(), commits + ONE_COMMIT);
  assert.deepEqual(answer, {
    mission_version: body.expected_mission_version,
    revisions: [],
    retired_node_ids: [],
    added_edges: [],
    removed_edges: [],
    open_attempts_unchanged: [],
  });
  assert.deepEqual(f.snapshot(), before);
});

test("node filename store maps unique-index failure to filename conflict", (t) => {
  const f = nodeFixture(t);
  const id = f.examine();
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
  assert.equal(f.node(id)?.filename, EXAMINE_FILENAME);
});

test("node update creates, changes and removes tasks", (t) => {
  const f = nodeFixture(t);
  const implementId = f.implement();
  const first = addTask(f, implementId);
  const second = addTask(f, implementId, OTHER_FILENAME);
  const body = updateBody(f, implementId);
  const commits = f.commits();
  const changed = f.update(implementId, {
    ...body,
    tasks: [
      {
        id: second,
        filename: NEW_FILENAME,
        content: { ...taskWrite().content, name: "task changed" },
      },
      taskWrite(TASK_FILENAME),
    ],
  });
  assert.equal(f.commits(), commits + ONE_COMMIT);
  assert.equal(
    changed.mission_version,
    body.expected_mission_version + VERSION_INCREMENT,
  );
  const revision = changed.revisions[FIRST_ELEMENT_INDEX]!;
  assert.equal(revision.node_id, implementId);
  assert.equal(revision.revision, body.expected_revision + VERSION_INCREMENT);
  const created = revision.tasks[SECOND_ENTRY_INDEX]!;
  assert.notEqual(created.id, first);
  assert.ok(identitySchema("task").safeParse(created.id).success);
  assert.deepEqual(revision.tasks, [
    {
      id: second,
      filename: NEW_FILENAME,
      content: { ...taskWrite().content, name: "task changed" },
    },
    { id: created.id, ...taskWrite(TASK_FILENAME) },
  ]);
  assert.deepEqual(revision.change, {
    write: RevisionWrite.NodeUpdate,
    previous_revision: body.expected_revision,
    changed_fields: [TASKS_FIELD],
    tasks: [
      {
        id: second,
        change: TaskChange.Updated,
        changed_fields: ["filename", "name"],
      },
      {
        id: created.id,
        change: TaskChange.Created,
        changed_fields: TASK_CONTENT_FIELDS,
      },
      { id: first, change: TaskChange.Retired, changed_fields: [] },
    ],
  });
  assert.equal(f.node(second), null);
  assert.equal(f.version(), changed.mission_version);
  updateRefuses(
    f,
    implementId,
    {
      ...updateBody(f, implementId),
      tasks: [taskWrite(IMPLEMENT_FILENAME)],
    },
    MissionErrorCode.FilenameConflict,
    { filename: IMPLEMENT_FILENAME },
  );
});

test("node update changes work while the attempt reads 0", (t) => {
  const f = nodeFixture(t);
  const id = f.examine();
  const body = updateBody(f, id);
  const changed = f.update(id, {
    ...body,
    content: { ...body.content, work: Work.Implement, bindings: [BINDING_ID] },
  });
  const revision = changed.revisions[FIRST_ELEMENT_INDEX]!;
  assert.equal(revision.content.work, Work.Implement);
  assert.deepEqual(revision.change.changed_fields, [
    ContentField.Bindings,
    ContentField.Work,
  ]);
  assert.equal(f.read(id).work, Work.Implement);
});

test("node update refuses a work change after the first claim with mission.node.work_locked", (t) => {
  const f = nodeFixture(t);
  const id = f.implement();
  f.store.transaction((tx) => {
    openAttempt(tx, id, FIRST_REVISION, HUMAN_ACTOR, CREATED_AT);
    tx.database
      .prepare("UPDATE mission_node SET attempt = ? WHERE id = ?")
      .run(FIRST_ATTEMPT, id);
  });
  const body = updateBody(f, id);
  updateRefuses(
    f,
    id,
    { ...body, content: { ...body.content, work: Work.Examine } },
    MissionErrorCode.WorkLocked,
    { node_id: id, attempt: FIRST_ATTEMPT },
  );
});

test("node update refuses a task of another node with mission.node.content_invalid", (t) => {
  const f = nodeFixture(t);
  const implementId = f.implement();
  const parentId = f.examine();
  const foreign = addTask(f, implementId);
  const other = f.create({
    ...f.body(Work.Implement),
    filename: OTHER_FILENAME,
  }).revisions[FIRST_ELEMENT_INDEX]!.node_id;
  updateRefuses(
    f,
    other,
    {
      ...updateBody(f, other),
      tasks: [{ ...taskWrite(NEW_FILENAME), id: foreign }],
    },
    MissionErrorCode.ContentInvalid,
    { field: TASKS_FIELD },
    HttpStatus.BadRequest,
  );
  updateRefuses(
    f,
    parentId,
    { ...updateBody(f, parentId), tasks: [taskWrite(NEW_FILENAME)] },
    MissionErrorCode.ContentInvalid,
    { field: TASKS_FIELD },
    HttpStatus.BadRequest,
  );
});

test("node update refuses a task that names a binding with mission.node.bindings_invalid", (t) => {
  const f = nodeFixture(t);
  const implementId = f.implement();
  updateRefuses(
    f,
    implementId,
    { ...updateBody(f, implementId), tasks: [boundTaskWrite(NEW_FILENAME)] },
    MissionErrorCode.BindingsInvalid,
    { filename: NEW_FILENAME },
    HttpStatus.BadRequest,
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
  const id = f.examine();
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
    { ...body, expected_mission_version: FIRST_REVISION },
    MissionErrorCode.VersionConflict,
    { current: body.expected_mission_version },
  );
  updateRefuses(
    f,
    id,
    { ...body, expected_revision: NEXT_REVISION },
    MissionErrorCode.RevisionConflict,
    { current: FIRST_REVISION },
  );
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, id);
  updateRefuses(
    f,
    id,
    { ...body, expected_mission_version: FIRST_REVISION },
    MissionErrorCode.Retired,
    { node_id: id },
  );
});

for (const kind of [Work.Examine, Work.Implement]) {
  test(`node.update refuses terminal ${kind}`, (t) => {
    const f = nodeFixture(t);
    const id = kind === Work.Examine ? f.examine() : f.implement();
    const body = updateBody(f, id);
    f.setState(id, NodeState.Completed);
    updateRefuses(f, id, body, MissionErrorCode.Terminal, { node_id: id });
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
    expected_revision: update.expected_revision,
    expected_mission_version: update.expected_mission_version,
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
  const id = f.implement();
  const body = criterionBody(f, id);
  const before = f.snapshot();
  const commits = f.commits();
  assert.deepEqual(
    f.criterionSet(id, body),
    emptyChange(body.expected_mission_version),
  );
  assert.equal(f.commits(), commits + ONE_COMMIT);
  assert.deepEqual(f.snapshot(), before);
  const original = updateBody(f, id);
  const changed = f.criterionSet(id, { ...body, criterion: "new criterion" });
  const revision = changed.revisions[FIRST_ELEMENT_INDEX]!;
  assert.equal(
    changed.mission_version,
    body.expected_mission_version + VERSION_INCREMENT,
  );
  assert.equal(f.version(), changed.mission_version);
  assert.deepEqual(revision.change, {
    write: RevisionWrite.CriterionSet,
    previous_revision: body.expected_revision,
    changed_fields: [ContentField.Criterion],
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

test("criterion.set examine changes only criterion and verifications", (t) => {
  const f = nodeFixture(t);
  const id = f.examine();
  const body = criterionBody(f, id);
  const commits = f.commits();
  const result = f.criterionSet(id, {
    ...body,
    criterion: "new criterion",
    verifications: ["new verification"],
  });
  assert.equal(f.commits(), commits + ONE_COMMIT);
  assert.equal(
    result.mission_version,
    body.expected_mission_version + VERSION_INCREMENT,
  );
  assert.deepEqual(result.revisions[FIRST_ELEMENT_INDEX]!.change, {
    write: RevisionWrite.CriterionSet,
    previous_revision: FIRST_REVISION,
    changed_fields: [ContentField.Criterion, ContentField.Verifications],
    tasks: [],
  });
  assert.deepEqual(result.revisions[FIRST_ELEMENT_INDEX]!.tasks, []);
});

test("criterion.set keeps the task list unchanged", (t) => {
  const f = nodeFixture(t);
  const owner = f.implement();
  const task = addTask(f, owner);
  const body = criterionBody(f, owner);
  const prior = f.store.transaction((tx) => readCurrentRevision(tx, owner));
  assert.ok(prior);
  const changed = f.criterionSet(owner, {
    ...body,
    verifications: ["new verification"],
  });
  const revision = changed.revisions[FIRST_ELEMENT_INDEX]!;
  assert.equal(revision.node_id, owner);
  assert.equal(revision.revision, prior.revision + VERSION_INCREMENT);
  assert.deepEqual(revision.change, {
    write: RevisionWrite.CriterionSet,
    previous_revision: prior.revision,
    changed_fields: [ContentField.Verifications],
    tasks: [],
  });
  assert.deepEqual(revision.tasks, [{ id: task, ...taskWrite() }]);
});

test("criterion.set enforces check order, revisions and content validation", (t) => {
  const f = nodeFixture(t);
  const id = f.implement();
  addTask(f, id);
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
    { ...body, expected_mission_version: FIRST_REVISION },
    MissionErrorCode.VersionConflict,
    { current: f.version() },
  );
  criterionRefuses(
    f,
    id,
    { ...body, expected_revision: FIRST_REVISION },
    MissionErrorCode.RevisionConflict,
    { current: NEXT_REVISION },
  );
  assert.equal(
    missionOperations[RevisionWrite.CriterionSet].input.safeParse({
      params: { node_id: id },
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
  criterionRefuses(f, id, body, MissionErrorCode.Terminal, { node_id: id });
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, id);
  criterionRefuses(f, id, body, MissionErrorCode.Retired, { node_id: id });
});

const INVALID_RETIRE_DIGEST = "0".repeat(64);
const RETIRE_QUEUE_FAILURE = "retirement queue failure";
const RETIRE_PREVIEW_PATH = "/api/mission/node/:node_id/retire/preview";
const RETIRE_PATH = "/api/mission/node/:node_id/retire";

function retireFixture(t: TestContext) {
  const f = dependencyFixture(t);
  function preview(nodeId: string, query: object = {}): RetirePreview {
    const operation = missionOperations["node.retire.preview"];
    const input = operation.input.parse({
      params: { node_id: nodeId },
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
      params: { node_id: nodeId },
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
      expected_mission_version: plan.mission_version,
      preview_digest: plan.preview_digest,
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
      expected_mission_version: f.version(),
      preview_digest: INVALID_RETIRE_DIGEST,
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
    return addTask(f, parentId, filename);
  }
  function get(nodeId: string) {
    const operation = missionOperations["node.get"];
    const input = operation.input.parse({
      params: { node_id: nodeId },
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
  const id = f.examine();
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
        params: { node_id: id },
        query: { force },
        body: null,
      }).success,
      false,
    );
  }
});

test("node.retire preview is read-only and hashes precisely the other five fields; apply increments once", (t) => {
  const f = retireFixture(t);
  const id = f.implement();
  const before = { ...f.snapshot(), jobs: f.jobs() };
  const plan = f.preview(id);
  const { preview_digest: previewDigest, ...fields } = plan;
  assert.equal(previewDigest, digest(fields));
  assert.match(previewDigest, /^[0-9a-f]{64}$/);
  assert.deepEqual({ ...f.snapshot(), jobs: f.jobs() }, before);
  const result = f.apply(id, f.request(plan));
  assert.deepEqual(result, {
    ...emptyChange(plan.mission_version + VERSION_INCREMENT),
    retired_node_ids: [id],
  });
  assert.equal(f.version(), plan.mission_version + VERSION_INCREMENT);
  assert.deepEqual(f.snapshot().revisions, before.revisions);
  assert.equal(f.snapshot().nodes.length, before.nodes.length);
  assert.equal(f.node(id)?.state, NodeState.Available);
  assert.ok(f.node(id)?.retired_at);
  f.refuses(id, MissionErrorCode.Retired, { node_id: id });
});

for (const attempt of [FIRST_ATTEMPT, SECOND_ATTEMPT]) {
  test(`node.retire preview and apply refuse attempt ${attempt}`, (t) => {
    const f = retireFixture(t);
    const id = f.implement();
    f.store.database
      .prepare("UPDATE mission_node SET attempt = ? WHERE id = ?")
      .run(attempt, id);
    f.refuses(id, MissionErrorCode.RetireRefused, {
      node_id: id,
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
    const id = f.implement();
    f.setState(id, state);
    f.refuses(id, MissionErrorCode.RetireRefused, {
      node_id: id,
      state,
      attempt: NO_ATTEMPT,
    });
    f.refuses(
      id,
      MissionErrorCode.RetireRefused,
      { node_id: id, state, attempt: NO_ATTEMPT },
      HttpStatus.Conflict,
      true,
    );
  });
}

test("a node API retirement set holds the named node alone", (t) => {
  const f = retireFixture(t);
  const first = f.implement();
  const root = f.examine();
  f.edit(DependencyOperation.Add, root, first);
  f.setState(root, NodeState.Executing);
  f.setState(first, NodeState.Blocked);
  f.refuses(root, MissionErrorCode.RetireRefused, {
    node_id: root,
    state: NodeState.Executing,
    attempt: NO_ATTEMPT,
  });
  f.setState(root, NodeState.Available);
  const plan = f.preview(root);
  assert.deepEqual(plan.retired_node_ids, [root]);
  assert.deepEqual(plan.removed_edges, []);
  const result = f.apply(root, f.request(plan));
  assert.deepEqual(result.retired_node_ids, [root]);
  assert.ok(f.node(root)?.retired_at);
  assert.equal(f.node(first)?.retired_at, null);
  assert.equal(f.node(first)?.state, NodeState.Blocked);
});

test("node.retire refuses sorted unique nonterminal dependents without force, including force=false", (t) => {
  const f = retireFixture(t);
  const first = f.implement();
  const dependent = f.create({ ...f.body(), filename: NEW_FILENAME }).revisions[
    FIRST_ELEMENT_INDEX
  ]!.node_id;
  const another = f.create({ ...f.body(), filename: "another.md" }).revisions[
    FIRST_ELEMENT_INDEX
  ]!.node_id;
  f.edit(DependencyOperation.Add, dependent, first);
  f.edit(DependencyOperation.Add, another, first);
  f.refuses(first, MissionErrorCode.RetireHasDependents, {
    dependents: [dependent, another].sort(),
  });
  assert.throws(
    () => f.preview(first, { force: "false" }),
    retirementError(MissionErrorCode.RetireHasDependents, {
      dependents: [dependent, another].sort(),
    }),
  );
  const plan = f.preview(first, { force: "true" });
  const expected = [
    { dependent_id: dependent, depends_on_id: first },
    { dependent_id: another, depends_on_id: first },
  ].sort(
    (a, b) =>
      a.dependent_id.localeCompare(b.dependent_id) ||
      a.depends_on_id.localeCompare(b.depends_on_id),
  );
  assert.deepEqual(plan.removed_edges, expected);
  assert.deepEqual(dependsOnOf(f.read(dependent)), [first]);
  const result = f.apply(first, f.request(plan));
  assert.deepEqual(result.retired_node_ids, [first]);
  assert.deepEqual(result.removed_edges, expected);
  assert.deepEqual(dependsOnOf(f.read(dependent)), []);
  assert.deepEqual(dependsOnOf(f.read(another)), []);
  assert.equal(f.node(dependent)?.state, NodeState.Available);
  assert.equal(f.node(another)?.state, NodeState.Available);
  assert.deepEqual(
    f.jobs().map((job) => job.node_id),
    [dependent, another].sort(),
  );
  assert.deepEqual(f.snapshot().dependencies, []);
});

test("forced retirement refuses a guarded dependent and writes nothing", (t) => {
  const f = retireFixture(t);
  const { node_id: nodeId, depends_on_id: dependsOnId } = f.pair();
  f.edit(DependencyOperation.Add, nodeId, dependsOnId);
  for (const state of DEPENDENCY_GUARDED_STATES) {
    f.setState(nodeId, state);
    f.refuses(
      dependsOnId,
      ControlError.StateConflict,
      { node_id: nodeId, state, attempt: NO_ATTEMPT },
      HttpStatus.Conflict,
      true,
    );
  }
  pauseOnRequest(f, nodeId);
  f.refuses(
    dependsOnId,
    ControlError.StateConflict,
    { node_id: nodeId, state: NodeState.Paused, attempt: FIRST_REVISION },
    HttpStatus.Conflict,
    true,
  );
});

for (const state of [NodeState.Completed, NodeState.Discarded]) {
  test(`node.retire preserves ${state} dependent history with and without force`, (t) => {
    const f = retireFixture(t);
    const { node_id: nodeId, depends_on_id: dependsOnId } = f.pair();
    f.edit(DependencyOperation.Add, nodeId, dependsOnId);
    f.setState(nodeId, state);
    const dependencies = f.snapshot().dependencies;
    assert.deepEqual(f.preview(dependsOnId).removed_edges, []);
    const plan = f.preview(dependsOnId, { force: "true" });
    assert.deepEqual(plan.removed_edges, []);
    f.apply(dependsOnId, f.request(plan));
    assert.deepEqual(f.snapshot().dependencies, dependencies);
    assert.equal(f.node(nodeId)?.state, state);
    assert.equal(
      f.jobs().some((job) => job.node_id === nodeId),
      false,
    );
  });
}

test("node retire of an implement node keeps its tasks in its last revision", (t) => {
  const f = retireFixture(t);
  const implement = f.implement();
  const task = f.task(implement);
  const sibling = f.task(implement, OTHER_FILENAME);
  const previous = f.store.transaction((tx) =>
    readCurrentRevision(tx, implement),
  )!;
  const plan = f.preview(implement);
  assert.deepEqual(plan.retired_node_ids, [implement]);
  const result = f.apply(implement, f.request(plan));
  assert.deepEqual(result.retired_node_ids, [implement]);
  assert.deepEqual(result.revisions, []);
  const retired = f.get(implement);
  assert.ok(retired.retired_at);
  assert.equal(retired.visible_revision, previous.revision);
  assert.deepEqual(
    retired.tasks.map((item) => item.id),
    [task, sibling],
  );
  assert.equal(
    f.store.transaction((tx) => readCurrentRevision(tx, implement))?.revision,
    previous.revision,
  );
});

test("node.retire keeps retired runnable identity, filename, content and revisions readable", (t) => {
  const f = retireFixture(t);
  const id = f.implement();
  const before = f.get(id);
  const revisions = f.snapshot().revisions;
  f.apply(id, f.request(f.preview(id)));
  assert.deepEqual(f.get(id), {
    ...before,
    retired_at: f.node(id)!.retired_at,
  });
  const operation = missionOperations["node.revision.list"];
  const input = operation.input.parse({
    params: { node_id: id },
    query: {},
    body: null,
  });
  const result = operation.output.parse(
    f.registry.get(operation.id).handler(input, f.caller),
  );
  assert.equal(result.items.length, SINGLE_ITEM);
  assert.equal(result.items[FIRST_ELEMENT_INDEX]!.node_id, id);
  assert.equal(result.items[FIRST_ELEMENT_INDEX]!.filename, before.filename);
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
  const id = f.implement();
  const plan = f.preview(id);
  const body = f.request(plan);
  const before = { ...f.snapshot(), jobs: f.jobs() };
  assert.throws(
    () => f.apply(id, { ...body, preview_digest: INVALID_RETIRE_DIGEST }),
    retirementError(MissionErrorCode.RetireMismatch),
  );
  assert.deepEqual({ ...f.snapshot(), jobs: f.jobs() }, before);
  f.setState(id, NodeState.Executing);
  assert.throws(
    () =>
      f.apply(id, {
        ...body,
        expected_mission_version: MISSION_INITIAL_VERSION,
        reason: "x".repeat(TEXT_MAX_BYTES + VERSION_INCREMENT),
      }),
    retirementError(MissionErrorCode.VersionConflict, {
      current: plan.mission_version,
    }),
  );
  assert.throws(
    () =>
      f.apply(id, {
        ...body,
        reason: "x".repeat(TEXT_MAX_BYTES + VERSION_INCREMENT),
      }),
    retirementError(
      MissionErrorCode.ContentInvalid,
      undefined,
      HttpStatus.BadRequest,
    ),
  );
  assert.throws(
    () => f.apply(id, body),
    retirementError(MissionErrorCode.RetireRefused, {
      node_id: id,
      state: NodeState.Executing,
      attempt: NO_ATTEMPT,
    }),
  );
  f.setState(id, NodeState.Available);
  f.apply(id, body);
  assert.throws(
    () => f.apply(id, body),
    retirementError(MissionErrorCode.Retired, { node_id: id }),
  );
});

test("node.retire detects a changed dependency digest even without a mission version change", (t) => {
  const f = retireFixture(t);
  const { node_id: nodeId, depends_on_id: dependsOnId } = f.pair();
  const plan = f.preview(dependsOnId, { force: "true" });
  f.store.database
    .prepare(
      "INSERT INTO mission_dependency (mission_id, dependent_id, depends_on_id) VALUES (?, ?, ?)",
    )
    .run(f.mission_id, nodeId, dependsOnId);
  const before = { ...f.snapshot(), jobs: f.jobs() };
  const changed = f.preview(dependsOnId, { force: "true" });
  assert.equal(changed.mission_version, plan.mission_version);
  assert.notEqual(changed.preview_digest, plan.preview_digest);
  assert.throws(
    () => f.apply(dependsOnId, f.request(plan)),
    retirementError(MissionErrorCode.RetireMismatch),
  );
  assert.deepEqual({ ...f.snapshot(), jobs: f.jobs() }, before);
});

test("node.retire digest binds force and mission version", (t) => {
  const f = retireFixture(t);
  const id = f.examine();
  const plan = f.preview(id);
  assert.notEqual(
    f.preview(id, { force: "true" }).preview_digest,
    plan.preview_digest,
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
      current: plan.mission_version + VERSION_INCREMENT,
    }),
  );
  assert.throws(
    () =>
      f.apply(id, {
        ...f.request(plan),
        expected_mission_version: plan.mission_version + VERSION_INCREMENT,
      }),
    retirementError(MissionErrorCode.RetireMismatch),
  );
  assert.deepEqual({ ...f.snapshot(), jobs: f.jobs() }, before);
});

test("node.retire rolls back retirement, dependency removal, routing and jobs when queue deletion fails", (t) => {
  const f = retireFixture(t);
  const { node_id: nodeId, depends_on_id: dependsOnId } = f.pair();
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

function isNodeEntry(entry: ImportEntry): entry is ImportNodeEntry {
  return "work" in entry;
}

function importPreviewFixture(t: TestContext) {
  const f = nodeFixture(t);
  f.examine();
  const implementId = f.implement();
  addTask(f, implementId);
  const entries: ImportEntry[] = f.store.transaction((tx) => {
    const nodes = readMissionNodes(tx, f.mission_id);
    return nodes.flatMap((node) => {
      const record = nodeRecord(tx, node, bindings);
      return [
        {
          id: node.id,
          filename: node.filename,
          ...record.content,
          bindings:
            record.content.work === Work.Implement ? [REPOSITORY_NAME] : [],
        },
        ...record.tasks.map((task) => ({
          id: task.id,
          filename: task.filename,
          node: node.filename,
          ...task.content,
        })),
      ];
    });
  });
  const snapshot: Extract<
    ImportSnapshot,
    { format: typeof ImportFormat.Json }
  > = {
    format: ImportFormat.Json,
    mission_id: f.mission_id,
    mission_version: f.version(),
    reason: REASON,
    entries,
  };
  function preview(body: ImportSnapshot = snapshot, missionId = f.mission_id) {
    const operation = missionOperations["import.preview"];
    const input = operation.input.parse({
      params: { mission_id: missionId },
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
        entry.id === implementId ? { ...entry, ...patch } : entry,
      ),
    };
  }
  return {
    ...f,
    entries,
    importSnapshot: snapshot,
    implementId,
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
  assert.deepEqual(
    result.no_ops,
    f.entries
      .filter(isNodeEntry)
      .map((entry) => entry.id!)
      .sort(),
  );
  assert.deepEqual(
    [result.creates, result.updates, result.retirements, result.removed_edges],
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
      result.removed_edges,
      result.no_ops,
    ],
    [[], [], [], [], []],
  );
  assert.equal(
    result.preview_digest,
    importDigest(
      f.mission_id,
      snapshot.mission_version,
      normalizeImportSnapshot(snapshot, f.mission_id, TEXT_MAX_BYTES).entries,
      [],
    ),
  );
});

test("import.preview malformed Markdown digest omits refused files and does not resolve references", (t) => {
  const f = importPreviewFixture(t);
  const snapshot: ImportSnapshot = {
    mission_id: f.mission_id,
    mission_version: f.importSnapshot.mission_version,
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
    result.preview_digest,
    importDigest(f.mission_id, snapshot.mission_version, [], []),
  );
  assert.deepEqual(result.retirements, []);
});

for (const [label, patch, code] of [
  ["cycle", { depends_on: [IMPLEMENT_FILENAME] }, MissionErrorCode.Cycle],
  ["unknown identity", { id: UNKNOWN_NODE_ID }, MissionErrorCode.UnknownId],
  [
    "unresolved binding",
    { bindings: [UNKNOWN_NAME] },
    MissionErrorCode.BindingsInvalid,
  ],
] satisfies Array<[string, Partial<ImportEntry>, string]>) {
  test(`import.preview stage two rejects ${label} without running stage three`, (t) => {
    const f = importPreviewFixture(t);
    f.setState(f.implementId, NodeState.Completed);
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
        result.removed_edges,
        result.no_ops,
      ],
      [[], [], [], [], []],
    );
    if (code === MissionErrorCode.BindingsInvalid)
      assert.deepEqual(result.violations[FIRST_ELEMENT_INDEX]?.details, {
        binding: UNKNOWN_NAME,
      });
  });
}

test("import.preview stage two rejects a retired identity", (t) => {
  const f = importPreviewFixture(t);
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, f.implementId);
  const result = f.preview();
  assert.deepEqual(
    result.violations.map((value) => value.code),
    [MissionErrorCode.RetiredId, MissionErrorCode.RetiredId],
  );
  assert.ok(
    result.violations.some(
      (value) =>
        JSON.stringify(value.details) === JSON.stringify({ id: f.implementId }),
    ),
  );
});

for (const [state, attempt] of [
  [NodeState.Executing, NO_ATTEMPT],
  [NodeState.Available, FIRST_ATTEMPT],
] as const) {
  test(`import.preview stage three rejects ${state} at attempt ${attempt}`, (t) => {
    const f = importPreviewFixture(t);
    f.store.database
      .prepare("UPDATE mission_node SET state = ?, attempt = ? WHERE id = ?")
      .run(state, attempt, f.implementId);
    const result = f.preview(f.changed({ name: "Changed" }));
    assert.deepEqual(result.updates, [f.implementId]);
    assert.deepEqual(
      result.violations.map(({ code, node_id: nodeId, details }) => ({
        code,
        node_id: nodeId,
        details,
      })),
      [
        {
          code: MissionErrorCode.ConditionFailed,
          node_id: f.implementId,
          details: { state, attempt },
        },
      ],
    );
  });
}

test("import.preview terminal noOps are allowed but changes are terminal_change", (t) => {
  const f = importPreviewFixture(t);
  f.setState(f.implementId, NodeState.Completed);
  assert.deepEqual(f.preview().violations, []);
  const result = f.preview(f.changed({ name: "Changed" }));
  assert.deepEqual(
    result.violations.map(({ code, node_id: nodeId, details }) => ({
      code,
      node_id: nodeId,
      details,
    })),
    [
      {
        code: MissionErrorCode.TerminalChange,
        node_id: f.implementId,
        details: { node_id: f.implementId },
      },
    ],
  );
});

test("import.preview checks mission existence, version and reason before stages", (t) => {
  const f = importPreviewFixture(t);
  const invalid = {
    ...f.importSnapshot,
    mission_version: MISSION_INITIAL_VERSION,
    reason: "x".repeat(TEXT_MAX_BYTES + VERSION_INCREMENT),
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
      current: f.importSnapshot.mission_version,
    }),
  );
  assert.throws(
    () =>
      f.preview({
        ...invalid,
        mission_version: f.importSnapshot.mission_version,
      }),
    retirementError(
      MissionErrorCode.ContentInvalid,
      { field: "reason" },
      HttpStatus.BadRequest,
    ),
  );
  assert.equal(f.commits(), commits + THREE_COMMITS);
  assert.deepEqual(f.snapshot(), before);
});

test("import.preview empty set retires every current node without writes or queue calls", (t) => {
  const f = importPreviewFixture(t);
  const result = f.preview({ ...f.importSnapshot, entries: [] });
  assert.deepEqual(
    result.retirements,
    f.entries
      .filter(isNodeEntry)
      .map((entry) => entry.id!)
      .sort(),
  );
  assert.deepEqual(result.violations, []);
  assert.deepEqual(result.removed_edges, []);
  assert.equal(
    result.preview_digest,
    importDigest(
      f.mission_id,
      f.importSnapshot.mission_version,
      [],
      result.retirements,
    ),
  );
});

test("import.preview equivalent Markdown and JSON plans have identical classifications and digest", (t) => {
  const f = importPreviewFixture(t);
  const entries = [
    ...f.entries.map((entry) =>
      entry.id === f.implementId ? { ...entry, name: "Changed" } : entry,
    ),
    {
      ...f.entries
        .filter(isNodeEntry)
        .find((entry) => entry.work === Work.Examine)!,
      id: undefined,
      filename: NEW_FILENAME,
    },
  ];
  const json = f.preview({ ...f.importSnapshot, entries });
  const markdown = f.preview({
    format: ImportFormat.Markdown,
    mission_id: f.mission_id,
    mission_version: f.importSnapshot.mission_version,
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
  assert.deepEqual(json.updates, [f.implementId]);
});

const IMPORT_APPLY_PATH = "/api/mission/:mission_id/import";
const IMPORT_QUEUE_FAILURE = "import queue insert failed";
const IMPORT_UPDATED_NAME = "Updated imported content";
const IMPORT_EXTRA_TASK = "extra-task.md";
const IMPORT_OTHER_TASK = "other-task.md";
const IMPORT_NEW_TASK = "new-task.md";
const IMPORT_NEW_DEPENDENT = "new-dependent.md";
const IMPORT_NODE_COUNT = 5;

function assignedId(result: ImportResult, filename: string): string {
  const item = result.assigned_ids.find((entry) => entry.filename === filename);
  assert.ok(item);
  return "node_id" in item ? item.node_id : item.task_id;
}

function importApplyFixture(
  t: TestContext,
  bindingRevision?: MissionBindings["getBindingRevision"],
  text_max_bytes?: number,
  collaborators: Partial<Collaborators> = {},
) {
  const f = dependencyFixture(
    t,
    bindingRevision,
    text_max_bytes,
    collaborators,
  );
  function entry(filename: string, work: Work): ImportNodeEntry {
    return {
      filename,
      work,
      name: NODE_TEXT,
      requirement: NODE_TEXT,
      criterion: NODE_TEXT,
      verifications: [VERIFICATION],
      bindings: work === Work.Implement ? [REPOSITORY_NAME] : [],
    };
  }
  function taskEntry(filename: string, node: string): ImportTaskEntry {
    return {
      filename,
      node,
      name: NODE_TEXT,
      requirement: NODE_TEXT,
      criterion: NODE_TEXT,
      verifications: [VERIFICATION],
      bindings: [],
    };
  }
  const initial: ImportEntry[] = [
    {
      ...entry(EXAMINE_FILENAME, Work.Examine),
      depends_on: [IMPLEMENT_FILENAME, OTHER_FILENAME],
    },
    entry(IMPLEMENT_FILENAME, Work.Implement),
    {
      ...entry(OTHER_FILENAME, Work.Implement),
      depends_on: [IMPLEMENT_FILENAME],
    },
    taskEntry(TASK_FILENAME, IMPLEMENT_FILENAME),
    taskEntry(IMPORT_OTHER_TASK, OTHER_FILENAME),
  ];
  function snapshot(entries: ImportEntry[] = initial): ImportSnapshot {
    return {
      format: ImportFormat.Json,
      mission_id: f.mission_id,
      mission_version: f.version(),
      reason: REASON,
      entries,
    };
  }
  function preview(body: ImportSnapshot) {
    const operation = missionOperations["import.preview"];
    return operation.output.parse(
      f.registry.get(operation.id).handler(
        operation.input.parse({
          params: { mission_id: f.mission_id },
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
      preview_digest: plan.preview_digest,
      confirmed_retirements: plan.retirements,
    };
  }
  function apply(body: ImportApply, missionId = f.mission_id) {
    const operation = missionOperations["import.apply"];
    const input = operation.input.parse({
      params: { mission_id: missionId },
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
      result.assigned_ids.map((item) => [
        item.filename,
        "node_id" in item ? item.node_id : item.task_id,
      ]),
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
    taskEntry,
    initial,
    importSnapshot: snapshot,
    preview,
    request,
    apply,
    identified,
    state,
  };
}

test("import dependency additions settle a live dependent and dependency-only edits bypass the content import condition", (t) => {
  const claimed = new Set<string>();
  const settled = new Set<string>();
  const executionId = createIdentity("execution");
  const f = importApplyFixture(t, undefined, undefined, {
    schedulerClaims: {
      revoke: () => assert.fail(),
      settle: (_tx, id) => {
        settled.add(id);
      },
      liveExecutionOf: (_tx, id) => {
        assert.ok(settled.has(id));
        return claimed.has(id)
          ? {
              execution_id: executionId,
              runtime_identity: "runtime",
              attempt: 1,
              pinned_revision: 1,
            }
          : null;
      },
    },
  });
  const entries = [...f.initial, f.entry(IMPORT_NEW_DEPENDENT, Work.Examine)];
  const ids = f.identified(
    f.apply(f.request(f.importSnapshot(entries))),
    entries,
  );
  const parentId = ids.find((item) => item.filename === EXAMINE_FILENAME)!.id!;
  f.store.transaction((tx) =>
    openAttempt(tx, parentId, FIRST_REVISION, HUMAN_ACTOR, CREATED_AT),
  );
  const modified = ids.map((item) =>
    item.id === parentId
      ? { ...item, depends_on: [IMPORT_NEW_DEPENDENT] }
      : item,
  );
  const body = f.request(f.importSnapshot(modified));
  claimed.add(parentId);
  const before = f.state();
  assert.throws(
    () => f.apply(body),
    (error) => {
      assert.ok(error instanceof OperationError);
      assert.equal(error.code, MissionErrorCode.ClaimLive);
      assert.equal(error.status, HttpStatus.Conflict);
      assert.deepEqual(error.details, {
        node_id: parentId,
        execution_id: executionId,
      });
      return true;
    },
  );
  assert.deepEqual(f.state(), before);
  claimed.clear();
  const applied = f.apply(body);
  assert.deepEqual(applied.changes.revisions, []);
  assert.equal(
    f.store.transaction((tx) => readOpenAttempt(tx, parentId))?.attempt,
    FIRST_REVISION,
  );
  const removed = f.apply(f.request(f.importSnapshot(ids)));
  assert.equal(removed.changes.removed_edges.length, SINGLE_ITEM);
});

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
  assert.equal(
    result.mission_version,
    body.mission_version + VERSION_INCREMENT,
  );
  assert.equal(result.changes.mission_version, result.mission_version);
  assert.equal(f.version(), result.mission_version);
  assert.equal(result.assigned_ids.length, IMPORT_NODE_COUNT);
  assert.deepEqual(
    result.assigned_ids.map((item) => item.filename),
    f.initial.map((item) => item.filename).sort(),
  );
  assert.deepEqual(result.actor, humanActor(f.caller));
  assert.ok(result.accepted_at >= CREATED_AT);
  const ids = new Map(
    result.assigned_ids.map((item) => [
      item.filename,
      assignedId(result, item.filename),
    ]),
  );
  const implement = ids.get(IMPLEMENT_FILENAME)!;
  const task = ids.get(TASK_FILENAME)!;
  assert.ok(identitySchema("task").safeParse(task).success);
  assert.equal(f.node(task), null);
  assert.equal(f.node(ids.get(OTHER_FILENAME)!)?.state, NodeState.Pending);
  assert.deepEqual(dependsOnOf(f.read(ids.get(OTHER_FILENAME)!)), [implement]);
  assert.deepEqual(
    dependsOnOf(f.read(ids.get(EXAMINE_FILENAME)!)),
    [implement, ids.get(OTHER_FILENAME)!].sort(),
  );
  assert.equal(f.node(ids.get(EXAMINE_FILENAME)!)?.state, NodeState.Pending);
  assert.deepEqual(
    f.jobs().map((job) => job.node_id),
    [implement],
  );
  assert.equal(result.changes.revisions.length, THREE_REVISIONS);
  assert.equal(
    f.store.transaction((tx) => readCurrentRevision(tx, task)),
    null,
  );
  const revision = result.changes.revisions.find(
    (item) => item.node_id === implement,
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
    previous_revision: null,
    changed_fields: [...CONTENT_FIELDS, TASKS_FIELD],
    tasks: [
      {
        id: task,
        change: TaskChange.Created,
        changed_fields: [...TASK_CONTENT_FIELDS],
      },
    ],
  });
  assert.equal(result.changes.added_edges.length, THREE_REVISIONS);
  assert.deepEqual(result.changes.removed_edges, []);
  assert.deepEqual(result.changes.open_attempts_unchanged, []);
  assert.deepEqual(
    result.changes.revisions.map((item) => item.node_id),
    result.changes.revisions.map((item) => item.node_id).sort(),
  );
  for (const revision of result.changes.revisions) {
    assert.equal(revision.revision, FIRST_REVISION);
    assert.equal(revision.change.write, RevisionWrite.Import);
    assert.equal(revision.reason, REASON);
    assert.deepEqual(revision.actor, result.actor);
    assert.equal(revision.created_at, result.accepted_at);
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
  assert.equal(result.mission_version, first.mission_version);
  assert.deepEqual(result.assigned_ids, first.assigned_ids);
  assert.deepEqual(result.changes, {
    mission_version: first.mission_version,
    revisions: [],
    retired_node_ids: [],
    added_edges: [],
    removed_edges: [],
    open_attempts_unchanged: [],
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
    {
      ...f.initial[FIRST_ELEMENT_INDEX]!,
      filename: "../invalid.md",
      id: UNKNOWN_NODE_ID,
    },
    { ...f.initial[SECOND_ENTRY_INDEX]!, bindings: [UNKNOWN_NAME] },
  ]);
  const first = f.preview(snapshot).violations[FIRST_ELEMENT_INDEX]!;
  const before = f.state();
  assert.throws(
    () =>
      f.apply({
        ...snapshot,
        preview_digest: INVALID_RETIRE_DIGEST,
        confirmed_retirements: [],
      }),
    retirementError(
      first.code,
      { field: "filename", filename: first.filename, node_id: first.node_id },
      HttpStatus.BadRequest,
    ),
  );
  assert.deepEqual(f.state(), before);
});

for (const [label, patch, code] of [
  ["unknown id", { id: UNKNOWN_NODE_ID }, MissionErrorCode.UnknownId],
  ["binding", { bindings: [UNKNOWN_NAME] }, MissionErrorCode.BindingsInvalid],
  [
    "reference",
    { depends_on: [NEW_FILENAME] },
    MissionErrorCode.UnresolvedReference,
  ],
  ["cycle", { depends_on: [IMPLEMENT_FILENAME] }, MissionErrorCode.Cycle],
] satisfies Array<[string, Partial<ImportEntry>, string]>) {
  test(`import.apply maps resolved ${label} violations to 400 with locators and no effects`, (t) => {
    const f = importApplyFixture(t);
    const snapshot = f.importSnapshot(
      f.initial.map((item) =>
        item.filename === IMPLEMENT_FILENAME ? { ...item, ...patch } : item,
      ),
    );
    const violation = f.preview(snapshot).violations[FIRST_ELEMENT_INDEX]!;
    assert.equal(violation.code, code);
    const before = f.state();
    assert.throws(
      () =>
        f.apply({
          ...snapshot,
          preview_digest: INVALID_RETIRE_DIGEST,
          confirmed_retirements: [],
        }),
      retirementError(
        code,
        {
          ...(violation.details as object),
          filename: violation.filename,
          node_id: violation.node_id,
        },
        HttpStatus.BadRequest,
      ),
    );
    assert.deepEqual(f.state(), before);
  });
}

const IMPORT_COMMAND = "pnpm test";
const IMPORT_NEAR_MISS_COMMAND = "pnpm  test";

for (const [label, taskCommand] of [
  ["a near-miss task command", IMPORT_NEAR_MISS_COMMAND],
] as const) {
  test(`import.preview and import.apply refuse an implement verification uncovered by ${label}`, (t) => {
    const f = importApplyFixture(t);
    const snapshot = f.importSnapshot(
      f.initial.flatMap((item) => {
        if (item.filename === IMPLEMENT_FILENAME)
          return [{ ...item, verifications: [IMPORT_COMMAND] }];
        if (item.filename !== TASK_FILENAME) return [item];
        return [{ ...item, verifications: [taskCommand] }];
      }),
    );
    const violation = f.preview(snapshot).violations[FIRST_ELEMENT_INDEX]!;
    assert.equal(violation.code, MissionErrorCode.VerificationUncovered);
    assert.deepEqual(violation.details, {
      name: IMPLEMENT_FILENAME,
      command: IMPORT_COMMAND,
    });
    const before = f.state();
    assert.throws(
      () =>
        f.apply({
          ...snapshot,
          preview_digest: INVALID_RETIRE_DIGEST,
          confirmed_retirements: [],
        }),
      retirementError(
        MissionErrorCode.VerificationUncovered,
        {
          name: IMPLEMENT_FILENAME,
          command: IMPORT_COMMAND,
          filename: IMPLEMENT_FILENAME,
          node_id: violation.node_id,
        },
        HttpStatus.BadRequest,
      ),
    );
    assert.deepEqual(f.state(), before);
  });
}

test("import.preview accepts an implement node with no task file", (t) => {
  const f = importApplyFixture(t);
  const snapshot = f.importSnapshot(
    f.initial.flatMap((item) => {
      if (item.filename === IMPLEMENT_FILENAME)
        return [{ ...item, verifications: [IMPORT_COMMAND] }];
      return item.filename === TASK_FILENAME ? [] : [item];
    }),
  );
  assert.deepEqual(f.preview(snapshot).violations, []);
});

test("import.preview accepts an implement verification that a task of the node holds exactly", (t) => {
  const f = importApplyFixture(t);
  const snapshot = f.importSnapshot(
    f.initial.map((item) =>
      item.filename === IMPLEMENT_FILENAME
        ? { ...item, verifications: [IMPORT_COMMAND] }
        : item.filename === TASK_FILENAME
          ? { ...item, verifications: [VERIFICATION, IMPORT_COMMAND] }
          : item,
    ),
  );
  assert.deepEqual(f.preview(snapshot).violations, []);
});

for (const [state, code] of [
  [NodeState.Executing, MissionErrorCode.ConditionFailed],
  [NodeState.Completed, MissionErrorCode.TerminalChange],
] as const) {
  test(`import.apply maps ${state} condition violations to 409 before digest mismatch`, (t) => {
    const f = importApplyFixture(t);
    const first = f.apply(f.request());
    const entries = f.identified(first);
    const implement = entries.find(
      (item) => item.filename === IMPLEMENT_FILENAME,
    )!;
    f.setState(implement.id!, state);
    const snapshot = f.importSnapshot(
      entries.map((item) =>
        item.id === implement.id
          ? { ...item, name: IMPORT_UPDATED_NAME }
          : item,
      ),
    );
    const before = f.state();
    assert.throws(
      () =>
        f.apply({
          ...snapshot,
          preview_digest: INVALID_RETIRE_DIGEST,
          confirmed_retirements: [],
        }),
      retirementError(code, {
        ...(code === MissionErrorCode.ConditionFailed
          ? { state, attempt: NO_ATTEMPT }
          : {}),
        filename: IMPLEMENT_FILENAME,
        node_id: implement.id,
      }),
    );
    assert.deepEqual(f.state(), before);
  });
}

test("import.apply refuses a dependency edit on a Waiting dependent", (t) => {
  const f = importApplyFixture(t);
  const entries = f.identified(f.apply(f.request()));
  const other = entries.find((item) => item.filename === OTHER_FILENAME)!;
  f.setState(other.id!, NodeState.Waiting);
  const snapshot = f.importSnapshot(
    entries.map((item) =>
      item.id === other.id ? { ...item, depends_on: [] } : item,
    ),
  );
  const before = f.state();
  assert.throws(
    () =>
      f.apply({
        ...snapshot,
        preview_digest: INVALID_RETIRE_DIGEST,
        confirmed_retirements: [],
      }),
    retirementError(ControlError.StateConflict, {
      state: NodeState.Waiting,
      attempt: NO_ATTEMPT,
      filename: OTHER_FILENAME,
      node_id: other.id,
    }),
  );
  assert.deepEqual(f.state(), before);
});

test("import.apply checks existence then version then reason without changing rows", (t) => {
  const f = importApplyFixture(t);
  const body = f.request();
  f.apply(body);
  const before = f.state();
  const invalid = {
    ...body,
    reason: "x".repeat(TEXT_MAX_BYTES + VERSION_INCREMENT),
  };
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
      current: body.mission_version + VERSION_INCREMENT,
    }),
  );
  assert.throws(
    () => f.apply({ ...invalid, mission_version: f.version() }),
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
    { ...body, preview_digest: INVALID_RETIRE_DIGEST },
    { ...body, confirmed_retirements: [] },
    {
      ...body,
      confirmed_retirements: [
        ...body.confirmed_retirements.slice(SECOND_ENTRY_INDEX),
        UNKNOWN_NODE_ID,
      ],
    },
    {
      ...body,
      confirmed_retirements: [...body.confirmed_retirements, UNKNOWN_NODE_ID],
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
    confirmed_retirements: [
      ...body.confirmed_retirements,
      ...body.confirmed_retirements,
    ],
  });
  assert.deepEqual(result.changes.retired_node_ids, body.confirmed_retirements);
  assert.deepEqual(f.jobs(), []);
});

test("import.apply task rename and move, implement retirement and dependency replacement write import revisions atomically", (t) => {
  const f = importApplyFixture(t);
  const first = f.apply(f.request());
  const entries = f.identified(first);
  const oldImplement = entries.find(
    (item) => item.filename === IMPLEMENT_FILENAME,
  )!.id!;
  const newImplement = entries.find(
    (item) => item.filename === OTHER_FILENAME,
  )!.id!;
  const task = entries.find((item) => item.filename === TASK_FILENAME)!.id!;
  const examineId = entries.find(
    (item) => item.filename === EXAMINE_FILENAME,
  )!.id!;
  const next = entries
    .filter((item) => item.id !== oldImplement)
    .map((item) => {
      if (item.id === newImplement)
        return {
          ...item,
          depends_on: [NEW_FILENAME],
          name: IMPORT_UPDATED_NAME,
        };
      if (item.id === examineId)
        return { ...item, depends_on: [OTHER_FILENAME] };
      if (item.id === task)
        return { ...item, filename: IMPORT_NEW_TASK, node: OTHER_FILENAME };
      return item;
    });
  next.push(f.entry(NEW_FILENAME, Work.Examine));
  const body = f.request(f.importSnapshot(next));
  const result = f.apply(body);
  assert.equal(
    result.mission_version,
    first.mission_version + VERSION_INCREMENT,
  );
  assert.equal(f.node(oldImplement)?.retired_at, result.accepted_at);
  assert.equal(f.node(task), null);
  const oldRevision = result.changes.revisions.find(
    (item) => item.node_id === oldImplement,
  )!;
  const newRevision = result.changes.revisions.find(
    (item) => item.node_id === newImplement,
  )!;
  assert.deepEqual(oldRevision.change.tasks, [
    { id: task, change: TaskChange.MovedOut, changed_fields: [] },
  ]);
  assert.deepEqual(oldRevision.tasks, []);
  assert.deepEqual(newRevision.change.tasks, [
    {
      id: task,
      change: TaskChange.MovedIn,
      changed_fields: [...TASK_CONTENT_FIELDS],
    },
  ]);
  assert.deepEqual(newRevision.change.changed_fields, [
    ContentField.Name,
    TASKS_FIELD,
  ]);
  assert.equal(
    newRevision.tasks?.find((item) => item.id === task)?.filename,
    IMPORT_NEW_TASK,
  );
  assert.equal(newRevision.revision, NEXT_REVISION);
  assert.ok(
    result.changes.revisions.every(
      (item) => item.change.write === RevisionWrite.Import,
    ),
  );
  assert.deepEqual(result.changes.retired_node_ids, [oldImplement]);
  assert.deepEqual(
    result.changes.removed_edges,
    [
      { dependent_id: examineId, depends_on_id: oldImplement },
      { dependent_id: newImplement, depends_on_id: oldImplement },
    ].sort(
      (a, b) =>
        a.dependent_id.localeCompare(b.dependent_id) ||
        a.depends_on_id.localeCompare(b.depends_on_id),
    ),
  );
  const created = assignedId(result, NEW_FILENAME);
  assert.deepEqual(
    f.jobs().map((job) => job.node_id),
    [created],
  );
  assert.equal(f.node(newImplement)?.state, NodeState.Pending);
  assert.equal(f.node(examineId)?.state, NodeState.Pending);
  assert.deepEqual(
    f
      .state()
      .dependencies.map((edge) => ({ ...edge }))
      .sort(
        (a, b) =>
          String(a.dependent_id).localeCompare(String(b.dependent_id)) ||
          String(a.depends_on_id).localeCompare(String(b.depends_on_id)),
      ),
    [
      {
        mission_id: f.mission_id,
        dependent_id: examineId,
        depends_on_id: newImplement,
      },
      {
        mission_id: f.mission_id,
        dependent_id: newImplement,
        depends_on_id: created,
      },
    ].sort(
      (a, b) =>
        a.dependent_id.localeCompare(b.dependent_id) ||
        a.depends_on_id.localeCompare(b.depends_on_id),
    ),
  );
});

test("import.apply retains stored task order, appends creates in set order and coalesces all task changes into one implement revision", (t) => {
  const f = importApplyFixture(t);
  const initial = [
    ...f.initial,
    f.taskEntry(IMPORT_EXTRA_TASK, IMPLEMENT_FILENAME),
  ];
  const first = f.apply(f.request(f.importSnapshot(initial)));
  const entries = f.identified(first, initial);
  const originalTask = entries.find((item) => item.filename === TASK_FILENAME)!;
  const retiredTask = entries.find(
    (item) => item.filename === IMPORT_EXTRA_TASK,
  )!;
  const next = [
    f.taskEntry(IMPORT_NEW_TASK, IMPLEMENT_FILENAME),
    ...entries
      .filter((item) => item.id !== retiredTask.id)
      .reverse()
      .map((item) =>
        item.id === originalTask.id
          ? { ...item, filename: NEW_FILENAME, name: IMPORT_UPDATED_NAME }
          : item,
      ),
    f.taskEntry(IMPORT_EXTRA_TASK, IMPLEMENT_FILENAME),
  ];
  const result = f.apply(f.request(f.importSnapshot(next)));
  assert.equal(result.changes.revisions.length, SINGLE_ITEM);
  const revision = result.changes.revisions[FIRST_ELEMENT_INDEX]!;
  assert.deepEqual(
    revision.tasks?.map((item) => item.filename),
    [NEW_FILENAME, IMPORT_NEW_TASK, IMPORT_EXTRA_TASK],
  );
  assert.deepEqual(revision.change.changed_fields, [TASKS_FIELD]);
  assert.deepEqual(
    revision.change.tasks?.slice(FIRST_ELEMENT_INDEX, TWO_ITEMS),
    [
      {
        id: originalTask.id,
        change: TaskChange.Updated,
        changed_fields: [ContentField.Filename, ContentField.Name],
      },
      { id: retiredTask.id, change: TaskChange.Retired, changed_fields: [] },
    ],
  );
  assert.ok(
    revision.change.tasks
      ?.slice(TWO_ITEMS)
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
  const old = entries.find((item) => item.filename === IMPLEMENT_FILENAME)!.id!;
  const next = entries.map((item) =>
    item.id === old ? { ...item, id: undefined } : item,
  );
  const result = f.apply(f.request(f.importSnapshot(next)));
  const replacement = assignedId(result, IMPLEMENT_FILENAME);
  assert.notEqual(replacement, old);
  assert.equal(f.node(old)?.retired_at, result.accepted_at);
  assert.equal(f.node(replacement)?.retired_at, null);
  assert.deepEqual(
    f.jobs().map((job) => job.node_id),
    [replacement],
  );
  assert.deepEqual(result.changes.retired_node_ids, [old]);
  assert.deepEqual(
    f.store.database.prepare("PRAGMA foreign_key_check").all(),
    [],
  );
});

test("import.apply rolls back every row including jobs after a late queue insertion failure", (t) => {
  const f = importApplyFixture(t);
  const first = f.apply(f.request());
  const entries = f.identified(first);
  const old = entries.find((item) => item.filename === IMPLEMENT_FILENAME)!.id!;
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
  assert.equal(
    result.mission_version,
    first.mission_version + VERSION_INCREMENT,
  );
});

test("import.apply handles filename swaps and a new dependent without transient uniqueness or foreign key failures", (t) => {
  const f = importApplyFixture(t);
  const first = f.apply(f.request());
  const entries = f.identified(first);
  const next: ImportEntry[] = entries.map((item) => {
    if (item.filename === IMPLEMENT_FILENAME)
      return { ...item, filename: OTHER_FILENAME };
    if (item.filename === OTHER_FILENAME)
      return {
        ...item,
        filename: IMPLEMENT_FILENAME,
        depends_on: [OTHER_FILENAME],
      };
    if (!isNodeEntry(item))
      return {
        ...item,
        node:
          item.node === IMPLEMENT_FILENAME
            ? OTHER_FILENAME
            : IMPLEMENT_FILENAME,
      };
    return item;
  });
  next.push({
    ...f.entry(IMPORT_NEW_DEPENDENT, Work.Examine),
    depends_on: [OTHER_FILENAME],
  });
  const result = f.apply(f.request(f.importSnapshot(next)));
  const dependent = assignedId(result, IMPORT_NEW_DEPENDENT);
  const moved = entries.find(
    (item) => item.filename === IMPLEMENT_FILENAME,
  )!.id!;
  assert.deepEqual(dependsOnOf(f.read(dependent)), [moved]);
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
  const implement = entries.find(
    (item) => item.filename === IMPLEMENT_FILENAME,
  )!;
  const before = f.state().revisions;
  const next = entries.map((item) =>
    item.id === other.id ? { ...item, depends_on: [] } : item,
  );
  const result = f.apply(f.request(f.importSnapshot(next)));
  assert.equal(
    result.mission_version,
    first.mission_version + VERSION_INCREMENT,
  );
  assert.deepEqual(result.changes.revisions, []);
  assert.deepEqual(f.state().revisions, before);
  assert.deepEqual(result.changes.added_edges, []);
  assert.deepEqual(result.changes.removed_edges, [
    {
      dependent_id: other.id,
      depends_on_id: implement.id,
    },
  ]);
  assert.deepEqual(
    f.jobs().map((job) => job.node_id),
    [implement.id!, other.id!].sort(),
  );
});

test("import.apply permits terminal no-ops and an empty mission without writes", (t) => {
  const f = importApplyFixture(t);
  const empty = f.apply(f.request(f.importSnapshot([])));
  assert.equal(empty.mission_version, MISSION_INITIAL_VERSION);
  assert.deepEqual(empty.assigned_ids, []);
  const first = f.apply(f.request());
  const entries = f.identified(first);
  const implement = entries.find(
    (item) => item.filename === IMPLEMENT_FILENAME,
  )!;
  f.setState(implement.id!, NodeState.Completed);
  const body = f.request(f.importSnapshot(entries));
  const before = f.state();
  const result = f.apply(body);
  assert.equal(result.mission_version, first.mission_version);
  assert.deepEqual(result.changes.revisions, []);
  assert.deepEqual(f.state(), before);
});

test("import.apply Markdown uses the same digest, revisions, graph and no-op behavior as JSON", (t) => {
  const f = importApplyFixture(t);
  function markdown(entries: ImportEntry[]): ImportSnapshot {
    return {
      format: ImportFormat.Markdown,
      mission_id: f.mission_id,
      mission_version: f.version(),
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
  assert.equal(body.preview_digest, f.request().preview_digest);
  const result = f.apply(body);
  assert.equal(result.assigned_ids.length, IMPORT_NODE_COUNT);
  assert.equal(result.changes.revisions.length, THREE_REVISIONS);
  assert.equal(f.jobs().length, SINGLE_ITEM);
  const entries = f.identified(result);
  const before = f.state();
  const second = f.apply(f.request(markdown(entries)));
  assert.equal(second.mission_version, result.mission_version);
  assert.deepEqual(second.assigned_ids, result.assigned_ids);
  assert.deepEqual(f.state(), before);
});

const EXPORT_PATH = "/api/mission/:mission_id/export";

function invokeExport(
  f: ReturnType<typeof importApplyFixture>,
  format: ImportFormat,
  missionId = f.mission_id,
): ExportAnswer {
  const operation = missionOperations.export;
  const input = operation.input.parse({
    params: { mission_id: missionId },
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
        params: { mission_id: f.mission_id },
        query: {},
        body: null,
      }),
    );
    const before = f.state();
    const answer = invokeExport(f, format);
    assert.equal(answer.mission_version, f.version());
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
      preview_digest: preview.preview_digest,
      confirmed_retirements: [],
    });
    assert.deepEqual(applied.changes.revisions, []);
    assert.equal(applied.mission_version, answer.mission_version);
    assert.deepEqual(f.state(), before);
    if ("entries" in answer) {
      assert.deepEqual(
        answer.entries.map((entry) => entry.filename),
        [
          EXAMINE_FILENAME,
          IMPLEMENT_FILENAME,
          IMPORT_OTHER_TASK,
          OTHER_FILENAME,
          TASK_FILENAME,
        ],
      );
      const examine = answer.entries.find(
        (entry) => entry.filename === EXAMINE_FILENAME,
      )!;
      const implement = answer.entries.find(
        (entry) => entry.filename === IMPLEMENT_FILENAME,
      )!;
      const task = answer.entries.find(
        (entry) => entry.filename === TASK_FILENAME,
      )!;
      assert.ok("work" in examine && "work" in implement);
      assert.ok("node" in task);
      assert.equal(examine.work, Work.Examine);
      assert.deepEqual(examine.requires, []);
      assert.deepEqual(
        examine.depends_on,
        [IMPLEMENT_FILENAME, OTHER_FILENAME].sort(),
      );
      assert.equal(implement.work, Work.Implement);
      assert.equal(Object.hasOwn(implement, "node"), false);
      assert.deepEqual(implement.bindings, [REPOSITORY_NAME]);
      for (const key of ["depends_on", "requires", "work"])
        assert.equal(Object.hasOwn(task, key), false);
      assert.equal(task.node, IMPLEMENT_FILENAME);
    } else {
      assert.match(
        answer.files.find((file) => file.filename === IMPLEMENT_FILENAME)!
          .content,
        /api-repo/,
      );
      assert.doesNotMatch(
        answer.files.find((file) => file.filename === IMPLEMENT_FILENAME)!
          .content,
        new RegExp(BINDING_ID),
      );
    }
  });
}

test("mission.export excludes retired nodes and refuses an unknown mission", (t) => {
  const f = importApplyFixture(t);
  const result = f.apply(f.request());
  const retired = assignedId(result, IMPLEMENT_FILENAME);
  f.store.database
    .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
    .run(RETIRED_AT, retired);
  for (const format of [ImportFormat.Json, ImportFormat.Markdown]) {
    const answer = invokeExport(f, format);
    const filenames =
      "entries" in answer
        ? answer.entries.map((entry) => entry.filename)
        : answer.files.map((file) => file.filename);
    assert.equal(filenames.includes(IMPLEMENT_FILENAME), false);
    assert.equal(filenames.includes(TASK_FILENAME), false);
    assert.equal(filenames.length, IMPORT_NODE_COUNT - TWO_ITEMS);
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
    mission_id: UNKNOWN_MISSION_ID,
    mission_version: FIRST_REVISION,
    entries: [
      {
        filename: IMPLEMENT_FILENAME,
        id: UNKNOWN_NODE_ID,
        work: Work.Implement,
        requires: [],
        depends_on: [],
        bindings: [REPOSITORY_NAME],
        verifications: ["echo key: value", "echo #hash", 'echo "quoted"'],
        name: "Implement",
        requirement: "A requirement",
        criterion: "A criterion",
      },
    ],
  });
  assert.ok("entries" in entry);
  const implement = entry.entries[FIRST_ELEMENT_INDEX]!;
  const parsed = parsePlanFile(
    implement.filename,
    serializePlanFile(implement),
  );
  assert.deepEqual(parsed, implement);
  assert.deepEqual(parsed.verifications, implement.verifications);
});

const REBIND_PATH = "/api/mission/:mission_id/rebind";
const NEXT_BINDING_ID = "binding_00000000000000000000000003";
const NEXT_STORAGE_ID = "binding_00000000000000000000000004";
type BindingRevision = NonNullable<
  ReturnType<MissionBindings["getBindingRevision"]>
>;

function rebindFixture(t: TestContext) {
  const table = new Map<string, BindingRevision>(
    [...bindingMap].map(([name, binding]) => [
      binding.binding_id,
      {
        ...binding,
        project_id: PROJECT_ID,
        name,
        revision: FIRST_REVISION,
        tombstone: false,
        disabled: false,
      },
    ]),
  );
  table.set(NEXT_BINDING_ID, {
    ...table.get(BINDING_ID)!,
    binding_id: NEXT_BINDING_ID,
    revision: NEXT_REVISION,
  });
  table.set(NEXT_STORAGE_ID, {
    ...table.get(OTHER_BINDING_ID)!,
    binding_id: NEXT_STORAGE_ID,
    revision: NEXT_REVISION,
  });
  const f = nodeFixture(t, (_tx, id) => table.get(id) ?? null);
  function rebind(overrides: Partial<Rebind> = {}, missionId = f.mission_id) {
    const operation = missionOperations[RevisionWrite.NodeRebind];
    const input = operation.input.parse({
      params: { mission_id: missionId },
      query: {},
      body: {
        binding_id: NEXT_BINDING_ID,
        reason: REASON,
        expected_mission_version: f.version(),
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
    missionId = f.mission_id,
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
    mission_version: missionVersion,
    revisions: [],
    retired_node_ids: [],
    added_edges: [],
    removed_edges: [],
    open_attempts_unchanged: [],
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
  const implementBody = f.body(Work.Implement);
  implementBody.content.requires = ["platform.macos"];
  const nodeId =
    f.create(implementBody).revisions[FIRST_ELEMENT_INDEX]!.node_id;
  addTask(f, nodeId);
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
  const result = f.rebind({ node_id: nodeId });
  assert.equal(result.node_change.mission_version, version + VERSION_INCREMENT);
  assert.equal(result.node_change.revisions.length, SINGLE_ITEM);
  const revision = result.node_change.revisions[FIRST_ELEMENT_INDEX]!;
  assert.equal(revision.node_id, nodeId);
  assert.equal(revision.revision, previous.revision + VERSION_INCREMENT);
  assert.deepEqual(revision.change, {
    write: RevisionWrite.NodeRebind,
    previous_revision: previous.revision,
    changed_fields: [ContentField.Bindings],
    tasks: [],
  });
  assert.deepEqual(revision.tasks, JSON.parse(previous.tasks));
  assert.deepEqual(revision.content, {
    name: previous.name,
    requirement: previous.requirement,
    criterion: previous.criterion,
    verifications: JSON.parse(previous.verifications),
    bindings: [NEXT_BINDING_ID],
    work: Work.Implement,
    requires: ["platform.macos"],
  });
  assert.deepEqual(revision.actor, {
    kind: ActorKind.Human,
    account: ACCOUNT_ID,
    name: DISPLAY_NAME,
  });
  assert.equal(revision.reason, REASON);
  assert.deepEqual(revision.pinned_by_attempts, []);
  assert.deepEqual(result.skipped, []);
  assert.deepEqual(result.node_change.open_attempts_unchanged, []);
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

test("mission rebind changes examine and implement nodes once, preserving unrelated pins and implement snapshots", (t) => {
  const f = rebindFixture(t);
  const examineBody = f.body();
  examineBody.content.bindings = [OTHER_BINDING_ID];
  const examine = f.create(examineBody).revisions[FIRST_ELEMENT_INDEX]!.node_id;
  const implementBody = f.body(Work.Implement);
  implementBody.content.bindings.push(OTHER_BINDING_ID);
  const implement =
    f.create(implementBody).revisions[FIRST_ELEMENT_INDEX]!.node_id;
  const version = f.version();
  const result = f.rebind({ binding_id: NEXT_STORAGE_ID });
  assert.equal(result.node_change.mission_version, version + VERSION_INCREMENT);
  assert.equal(result.node_change.revisions.length, TWO_REVISIONS);
  const examineRevision = result.node_change.revisions.find(
    (r) => r.node_id === examine,
  )!;
  const implementRevision = result.node_change.revisions.find(
    (r) => r.node_id === implement,
  )!;
  assert.deepEqual(examineRevision.content.bindings, [NEXT_STORAGE_ID]);
  assert.equal(examineRevision.content.work, Work.Examine);
  assert.deepEqual(examineRevision.change.tasks, []);
  assert.deepEqual(examineRevision.tasks, []);
  assert.deepEqual(implementRevision.content.bindings, [
    BINDING_ID,
    NEXT_STORAGE_ID,
  ]);
  assert.deepEqual(implementRevision.change.tasks, []);
  assert.deepEqual(implementRevision.tasks, []);
  assert.deepEqual(result.skipped, []);
});

test("mission rebind reports only terminal and retired earlier pins and keeps skipped-only acts as no-ops", (t) => {
  const f = rebindFixture(t);
  const parent = f.examine();
  const conditions = [
    NodeState.Completed,
    NodeState.Discarded,
    NodeState.Available,
  ];
  const expected = conditions.map((state, index) => {
    const body = f.body(Work.Implement);
    body.filename = `node-${index}.md`;
    const nodeId = f.create(body).revisions[FIRST_ELEMENT_INDEX]!.node_id;
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
  assert.deepEqual(result.node_change, emptyRebindChange(f.version()));
  assert.deepEqual(
    result.skipped,
    expected.sort((a, b) => a.node.id.localeCompare(b.node.id)),
  );
  assert.deepEqual(f.snapshot(), before);
  const body = f.body();
  body.filename = NEW_FILENAME;
  f.create(body);
  const activeBody = f.body(Work.Implement);
  activeBody.filename = OTHER_FILENAME;
  const active = f.create(activeBody).revisions[FIRST_ELEMENT_INDEX]!.node_id;
  const mixed = f.rebind();
  assert.deepEqual(mixed.skipped, expected);
  assert.deepEqual(
    mixed.node_change.revisions.map((r) => r.node_id),
    [active],
  );
});

for (const named of [false, true]) {
  test(`equal target rebind is a no-op with named=${named}`, (t) => {
    const f = rebindFixture(t);
    const nodeId = f.implement();
    f.rebind({ node_id: nodeId });
    const version = f.version();
    const before = f.snapshot();
    assert.deepEqual(f.rebind(named ? { node_id: nodeId } : {}), {
      node_change: emptyRebindChange(version),
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
        project_id: UNKNOWN_PROJECT_ID,
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
      { node_id: UNKNOWN_NODE_ID },
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
      expected_mission_version: NEXT_REVISION,
      reason: "x".repeat(TEXT_MAX_BYTES + VERSION_INCREMENT),
    },
    MissionErrorCode.VersionConflict,
    HttpStatus.Conflict,
    { current: FIRST_REVISION },
  );
  f.refuses(
    { reason: "x".repeat(TEXT_MAX_BYTES + VERSION_INCREMENT) },
    MissionErrorCode.ContentInvalid,
    HttpStatus.BadRequest,
    { field: "reason" },
  );
});

for (const condition of Object.values(RebindSkipCondition)) {
  test(`mission rebind refuses a named ${condition} node before binding matching`, (t) => {
    const f = rebindFixture(t);
    const nodeId = f.examine();
    f.setState(nodeId, NodeState.Completed);
    if (condition === RebindSkipCondition.Retired)
      f.store.database
        .prepare("UPDATE mission_node SET retired_at = ? WHERE id = ?")
        .run(RETIRED_AT, nodeId);
    f.refuses(
      { node_id: nodeId },
      condition === RebindSkipCondition.Retired
        ? MissionErrorCode.Retired
        : MissionErrorCode.Terminal,
      HttpStatus.Conflict,
      { node_id: nodeId },
    );
  });
}

test("mission rebind refuses missing and foreign named nodes", (t) => {
  const f = rebindFixture(t);
  f.refuses(
    { node_id: UNKNOWN_NODE_ID },
    MissionErrorCode.NodeNotFound,
    HttpStatus.NotFound,
  );
  const nodeId = f.implement();
  f.store.transaction((tx) =>
    f.mission.createMission(tx, UNKNOWN_PROJECT_ID, HUMAN_ACTOR),
  );
  const foreignMission = f.invoke(UNKNOWN_PROJECT_ID).id;
  f.store.database
    .prepare("UPDATE mission_node SET mission_id = ? WHERE id = ?")
    .run(foreignMission, nodeId);
  f.refuses(
    { node_id: nodeId },
    MissionErrorCode.NodeNotFound,
    HttpStatus.NotFound,
  );
});

for (const kind of [Work.Examine, Work.Implement]) {
  test(`mission rebind refuses a named ${kind} that pins no matching binding`, (t) => {
    const f = rebindFixture(t);
    const nodeId = kind === Work.Examine ? f.examine() : f.implement();
    const bindingId = NEXT_STORAGE_ID;
    f.refuses(
      { node_id: nodeId, binding_id: bindingId },
      MissionErrorCode.BindingMismatch,
      HttpStatus.Conflict,
      { node_id: nodeId, binding_id: bindingId },
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
    const nodeId = f.implement();
    const stored = f.table.get(BINDING_ID)!;
    if (condition === UnmatchedPin.Foreign)
      stored.project_id = UNKNOWN_PROJECT_ID;
    if (condition === UnmatchedPin.Newer) stored.revision = THIRD_REVISION;
    if (condition === UnmatchedPin.Missing) f.table.delete(BINDING_ID);
    const before = f.snapshot();
    assert.deepEqual(f.rebind(), {
      node_change: emptyRebindChange(f.version()),
      skipped: [],
    });
    assert.deepEqual(f.snapshot(), before);
    f.refuses(
      { node_id: nodeId },
      MissionErrorCode.BindingMismatch,
      HttpStatus.Conflict,
      { node_id: nodeId, binding_id: NEXT_BINDING_ID },
    );
  });
}

test("MissionService refuses to restart after stop", async (t) => {
  const { mission } = fixture(t);
  assert.equal(await mission.start(), null);
  assert.equal(await mission.stop(), null);
  const error = await mission.start();
  assert.ok(error instanceof Diagnostic);
  assert.equal(error.code, MISSION_STOPPED_CODE);
  assert.deepEqual(await mission.healthcheck(), {
    operations: HealthStatus.Unavailable,
  });
});
