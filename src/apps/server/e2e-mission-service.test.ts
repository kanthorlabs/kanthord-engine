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
  NODE_IDENTITY_PREFIX,
  MissionErrorCode,
  RebindSkipCondition,
  type Node,
  type Revision,
  type RebindResult,
  type Edge,
  NodeKind,
  NodeState,
  type NodeChange,
  type ExportAnswer,
  type Mission,
  type ImportPreview,
  type ImportResult,
  type RetirePreview,
} from "../../mission/contract.ts";
import { BindingKind, REPOSITORY_PLATFORM } from "../../project/contract.ts";
import type { Job } from "../../scheduler/contract.ts";
import { environment, kanthord } from "./cli-support.ts";
import { gatewayFixture } from "./test-support.ts";

const SUCCESS = 0;
const FAILURE = 1;
const PLANNING_LIFECYCLE_TIMEOUT_MS = 120000;
const NODE_EDIT_LIFECYCLE_TIMEOUT_MS = 60000;
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
const IMPORT = "import";
const FORCE = "--force";
const THREE = 3;
const DIGEST = "0".repeat(64);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const MANIFEST_FILE = "manifest.json";
const RETIRE_FILE = "retire.json";
const PLAN_ONE = "plan1.md";
const PLAN_TWO = "plan2.md";
const NEW_OBJECTIVE_FILE = "new-objective.md";
const NEW_OBJECTIVE_CONTENT = [
  "---",
  "kind: objective",
  "parent: initiative-1.md",
  "bindings: [repo]",
  "verifications: [Check result]",
  "---",
  "# New objective — unchanged UTF-8",
  "",
  "## Requirement",
  "Do new work",
  "",
  "## Criterion",
  "New work is done",
  "",
].join("\r\n");
const IMPORT_CONTROLS = {
  format: ImportFormat.Markdown,
  missionVersion: ONE,
  reason: REASON,
};
const APPLY_CONTROLS = { previewDigest: DIGEST, confirmedRetirements: [] };
const RETIRE_CONTROLS = {
  reason: REASON,
  expectedMissionVersion: ONE,
  previewDigest: DIGEST,
};
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
const SCENARIO_FILE = "scenario.json";
const INITIATIVE_FILE = "scenario-initiative.json";
const INITIATIVE_PLAN = "scenario-initiative.md";
const EXISTING_EXPORT_FILE = "expanded-mission.json";
const UPDATED_NAME = "Updated objective";
const UPDATED_CRITERION = "Revised acceptance criterion";
const JSON_ENTRIES = "entries";
const SCHEDULER = "scheduler";
const QUEUE = "queue";
const PEEK = "peek";
const MAIN_BRANCH = "main";
const NEXT_BRANCH = "develop";
const SECOND_REPOSITORY_NAME = "other-repo";
const SECOND_REPOSITORY_ADDRESS = "git@github.com:owner/other-repo.git";
const LARGE_TEXT_BYTES = 32769;
const LARGE_TEXT_CHARACTER = "x";
const REFUSED_PLAN = "refused.md";
const REPOSITORY_CONFIGURATION = {
  available: true,
  platform: REPOSITORY_PLATFORM,
  address: REPOSITORY_ADDRESS,
  strategy: { baseBranch: MAIN_BRANCH },
  credential: REPOSITORY_PLATFORM,
};
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
type ImportMutation = ImportResult & { idempotencyKey: string };

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
  writePrivate(path, JSON.stringify(body), true);
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

test(
  "mission node create replay, update and move task between objectives",
  { timeout: NODE_EDIT_LIFECYCLE_TIMEOUT_MS },
  async (t) => {
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
    success(
      await kanthord([CREDENTIAL, CREATE, FILE, credential], fixture.env),
    );
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
  },
);

for (const { path, flags } of [
  { path: [NODE, RETIRE], flags: [FILE, FORCE, KEY] },
  { path: [NODE, RETIRE, PREVIEW], flags: [FORCE] },
  { path: [IMPORT, PREVIEW], flags: [FILE] },
  { path: [IMPORT, APPLY], flags: [FILE, KEY] },
]) {
  test(`mission ${path.join(SPACE)} help works offline`, async (t) => {
    const result = await kanthord([MISSION, ...path, HELP], isolated(t).env);
    assert.equal(result.code, SUCCESS, result.stderr);
    for (const flag of flags) assert.ok(result.stdout.includes(flag));
    if (path.includes(IMPORT) && path.includes(PREVIEW))
      assert.ok(!result.stdout.includes(KEY));
  });
}

