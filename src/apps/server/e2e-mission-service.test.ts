import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { ulid } from "ulid";
import {
  PRIVATE_DIRECTORY_MODE,
  PRIVATE_FILE_MODE,
  writePrivate,
} from "../../kernel/files.ts";
import { temporary } from "../../kernel/test-support.ts";
import {
  ImportFormat,
  MISSION_IDENTITY_PREFIX,
  MISSION_INITIAL_VERSION,
  NodeKind,
  NodeState,
  type NodeChange,
  type ExportAnswer,
  type Mission,
} from "../../mission/contract.ts";
import { BindingKind, REPOSITORY_PLATFORM } from "../../project/contract.ts";
import { environment, kanthord } from "./cli-support.ts";
import { gatewayFixture } from "./test-support.ts";

const SUCCESS = 0;
const FAILURE = 1;
const EMPTY = "";
const UTF8 = "utf8";
const MODE_MASK = 0o777;
const DATA = "data";
const STATE_DIRECTORY = "state";
const MISSION = "mission";
const PROJECT = "project";
const CREATE = "create";
const GET = "get";
const UPDATE = "update";
const MOVE = "move";
const ADD = "add";
const REMOVE = "remove";
const SET = "set";
const DEPENDENCY = "dependency";
const CRITERION = "criterion";
const REBIND = "rebind";
const PRIORITY = "priority";
const PRIORITY_VALUE = 42;
const INVALID_BINDING_ID = "invalid_bid";
const INVALID_BINDING_CODE = "cli.mission.node.rebind.invalid_binding_id";
const APPLY = "apply";
const BINDING = "binding";
const CREDENTIAL = "credential";
const FILE = "--file";
const ONE = 1;
const TWO = 2;
const REPOSITORY_NAME = "repo";
const REPOSITORY_ADDRESS = "git@github.com:owner/repo.git";
const REASON = "planning edit";
const CONTENT = {
  name: "Plan",
  requirement: "Do the work",
  criterion: "Work is done",
  verifications: ["Check result"],
  bindings: [],
};
const NODE = "node";
const LIST = "list";
const REVISION = "revision";
const EDGE = "edge";
const RETIRE = "retire";
const PREVIEW = "preview";
const EXPORT = "export";
const HELP = "--help";
const ENDPOINT = "--endpoint";
const TOKEN = "--token";
const KIND = "--kind";
const STATE = "--state";
const PARENT = "--parent";
const NODE_OPTION = "--node";
const SPACE = " ";
const INCLUDE_RETIRED = "--include-retired";
const LIMIT = "--limit";
const FORMAT = "--format";
const OUT = "--out";
const NAME = "--name";
const KEY = "--idempotency-key";
const CONFIG = "--config";
const PROJECT_ID_ARGUMENT = "<project-id>";
const PROJECT_NAME = "mission-cli-project";
const MISSION_ID = "mission_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const NODE_ID = "node_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAA";
const LOCAL_ENDPOINT = "http://localhost:31415";
const LOCAL_TOKEN = "t";
const INVALID_REVISION = "notanint";
const VALID_REVISION = "1";
const INVALID_FORMAT = "xml";
const INVALID = "invalid";
const ZERO_LIMIT = "0";
const EXCESS_LIMIT = "1001";
const OUTPUT_DIRECTORY = "markdown";
const ABSENT_OUTPUT_DIRECTORY = "absent-markdown";
const OUTPUT_FILE = "mission.json";
const EXISTING_FILE = "keep.md";
const EXISTING_CONTENT = "preserve this file";
const KIND_STATE_CONFLICT = "cli.mission.node.list.kind_state_conflict";
const INVALID_REVISION_CODE = "cli.mission.node.revision.get.invalid_revision";
const INVALID_FORMAT_CODE = "cli.mission.export.invalid_format";
const OUT_NOT_EMPTY = "cli.mission.export.out_not_empty";
const FILE_NOT_FOUND = "cli.file.not_found";
const FILE_SCHEMA_INVALID = "cli.file.schema_invalid";
const DUPLICATE_OPTION = "cli.option.duplicate";
const LIMIT_INVALID = "cli.pagination.limit_invalid";
const LIMIT_OUT_OF_RANGE = "cli.pagination.limit_out_of_range";
const INVALID_PROJECT_ID_CODE = "cli.mission.get.invalid_project_id";
const INVALID_MISSION_ID_CODE = "cli.mission.node.list.invalid_mission_id";
const INVALID_NODE_ID_CODE = "cli.mission.node.get.invalid_node_id";
const INVALID_KIND_CODE = "cli.mission.node.list.invalid_kind";
const INVALID_STATE_CODE = "cli.mission.node.list.invalid_state";
const INVALID_PARENT_CODE = "cli.mission.node.list.invalid_node_id";
const INVALID_EDGE_KIND_CODE = "cli.mission.edge.list.invalid_kind";
const INVALID_EDGE_NODE_CODE = "cli.mission.edge.list.invalid_node_id";
const INVALID_RETIRE_NODE_CODE =
  "cli.mission.node.retire.preview.invalid_node_id";
