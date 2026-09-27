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
  type MissionBindings,
  type WorkQueue,
} from "./contract.ts";
import { missionMigrations } from "./migrations.ts";
import { MissionService, humanActor } from "./service.ts";

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

function makeService(health: HealthRegistry): MissionService {
  return new MissionService({
    config: {
      consecutiveLossLimit: CONSECUTIVE_LOSS_LIMIT,
      textMaxBytes: TEXT_MAX_BYTES,
    },
    health,
    bindings,
    workQueue,
  });
}

function fixture(t: TestContext) {
  const store = new Store(IN_MEMORY_DATABASE);
  t.after(() => store.close());
  store.migrate([
    { service: MISSION_SERVICE_NAME, migrations: missionMigrations },
  ]);
  return { store, mission: makeService(new HealthRegistry()) };
}

function handlerFixture(t: TestContext) {
  const { store, mission } = fixture(t);
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