test("mission node retire validates its identity, token, file and flag ownership", async (t) => {
  const fixture = isolated(t);
  const path = jsonFile(fixture, RETIRE_FILE, RETIRE_CONTROLS);
  const args = [MISSION, NODE, RETIRE, NODE_ID, FILE, path];
  refusal(
    await kanthord(args, fixture.env),
    "cli.mission.node.retire.token_required",
  );
  refusal(
    await kanthord(
      [MISSION, NODE, RETIRE, INVALID, FILE, path, ...LOCAL_FLAGS],
      fixture.env,
    ),
    "cli.mission.node.retire.invalid_node_id",
  );
  jsonFile(fixture, RETIRE_FILE, { ...RETIRE_CONTROLS, force: false });
  refusal(
    await kanthord([...args, ...LOCAL_FLAGS], fixture.env),
    FILE_SCHEMA_INVALID,
  );
  const missing = await kanthord(
    [MISSION, NODE, RETIRE, NODE_ID, ...LOCAL_FLAGS],
    fixture.env,
  );
  assert.equal(missing.code, FAILURE);
  assert.match(missing.stderr, /required option '--file/);
});

for (const action of [PREVIEW, APPLY] as const) {
  test(`mission import ${action} validates positional files and its final schema offline`, async (t) => {
    const fixture = isolated(t);
    const controls = {
      ...IMPORT_CONTROLS,
      ...(action === APPLY ? APPLY_CONTROLS : {}),
    };
    const path = jsonFile(fixture, MANIFEST_FILE, controls);
    const args = [MISSION, IMPORT, action, MISSION_ID, FILE, path];
    const local = [...args, ...LOCAL_FLAGS];
    refusal(
      await kanthord(args, fixture.env),
      `cli.mission.import.${action}.token_required`,
    );
    refusal(
      await kanthord(
        [MISSION, IMPORT, action, INVALID, FILE, path, ...LOCAL_FLAGS],
        fixture.env,
      ),
      `cli.mission.import.${action}.invalid_mission_id`,
    );
    jsonFile(fixture, MANIFEST_FILE, { ...controls, files: [] });
    refusal(
      await kanthord([...local, PLAN_ONE, PLAN_TWO], fixture.env),
      `cli.mission.import.${action}.files_conflict`,
    );
    jsonFile(fixture, MANIFEST_FILE, {
      ...controls,
      format: ImportFormat.Json,
      entries: [],
    });
    refusal(
      await kanthord([...local, PLAN_ONE], fixture.env),
      `cli.mission.import.${action}.positionals_not_accepted`,
    );
    jsonFile(fixture, MANIFEST_FILE, controls);
    refusal(
      await kanthord(
        [...local, join(fixture.directory, PLAN_ONE)],
        fixture.env,
      ),
      FILE_NOT_FOUND,
    );
    for (const manifest of [
      { ...controls, format: ImportFormat.Json },
      { ...controls, files: null },
      { ...controls, missionId: null },
      { ...controls, entries: [] },
      { ...controls, unknown: true },
      ...(action === APPLY
        ? [{ ...IMPORT_CONTROLS, files: [] }]
        : [{ ...controls, ...APPLY_CONTROLS }]),
    ]) {
      jsonFile(fixture, MANIFEST_FILE, manifest);
      refusal(await kanthord(local, fixture.env), FILE_SCHEMA_INVALID);
    }
    if (action === PREVIEW) {
      const result = await kanthord([...local, KEY, ulid()], fixture.env);
      assert.equal(result.code, FAILURE);
      assert.match(result.stderr, UNKNOWN_OPTION);
    }
  });
}

async function configureRepository(
  fixture: Fixture,
  projectId: string,
): Promise<void> {
  const credential = jsonFile(fixture, "import-credential.json", {
    name: REPOSITORY_PLATFORM,
    platform: REPOSITORY_PLATFORM,
    metadata: null,
    secret: { key: "test-secret" },
  });
  success(await kanthord([CREDENTIAL, CREATE, FILE, credential], fixture.env));
  const bindingFile = jsonFile(fixture, "import-binding.json", {
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
  const result = success<{ bindingSetVersion: number }>(
    await kanthord(
      [PROJECT, BINDING, APPLY, projectId, FILE, bindingFile],
      fixture.env,
    ),
  );
  assert.equal(result.bindingSetVersion, TWO);
  assert.ok(projectId);
}

async function previewImport(
  fixture: Fixture,
  missionId: string,
  manifest: object,
  paths: string[],
): Promise<ImportPreview> {
  const path = jsonFile(fixture, MANIFEST_FILE, manifest);
  const preview = success<ImportPreview>(
    await kanthord(
      [MISSION, IMPORT, PREVIEW, missionId, FILE, path, ...paths],
      fixture.env,
    ),
  );
  assert.match(preview.previewDigest, DIGEST_PATTERN);
  assert.deepEqual(preview.violations, []);
  assert.ok(!Object.hasOwn(preview, "idempotencyKey"));
  return preview;
}

async function applyImport(
  fixture: Fixture,
  missionId: string,
  manifest: object,
  paths: string[],
  preview: ImportPreview,
): Promise<ImportMutation> {
  assert.equal(preview.missionId, missionId);
  assert.deepEqual(preview.violations, []);
  const path = jsonFile(fixture, MANIFEST_FILE, {
    ...manifest,
    previewDigest: preview.previewDigest,
    confirmedRetirements: [],
  });
  const key = ulid();
  const args = [
    MISSION,
    IMPORT,
    APPLY,
    missionId,
    FILE,
    path,
    ...paths,
    KEY,
    key,
  ];
  const applied = success<ImportMutation>(await kanthord(args, fixture.env));
  assert.equal(applied.idempotencyKey, key);
  assert.deepEqual(success(await kanthord(args, fixture.env)), applied);
  return applied;
}

test("mission Markdown export/import preserves the set, adds an objective, then retires it", async (t) => {
  const fixture = await setup(t);
  const mission = await createMission(fixture);
  await configureRepository(fixture, mission.projectId);
  const initiative = await createNode(
    fixture,
    mission.id,
    NodeKind.Initiative,
    mission.version,
  );
  const objective = await createNode(
    fixture,
    mission.id,
    NodeKind.Objective,
    initiative.missionVersion,
    initiative.revisions[0]!.nodeId,
  );
  const task = await createNode(
    fixture,
    mission.id,
    NodeKind.Task,
    objective.missionVersion,
    objective.revisions[0]!.nodeId,
  );
  const out = join(fixture.directory, OUTPUT_DIRECTORY);
  const exported = success<{ missionVersion: number }>(
    await kanthord(
      exportArgs(mission.id, ImportFormat.Markdown, out),
      fixture.env,
    ),
  );
  assert.equal(exported.missionVersion, task.missionVersion);
  const paths = readdirSync(out).map((filename) => join(out, filename));
  assert.equal(paths.length, THREE);
  const manifest = {
    ...IMPORT_CONTROLS,
    missionVersion: exported.missionVersion,
  };
  const preview = await previewImport(fixture, mission.id, manifest, paths);
  assert.equal(preview.noOps.length, THREE);
  assert.deepEqual(preview.creates, []);
  const unchanged = await applyImport(
    fixture,
    mission.id,
    manifest,
    paths,
    preview,
  );
  assert.equal(unchanged.missionVersion, exported.missionVersion);
  assert.ok(unchanged.idempotencyKey);
  assert.equal(unchanged.assignedIds.length, THREE);
  const newPath = join(fixture.directory, NEW_OBJECTIVE_FILE);
  writePrivate(newPath, NEW_OBJECTIVE_CONTENT);
  const expandedPaths = [...paths, newPath];
  const expanded = await previewImport(
    fixture,
    mission.id,
    manifest,
    expandedPaths,
  );
  assert.deepEqual(expanded.creates, [NEW_OBJECTIVE_FILE]);
  const applied = await applyImport(
    fixture,
    mission.id,
    manifest,
    expandedPaths,
    expanded,
  );
  assert.equal(applied.missionVersion, unchanged.missionVersion + ONE);
  assert.ok(applied.idempotencyKey);
  assert.equal(applied.assignedIds.length, unchanged.assignedIds.length + ONE);
  assert.ok(
    applied.assignedIds.some(({ filename }) => filename === NEW_OBJECTIVE_FILE),
  );
  assert.equal(readFileSync(newPath, UTF8), NEW_OBJECTIVE_CONTENT);
  await retireImportedNode(fixture, applied);
});

async function retireImportedNode(
  fixture: Fixture,
  applied: ImportMutation,
): Promise<void> {
  const assigned = applied.assignedIds.find(
    ({ filename }) => filename === NEW_OBJECTIVE_FILE,
  );
  assert.ok(assigned);
  const nodeId = assigned.nodeId;
  const preview = success<RetirePreview>(
    await kanthord([MISSION, NODE, RETIRE, PREVIEW, nodeId], fixture.env),
  );
  assert.equal(preview.force, false);
  assert.equal(preview.missionVersion, applied.missionVersion);
  const path = jsonFile(fixture, RETIRE_FILE, {
    reason: REASON,
    expectedMissionVersion: applied.missionVersion,
    previewDigest: preview.previewDigest,
  });
  const key = ulid();
  const args = [MISSION, NODE, RETIRE, nodeId, FILE, path, KEY, key];
  const retired = success<Mutation>(await kanthord(args, fixture.env));
  assert.ok(retired.retiredNodeIds.includes(nodeId));
  assert.equal(retired.missionVersion, applied.missionVersion + ONE);
  assert.equal(retired.idempotencyKey, key);
  assert.deepEqual(success(await kanthord(args, fixture.env)), retired);
}

test("mission node retire force previews and removes dependent edges", async (t) => {
  const fixture = await setup(t);
  const mission = await createMission(fixture);
  const first = await createNode(
    fixture,
    mission.id,
    NodeKind.Initiative,
    mission.version,
  );
  const second = await createNode(
    fixture,
    mission.id,
    NodeKind.Initiative,
    first.missionVersion,
  );
  const nodeId = first.revisions[0]!.nodeId;
  const dependentId = second.revisions[0]!.nodeId;
  const graphFile = jsonFile(fixture, "retire-dependency.json", {
    reason: REASON,
    expectedMissionVersion: second.missionVersion,
  });
  const dependency = success<Mutation>(
    await kanthord(
      [MISSION, DEPENDENCY, ADD, dependentId, nodeId, FILE, graphFile],
      fixture.env,
    ),
  );
  const preview = success<RetirePreview>(
    await kanthord(
      [MISSION, NODE, RETIRE, PREVIEW, nodeId, FORCE],
      fixture.env,
    ),
  );
  assert.equal(preview.force, true);
  assert.equal(preview.missionVersion, dependency.missionVersion);
  assert.equal(preview.removedEdges.length, ONE);
  const path = jsonFile(fixture, RETIRE_FILE, {
    reason: REASON,
    expectedMissionVersion: preview.missionVersion,
    previewDigest: preview.previewDigest,
  });
  const retired = success<Mutation>(
    await kanthord(
      [MISSION, NODE, RETIRE, nodeId, FILE, path, FORCE],
      fixture.env,
    ),
  );
  assert.deepEqual(retired.retiredNodeIds, [nodeId]);
  assert.deepEqual(retired.removedEdges, preview.removedEdges);
  assert.equal(retired.missionVersion, preview.missionVersion + ONE);
  assert.ok(retired.idempotencyKey);
});

test("mission imports accept empty Markdown controls, embedded files and JSON entries", async (t) => {
  const fixture = await setup(t);
  const mission = await createMission(fixture);
  for (const manifest of [
    IMPORT_CONTROLS,
    { ...IMPORT_CONTROLS, missionId: mission.id, files: [] },
    { ...IMPORT_CONTROLS, format: ImportFormat.Json, entries: [] },
  ]) {
    const preview = await previewImport(fixture, mission.id, manifest, []);
    const applied = await applyImport(
      fixture,
      mission.id,
      manifest,
      [],
      preview,
    );
    assert.equal(applied.missionVersion, mission.version);
    assert.ok(applied.idempotencyKey);
  }
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

type Page<T> = { items: T[]; nextCursor: string | null };
type Scenario = {
  fixture: Fixture;
  mission: Mission;
  version: number;
  initiativeId: string;
  objectiveId: string;
  secondObjectiveId: string;
  taskId: string;
  importedId: string;
  bindingId: string;
  createArgs: string[];
  created: Mutation;
};
type RepositoryRecord = { id: string; name: string; revision: number };
type RepositorySet = Record<
  string,
  {
    kind: typeof BindingKind.Repository;
    config: typeof REPOSITORY_CONFIGURATION;
  }
>;

async function readNode(fixture: Fixture, nodeId: string): Promise<Node> {
  const node = success<Node>(
    await kanthord([MISSION, NODE, GET, nodeId], fixture.env),
  );
  assert.equal(node.id, nodeId);
  assert.ok(node.visibleRevision >= ONE);
  return node;
}

async function scenarioChange(
  scenario: Scenario,
  args: string[],
  fields: object = {},
): Promise<Mutation> {
  const { fixture, version } = scenario;
  const path = jsonFile(fixture, SCENARIO_FILE, {
    reason: REASON,
    expectedMissionVersion: version,
    ...fields,
  });
  const changed = success<Mutation>(
    await kanthord([MISSION, ...args, FILE, path], fixture.env),
  );
  assert.equal(changed.missionVersion, version + ONE);
  assert.ok(changed.idempotencyKey);
  scenario.version = changed.missionVersion;
  return changed;
}

async function queued(scenario: Scenario, nodeId: string): Promise<void> {
  const { fixture, mission } = scenario;
  const queue = success<Page<Job>>(
    await kanthord([SCHEDULER, QUEUE, LIST, mission.projectId], fixture.env),
  );
  assert.equal(queue.nextCursor, null);
  const job = queue.items.find((item) => item.nodeId === nodeId);
  assert.ok(job);
  assert.equal(job.projectId, mission.projectId);
}

async function scenarioProject(fixture: Fixture): Promise<Mission> {
  const args = [PROJECT, CREATE, NAME, PROJECT_NAME, KEY, ulid()];
  const project = success<{ id: string; bindingSetVersion: number }>(
    await kanthord(args, fixture.env),
  );
  assert.equal(project.bindingSetVersion, ONE);
  const mission = success<Mission>(
    await kanthord([MISSION, GET, project.id], fixture.env),
  );
  assert.ok(mission.id.startsWith(`${MISSION_IDENTITY_PREFIX}_`));
  assert.equal(mission.version, MISSION_INITIAL_VERSION);
  assert.equal(mission.projectId, project.id);
  const replayed = success<{ id: string }>(await kanthord(args, fixture.env));
  assert.equal(replayed.id, project.id);
  assert.deepEqual(replayed, project);
  const reread = success<Mission>(
    await kanthord([MISSION, GET, project.id], fixture.env),
  );
  assert.deepEqual(reread, mission);
  await configureRepository(fixture, project.id);
  return mission;
}

async function scenarioInitiative(fixture: Fixture): Promise<Scenario> {
  const mission = await scenarioProject(fixture);
  const path = jsonFile(fixture, INITIATIVE_FILE, {
    filename: INITIATIVE_PLAN,
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
    path,
    KEY,
    ulid(),
  ];
  const created = success<Mutation>(await kanthord(createArgs, fixture.env));
  assert.equal(created.missionVersion, mission.version + ONE);
  assert.equal(created.revisions.length, ONE);
  const initiativeId = created.revisions[0]!.nodeId;
  assert.ok(initiativeId.startsWith(`${NODE_IDENTITY_PREFIX}_`));
  const scenario: Scenario = {
    fixture,
    mission,
    version: created.missionVersion,
    initiativeId,
    objectiveId: EMPTY,
    secondObjectiveId: EMPTY,
    taskId: EMPTY,
    importedId: EMPTY,
    bindingId: EMPTY,
    createArgs,
    created,
  };
  await queued(scenario, initiativeId);
  const peek = success<{ job: Job | null }>(
    await kanthord([SCHEDULER, QUEUE, PEEK, mission.projectId], fixture.env),
  );
  assert.equal(peek.job?.nodeId, initiativeId);
  const initiative = await readNode(fixture, initiativeId);
  assert.equal(initiative.kind, NodeKind.Initiative);
  assert.equal(initiative.state, NodeState.Available);
  return scenario;
}

async function scenarioChildren(scenario: Scenario): Promise<void> {
  const { fixture, mission, initiativeId } = scenario;
  const bindings = success<Page<RepositoryRecord>>(
    await kanthord([PROJECT, BINDING, LIST, mission.projectId], fixture.env),
  );
  assert.equal(bindings.items.length, ONE);
  scenario.bindingId = bindings.items[0]!.id;
  const objective = await createNode(
    fixture,
    mission.id,
    NodeKind.Objective,
    scenario.version,
    initiativeId,
  );
  assert.equal(objective.missionVersion, scenario.version + ONE);
  assert.equal(objective.revisions.length, ONE);
  scenario.objectiveId = objective.revisions[0]!.nodeId;
  scenario.version = objective.missionVersion;
  const read = await readNode(fixture, scenario.objectiveId);
  assert.deepEqual(read.content.bindings, [scenario.bindingId]);
  const task = await createNode(
    fixture,
    mission.id,
    NodeKind.Task,
    scenario.version,
    scenario.objectiveId,
  );
  assert.equal(task.missionVersion, scenario.version + ONE);
  const taskId = task.revisions[0]?.tasks?.[0]?.id;
  assert.ok(taskId);
  scenario.taskId = taskId;
  scenario.version = task.missionVersion;
  const listed = success<Page<Node>>(
    await kanthord([MISSION, NODE, LIST, mission.id], fixture.env),
  );
  assert.equal(listed.items.length, THREE);
  assert.equal(listed.nextCursor, null);
  assert.deepEqual(
    listed.items.map(({ id }) => id).sort(),
    [initiativeId, scenario.objectiveId, taskId].sort(),
  );
}

async function scenarioRevisions(scenario: Scenario): Promise<void> {
  const { fixture, objectiveId } = scenario;
  const before = await readNode(fixture, objectiveId);
  await scenarioChange(scenario, [NODE, UPDATE, objectiveId], {
    filename: before.filename,
    content: {
      ...before.content,
      name: UPDATED_NAME,
      bindings: [REPOSITORY_NAME],
    },
    expectedRevision: before.visibleRevision,
  });
  const updated = await readNode(fixture, objectiveId);
  assert.equal(updated.content.name, UPDATED_NAME);
  assert.equal(updated.visibleRevision, before.visibleRevision + ONE);
  const revisions = success<Page<Revision>>(
    await kanthord([MISSION, NODE, REVISION, LIST, objectiveId], fixture.env),
  );
  assert.ok(revisions.items.length >= ONE);
  assert.equal(revisions.items[0]?.revision, updated.visibleRevision);
  const first = success<Revision>(
    await kanthord(
      [MISSION, NODE, REVISION, GET, objectiveId, VALID_REVISION],
      fixture.env,
    ),
  );
  assert.equal(first.revision, ONE);
  assert.equal(first.content.name, CONTENT.name);
}

async function scenarioMove(scenario: Scenario): Promise<void> {
  const { fixture, mission, initiativeId, objectiveId, taskId } = scenario;
  const initiative = await readNode(fixture, initiativeId);
  const second = await createNode(
    fixture,
    mission.id,
    NodeKind.Objective,
    scenario.version,
    initiativeId,
    initiative.visibleRevision,
  );
  assert.equal(second.missionVersion, scenario.version + ONE);
  assert.equal(second.revisions.length, ONE);
  scenario.secondObjectiveId = second.revisions[0]!.nodeId;
  scenario.version = second.missionVersion;
  const oldParent = await readNode(fixture, objectiveId);
  const newParent = await readNode(fixture, scenario.secondObjectiveId);
  const task = await readNode(fixture, taskId);
  await scenarioChange(scenario, [NODE, MOVE, taskId], {
    newParentId: newParent.id,
    expectedRevision: task.visibleRevision,
    expectedOldParentRevision: oldParent.visibleRevision,
    expectedNewParentRevision: newParent.visibleRevision,
  });
  const moved = await readNode(fixture, taskId);
  assert.equal(moved.parentId, newParent.id);
  assert.equal(moved.kind, NodeKind.Task);
}

async function scenarioDependencies(scenario: Scenario): Promise<void> {
  const { fixture, mission, objectiveId, secondObjectiveId } = scenario;
  await scenarioChange(scenario, [
    DEPENDENCY,
    ADD,
    objectiveId,
    secondObjectiveId,
  ]);
  const pending = await readNode(fixture, objectiveId);
  assert.ok(pending.kind !== NodeKind.Task);
  assert.equal(pending.state, NodeState.Pending);
  await scenarioChange(scenario, [
    DEPENDENCY,
    REMOVE,
    objectiveId,
    secondObjectiveId,
  ]);
  const available = await readNode(fixture, objectiveId);
  assert.ok(available.kind !== NodeKind.Task);
  assert.equal(available.state, NodeState.Available);
  const edges = success<Page<Edge>>(
    await kanthord([MISSION, EDGE, LIST, mission.id], fixture.env),
  );
  assert.ok(edges.items.length >= ONE);
  assert.equal(edges.nextCursor, null);
  await scenarioChange(scenario, [CRITERION, SET, objectiveId], {
    criterion: UPDATED_CRITERION,
    verifications: CONTENT.verifications,
    expectedRevision: available.visibleRevision,
  });
  const revised = await readNode(fixture, objectiveId);
  assert.equal(revised.content.criterion, UPDATED_CRITERION);
  assert.equal(revised.visibleRevision, available.visibleRevision + ONE);
}

async function scenarioRetire(scenario: Scenario): Promise<void> {
  const { fixture, objectiveId } = scenario;
  const preview = success<RetirePreview>(
    await kanthord([MISSION, NODE, RETIRE, PREVIEW, objectiveId], fixture.env),
  );
  assert.match(preview.previewDigest, DIGEST_PATTERN);
  assert.equal(preview.missionVersion, scenario.version);
  assert.deepEqual(preview.retiredNodeIds, [objectiveId]);
  const retired = await scenarioChange(scenario, [NODE, RETIRE, objectiveId], {
    previewDigest: preview.previewDigest,
  });
  assert.ok(retired.retiredNodeIds.includes(objectiveId));
  const read = await readNode(fixture, objectiveId);
  assert.notEqual(read.retiredAt, null);
}

async function scenarioExport(scenario: Scenario, filename: string) {
  const { fixture, mission } = scenario;
  const out = join(fixture.directory, filename);
  const summary = success<{ missionId: string; missionVersion: number }>(
    await kanthord(exportArgs(mission.id, ImportFormat.Json, out), fixture.env),
  );
  assert.equal(summary.missionId, mission.id);
  assert.equal(summary.missionVersion, scenario.version);
  const exported = JSON.parse(readFileSync(out, UTF8)) as ExportAnswer;
  assert.ok(JSON_ENTRIES in exported);
  assert.equal(exported.missionId, summary.missionId);
  assert.equal(exported.missionVersion, summary.missionVersion);
  return exported;
}

async function scenarioImport(scenario: Scenario): Promise<void> {
  const { fixture, mission } = scenario;
  const exported = await scenarioExport(scenario, OUTPUT_FILE);
  assert.deepEqual(
    exported.entries.map(({ id }) => id).sort(),
    [scenario.initiativeId, scenario.secondObjectiveId, scenario.taskId].sort(),
  );
  const manifest = {
    format: ImportFormat.Json,
    missionId: mission.id,
    missionVersion: exported.missionVersion,
    reason: REASON,
    entries: [
      ...exported.entries,
      {
        ...CONTENT,
        filename: NEW_OBJECTIVE_FILE,
        kind: NodeKind.Objective,
        parent: INITIATIVE_PLAN,
        bindings: [REPOSITORY_NAME],
        dependsOn: [],
      },
    ],
  };
  const preview = await previewImport(fixture, mission.id, manifest, []);
  assert.deepEqual(preview.retirements, []);
  assert.deepEqual(preview.creates, [NEW_OBJECTIVE_FILE]);
  const path = jsonFile(fixture, MANIFEST_FILE, {
    ...manifest,
    previewDigest: preview.previewDigest,
    confirmedRetirements: preview.retirements,
  });
  const applied = success<ImportMutation>(
    await kanthord(
      [MISSION, IMPORT, APPLY, mission.id, FILE, path],
      fixture.env,
    ),
  );
  assert.equal(applied.missionVersion, scenario.version + ONE);
  scenario.version = applied.missionVersion;
  const assigned = applied.assignedIds.find(
    ({ filename }) => filename === NEW_OBJECTIVE_FILE,
  );
  assert.ok(assigned);
  scenario.importedId = assigned.nodeId;
  await queued(scenario, assigned.nodeId);
  const after = await scenarioExport(scenario, EXISTING_EXPORT_FILE);
  assert.equal(after.entries.length, exported.entries.length + ONE);
  assert.ok(after.entries.some(({ id }) => id === assigned.nodeId));
}

async function applyRepositorySet(scenario: Scenario, bindings: RepositorySet) {
  const { fixture, mission } = scenario;
  const project = success<{ id: string; bindingSetVersion: number }>(
    await kanthord([PROJECT, GET, mission.projectId], fixture.env),
  );
  const path = jsonFile(fixture, SCENARIO_FILE, {
    version: project.bindingSetVersion,
    bindings,
  });
  const applied = success<{ projectId: string; bindingSetVersion: number }>(
    await kanthord(
      [PROJECT, BINDING, APPLY, mission.projectId, FILE, path],
      fixture.env,
    ),
  );
  assert.equal(applied.projectId, mission.projectId);
  assert.equal(applied.bindingSetVersion, project.bindingSetVersion + ONE);
  const listed = success<Page<RepositoryRecord>>(
    await kanthord([PROJECT, BINDING, LIST, mission.projectId], fixture.env),
  );
  assert.equal(listed.items.length, Object.keys(bindings).length);
  assert.equal(listed.nextCursor, null);
  return listed.items;
}

async function scenarioRebind(scenario: Scenario): Promise<void> {
  const { fixture, mission, secondObjectiveId, importedId } = scenario;
  const bindings = await applyRepositorySet(scenario, {
    [REPOSITORY_NAME]: {
      kind: BindingKind.Repository,
      config: {
        ...REPOSITORY_CONFIGURATION,
        strategy: { baseBranch: NEXT_BRANCH },
      },
    },
  });
  const next = bindings.find(({ name }) => name === REPOSITORY_NAME);
  assert.ok(next);
  assert.equal(next.revision, TWO);
  assert.notEqual(next.id, scenario.bindingId);
  const path = jsonFile(fixture, SCENARIO_FILE, {
    reason: REASON,
    expectedMissionVersion: scenario.version,
  });
  const rebound = success<RebindResult>(
    await kanthord(
      [MISSION, NODE, REBIND, mission.id, next.id, FILE, path],
      fixture.env,
    ),
  );
  assert.equal(rebound.nodeChange.missionVersion, scenario.version + ONE);
  assert.equal(rebound.skipped.length, ONE);
  assert.equal(rebound.skipped[0]?.node.id, scenario.objectiveId);
  assert.equal(rebound.skipped[0]?.condition, RebindSkipCondition.Retired);
  assert.deepEqual(
    rebound.nodeChange.revisions.map(({ nodeId }) => nodeId).sort(),
    [secondObjectiveId, importedId].sort(),
  );
  scenario.version = rebound.nodeChange.missionVersion;
  scenario.bindingId = next.id;
  const second = await readNode(fixture, secondObjectiveId);
  const imported = await readNode(fixture, importedId);
  assert.deepEqual(second.content.bindings, [next.id]);
  assert.deepEqual(imported.content.bindings, [next.id]);
}

async function scenarioPriorityReplay(scenario: Scenario): Promise<void> {
  const { fixture, mission, secondObjectiveId, createArgs, created } = scenario;
  const path = jsonFile(fixture, SCENARIO_FILE, {
    value: PRIORITY_VALUE,
    expectedMissionVersion: scenario.version,
  });
  const priority = success<Node>(
    await kanthord(
      [MISSION, NODE, PRIORITY, SET, secondObjectiveId, FILE, path],
      fixture.env,
    ),
  );
  assert.equal(priority.id, secondObjectiveId);
  assert.ok(priority.kind !== NodeKind.Task);
  assert.equal(priority.priority, PRIORITY_VALUE);
  const read = await readNode(fixture, secondObjectiveId);
  assert.ok(read.kind !== NodeKind.Task);
  assert.equal(read.priority, PRIORITY_VALUE);
  const beforeReplay = success<Mission>(
    await kanthord([MISSION, GET, mission.projectId], fixture.env),
  );
  const replay = success<Mutation>(await kanthord(createArgs, fixture.env));
  assert.equal(replay.revisions[0]?.nodeId, scenario.initiativeId);
  assert.deepEqual(replay, created);
  const afterReplay = success<Mission>(
    await kanthord([MISSION, GET, mission.projectId], fixture.env),
  );
  assert.deepEqual(afterReplay, beforeReplay);
  scenario.version = afterReplay.version;
}

test(
  "E06.1-E06.24 mission planning lifecycle and replay",
  { timeout: PLANNING_LIFECYCLE_TIMEOUT_MS },
  async (t) => {
    const scenario = await scenarioInitiative(await setup(t));
    await scenarioChildren(scenario);
    await scenarioRevisions(scenario);
    await scenarioMove(scenario);
    await scenarioDependencies(scenario);
    await scenarioRetire(scenario);
    await scenarioImport(scenario);
    await scenarioRebind(scenario);
    await scenarioPriorityReplay(scenario);
    const { fixture, mission } = scenario;
    await t.test("E06.25 oversized node content is refused", async () => {
      const content = {
        ...CONTENT,
        name: LARGE_TEXT_CHARACTER.repeat(LARGE_TEXT_BYTES),
      };
      assert.equal(Buffer.byteLength(content.name, UTF8), LARGE_TEXT_BYTES);
      const path = jsonFile(fixture, SCENARIO_FILE, {
        filename: REFUSED_PLAN,
        kind: NodeKind.Initiative,
        content,
        reason: REASON,
        expectedMissionVersion: scenario.version,
      });
      refusal(
        await kanthord(
          [MISSION, NODE, CREATE, mission.id, FILE, path],
          fixture.env,
        ),
        MissionErrorCode.ContentInvalid,
      );
      const read = success<Mission>(
        await kanthord([MISSION, GET, mission.projectId], fixture.env),
      );
      assert.equal(read.version, scenario.version);
    });
    await t.test(
      "E06.26 creating a child of the retired objective is refused",
      async () => {
        const parent = await readNode(fixture, scenario.objectiveId);
        assert.notEqual(parent.retiredAt, null);
        const path = jsonFile(fixture, SCENARIO_FILE, {
          filename: REFUSED_PLAN,
          kind: NodeKind.Task,
          content: CONTENT,
          parentId: parent.id,
          expectedParentRevision: parent.visibleRevision,
          reason: REASON,
          expectedMissionVersion: scenario.version,
        });
        refusal(
          await kanthord(
            [MISSION, NODE, CREATE, mission.id, FILE, path],
            fixture.env,
          ),
          MissionErrorCode.Retired,
        );
        const read = success<Mission>(
          await kanthord([MISSION, GET, mission.projectId], fixture.env),
        );
        assert.equal(read.version, scenario.version);
      },
    );
    await t.test(
      "E06.27 rebinding to a tombstoned binding is refused without changing pins",
      async () => {
        await scenarioRemovedBinding(scenario);
      },
    );
  },
);

async function scenarioRemovedBinding(scenario: Scenario): Promise<void> {
  const { fixture, mission, secondObjectiveId } = scenario;
  const original = {
    kind: BindingKind.Repository,
    config: {
      ...REPOSITORY_CONFIGURATION,
      strategy: { baseBranch: NEXT_BRANCH },
    },
  };
  const added = await applyRepositorySet(scenario, {
    [REPOSITORY_NAME]: original,
    [SECOND_REPOSITORY_NAME]: {
      kind: BindingKind.Repository,
      config: {
        ...REPOSITORY_CONFIGURATION,
        address: SECOND_REPOSITORY_ADDRESS,
      },
    },
  });
  const extra = added.find(({ name }) => name === SECOND_REPOSITORY_NAME);
  assert.ok(extra);
  await applyRepositorySet(scenario, { [REPOSITORY_NAME]: original });
  const before = await readNode(fixture, secondObjectiveId);
  assert.deepEqual(before.content.bindings, [scenario.bindingId]);
  const path = jsonFile(fixture, SCENARIO_FILE, {
    reason: REASON,
    expectedMissionVersion: scenario.version,
  });
  refusal(
    await kanthord(
      [MISSION, NODE, REBIND, mission.id, extra.id, FILE, path],
      fixture.env,
    ),
    MissionErrorCode.BindingRemoved,
  );
  const after = await readNode(fixture, secondObjectiveId);
  assert.deepEqual(after.content.bindings, before.content.bindings);
  assert.deepEqual(after, before);
  const read = success<Mission>(
    await kanthord([MISSION, GET, mission.projectId], fixture.env),
  );
  assert.equal(read.version, scenario.version);
}