const UNKNOWN_OPTION = /unknown option/;
const LOCAL_FLAGS = [ENDPOINT, LOCAL_ENDPOINT, TOKEN, LOCAL_TOKEN];
const READ_LEAVES = [
  { path: [GET, PROJECT_ID], code: "cli.mission.get.token_required" },
  {
    path: [NODE, LIST, MISSION_ID],
    code: "cli.mission.node.list.token_required",
  },
  { path: [NODE, GET, NODE_ID], code: "cli.mission.node.get.token_required" },
  {
    path: [NODE, REVISION, LIST, NODE_ID],
    code: "cli.mission.node.revision.list.token_required",
  },
  {
    path: [NODE, REVISION, GET, NODE_ID, VALID_REVISION],
    code: "cli.mission.node.revision.get.token_required",
  },
  {
    path: [EDGE, LIST, MISSION_ID],
    code: "cli.mission.edge.list.token_required",
  },
  {
    path: [NODE, RETIRE, PREVIEW, NODE_ID],
    code: "cli.mission.node.retire.preview.token_required",
  },
  {
    path: [EXPORT, MISSION_ID, FORMAT, ImportFormat.Json],
    code: "cli.mission.export.token_required",
  },
];
const INVALID_CASES = [
  {
    args: [
      NODE,
      LIST,
      MISSION_ID,
      KIND,
      NodeKind.Task,
      STATE,
      NodeState.Available,
    ],
    code: KIND_STATE_CONFLICT,
  },
  {
    args: [NODE, REVISION, GET, NODE_ID, INVALID_REVISION],
    code: INVALID_REVISION_CODE,
  },
  {
    args: [EXPORT, MISSION_ID, FORMAT, INVALID_FORMAT],
    code: INVALID_FORMAT_CODE,
  },
  { args: [GET, INVALID], code: INVALID_PROJECT_ID_CODE },
  { args: [NODE, LIST, INVALID], code: INVALID_MISSION_ID_CODE },
  { args: [NODE, GET, INVALID], code: INVALID_NODE_ID_CODE },
  { args: [NODE, LIST, MISSION_ID, KIND, INVALID], code: INVALID_KIND_CODE },
  { args: [NODE, LIST, MISSION_ID, STATE, INVALID], code: INVALID_STATE_CODE },
  {
    args: [NODE, LIST, MISSION_ID, PARENT, INVALID],
    code: INVALID_PARENT_CODE,
  },
  {
    args: [EDGE, LIST, MISSION_ID, KIND, INVALID],
    code: INVALID_EDGE_KIND_CODE,
  },
  {
    args: [EDGE, LIST, MISSION_ID, NODE_OPTION, INVALID],
    code: INVALID_EDGE_NODE_CODE,
  },
  { args: [NODE, RETIRE, PREVIEW, INVALID], code: INVALID_RETIRE_NODE_CODE },
  { args: [NODE, LIST, MISSION_ID, LIMIT, ZERO_LIMIT], code: LIMIT_INVALID },
  {
    args: [NODE, REVISION, LIST, NODE_ID, LIMIT, EXCESS_LIMIT],
    code: LIMIT_OUT_OF_RANGE,
  },
  { args: [EDGE, LIST, MISSION_ID, LIMIT, ZERO_LIMIT], code: LIMIT_INVALID },
  {
    args: [NODE, LIST, MISSION_ID, KIND, NodeKind.Task, KIND, NodeKind.Task],
    code: DUPLICATE_OPTION,
  },
];

