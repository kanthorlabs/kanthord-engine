import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
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
  TASK_IDENTITY_PREFIX,
  TaskChange,
  type TaskContent,
  MissionErrorCode,
  RebindSkipCondition,
  type Attempt,
  type ControlResult,
  type Node,
  type Revision,
  type RebindResult,
  type Edge,
  Intent,
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
import {
  applyCoveringBindings,
  COVERING_WORKER_BINDINGS,
  createFakeSshCredential,
  enableCoveringAgents,
  gatewayFixture,
} from "./test-support.ts";
import { createIdempotencyKey } from "../../kernel/identity.ts";

const SUCCESS = 0;
const FAILURE = 1;
const PLANNING_LIFECYCLE_TIMEOUT_MS = 120000;
const NODE_EDIT_LIFECYCLE_TIMEOUT_MS = 60000;
const IMPORT_LIFECYCLE_TIMEOUT_MS = 60000;
const IMPORT_APPLY_VALIDATION_TIMEOUT_MS = 60000;
const NO_OUTPUT = "";
const UNSET_NODE_ID = "";
const UTF8 = "utf8";
const MODE_MASK = 0o777;
const SHARED_DIRECTORY_MODE = 0o755;
const DATA = "data";
const STATE_DIRECTORY = "state";
const MISSION = "mission";
const PROJECT = "project";
const CREATE = "create";
const GET = "get";
const UPDATE = "update";
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
const REPOSITORY = "repository";
const FILE = "--file";
const FIRST_REVISION = 1;
const VERSION_INCREMENT = 1;
const SINGLE_ITEM = 1;
const SECOND_REVISION = 2;
const COVERED_BINDING_VERSION = 3;
const REPOSITORY_BINDING_VERSION = 4;
const REPOSITORY_NAME = "repo";
const REPOSITORY_ADDRESS = "git@github.com:owner/repo.git";
const OTHER_REPOSITORY_NAME = "other-repo";
const OTHER_REPOSITORY_ADDRESS = "git@github.com:owner/other-repo.git";
const READY = "ready";
const ATTEMPT = "attempt";
const NO_ATTEMPT = 0;
const STATE_CONFLICT = "mission.node.state_conflict";
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
const TWO_ITEMS = 2;
const THREE_ITEMS = 3;
const DIGEST = "0".repeat(64);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const TASK_ID_PATTERN = /^task_[0-9A-HJKMNP-TV-Z]{26}$/;
const MANIFEST_FILE = "manifest.json";
const RETIRE_FILE = "retire.json";
const PLAN_FIRST_REVISION = "plan1.md";
const PLAN_SECOND_REVISION = "plan2.md";
const NEW_NODE_FILE = "new-implement.md";
const NEW_TASK_FILE = "new-task.md";
const TASK_FILE = "task-1.md";
const NEW_NODE_CONTENT = [
  "---",
  "intent: implement",
  "depends_on: []",
  "tags: []",
  "bindings: [repo]",
  "verifications: [Check result]",
  "---",
  "# New implement node — unchanged UTF-8",
  "",
  "## Requirement",
  "Do new work",
  "",
  "## Criterion",
  "New work is done",
  "",
].join("\r\n");
const NEW_TASK_CONTENT = [
  "---",
  "node: new-implement.md",
  "bindings: []",
  "verifications: [Check result]",
  "---",
  "# New task",
  "",
  "## Requirement",
  "Do new task work",
  "",
  "## Criterion",
  "New task work is done",
  "",
].join("\r\n");
const IMPORT_CONTROLS = {
  format: ImportFormat.Markdown,
  mission_version: FIRST_REVISION,
  reason: REASON,
};
const APPLY_CONTROLS = { preview_digest: DIGEST, confirmed_retirements: [] };
const RETIRE_CONTROLS = {
  reason: REASON,
  expected_mission_version: FIRST_REVISION,
  preview_digest: DIGEST,
};
const EXPORT = "export";
const HELP = "--help";
const ENDPOINT = "--endpoint";
const TOKEN = "--token";
const INTENT_OPTION = "--intent";
const STATE = "--state";
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
const SHARED_DIRECTORY = "shared";
const PUBLISH_FAILED = "system.files.publish_failed";
const EXISTING_FILE = "keep.md";
const EXISTING_CONTENT = "preserve this file";
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
const INVALID_INTENT_CODE = "cli.mission.node.list.invalid_intent";
const INVALID_STATE_CODE = "cli.mission.node.list.invalid_state";
const INVALID_EDGE_NODE_CODE = "cli.mission.edge.list.invalid_node_id";
const INVALID_RETIRE_NODE_CODE =
  "cli.mission.node.retire.preview.invalid_node_id";
const UNKNOWN_OPTION = /unknown option/;
const LOCAL_FLAGS = [ENDPOINT, LOCAL_ENDPOINT, TOKEN, LOCAL_TOKEN];
const SCENARIO_FILE = "scenario.json";
const EXAMINE_FILE = "scenario-examine.json";
const EXAMINE_PLAN = "scenario-examine.md";
const EXISTING_EXPORT_FILE = "expanded-mission.json";
const UPDATED_NAME = "Updated implement node";
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
  ssh_credential: "github-ssh",
  strategy: { base_branch: MAIN_BRANCH },
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
  {
    args: [NODE, LIST, MISSION_ID, INTENT_OPTION, INVALID],
    code: INVALID_INTENT_CODE,
  },
  { args: [NODE, LIST, MISSION_ID, STATE, INVALID], code: INVALID_STATE_CODE },
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
    args: [
      NODE,
      LIST,
      MISSION_ID,
      INTENT_OPTION,
      Intent.Implement,
      INTENT_OPTION,
      Intent.Implement,
    ],
    code: DUPLICATE_OPTION,
  },
];

type Result = Awaited<ReturnType<typeof kanthord>>;
type Fixture = { directory: string; env: NodeJS.ProcessEnv };
type Mutation = NodeChange & { idempotency_key: string };
type ImportMutation = ImportResult & { idempotency_key: string };

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
    repositoryConnector: {
      gitLsRemote: async () => {},
    },
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
  assert.equal(result.stderr, NO_OUTPUT);
  return JSON.parse(result.stdout) as T;
}

function refusal(result: Result, code: string): void {
  assert.equal(result.code, FAILURE, result.stderr);
  assert.ok(result.stderr.startsWith(`${code}:`), result.stderr);
  assert.equal(result.stdout, NO_OUTPUT);
}

