import assert from "node:assert/strict";
import { mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
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
  NodeKind,
  NodeState,
  type ExportAnswer,
  type Mission,
} from "../../mission/contract.ts";
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