type Result = Awaited<ReturnType<typeof kanthord>>;
type Fixture = { directory: string; env: NodeJS.ProcessEnv };
type Mutation = NodeChange & { idempotencyKey: string };

function isolated(t: TestContext): Fixture {
  const directory = temporary(t);
  const env: NodeJS.ProcessEnv = {
    ...environment(directory),
    XDG_DATA_HOME: join(directory, DATA),
    XDG_STATE_HOME: join(directory, STATE_DIRECTORY),
  };
  assert.ok(env.XDG_CONFIG_HOME);
  assert.ok(env.XDG_DATA_HOME);
  return { directory, env };
}

async function setup(t: TestContext): Promise<Fixture> {
  const fixture = await gatewayFixture(t, {
    repositoryConnector: { gitLsRemote: async () => {} },
  });
  const { directory, env } = isolated(t);
  assert.ok(fixture.endpoint);
  assert.ok(fixture.token);
  return {
    directory,
    env: {
      ...env,
      KANTHORD_ENDPOINT: fixture.endpoint,
      KANTHORD_TOKEN: fixture.token,
    },
  };
}

function success<T>(result: Result): T {
  assert.equal(result.code, SUCCESS, result.stderr);
  assert.equal(result.stderr, EMPTY);
  return JSON.parse(result.stdout) as T;
}

function refusal(result: Result, code: string): void {
  assert.equal(result.code, FAILURE, result.stderr);
  assert.ok(result.stderr.startsWith(`${code}:`), result.stderr);
  assert.equal(result.stdout, EMPTY);
}

async function createMission(fixture: Fixture): Promise<Mission> {
  const project = success<{ id: string }>(
    await kanthord([PROJECT, CREATE, NAME, PROJECT_NAME], fixture.env),
  );
  const mission = success<Mission>(
    await kanthord([MISSION, GET, project.id], fixture.env),
  );
  assert.ok(mission.id.startsWith(`${MISSION_IDENTITY_PREFIX}_`));
  assert.equal(mission.projectId, project.id);
  assert.equal(mission.version, MISSION_INITIAL_VERSION);
  return mission;
}

function jsonFile(fixture: Fixture, name: string, body: unknown): string {
  assert.ok(fixture.directory);
  assert.ok(name.endsWith(".json"));
  const path = join(fixture.directory, name);
  writePrivate(path, JSON.stringify(body));
  return path;
}

async function createNode(
  fixture: Fixture,
  missionId: string,
  kind: NodeKind,
  version: number,
  parentId?: string,
  parentRevision = ONE,
): Promise<Mutation> {
  assert.ok(missionId);
  assert.ok(Number.isSafeInteger(version));
  const body = {
    filename: `${kind}-${version}.md`,
    kind,
    content: {
      ...CONTENT,
      bindings: kind === NodeKind.Objective ? [REPOSITORY_NAME] : [],
    },
    reason: REASON,
    expectedMissionVersion: version,
    ...(parentId === undefined
      ? {}
      : { parentId, expectedParentRevision: parentRevision }),
  };
  const path = jsonFile(fixture, `${kind}-${version}.json`, body);
  return success<Mutation>(
    await kanthord([MISSION, NODE, CREATE, missionId, FILE, path], fixture.env),
  );
}

function exportArgs(missionId: string, format: string, out: string): string[] {
  assert.ok(missionId.startsWith(`${MISSION_IDENTITY_PREFIX}_`));
  assert.ok(out);
  return [MISSION, EXPORT, missionId, FORMAT, format, OUT, out];
}

test("mission read help works offline and exposes positional IDs and filters", async (t) => {
  const { env } = isolated(t);
  const get = await kanthord([MISSION, GET, HELP], env);
  assert.equal(get.code, SUCCESS, get.stderr);
  assert.ok(get.stdout.includes(PROJECT_ID_ARGUMENT));
  const list = await kanthord([MISSION, NODE, LIST, HELP], env);
  assert.equal(list.code, SUCCESS, list.stderr);
  for (const flag of [KIND, STATE, PARENT, INCLUDE_RETIRED])
    assert.ok(list.stdout.includes(flag));
});