async function createMission(fixture: Fixture): Promise<Mission> {
  const project = success<{ id: string }>(
    await kanthord([PROJECT, CREATE, NAME, PROJECT_NAME], fixture.env),
  );
  const mission = success<Mission>(
    await kanthord([MISSION, GET, project.id], fixture.env),
  );
  assert.ok(mission.id.startsWith(`${MISSION_IDENTITY_PREFIX}_`));
  assert.equal(mission.project_id, project.id);
  assert.equal(mission.version, MISSION_INITIAL_VERSION);
  assert.ok(fixture.directory);
  await enableCoveringAgents(fixture.env);
  assert.equal(
    await applyCoveringBindings(fixture.env, fixture.directory, project.id),
    COVERED_BINDING_VERSION,
  );
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
  intent: Intent,
  version: number,
  bindings: string[] = [],
  tasks: string[] = [],
): Promise<Mutation> {
  assert.ok(missionId);
  assert.ok(Number.isSafeInteger(version));
  const body = {
    filename: `${intent}-${version}.md`,
    content: { ...CONTENT, intent, bindings },
    tasks: tasks.map((filename) => ({ filename, content: CONTENT })),
    reason: REASON,
    expected_mission_version: version,
  };
  const path = jsonFile(fixture, `${intent}-${version}.json`, body);
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
  for (const flag of [INTENT_OPTION, STATE, INCLUDE_RETIRED])
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
  writePrivate(invalid, JSON.stringify({ intent: Intent.Examine }));
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
  ] as const) {
    refusal(
      await kanthord([MISSION, NODE, leaf, id, FILE, invalid], env),
      code,
    );
  }
  for (const [leaf, code] of [
    [CREATE, "cli.mission.node.create.invalid_mission_id"],
    [UPDATE, "cli.mission.node.update.invalid_node_id"],
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
  "mission node create replay and update an implement node with its task",
  { timeout: NODE_EDIT_LIFECYCLE_TIMEOUT_MS },
  async (t) => {
    const fixture = await setup(t);
    const mission = await createMission(fixture);
    const key = createIdempotencyKey();
    const examineFile = jsonFile(fixture, "examine.json", {
      filename: "examine.md",
      content: { ...CONTENT, intent: Intent.Examine },
      tasks: [],
      reason: REASON,
      expected_mission_version: mission.version,
    });
    const createArgs = [
      MISSION,
      NODE,
      CREATE,
      mission.id,
      FILE,
      examineFile,
      KEY,
      key,
    ];
    const created = success<Mutation>(await kanthord(createArgs, fixture.env));
    assert.equal(created.idempotency_key, key);
    assert.equal(created.revisions.length, SINGLE_ITEM);
    const examineId = created.revisions[0]!.node_id;
    const replayed = success<Mutation>(await kanthord(createArgs, fixture.env));
    assert.equal(replayed.revisions[0]?.node_id, examineId);
    assert.deepEqual(replayed, created);
    const updated = success<Mutation>(
      await kanthord(
        [
          MISSION,
          NODE,
          UPDATE,
          examineId,
          FILE,
          jsonFile(fixture, "update.json", {
            filename: "examine.md",
            content: {
              ...CONTENT,
              intent: Intent.Examine,
              name: "Updated plan",
            },
            tasks: [],
            reason: REASON,
            expected_revision: FIRST_REVISION,
            expected_mission_version: SECOND_REVISION,
          }),
        ],
        fixture.env,
      ),
    );
    assert.equal(
      updated.mission_version,
      created.mission_version + VERSION_INCREMENT,
    );
    assert.equal(updated.revisions[0]?.revision, SECOND_REVISION);
    assert.ok(updated.idempotency_key);
    const credential = jsonFile(fixture, "credential.json", {
      name: REPOSITORY_PLATFORM,
      platform: REPOSITORY_PLATFORM,
      metadata: null,
      secret: { key: "test-secret" },
    });
    success(
      await kanthord(
        [REPOSITORY, CREDENTIAL, CREATE, FILE, credential],
        fixture.env,
      ),
    );
    await createFakeSshCredential(async <T>(args: string[]) =>
      success<T>(await kanthord(args, fixture.env)),
    );
    const bindingFile = jsonFile(fixture, "binding.json", {
      version: COVERED_BINDING_VERSION,
      bindings: {
        ...COVERING_WORKER_BINDINGS,
        [REPOSITORY_NAME]: {
          kind: BindingKind.Repository,
          config: {
            available: true,
            platform: REPOSITORY_PLATFORM,
            address: REPOSITORY_ADDRESS,
            ssh_credential: "github-ssh",
            strategy: { base_branch: "main" },
            credential: REPOSITORY_PLATFORM,
          },
        },
      },
    });
    const binding = success<{
      binding_set_version: number;
      bindings: Record<string, { id: string }>;
    }>(
      await kanthord(
        [PROJECT, BINDING, APPLY, mission.project_id, FILE, bindingFile],
        fixture.env,
      ),
    );
    assert.equal(binding.binding_set_version, REPOSITORY_BINDING_VERSION);
    const bindingId = binding.bindings[REPOSITORY_NAME]!.id;
    const first = await createNode(
      fixture,
      mission.id,
      Intent.Implement,
      updated.mission_version,
      [bindingId],
      [TASK_FILE],
    );
    const second = await createNode(
      fixture,
      mission.id,
      Intent.Implement,
      first.mission_version,
      [bindingId],
    );
    const firstId = first.revisions[0]!.node_id;
    const secondId = second.revisions[0]!.node_id;
    const taskId = first.revisions[0]!.tasks[0]!.id;
    assert.ok(taskId.startsWith(`${TASK_IDENTITY_PREFIX}_`));
    const read = success<Node>(
      await kanthord([MISSION, NODE, GET, firstId], fixture.env),
    );
    assert.equal(read.intent, Intent.Implement);
    assert.deepEqual(read.tags, []);
    assert.deepEqual(
      read.tasks.map((task) => task.id),
      [taskId],
    );
    const graphFile = (version: number) =>
      jsonFile(fixture, `graph-${version}.json`, {
        reason: REASON,
        expected_mission_version: version,
      });
    const added = success<Mutation>(
      await kanthord(
        [
          MISSION,
          DEPENDENCY,
          ADD,
          firstId,
          secondId,
          FILE,
          graphFile(second.mission_version),
        ],
        fixture.env,
      ),
    );
    assert.equal(
      added.mission_version,
      second.mission_version + VERSION_INCREMENT,
    );
    assert.ok(added.idempotency_key);
    const pending = success<{ state: string }>(
      await kanthord([MISSION, NODE, GET, firstId], fixture.env),
    );
    assert.equal(pending.state, NodeState.Pending);
    const removed = success<Mutation>(
      await kanthord(
        [
          MISSION,
          DEPENDENCY,
          REMOVE,
          firstId,
          secondId,
          FILE,
          graphFile(added.mission_version),
        ],
        fixture.env,
      ),
    );
    assert.equal(
      removed.mission_version,
      added.mission_version + VERSION_INCREMENT,
    );
    const available = success<{ state: string; visible_revision: number }>(
      await kanthord([MISSION, NODE, GET, firstId], fixture.env),
    );
    assert.equal(available.state, NodeState.Available);
    assert.ok(available.visible_revision >= FIRST_REVISION);
    const criterion = success<Mutation>(
      await kanthord(
        [
          MISSION,
          CRITERION,
          SET,
          firstId,
          FILE,
          jsonFile(fixture, "criterion.json", {
            criterion: "Revised criterion",
            verifications: ["true"],
            reason: REASON,
            expected_revision: available.visible_revision,
            expected_mission_version: removed.mission_version,
          }),
        ],
        fixture.env,
      ),
    );
    assert.equal(
      criterion.mission_version,
      removed.mission_version + VERSION_INCREMENT,
    );
    const priority = success<{
      id: string;
      priority: number;
      idempotency_key: string;
    }>(
      await kanthord(
        [
          MISSION,
          NODE,
          PRIORITY,
          SET,
          secondId,
          FILE,
          jsonFile(fixture, "priority.json", {
            value: PRIORITY_VALUE,
            expected_mission_version: criterion.mission_version,
          }),
        ],
        fixture.env,
      ),
    );
    assert.equal(priority.id, secondId);
    assert.equal(priority.priority, PRIORITY_VALUE);
    assert.ok(priority.idempotency_key);
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
  test(
    `mission import ${action} validates positional files and its final schema offline`,
    action === APPLY ? { timeout: IMPORT_APPLY_VALIDATION_TIMEOUT_MS } : {},
    async (t) => {
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
        await kanthord(
          [...local, PLAN_FIRST_REVISION, PLAN_SECOND_REVISION],
          fixture.env,
        ),
        `cli.mission.import.${action}.files_conflict`,
      );
      jsonFile(fixture, MANIFEST_FILE, {
        ...controls,
        format: ImportFormat.Json,
        entries: [],
      });
      refusal(
        await kanthord([...local, PLAN_FIRST_REVISION], fixture.env),
        `cli.mission.import.${action}.positionals_not_accepted`,
      );
      jsonFile(fixture, MANIFEST_FILE, controls);
      refusal(
        await kanthord(
          [...local, join(fixture.directory, PLAN_FIRST_REVISION)],
          fixture.env,
        ),
        FILE_NOT_FOUND,
      );
      for (const manifest of [
        controls,
        { ...controls, format: ImportFormat.Json },
        { ...controls, files: null },
        { ...controls, mission_id: null },
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
        const result = await kanthord(
          [...local, KEY, createIdempotencyKey()],
          fixture.env,
        );
        assert.equal(result.code, FAILURE);
        assert.match(result.stderr, UNKNOWN_OPTION);
      }
    },
  );
}

async function configureRepository(
  fixture: Fixture,
  projectId: string,
): Promise<string> {
  const credential = jsonFile(fixture, "import-credential.json", {
    name: REPOSITORY_PLATFORM,
    platform: REPOSITORY_PLATFORM,
    metadata: null,
    secret: { key: "test-secret" },
  });
  success(
    await kanthord(
      [REPOSITORY, CREDENTIAL, CREATE, FILE, credential],
      fixture.env,
    ),
  );
  await createFakeSshCredential(async <T>(args: string[]) =>
    success<T>(await kanthord(args, fixture.env)),
  );
  const bindingFile = jsonFile(fixture, "import-binding.json", {
    version: COVERED_BINDING_VERSION,
    bindings: {
      ...COVERING_WORKER_BINDINGS,
      [REPOSITORY_NAME]: {
        kind: BindingKind.Repository,
        config: {
          available: true,
          platform: REPOSITORY_PLATFORM,
          address: REPOSITORY_ADDRESS,
          ssh_credential: "github-ssh",
          strategy: { base_branch: "main" },
          credential: REPOSITORY_PLATFORM,
        },
      },
    },
  });
  const result = success<{
    binding_set_version: number;
    bindings: Record<string, { id: string }>;
  }>(
    await kanthord(
      [PROJECT, BINDING, APPLY, projectId, FILE, bindingFile],
      fixture.env,
    ),
  );
  assert.equal(result.binding_set_version, REPOSITORY_BINDING_VERSION);
  assert.ok(projectId);
  return result.bindings[REPOSITORY_NAME]!.id;
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
  assert.match(preview.preview_digest, DIGEST_PATTERN);
  assert.deepEqual(preview.violations, []);
  assert.ok(!Object.hasOwn(preview, "idempotency_key"));
  return preview;
}

async function applyImport(
  fixture: Fixture,
  missionId: string,
  manifest: object,
  paths: string[],
  preview: ImportPreview,
): Promise<ImportMutation> {
  assert.equal(preview.mission_id, missionId);
  assert.deepEqual(preview.violations, []);
  const path = jsonFile(fixture, MANIFEST_FILE, {
    ...manifest,
    preview_digest: preview.preview_digest,
    confirmed_retirements: [],
  });
  const key = createIdempotencyKey();
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
  assert.equal(applied.idempotency_key, key);
  assert.deepEqual(success(await kanthord(args, fixture.env)), applied);
  return applied;
}

test(
  "mission Markdown export/import preserves the set, adds an implement node, then retires it",
  { timeout: IMPORT_LIFECYCLE_TIMEOUT_MS },
  async (t) => {
    const fixture = await setup(t);
    const mission = await createMission(fixture);
    const bindingId = await configureRepository(fixture, mission.project_id);
    const examine = await createNode(
      fixture,
      mission.id,
      Intent.Examine,
      mission.version,
    );
    const implement = await createNode(
      fixture,
      mission.id,
      Intent.Implement,
      examine.mission_version,
      [bindingId],
      [TASK_FILE],
    );
    const out = join(fixture.directory, OUTPUT_DIRECTORY);
    const exported = success<{ mission_version: number }>(
      await kanthord(
        exportArgs(mission.id, ImportFormat.Markdown, out),
        fixture.env,
      ),
    );
    assert.equal(exported.mission_version, implement.mission_version);
    const paths = readdirSync(out).map((filename) => join(out, filename));
    assert.equal(paths.length, THREE_ITEMS);
    const manifest = {
      ...IMPORT_CONTROLS,
      mission_version: exported.mission_version,
    };
    const preview = await previewImport(fixture, mission.id, manifest, paths);
    assert.equal(preview.no_ops.length, TWO_ITEMS);
    assert.deepEqual(preview.creates, []);
    const unchanged = await applyImport(
      fixture,
      mission.id,
      manifest,
      paths,
      preview,
    );
    assert.equal(unchanged.mission_version, exported.mission_version);
    assert.ok(unchanged.idempotency_key);
    assert.equal(unchanged.assigned_ids.length, THREE_ITEMS);
    const newPath = join(fixture.directory, NEW_NODE_FILE);
    writePrivate(newPath, NEW_NODE_CONTENT);
    const newTaskPath = join(fixture.directory, NEW_TASK_FILE);
    writePrivate(newTaskPath, NEW_TASK_CONTENT);
    const expandedPaths = [...paths, newPath, newTaskPath];
    const expanded = await previewImport(
      fixture,
      mission.id,
      manifest,
      expandedPaths,
    );
    assert.deepEqual(expanded.creates, [NEW_NODE_FILE, NEW_TASK_FILE]);
    const applied = await applyImport(
      fixture,
      mission.id,
      manifest,
      expandedPaths,
      expanded,
    );
    assert.equal(
      applied.mission_version,
      unchanged.mission_version + VERSION_INCREMENT,
    );
    assert.ok(applied.idempotency_key);
    assert.equal(
      applied.assigned_ids.length,
      unchanged.assigned_ids.length + TWO_ITEMS,
    );
    assert.ok(
      applied.assigned_ids.some(({ filename }) => filename === NEW_NODE_FILE),
    );
    assert.ok(
      applied.assigned_ids.some(
        (assigned) =>
          assigned.filename === NEW_TASK_FILE &&
          "task_id" in assigned &&
          assigned.task_id.startsWith(`${TASK_IDENTITY_PREFIX}_`),
      ),
    );
    assert.equal(readFileSync(newPath, UTF8), NEW_NODE_CONTENT);
    await retireImportedNode(fixture, applied);
  },
);

test(
  "EF01.1-EF01.6 tasks are content of their implement node through the CLI",
  { timeout: IMPORT_LIFECYCLE_TIMEOUT_MS },
  async (t) => {
    const fixture = await setup(t);
    const mission = await createMission(fixture);
    const bindingId = await configureRepository(fixture, mission.project_id);
    const created = success<Mutation>(
      await kanthord(
        [
          MISSION,
          NODE,
          CREATE,
          mission.id,
          FILE,
          jsonFile(fixture, "implement.json", {
            filename: "implement-tasks.md",
            content: {
              ...CONTENT,
              intent: Intent.Implement,
              bindings: [bindingId],
            },
            tasks: [
              { filename: "task-first.md", content: CONTENT },
              { filename: "task-second.md", content: CONTENT },
            ],
            reason: REASON,
            expected_mission_version: mission.version,
          }),
        ],
        fixture.env,
      ),
    );
    const revision = created.revisions[0]!;
    const implementId = revision.node_id;
    assert.equal(revision.tasks.length, TWO_ITEMS);
    for (const task of revision.tasks) assert.match(task.id, TASK_ID_PATTERN);
    assert.deepEqual(
      revision.change.tasks?.map(({ change }) => change),
      [TaskChange.Created, TaskChange.Created],
    );
    const [first, second] = revision.tasks as [TaskContent, TaskContent];
    const read = await readNode(fixture, implementId);
    assert.deepEqual(read.tasks, revision.tasks);
    const updated = success<Mutation>(
      await kanthord(
        [
          MISSION,
          NODE,
          UPDATE,
          implementId,
          FILE,
          jsonFile(fixture, "update.json", {
            filename: read.filename,
            content: read.content,
            tasks: [second],
            reason: REASON,
            expected_revision: read.visible_revision,
            expected_mission_version: created.mission_version,
          }),
        ],
        fixture.env,
      ),
    );
    assert.deepEqual(updated.revisions[0]!.change.tasks, [
      { id: first.id, change: TaskChange.Retired, changed_fields: [] },
    ]);
    refusal(
      await kanthord([MISSION, NODE, GET, second.id], fixture.env),
      INVALID_NODE_ID_CODE,
    );
    const out = join(fixture.directory, OUTPUT_FILE);
    const exported = success<{ mission_version: number }>(
      await kanthord(
        exportArgs(mission.id, ImportFormat.Json, out),
        fixture.env,
      ),
    );
    const payload = JSON.parse(readFileSync(out, UTF8)) as ExportAnswer;
    assert.ok(JSON_ENTRIES in payload);
    const manifest = {
      format: ImportFormat.Json,
      mission_id: mission.id,
      mission_version: exported.mission_version,
      reason: REASON,
      entries: payload.entries,
    };
    const preview = await previewImport(fixture, mission.id, manifest, []);
    const applied = await applyImport(
      fixture,
      mission.id,
      manifest,
      [],
      preview,
    );
    assert.equal(applied.mission_version, exported.mission_version);
    const kept = await readNode(fixture, implementId);
    assert.equal(
      kept.visible_revision,
      read.visible_revision + VERSION_INCREMENT,
    );
    assert.deepEqual(
      kept.tasks.map(({ id }) => id),
      [second.id],
    );
    const empty = success<Mutation>(
      await kanthord(
        [
          MISSION,
          NODE,
          CREATE,
          mission.id,
          FILE,
          jsonFile(fixture, "empty.json", {
            filename: "implement-empty.md",
            content: {
              ...CONTENT,
              intent: Intent.Implement,
              bindings: [bindingId],
            },
            tasks: [],
            reason: REASON,
            expected_mission_version: applied.mission_version,
          }),
        ],
        fixture.env,
      ),
    );
    assert.deepEqual(empty.revisions[0]!.tasks, []);
    const markdown = join(fixture.directory, OUTPUT_DIRECTORY);
    success(
      await kanthord(
        exportArgs(mission.id, ImportFormat.Markdown, markdown),
        fixture.env,
      ),
    );
    const paths = readdirSync(markdown)
      .filter((filename) => !filename.startsWith("task-"))
      .map((filename) => join(markdown, filename));
    const uncovered = await previewImport(
      fixture,
      mission.id,
      { ...IMPORT_CONTROLS, mission_version: empty.mission_version },
      paths,
    );
    assert.deepEqual(uncovered.violations, []);
  },
);

async function retireImportedNode(
  fixture: Fixture,
  applied: ImportMutation,
): Promise<void> {
  const assigned = applied.assigned_ids.find(
    ({ filename }) => filename === NEW_NODE_FILE,
  );
  assert.ok(assigned && "node_id" in assigned);
  const nodeId = assigned.node_id;
  const preview = success<RetirePreview>(
    await kanthord([MISSION, NODE, RETIRE, PREVIEW, nodeId], fixture.env),
  );
  assert.equal(preview.force, false);
  assert.equal(preview.mission_version, applied.mission_version);
  const path = jsonFile(fixture, RETIRE_FILE, {
    reason: REASON,
    expected_mission_version: applied.mission_version,
    preview_digest: preview.preview_digest,
  });
  const key = createIdempotencyKey();
  const args = [MISSION, NODE, RETIRE, nodeId, FILE, path, KEY, key];
  const retired = success<Mutation>(await kanthord(args, fixture.env));
  assert.ok(retired.retired_node_ids.includes(nodeId));
  assert.equal(
    retired.mission_version,
    applied.mission_version + VERSION_INCREMENT,
  );
  assert.equal(retired.idempotency_key, key);
  assert.deepEqual(success(await kanthord(args, fixture.env)), retired);
}

test("mission node retire force previews and removes dependent edges", async (t) => {
  const fixture = await setup(t);
  const mission = await createMission(fixture);
  const first = await createNode(
    fixture,
    mission.id,
    Intent.Examine,
    mission.version,
  );
  const second = await createNode(
    fixture,
    mission.id,
    Intent.Examine,
    first.mission_version,
  );
  const nodeId = first.revisions[0]!.node_id;
  const dependentId = second.revisions[0]!.node_id;
  const graphFile = jsonFile(fixture, "retire-dependency.json", {
    reason: REASON,
    expected_mission_version: second.mission_version,
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
  assert.equal(preview.mission_version, dependency.mission_version);
  assert.equal(preview.removed_edges.length, SINGLE_ITEM);
  const path = jsonFile(fixture, RETIRE_FILE, {
    reason: REASON,
    expected_mission_version: preview.mission_version,
    preview_digest: preview.preview_digest,
  });
  const retired = success<Mutation>(
    await kanthord(
      [MISSION, NODE, RETIRE, nodeId, FILE, path, FORCE],
      fixture.env,
    ),
  );
  assert.deepEqual(retired.retired_node_ids, [nodeId]);
  assert.deepEqual(retired.removed_edges, preview.removed_edges);
  assert.equal(
    retired.mission_version,
    preview.mission_version + VERSION_INCREMENT,
  );
  assert.ok(retired.idempotency_key);
});

test("mission imports accept embedded empty files and JSON entries", async (t) => {
  const fixture = await setup(t);
  const mission = await createMission(fixture);
  for (const manifest of [
    { ...IMPORT_CONTROLS, mission_id: mission.id, files: [] },
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
    assert.equal(applied.mission_version, mission.version);
    assert.ok(applied.idempotency_key);
  }
});

test("mission get reads the empty mission created with its project", async (t) => {
  await createMission(await setup(t));
});

test("mission export writes empty Markdown and complete private JSON answers", async (t) => {
  const fixture = await setup(t);
  const mission = await createMission(fixture);
  const summary = { mission_id: mission.id, mission_version: mission.version };
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

test("mission export writes into a shared directory and never overwrites a file", async (t) => {
  const fixture = await setup(t);
  const mission = await createMission(fixture);
  const examine = await createNode(
    fixture,
    mission.id,
    Intent.Examine,
    mission.version,
  );
  const summary = {
    mission_id: mission.id,
    mission_version: examine.mission_version,
  };
  const shared = join(fixture.directory, SHARED_DIRECTORY);
  mkdirSync(shared);
  chmodSync(shared, SHARED_DIRECTORY_MODE);
  const path = join(shared, OUTPUT_FILE);
  const args = exportArgs(mission.id, ImportFormat.Json, path);
  assert.deepEqual(success(await kanthord(args, fixture.env)), summary);
  const written = readFileSync(path, UTF8);
  assert.equal(
    (JSON.parse(written) as ExportAnswer).mission_id,
    summary.mission_id,
  );
  refusal(await kanthord(args, fixture.env), PUBLISH_FAILED);
  assert.equal(readFileSync(path, UTF8), written);
  const markdown = join(shared, OUTPUT_DIRECTORY);
  mkdirSync(markdown);
  chmodSync(markdown, SHARED_DIRECTORY_MODE);
  assert.deepEqual(
    success(
      await kanthord(
        exportArgs(mission.id, ImportFormat.Markdown, markdown),
        fixture.env,
      ),
    ),
    summary,
  );
  assert.equal(readdirSync(markdown).length, SINGLE_ITEM);
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

type Page<T> = { items: T[]; next_cursor: string | null };
type Scenario = {
  fixture: Fixture;
  mission: Mission;
  version: number;
  examineId: string;
  implementId: string;
  secondImplementId: string;
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
  assert.ok(node.visible_revision >= FIRST_REVISION);
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
    expected_mission_version: version,
    ...fields,
  });
  const changed = success<Mutation>(
    await kanthord([MISSION, ...args, FILE, path], fixture.env),
  );
  assert.equal(changed.mission_version, version + VERSION_INCREMENT);
  assert.ok(changed.idempotency_key);
  scenario.version = changed.mission_version;
  return changed;
}

async function queued(scenario: Scenario, nodeId: string): Promise<void> {
  const { fixture, mission } = scenario;
  const queue = success<Page<Job>>(
    await kanthord([SCHEDULER, QUEUE, LIST, mission.project_id], fixture.env),
  );
  assert.equal(queue.next_cursor, null);
  const job = queue.items.find((item) => item.node_id === nodeId);
  assert.ok(job);
  assert.equal(job.project_id, mission.project_id);
}

async function scenarioProject(fixture: Fixture): Promise<Mission> {
  const args = [
    PROJECT,
    CREATE,
    NAME,
    PROJECT_NAME,
    KEY,
    createIdempotencyKey(),
  ];
  const project = success<{ id: string; binding_set_version: number }>(
    await kanthord(args, fixture.env),
  );
  assert.equal(project.binding_set_version, FIRST_REVISION);
  const mission = success<Mission>(
    await kanthord([MISSION, GET, project.id], fixture.env),
  );
  assert.ok(mission.id.startsWith(`${MISSION_IDENTITY_PREFIX}_`));
  assert.equal(mission.version, MISSION_INITIAL_VERSION);
  assert.equal(mission.project_id, project.id);
  const replayed = success<{ id: string }>(await kanthord(args, fixture.env));
  assert.equal(replayed.id, project.id);
  assert.deepEqual(replayed, project);
  const reread = success<Mission>(
    await kanthord([MISSION, GET, project.id], fixture.env),
  );
  assert.deepEqual(reread, mission);
  await enableCoveringAgents(fixture.env);
  await applyCoveringBindings(fixture.env, fixture.directory, project.id);
  await configureRepository(fixture, project.id);
  return mission;
}

async function scenarioExamine(fixture: Fixture): Promise<Scenario> {
  const mission = await scenarioProject(fixture);
  const path = jsonFile(fixture, EXAMINE_FILE, {
    filename: EXAMINE_PLAN,
    content: { ...CONTENT, intent: Intent.Examine },
    tasks: [],
    reason: REASON,
    expected_mission_version: mission.version,
  });
  const createArgs = [
    MISSION,
    NODE,
    CREATE,
    mission.id,
    FILE,
    path,
    KEY,
    createIdempotencyKey(),
  ];
  const created = success<Mutation>(await kanthord(createArgs, fixture.env));
  assert.equal(created.mission_version, mission.version + VERSION_INCREMENT);
  assert.equal(created.revisions.length, SINGLE_ITEM);
  const examineId = created.revisions[0]!.node_id;
  assert.ok(examineId.startsWith(`${NODE_IDENTITY_PREFIX}_`));
  const scenario: Scenario = {
    fixture,
    mission,
    version: created.mission_version,
    examineId,
    implementId: UNSET_NODE_ID,
    secondImplementId: UNSET_NODE_ID,
    taskId: UNSET_NODE_ID,
    importedId: UNSET_NODE_ID,
    bindingId: UNSET_NODE_ID,
    createArgs,
    created,
  };
  await queued(scenario, examineId);
  const peek = success<{ job: Job | null }>(
    await kanthord([SCHEDULER, QUEUE, PEEK, mission.project_id], fixture.env),
  );
  assert.equal(peek.job?.node_id, examineId);
  const examine = await readNode(fixture, examineId);
  assert.equal(examine.intent, Intent.Examine);
  assert.equal(examine.state, NodeState.Available);
  return scenario;
}

async function scenarioImplement(scenario: Scenario): Promise<void> {
  const { fixture, mission, examineId } = scenario;
  const bindings = success<Page<RepositoryRecord>>(
    await kanthord(
      [
        PROJECT,
        BINDING,
        LIST,
        mission.project_id,
        "--kind",
        BindingKind.Repository,
      ],
      fixture.env,
    ),
  );
  assert.equal(bindings.items.length, SINGLE_ITEM);
  scenario.bindingId = bindings.items[0]!.id;
  const implement = await createNode(
    fixture,
    mission.id,
    Intent.Implement,
    scenario.version,
    [scenario.bindingId],
    [TASK_FILE],
  );
  assert.equal(implement.mission_version, scenario.version + VERSION_INCREMENT);
  assert.equal(implement.revisions.length, SINGLE_ITEM);
  scenario.implementId = implement.revisions[0]!.node_id;
  scenario.version = implement.mission_version;
  const read = await readNode(fixture, scenario.implementId);
  assert.deepEqual(read.content.bindings, [scenario.bindingId]);
  const taskId = implement.revisions[0]!.tasks[0]!.id;
  assert.ok(taskId.startsWith(`${TASK_IDENTITY_PREFIX}_`));
  scenario.taskId = taskId;
  const listed = success<Page<Node>>(
    await kanthord([MISSION, NODE, LIST, mission.id], fixture.env),
  );
  assert.equal(listed.items.length, TWO_ITEMS);
  assert.equal(listed.next_cursor, null);
  assert.deepEqual(
    listed.items.map(({ id }) => id).sort(),
    [examineId, scenario.implementId].sort(),
  );
}

async function scenarioRevisions(scenario: Scenario): Promise<void> {
  const { fixture, implementId } = scenario;
  const before = await readNode(fixture, implementId);
  await scenarioChange(scenario, [NODE, UPDATE, implementId], {
    filename: before.filename,
    content: { ...before.content, name: UPDATED_NAME },
    tasks: before.tasks,
    expected_revision: before.visible_revision,
  });
  const updated = await readNode(fixture, implementId);
  assert.equal(updated.content.name, UPDATED_NAME);
  assert.deepEqual(updated.tasks, before.tasks);
  assert.equal(
    updated.visible_revision,
    before.visible_revision + VERSION_INCREMENT,
  );
  const revisions = success<Page<Revision>>(
    await kanthord([MISSION, NODE, REVISION, LIST, implementId], fixture.env),
  );
  assert.ok(revisions.items.length >= FIRST_REVISION);
  assert.equal(revisions.items[0]?.revision, updated.visible_revision);
  const first = success<Revision>(
    await kanthord(
      [MISSION, NODE, REVISION, GET, implementId, VALID_REVISION],
      fixture.env,
    ),
  );
  assert.equal(first.revision, FIRST_REVISION);
  assert.equal(first.content.name, CONTENT.name);
}

async function scenarioTaskTransfer(scenario: Scenario): Promise<void> {
  const { fixture, mission, implementId, taskId } = scenario;
  const second = await createNode(
    fixture,
    mission.id,
    Intent.Implement,
    scenario.version,
    [scenario.bindingId],
  );
  assert.equal(second.mission_version, scenario.version + VERSION_INCREMENT);
  assert.equal(second.revisions.length, SINGLE_ITEM);
  scenario.secondImplementId = second.revisions[0]!.node_id;
  scenario.version = second.mission_version;
  const oldOwner = await readNode(fixture, implementId);
  const task = oldOwner.tasks.find(({ id }) => id === taskId)!;
  await scenarioChange(scenario, [NODE, UPDATE, implementId], {
    filename: oldOwner.filename,
    content: oldOwner.content,
    tasks: [],
    expected_revision: oldOwner.visible_revision,
  });
  const newOwner = await readNode(fixture, scenario.secondImplementId);
  await scenarioChange(scenario, [NODE, UPDATE, newOwner.id], {
    filename: newOwner.filename,
    content: newOwner.content,
    tasks: [{ filename: task.filename, content: task.content }],
    expected_revision: newOwner.visible_revision,
  });
  assert.deepEqual((await readNode(fixture, implementId)).tasks, []);
  const owner = await readNode(fixture, newOwner.id);
  assert.equal(owner.tasks.length, SINGLE_ITEM);
  assert.equal(owner.tasks[0]!.filename, task.filename);
  assert.ok(owner.tasks[0]!.id.startsWith(`${TASK_IDENTITY_PREFIX}_`));
  scenario.taskId = owner.tasks[0]!.id;
}

async function scenarioDependencies(scenario: Scenario): Promise<void> {
  const { fixture, mission, implementId, secondImplementId } = scenario;
  await scenarioChange(scenario, [
    DEPENDENCY,
    ADD,
    implementId,
    secondImplementId,
  ]);
  const pending = await readNode(fixture, implementId);
  assert.equal(pending.state, NodeState.Pending);
  await scenarioChange(scenario, [
    DEPENDENCY,
    REMOVE,
    implementId,
    secondImplementId,
  ]);
  const available = await readNode(fixture, implementId);
  assert.equal(available.state, NodeState.Available);
  const edges = success<Page<Edge>>(
    await kanthord([MISSION, EDGE, LIST, mission.id], fixture.env),
  );
  assert.deepEqual(edges.items, []);
  assert.equal(edges.next_cursor, null);
  await scenarioChange(scenario, [CRITERION, SET, implementId], {
    criterion: UPDATED_CRITERION,
    verifications: CONTENT.verifications,
    expected_revision: available.visible_revision,
  });
  const revised = await readNode(fixture, implementId);
  assert.equal(revised.content.criterion, UPDATED_CRITERION);
  assert.equal(
    revised.visible_revision,
    available.visible_revision + VERSION_INCREMENT,
  );
}

async function scenarioRetire(scenario: Scenario): Promise<void> {
  const { fixture, implementId } = scenario;
  const preview = success<RetirePreview>(
    await kanthord([MISSION, NODE, RETIRE, PREVIEW, implementId], fixture.env),
  );
  assert.match(preview.preview_digest, DIGEST_PATTERN);
  assert.equal(preview.mission_version, scenario.version);
  assert.deepEqual(preview.retired_node_ids, [implementId]);
  const retired = await scenarioChange(scenario, [NODE, RETIRE, implementId], {
    preview_digest: preview.preview_digest,
  });
  assert.ok(retired.retired_node_ids.includes(implementId));
  const read = await readNode(fixture, implementId);
  assert.notEqual(read.retired_at, null);
}

async function scenarioExport(scenario: Scenario, filename: string) {
  const { fixture, mission } = scenario;
  const out = join(fixture.directory, filename);
  const summary = success<{ mission_id: string; mission_version: number }>(
    await kanthord(exportArgs(mission.id, ImportFormat.Json, out), fixture.env),
  );
  assert.equal(summary.mission_id, mission.id);
  assert.equal(summary.mission_version, scenario.version);
  const exported = JSON.parse(readFileSync(out, UTF8)) as ExportAnswer;
  assert.ok(JSON_ENTRIES in exported);
  assert.equal(exported.mission_id, summary.mission_id);
  assert.equal(exported.mission_version, summary.mission_version);
  return exported;
}

async function scenarioImport(scenario: Scenario): Promise<void> {
  const { fixture, mission } = scenario;
  const exported = await scenarioExport(scenario, OUTPUT_FILE);
  assert.deepEqual(
    exported.entries.map(({ id }) => id).sort(),
    [scenario.examineId, scenario.secondImplementId, scenario.taskId].sort(),
  );
  const manifest = {
    format: ImportFormat.Json,
    mission_id: mission.id,
    mission_version: exported.mission_version,
    reason: REASON,
    entries: [
      ...exported.entries,
      {
        ...CONTENT,
        filename: NEW_NODE_FILE,
        intent: Intent.Implement,
        bindings: [REPOSITORY_NAME],
        depends_on: [],
      },
      {
        ...CONTENT,
        filename: NEW_TASK_FILE,
        node: NEW_NODE_FILE,
      },
    ],
  };
  const preview = await previewImport(fixture, mission.id, manifest, []);
  assert.deepEqual(preview.retirements, []);
  assert.deepEqual(preview.creates, [NEW_NODE_FILE, NEW_TASK_FILE]);
  const path = jsonFile(fixture, MANIFEST_FILE, {
    ...manifest,
    preview_digest: preview.preview_digest,
    confirmed_retirements: preview.retirements,
  });
  const applied = success<ImportMutation>(
    await kanthord(
      [MISSION, IMPORT, APPLY, mission.id, FILE, path],
      fixture.env,
    ),
  );
  assert.equal(applied.mission_version, scenario.version + VERSION_INCREMENT);
  scenario.version = applied.mission_version;
  const assigned = applied.assigned_ids.find(
    ({ filename }) => filename === NEW_NODE_FILE,
  );
  assert.ok(assigned && "node_id" in assigned);
  scenario.importedId = assigned.node_id;
  await queued(scenario, assigned.node_id);
  const after = await scenarioExport(scenario, EXISTING_EXPORT_FILE);
  assert.equal(after.entries.length, exported.entries.length + TWO_ITEMS);
  assert.ok(after.entries.some(({ id }) => id === assigned.node_id));
}

async function applyRepositorySet(scenario: Scenario, bindings: RepositorySet) {
  const { fixture, mission } = scenario;
  const project = success<{ id: string; binding_set_version: number }>(
    await kanthord([PROJECT, GET, mission.project_id], fixture.env),
  );
  const path = jsonFile(fixture, SCENARIO_FILE, {
    version: project.binding_set_version,
    bindings: { ...COVERING_WORKER_BINDINGS, ...bindings },
  });
  const applied = success<{ project_id: string; binding_set_version: number }>(
    await kanthord(
      [PROJECT, BINDING, APPLY, mission.project_id, FILE, path],
      fixture.env,
    ),
  );
  assert.equal(applied.project_id, mission.project_id);
  assert.equal(
    applied.binding_set_version,
    project.binding_set_version + VERSION_INCREMENT,
  );
  const listed = success<Page<RepositoryRecord>>(
    await kanthord(
      [
        PROJECT,
        BINDING,
        LIST,
        mission.project_id,
        "--kind",
        BindingKind.Repository,
      ],
      fixture.env,
    ),
  );
  assert.equal(listed.items.length, Object.keys(bindings).length);
  assert.equal(listed.next_cursor, null);
  return listed.items;
}

async function scenarioRebind(scenario: Scenario): Promise<void> {
  const { fixture, mission, secondImplementId, importedId } = scenario;
  const bindings = await applyRepositorySet(scenario, {
    [REPOSITORY_NAME]: {
      kind: BindingKind.Repository,
      config: {
        ...REPOSITORY_CONFIGURATION,
        strategy: { base_branch: NEXT_BRANCH },
      },
    },
  });
  const next = bindings.find(({ name }) => name === REPOSITORY_NAME);
  assert.ok(next);
  assert.equal(next.revision, SECOND_REVISION);
  assert.notEqual(next.id, scenario.bindingId);
  const path = jsonFile(fixture, SCENARIO_FILE, {
    reason: REASON,
    expected_mission_version: scenario.version,
  });
  const rebound = success<RebindResult>(
    await kanthord(
      [MISSION, NODE, REBIND, mission.id, next.id, FILE, path],
      fixture.env,
    ),
  );
  assert.equal(
    rebound.node_change.mission_version,
    scenario.version + VERSION_INCREMENT,
  );
  assert.equal(rebound.skipped.length, SINGLE_ITEM);
  assert.equal(rebound.skipped[0]?.node.id, scenario.implementId);
  assert.equal(rebound.skipped[0]?.condition, RebindSkipCondition.Retired);
  assert.deepEqual(
    rebound.node_change.revisions.map(({ node_id: nodeId }) => nodeId).sort(),
    [secondImplementId, importedId].sort(),
  );
  scenario.version = rebound.node_change.mission_version;
  scenario.bindingId = next.id;
  const second = await readNode(fixture, secondImplementId);
  const imported = await readNode(fixture, importedId);
  assert.deepEqual(second.content.bindings, [next.id]);
  assert.deepEqual(imported.content.bindings, [next.id]);
}

async function scenarioPriorityReplay(scenario: Scenario): Promise<void> {
  const { fixture, mission, secondImplementId, createArgs, created } = scenario;
  const path = jsonFile(fixture, SCENARIO_FILE, {
    value: PRIORITY_VALUE,
    expected_mission_version: scenario.version,
  });
  const priority = success<Node>(
    await kanthord(
      [MISSION, NODE, PRIORITY, SET, secondImplementId, FILE, path],
      fixture.env,
    ),
  );
  assert.equal(priority.id, secondImplementId);
  assert.equal(priority.priority, PRIORITY_VALUE);
  const read = await readNode(fixture, secondImplementId);
  assert.equal(read.priority, PRIORITY_VALUE);
  const beforeReplay = success<Mission>(
    await kanthord([MISSION, GET, mission.project_id], fixture.env),
  );
  const replay = success<Mutation>(await kanthord(createArgs, fixture.env));
  assert.equal(replay.revisions[0]?.node_id, scenario.examineId);
  assert.deepEqual(replay, created);
  const afterReplay = success<Mission>(
    await kanthord([MISSION, GET, mission.project_id], fixture.env),
  );
  assert.deepEqual(afterReplay, beforeReplay);
  scenario.version = afterReplay.version;
}

test(
  "E06.1-E06.24 mission planning lifecycle and replay",
  { timeout: PLANNING_LIFECYCLE_TIMEOUT_MS },
  async (t) => {
    const scenario = await scenarioExamine(await setup(t));
    await scenarioImplement(scenario);
    await scenarioRevisions(scenario);
    await scenarioTaskTransfer(scenario);
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
        content: { ...content, intent: Intent.Examine },
        tasks: [],
        reason: REASON,
        expected_mission_version: scenario.version,
      });
      refusal(
        await kanthord(
          [MISSION, NODE, CREATE, mission.id, FILE, path],
          fixture.env,
        ),
        MissionErrorCode.ContentInvalid,
      );
      const read = success<Mission>(
        await kanthord([MISSION, GET, mission.project_id], fixture.env),
      );
      assert.equal(read.version, scenario.version);
    });
    await t.test(
      "E06.26 adding a task to the retired implement node is refused",
      async () => {
        const owner = await readNode(fixture, scenario.implementId);
        assert.notEqual(owner.retired_at, null);
        const path = jsonFile(fixture, SCENARIO_FILE, {
          filename: owner.filename,
          content: owner.content,
          tasks: [{ filename: REFUSED_PLAN, content: CONTENT }],
          expected_revision: owner.visible_revision,
          reason: REASON,
          expected_mission_version: scenario.version,
        });
        refusal(
          await kanthord(
            [MISSION, NODE, UPDATE, owner.id, FILE, path],
            fixture.env,
          ),
          MissionErrorCode.Retired,
        );
        const read = success<Mission>(
          await kanthord([MISSION, GET, mission.project_id], fixture.env),
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

async function readyAct(scenario: Scenario, nodeId: string) {
  const { fixture, mission } = scenario;
  const path = jsonFile(fixture, SCENARIO_FILE, {
    reason: REASON,
    expected_mission_version: scenario.version,
    expected_state: NodeState.Available,
    expected_attempt: NO_ATTEMPT,
  });
  const answer = success<ControlResult>(
    await kanthord([MISSION, NODE, READY, nodeId, FILE, path], fixture.env),
  );
  assert.equal(answer.node.state, NodeState.Waiting);
  scenario.version = success<Mission>(
    await kanthord([MISSION, GET, mission.project_id], fixture.env),
  ).version;
  return answer;
}

test(
  "EF02.1-EF02.5 direct dependencies gate an examine node through the CLI",
  { timeout: NODE_EDIT_LIFECYCLE_TIMEOUT_MS },
  async (t) => {
    const scenario = await scenarioExamine(await setup(t));
    await scenarioImplement(scenario);
    const { fixture, mission, examineId, implementId } = scenario;
    await t.test(
      "EF02.1 an examine node with no dependency holds a queue job",
      async () => {
        await queued(scenario, examineId);
        assert.equal(
          (await readNode(fixture, examineId)).state,
          NodeState.Available,
        );
      },
    );
    await t.test(
      "EF02.2 a dependency of the examine node on an implement node routes it to Pending",
      async () => {
        await scenarioChange(scenario, [
          DEPENDENCY,
          ADD,
          examineId,
          implementId,
        ]);
        const examine = await readNode(fixture, examineId);
        assert.deepEqual(examine.depends_on, [implementId]);
        assert.equal(examine.state, NodeState.Pending);
      },
    );
    await t.test(
      "EF02.3 a dependency add on a Waiting dependent answers state_conflict",
      async () => {
        const other = await createNode(
          fixture,
          mission.id,
          Intent.Implement,
          scenario.version,
          [scenario.bindingId],
        );
        scenario.version = other.mission_version;
        await readyAct(scenario, implementId);
        const path = jsonFile(fixture, SCENARIO_FILE, {
          reason: REASON,
          expected_mission_version: scenario.version,
        });
        refusal(
          await kanthord(
            [
              MISSION,
              DEPENDENCY,
              ADD,
              implementId,
              other.revisions[0]!.node_id,
              FILE,
              path,
            ],
            fixture.env,
          ),
          STATE_CONFLICT,
        );
      },
    );
    await t.test(
      "EF02.5 an examine node pins two repository bindings in write order and requires no external action",
      async () => {
        const bindings = await applyRepositorySet(scenario, {
          [REPOSITORY_NAME]: {
            kind: BindingKind.Repository,
            config: REPOSITORY_CONFIGURATION,
          },
          [OTHER_REPOSITORY_NAME]: {
            kind: BindingKind.Repository,
            config: {
              ...REPOSITORY_CONFIGURATION,
              address: OTHER_REPOSITORY_ADDRESS,
            },
          },
        });
        const order = [OTHER_REPOSITORY_NAME, REPOSITORY_NAME].map(
          (name) => bindings.find((binding) => binding.name === name)!.id,
        );
        const created = await createNode(
          fixture,
          mission.id,
          Intent.Examine,
          scenario.version,
          order,
        );
        scenario.version = created.mission_version;
        const nodeId = created.revisions[0]!.node_id;
        assert.deepEqual(
          (await readNode(fixture, nodeId)).content.bindings,
          order,
        );
        await readyAct(scenario, nodeId);
        const attempts = success<Page<Attempt>>(
          await kanthord([MISSION, ATTEMPT, LIST, nodeId], fixture.env),
        );
        assert.equal(attempts.items.length, SINGLE_ITEM);
        assert.deepEqual(attempts.items[0]!.required_external_actions, []);
      },
    );
  },
);

async function scenarioRemovedBinding(scenario: Scenario): Promise<void> {
  const { fixture, mission, secondImplementId } = scenario;
  const original = {
    kind: BindingKind.Repository,
    config: {
      ...REPOSITORY_CONFIGURATION,
      strategy: { base_branch: NEXT_BRANCH },
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
  const before = await readNode(fixture, secondImplementId);
  assert.deepEqual(before.content.bindings, [scenario.bindingId]);
  const path = jsonFile(fixture, SCENARIO_FILE, {
    reason: REASON,
    expected_mission_version: scenario.version,
  });
  refusal(
    await kanthord(
      [MISSION, NODE, REBIND, mission.id, extra.id, FILE, path],
      fixture.env,
    ),
    MissionErrorCode.BindingRemoved,
  );
  const after = await readNode(fixture, secondImplementId);
  assert.deepEqual(after.content.bindings, before.content.bindings);
  assert.deepEqual(after, before);
  const read = success<Mission>(
    await kanthord([MISSION, GET, mission.project_id], fixture.env),
  );
  assert.equal(read.version, scenario.version);
}

const RECOVERY_FILE = "account-recovery.md";
const RESET_FILE = "add-password-reset.md";
const RESET_REQUEST_FILE = "add-reset-request.md";
const TOKEN_EXPIRY_FILE = "add-reset-token-expiry.md";
const RESET_EMAIL_FILE = "add-password-reset-email.md";
const SEND_EMAIL_FILE = "send-reset-email.md";
const RESET_VERIFICATIONS = ["npm run e2e", "npm run test:reset"];
const IMPORT_SET_DIRECTORY = "import-set";
const INTENT_KEY = "intent:";
const TAGS_KEY = "tags:";
const NODE_KEY = "node:";
const INVALID_INTENT = "task";

function planFile(
  frontMatter: string[],
  title: string,
  requirement: string,
  criterion: string,
): string {
  return [
    "---",
    ...frontMatter,
    "---",
    "",
    `# ${title}`,
    "",
    "## Requirement",
    "",
    requirement,
    "",
    "## Criterion",
    "",
    criterion,
    "",
  ].join("\n");
}

function list(items: string[]): string {
  return `[${items.join(", ")}]`;
}

function nodeFile(
  intent: Intent,
  dependsOn: string[],
  bindings: string[],
  verifications: string[],
  title: string,
  requirement = `Deliver ${title.toLowerCase()}.`,
  criterion = `${title} works.`,
): string {
  return planFile(
    [
      `intent: ${intent}`,
      `depends_on: ${list(dependsOn)}`,
      "tags: []",
      `bindings: ${list(bindings)}`,
      `verifications: ${list(verifications)}`,
    ],
    title,
    requirement,
    criterion,
  );
}

function taskFile(
  node: string,
  verifications: string[],
  title: string,
  requirement = `Deliver ${title.toLowerCase()}.`,
  criterion = `${title} works.`,
) {
  return planFile(
    [`node: ${node}`, "bindings: []", `verifications: ${list(verifications)}`],
    title,
    requirement,
    criterion,
  );
}

function importSet(taskNode = RESET_FILE): Record<string, string> {
  return {
    [RECOVERY_FILE]: nodeFile(
      Intent.Examine,
      [RESET_FILE, RESET_EMAIL_FILE],
      [],
      RESET_VERIFICATIONS,
      "Account recovery",
    ),
    [RESET_FILE]: nodeFile(
      Intent.Implement,
      [],
      [REPOSITORY_NAME],
      RESET_VERIFICATIONS,
      "Add password reset",
      "Let account holders reset a forgotten password.",
      "A valid token permits one reset and an expired token permits none.",
    ),
    [RESET_REQUEST_FILE]: taskFile(
      taskNode,
      RESET_VERIFICATIONS,
      "Add the reset request",
      "Accept a reset request for an account and send one reset token.",
      "A valid token permits one reset.",
    ),
    [TOKEN_EXPIRY_FILE]: taskFile(
      RESET_FILE,
      ["npm run test:reset"],
      "Add the reset token expiry",
    ),
    [RESET_EMAIL_FILE]: nodeFile(
      Intent.Implement,
      [RESET_FILE],
      [REPOSITORY_NAME],
      ["npm run e2e"],
      "Add password reset email",
    ),
    [SEND_EMAIL_FILE]: taskFile(
      RESET_EMAIL_FILE,
      ["npm run e2e"],
      "Send the reset email",
    ),
  };
}

function writeImportSet(
  fixture: Fixture,
  name: string,
  files: Record<string, string>,
): string[] {
  const directory = join(fixture.directory, name);
  mkdirSync(directory, { mode: PRIVATE_DIRECTORY_MODE });
  return Object.entries(files).map(([filename, content]) => {
    const path = join(directory, filename);
    writePrivate(path, content);
    return path;
  });
}

async function flatScenario(fixture: Fixture): Promise<Scenario> {
  const mission = await scenarioProject(fixture);
  const bindings = success<Page<RepositoryRecord>>(
    await kanthord(
      [
        PROJECT,
        BINDING,
        LIST,
        mission.project_id,
        "--kind",
        BindingKind.Repository,
      ],
      fixture.env,
    ),
  );
  return {
    fixture,
    mission,
    version: mission.version,
    examineId: UNSET_NODE_ID,
    implementId: UNSET_NODE_ID,
    secondImplementId: UNSET_NODE_ID,
    taskId: UNSET_NODE_ID,
    importedId: UNSET_NODE_ID,
    bindingId: bindings.items[0]!.id,
    createArgs: [],
    created: { revisions: [] } as unknown as Mutation,
  };
}

async function listNodes(scenario: Scenario, args: string[] = []) {
  const { fixture, mission } = scenario;
  return success<Page<Node>>(
    await kanthord([MISSION, NODE, LIST, mission.id, ...args], fixture.env),
  );
}

function nodeNamed(page: Page<Node>, filename: string): Node {
  const node = page.items.find((item) => item.filename === filename);
  assert.ok(node, filename);
  return node;
}

async function createRefused(
  scenario: Scenario,
  intent: Intent,
  bindings: string[],
  code: string,
) {
  const { fixture, mission } = scenario;
  const path = jsonFile(fixture, SCENARIO_FILE, {
    filename: REFUSED_PLAN,
    content: { ...CONTENT, intent, bindings },
    tasks: [],
    reason: REASON,
    expected_mission_version: scenario.version,
  });
  refusal(
    await kanthord(
      [MISSION, NODE, CREATE, mission.id, FILE, path],
      fixture.env,
    ),
    code,
  );
}

test(
  "EF03.1-EF03.8 flat nodes carry their intent through the CLI",
  { timeout: IMPORT_LIFECYCLE_TIMEOUT_MS },
  async (t) => {
    const fixture = await setup(t);
    const scenario = await flatScenario(fixture);
    const { mission } = scenario;
    await t.test(
      "EF03.1 the import set creates three nodes and three edges",
      async () => {
        const paths = writeImportSet(
          fixture,
          IMPORT_SET_DIRECTORY,
          importSet(),
        );
        const manifest = {
          ...IMPORT_CONTROLS,
          mission_version: scenario.version,
        };
        const preview = await previewImport(
          fixture,
          mission.id,
          manifest,
          paths,
        );
        const applied = await applyImport(
          fixture,
          mission.id,
          manifest,
          paths,
          preview,
        );
        scenario.version = applied.mission_version;
        const nodes = await listNodes(scenario);
        assert.equal(nodes.items.length, THREE_ITEMS);
        const edges = success<Page<Edge>>(
          await kanthord([MISSION, EDGE, LIST, mission.id], fixture.env),
        );
        assert.equal(edges.items.length, THREE_ITEMS);
        const reset = await readNode(fixture, nodeNamed(nodes, RESET_FILE).id);
        assert.deepEqual(
          reset.tasks.map(({ filename }) => filename).sort(),
          [RESET_REQUEST_FILE, TOKEN_EXPIRY_FILE].sort(),
        );
        const recovery = await readNode(
          fixture,
          nodeNamed(nodes, RECOVERY_FILE).id,
        );
        assert.deepEqual(recovery.tasks, []);
        scenario.implementId = reset.id;
        scenario.examineId = recovery.id;
      },
    );
    await t.test("EF03.2 the node list filters by intent examine", async () => {
      const examine = await listNodes(scenario, [
        INTENT_OPTION,
        Intent.Examine,
      ]);
      assert.equal(examine.items.length, SINGLE_ITEM);
      assert.equal(examine.items[0]!.intent, Intent.Examine);
      assert.deepEqual(examine.items[0]!.tags, []);
    });
    await t.test(
      "EF03.3 a task file that names an examine node is refused",
      async () => {
        const paths = writeImportSet(
          fixture,
          `${IMPORT_SET_DIRECTORY}-${RECOVERY_FILE}`,
          importSet(RECOVERY_FILE),
        );
        const manifest = {
          ...IMPORT_CONTROLS,
          mission_version: scenario.version,
        };
        const preview = success<ImportPreview>(
          await kanthord(
            [
              MISSION,
              IMPORT,
              PREVIEW,
              mission.id,
              FILE,
              jsonFile(fixture, MANIFEST_FILE, manifest),
              ...paths,
            ],
            fixture.env,
          ),
        );
        assert.ok(
          preview.violations.some(
            ({ code, filename }) =>
              code === MissionErrorCode.ReferenceKindInvalid &&
              filename === RESET_REQUEST_FILE,
          ),
        );
        const path = jsonFile(fixture, MANIFEST_FILE, {
          ...manifest,
          preview_digest: preview.preview_digest,
          confirmed_retirements: [],
        });
        refusal(
          await kanthord(
            [
              MISSION,
              IMPORT,
              APPLY,
              mission.id,
              FILE,
              path,
              ...paths,
              KEY,
              createIdempotencyKey(),
            ],
            fixture.env,
          ),
          MissionErrorCode.ReferenceKindInvalid,
        );
      },
    );
    await t.test(
      "EF03.4 an intent change after the first attempt is locked",
      async () => {
        await readyAct(scenario, scenario.implementId);
        const node = await readNode(fixture, scenario.implementId);
        const path = jsonFile(fixture, SCENARIO_FILE, {
          filename: node.filename,
          content: { ...node.content, intent: Intent.Examine },
          tasks: node.tasks,
          reason: REASON,
          expected_revision: node.visible_revision,
          expected_mission_version: scenario.version,
        });
        refusal(
          await kanthord(
            [MISSION, NODE, UPDATE, node.id, FILE, path],
            fixture.env,
          ),
          MissionErrorCode.IntentLocked,
        );
      },
    );
    await t.test("EF03.5 an unknown intent filter is refused", async () => {
      refusal(
        await kanthord(
          [MISSION, NODE, LIST, mission.id, INTENT_OPTION, INVALID_INTENT],
          fixture.env,
        ),
        INVALID_INTENT_CODE,
      );
    });
    await t.test(
      "EF03.6 the Markdown export writes intent, tags and node",
      async () => {
        const out = join(fixture.directory, OUTPUT_DIRECTORY);
        success(
          await kanthord(
            exportArgs(mission.id, ImportFormat.Markdown, out),
            fixture.env,
          ),
        );
        const files = Object.fromEntries(
          readdirSync(out).map((filename) => [
            filename,
            readFileSync(join(out, filename), UTF8),
          ]),
        );
        for (const filename of [RECOVERY_FILE, RESET_FILE, RESET_EMAIL_FILE]) {
          assert.ok(files[filename]?.includes(INTENT_KEY), filename);
          assert.ok(files[filename]?.includes(TAGS_KEY), filename);
        }
        for (const filename of [
          RESET_REQUEST_FILE,
          TOKEN_EXPIRY_FILE,
          SEND_EMAIL_FILE,
        ])
          assert.ok(files[filename]?.includes(NODE_KEY), filename);
      },
    );
    await t.test(
      "EF03.8 an examine node with no binding takes none from the project",
      async () => {
        const created = await createNode(
          fixture,
          mission.id,
          Intent.Examine,
          scenario.version,
        );
        scenario.version = created.mission_version;
        assert.deepEqual(created.revisions[0]!.content.bindings, []);
        const bindings = success<Page<RepositoryRecord>>(
          await kanthord(
            [
              PROJECT,
              BINDING,
              LIST,
              mission.project_id,
              "--kind",
              BindingKind.Repository,
            ],
            fixture.env,
          ),
        );
        assert.equal(bindings.items.length, SINGLE_ITEM);
        assert.equal(bindings.items[0]!.name, REPOSITORY_NAME);
      },
    );
    await t.test(
      "EF03.7 an implement node needs one or more repository bindings",
      async () => {
        await createRefused(
          scenario,
          Intent.Implement,
          [],
          MissionErrorCode.BindingsInvalid,
        );
        const bindings = await applyRepositorySet(scenario, {
          [REPOSITORY_NAME]: {
            kind: BindingKind.Repository,
            config: REPOSITORY_CONFIGURATION,
          },
          [OTHER_REPOSITORY_NAME]: {
            kind: BindingKind.Repository,
            config: {
              ...REPOSITORY_CONFIGURATION,
              address: OTHER_REPOSITORY_ADDRESS,
            },
          },
        });
        const pinned = bindings.map(({ id }) => id).reverse();
        const created = await createNode(
          fixture,
          mission.id,
          Intent.Implement,
          scenario.version,
          pinned,
        );
        scenario.version = created.mission_version;
        const read = await readNode(fixture, created.revisions[0]!.node_id);
        assert.deepEqual(read.content.bindings, pinned);
      },
    );
  },
);