for (const { args, code } of INVALID_CASES) {
  test(`mission rejects ${code} before contacting a server`, async (t) => {
    const { directory, env } = isolated(t);
    const out = args.includes(EXPORT)
      ? [OUT, join(directory, OUTPUT_FILE)]
      : [];
    refusal(
      await kanthord([MISSION, ...args, ...out, ...LOCAL_FLAGS], env),
      code,
    );
    assert.deepEqual(readdirSync(directory), []);
  });
}

for (const { path, code } of READ_LEAVES) {
  test(`mission read ${path.join(SPACE)} requires a token and rejects mutation and config flags`, async (t) => {
    const { directory, env } = isolated(t);
    const out = path.includes(EXPORT)
      ? [OUT, join(directory, OUTPUT_FILE)]
      : [];
    const args = [MISSION, ...path, ...out];
    refusal(await kanthord(args, env), code);
    for (const flag of [KEY, CONFIG]) {
      const result = await kanthord([...args, flag, INVALID], env);
      assert.equal(result.code, FAILURE, result.stderr);
      assert.match(result.stderr, UNKNOWN_OPTION);
    }
    assert.deepEqual(readdirSync(directory), []);
  });
}

test("mission node create help and local file and identity validation", async (t) => {
  const { directory, env } = isolated(t);
  const help = await kanthord([MISSION, NODE, CREATE, HELP], env);
  assert.equal(help.code, SUCCESS, help.stderr);
  assert.ok(help.stdout.includes(FILE));
  const missing = join(directory, "missing.json");
  const args = [MISSION, NODE, CREATE, MISSION_ID, FILE, missing];
  refusal(await kanthord([...args, ...LOCAL_FLAGS], env), FILE_NOT_FOUND);
  const invalid = join(directory, "invalid.json");
  writePrivate(invalid, JSON.stringify({ kind: NodeKind.Initiative }));
  refusal(
    await kanthord(
      [MISSION, NODE, CREATE, MISSION_ID, FILE, invalid, ...LOCAL_FLAGS],
      env,
    ),
    FILE_SCHEMA_INVALID,
  );
  for (const [leaf, id, code] of [
    [CREATE, MISSION_ID, "cli.mission.node.create.token_required"],
    [UPDATE, NODE_ID, "cli.mission.node.update.token_required"],
    [MOVE, NODE_ID, "cli.mission.node.move.token_required"],
  ] as const) {
    refusal(
      await kanthord([MISSION, NODE, leaf, id, FILE, invalid], env),
      code,
    );
  }
  for (const [leaf, code] of [
    [CREATE, "cli.mission.node.create.invalid_mission_id"],
    [UPDATE, "cli.mission.node.update.invalid_node_id"],
    [MOVE, "cli.mission.node.move.invalid_node_id"],
  ] as const) {
    refusal(
      await kanthord(
        [MISSION, NODE, leaf, INVALID, FILE, invalid, ...LOCAL_FLAGS],
        env,
      ),
      code,
    );
  }
});

test("mission graph commands expose flags and reject invalid rebind IDs offline", async (t) => {
  const { env } = isolated(t);
  for (const path of [
    [DEPENDENCY, ADD, FILE],
    [CRITERION, SET, FILE],
    [NODE, REBIND, NODE_OPTION],
    [NODE, PRIORITY, SET, FILE],
  ]) {
    const flag = path.at(-1)!;
    const result = await kanthord([MISSION, ...path.slice(0, -1), HELP], env);
    assert.equal(result.code, SUCCESS, result.stderr);
    assert.ok(result.stdout.includes(flag));
  }
  refusal(
    await kanthord(
      [
        MISSION,
        NODE,
        REBIND,
        MISSION_ID,
        INVALID_BINDING_ID,
        FILE,
        "f.json",
        ...LOCAL_FLAGS,
      ],
      env,
    ),
    INVALID_BINDING_CODE,
  );
});

test("mission node create replay, update and move task between objectives", async (t) => {
  const fixture = await setup(t);
  const mission = await createMission(fixture);
  const key = ulid();
  const initiativeFile = jsonFile(fixture, "initiative.json", {
    filename: "initiative.md",
    kind: NodeKind.Initiative,
    content: CONTENT,
    reason: REASON,
    expectedMissionVersion: mission.version,
  });
  const createArgs = [
    MISSION,
    NODE,
    CREATE,
    mission.id,
    FILE,
    initiativeFile,
    KEY,
    key,
  ];
  const created = success<Mutation>(await kanthord(createArgs, fixture.env));
  assert.equal(created.idempotencyKey, key);
  assert.equal(created.revisions.length, ONE);
  const initiativeId = created.revisions[0]!.nodeId;
  const replayed = success<Mutation>(await kanthord(createArgs, fixture.env));
  assert.equal(replayed.revisions[0]?.nodeId, initiativeId);
  assert.deepEqual(replayed, created);
  const updated = success<Mutation>(
    await kanthord(
      [
        MISSION,
        NODE,
        UPDATE,
        initiativeId,
        FILE,
        jsonFile(fixture, "update.json", {
          filename: "initiative.md",
          content: { ...CONTENT, name: "Updated plan" },
          reason: REASON,
          expectedRevision: ONE,
          expectedMissionVersion: TWO,
        }),
      ],
      fixture.env,
    ),
  );
  assert.equal(updated.missionVersion, created.missionVersion + ONE);
  assert.equal(updated.revisions[0]?.revision, TWO);
  assert.ok(updated.idempotencyKey);
  const credential = jsonFile(fixture, "credential.json", {
    name: REPOSITORY_PLATFORM,
    platform: REPOSITORY_PLATFORM,
    metadata: null,
    secret: { key: "test-secret" },
  });
  success(await kanthord([CREDENTIAL, CREATE, FILE, credential], fixture.env));
  const bindingFile = jsonFile(fixture, "binding.json", {
    version: ONE,
    bindings: {
      [REPOSITORY_NAME]: {
        kind: BindingKind.Repository,
        config: {
          available: true,
          platform: REPOSITORY_PLATFORM,
          address: REPOSITORY_ADDRESS,
          strategy: { baseBranch: "main" },
          credential: REPOSITORY_PLATFORM,
        },
      },
    },
  });
  const binding = success<{ bindingSetVersion: number }>(
    await kanthord(
      [PROJECT, BINDING, APPLY, mission.projectId, FILE, bindingFile],
      fixture.env,
    ),
  );
  assert.equal(binding.bindingSetVersion, TWO);
  const first = await createNode(
    fixture,
    mission.id,
    NodeKind.Objective,
    updated.missionVersion,
    initiativeId,
    TWO,
  );
  const second = await createNode(
    fixture,
    mission.id,
    NodeKind.Objective,
    first.missionVersion,
    initiativeId,
    TWO,
  );
  const oldParent = first.revisions[0]!.nodeId;
  const newParent = second.revisions[0]!.nodeId;
  const task = await createNode(
    fixture,
    mission.id,
    NodeKind.Task,
    second.missionVersion,
    oldParent,
  );
  const taskId = task.revisions[0]?.tasks?.[0]?.id;
  assert.ok(taskId);
  const moved = success<Mutation>(
    await kanthord(
      [
        MISSION,
        NODE,
        MOVE,
        taskId,
        FILE,
        jsonFile(fixture, "move.json", {
          newParentId: newParent,
          reason: REASON,
          expectedMissionVersion: task.missionVersion,
          expectedRevision: TWO,
          expectedOldParentRevision: TWO,
          expectedNewParentRevision: ONE,
        }),
      ],
      fixture.env,
    ),
  );
  assert.equal(moved.missionVersion, task.missionVersion + ONE);
  assert.ok(moved.idempotencyKey);
  const read = success<{ parentId: string }>(
    await kanthord([MISSION, NODE, GET, taskId], fixture.env),
  );
  assert.equal(read.parentId, newParent);
  const graphFile = (version: number) =>
    jsonFile(fixture, `graph-${version}.json`, {
      reason: REASON,
      expectedMissionVersion: version,
    });
  const added = success<Mutation>(
    await kanthord(
      [
        MISSION,
        DEPENDENCY,
        ADD,
        oldParent,
        newParent,
        FILE,
        graphFile(moved.missionVersion),
      ],
      fixture.env,
    ),
  );
  assert.equal(added.missionVersion, moved.missionVersion + ONE);
  assert.ok(added.idempotencyKey);
  const pending = success<{ state: string }>(
    await kanthord([MISSION, NODE, GET, oldParent], fixture.env),
  );
  assert.equal(pending.state, NodeState.Pending);
  const removed = success<Mutation>(
    await kanthord(
      [
        MISSION,
        DEPENDENCY,
        REMOVE,
        oldParent,
        newParent,
        FILE,
        graphFile(added.missionVersion),
      ],
      fixture.env,
    ),
  );
  assert.equal(removed.missionVersion, added.missionVersion + ONE);
  const available = success<{ state: string; visibleRevision: number }>(
    await kanthord([MISSION, NODE, GET, oldParent], fixture.env),
  );
  assert.equal(available.state, NodeState.Available);
  assert.ok(available.visibleRevision >= ONE);
  const criterion = success<Mutation>(
    await kanthord(
      [
        MISSION,
        CRITERION,
        SET,
        oldParent,
        FILE,
        jsonFile(fixture, "criterion.json", {
          criterion: "Revised criterion",
          verifications: ["true"],
          reason: REASON,
          expectedRevision: available.visibleRevision,
          expectedMissionVersion: removed.missionVersion,
        }),
      ],
      fixture.env,
    ),
  );
  assert.equal(criterion.missionVersion, removed.missionVersion + ONE);
  const priority = success<{
    id: string;
    priority: number;
    idempotencyKey: string;
  }>(
    await kanthord(
      [
        MISSION,
        NODE,
        PRIORITY,
        SET,
        newParent,
        FILE,
        jsonFile(fixture, "priority.json", {
          value: PRIORITY_VALUE,
          expectedMissionVersion: criterion.missionVersion,
        }),
      ],
      fixture.env,
    ),
  );
  assert.equal(priority.id, newParent);
  assert.equal(priority.priority, PRIORITY_VALUE);
  assert.ok(priority.idempotencyKey);
});

test("mission get reads the empty mission created with its project", async (t) => {
  await createMission(await setup(t));
});

test("mission export writes empty Markdown and complete private JSON answers", async (t) => {
  const fixture = await setup(t);
  const mission = await createMission(fixture);
  const summary = { missionId: mission.id, missionVersion: mission.version };
  const directory = join(fixture.directory, OUTPUT_DIRECTORY);
  mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
  for (const out of [
    directory,
    join(fixture.directory, ABSENT_OUTPUT_DIRECTORY),
  ]) {
    const result = await kanthord(
      exportArgs(mission.id, ImportFormat.Markdown, out),
      fixture.env,
    );
    assert.deepEqual(success(result), summary);
    assert.deepEqual(readdirSync(out), []);
  }
  const path = join(fixture.directory, OUTPUT_FILE);
  const result = await kanthord(
    exportArgs(mission.id, ImportFormat.Json, path),
    fixture.env,
  );
  assert.deepEqual(success(result), summary);
  const answer: ExportAnswer = { ...summary, entries: [] };
  assert.equal(readFileSync(path, UTF8), JSON.stringify(answer));
  assert.equal(statSync(path).mode & MODE_MASK, PRIVATE_FILE_MODE);
});

test("mission Markdown export refuses occupied destinations before network I/O", async (t) => {
  const { directory, env } = isolated(t);
  const path = join(directory, EXISTING_FILE);
  writePrivate(path, EXISTING_CONTENT);
  for (const out of [directory, path]) {
    refusal(
      await kanthord(
        [...exportArgs(MISSION_ID, ImportFormat.Markdown, out), ...LOCAL_FLAGS],
        env,
      ),
      OUT_NOT_EMPTY,
    );
    assert.equal(readFileSync(path, UTF8), EXISTING_CONTENT);
  }
});
