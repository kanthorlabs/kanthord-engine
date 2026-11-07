import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { writeFileSync } from "node:fs";
import { createIdentity } from "../../kernel/identity.ts";
import { stopAfter, temporary } from "../../kernel/test-support.ts";
import type {
  Actor,
  Content,
  ControlResult,
  Node,
  NodeChange,
  Revision,
  TaskContent,
} from "../../mission/contract.ts";
import { ExitCode } from "./constants.ts";
import { runKanthord } from "./test-support.ts";

const NODE_ID = createIdentity("node");
const MISSION_ID = createIdentity("mission");
const PROJECT_ID = createIdentity("project");
const BINDING_ID = createIdentity("binding");
const FORM_TASK_ID = createIdentity("task");
const DROPPED_TASK_ID = createIdentity("task");
const GET = "GET";
const PUT = "PUT";
const POST = "POST";
const EMPTY_TEXT = "";
const ONE_WRITE = 1;
const NODE_FILENAME = "add-login.md";
const FORM_FILENAME = "write-form.md";
const API_FILENAME = "write-api.md";
const VISIBLE_REVISION = 3;
const MISSION_VERSION = 7;
const ATTEMPT = 2;
const REASON = "Replace the plan.";
const ACTOR: Actor = { kind: "human", account: "account", name: "name" };
const CONTENT: Content = {
  name: "Add login",
  requirement: "Users sign in with a password.",
  criterion: "A user signs in with a valid password.",
  verifications: ["pnpm test"],
  bindings: [BINDING_ID],
  intent: "implement",
  tags: [],
  external_links: [],
};
const NODE_TEXT = `---
intent: implement
bindings:
  - main-repo
verifications:
  - pnpm run check
---

# Add login

## Requirement

Users sign in with a password or a key.

## Criterion

A user signs in with a valid credential.
`;
const NODE_CHANGE: NodeChange = {
  mission_version: MISSION_VERSION + 1,
  revisions: [],
  retired_node_ids: [],
  added_edges: [],
  removed_edges: [],
  open_attempts_unchanged: [],
};

interface Request {
  method: string;
  path: string;
  body: unknown;
}

function taskContent(id: string, filename: string): TaskContent {
  return {
    id,
    filename,
    content: {
      name: "Task",
      requirement: "Do the task.",
      criterion: "The task is done.",
      verifications: ["pnpm test"],
      bindings: [],
    },
  };
}

function node(tasks: TaskContent[]): Node {
  return {
    id: NODE_ID,
    filename: NODE_FILENAME,
    mission_id: MISSION_ID,
    visible_revision: VISIBLE_REVISION,
    content: CONTENT,
    tasks,
    retired_at: null,
    pinned_by_attempts: [],
    state: "Blocked",
    attempt: ATTEMPT,
    pinned_revision: null,
    priority: 0,
    depends_on: [],
    intent: "implement",
    tags: [],
  };
}

function pinnedNode(tasks: TaskContent[]): Node {
  return { ...node(tasks), pinned_revision: VISIBLE_REVISION - 1 };
}

function controlResult(current: Node): ControlResult {
  return {
    node: current,
    attempt: null,
    outcome: null,
    actor: ACTOR,
    accepted_at: 1,
  };
}

function taskText(nodeFilename: string): string {
  return `---
node: ${nodeFilename}
verifications:
  - pnpm run check
---

# Task

## Requirement

Do the task.

## Criterion

The task is done.
`;
}

function revisionOf(tasks: TaskContent[]): Revision {
  return {
    node_id: NODE_ID,
    filename: NODE_FILENAME,
    revision: VISIBLE_REVISION,
    reason: REASON,
    actor: ACTOR,
    created_at: 1,
    content: CONTENT,
    tasks,
    change: {
      write: "node.update",
      previous_revision: null,
      changed_fields: [],
    },
    pinned_by_attempts: [],
  };
}

function answerOf(
  current: Node,
  visibleTasks: TaskContent[],
  request: Request,
): unknown {
  if (
    request.path === `/api/mission/node/${NODE_ID}/revision/${VISIBLE_REVISION}`
  )
    return revisionOf(visibleTasks);
  if (request.path === `/api/mission/node/${NODE_ID}`)
    return request.method === GET ? current : NODE_CHANGE;
  if (request.path === `/api/mission/node/${NODE_ID}/unblock`)
    return controlResult(current);
  if (request.path === `/api/mission/project/${PROJECT_ID}`)
    return { id: MISSION_ID, project_id: PROJECT_ID, version: MISSION_VERSION };
  assert.equal(request.path, `/api/project/${PROJECT_ID}/binding`);
  return {
    items: [
      {
        id: BINDING_ID,
        project_id: PROJECT_ID,
        name: "main-repo",
        kind: "repository",
        resource_identity: "repository:github:owner/repository",
        revision: 1,
        config: {},
        created_at: 1,
        removed_at: null,
      },
    ],
    next_cursor: null,
  };
}

async function stubServer(
  t: TestContext,
  current: Node,
  requests: Request[],
  visibleTasks: TaskContent[],
): Promise<string> {
  const server = createServer((incoming, response) => {
    const chunks: Buffer[] = [];
    incoming.on("data", (chunk: Buffer) => chunks.push(chunk));
    incoming.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      const request = {
        method: incoming.method ?? "",
        path: new URL(incoming.url ?? "", "http://stub").pathname,
        body: text === EMPTY_TEXT ? null : JSON.parse(text),
      };
      requests.push(request);
      response.writeHead(200, { "Content-Type": "application/json" });
      response.end(JSON.stringify(answerOf(current, visibleTasks, request)));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stopAfter(t, () => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

function write(directory: string, name: string, text: string): string {
  const path = join(directory, name);
  writeFileSync(path, text);
  return path;
}

async function run(
  t: TestContext,
  command: "update" | "unblock",
  current: Node,
  files: [string, string][],
  extra: string[] = [],
  visibleTasks: TaskContent[] = [],
) {
  const directory = temporary(t);
  const requests: Request[] = [];
  const endpoint = await stubServer(t, current, requests, visibleTasks);
  const paths = files.flatMap(([name, text]) => [
    "--plan-file",
    write(directory, name, text),
  ]);
  const result = await runKanthord(
    [
      "mission",
      "node",
      command,
      NODE_ID,
      ...paths,
      "--project",
      PROJECT_ID,
      "--reason",
      REASON,
      ...extra,
      "--endpoint",
      endpoint,
      "--token",
      "t",
    ],
    {
      ...process.env,
      KANTHORD_CONFIG: join(directory, "kanthord.yaml"),
      XDG_CONFIG_HOME: directory,
      XDG_DATA_HOME: join(directory, "data"),
      XDG_STATE_HOME: join(directory, "state"),
      KANTHORD_ENDPOINT: undefined,
      KANTHORD_TOKEN: undefined,
    },
    t.signal,
  );
  return { result, requests };
}

function writes(requests: Request[]): Request[] {
  return requests.filter((request) => request.method !== GET);
}

const EXPECTED_CONTENT = {
  name: "Add login",
  requirement: "Users sign in with a password or a key.",
  criterion: "A user signs in with a valid credential.",
  verifications: ["pnpm run check"],
  bindings: [BINDING_ID],
  intent: "implement",
  tags: [],
  external_links: [],
};

function expectedTask(filename: string, id?: string) {
  return {
    ...(id === undefined ? {} : { id }),
    filename,
    content: {
      name: "Task",
      requirement: "Do the task.",
      criterion: "The task is done.",
      verifications: ["pnpm run check"],
      bindings: [],
    },
  };
}

test("node update sends matched task IDs, a new task with no id and the binding IDs", async (t) => {
  const { result, requests } = await run(
    t,
    "update",
    node([taskContent(FORM_TASK_ID, FORM_FILENAME)]),
    [
      [NODE_FILENAME, NODE_TEXT],
      [FORM_FILENAME, taskText(NODE_FILENAME)],
      [API_FILENAME, taskText(NODE_FILENAME)],
    ],
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  const sent = writes(requests);
  assert.equal(sent.length, ONE_WRITE);
  assert.equal(sent[0]!.method, PUT);
  assert.deepEqual(sent[0]!.body, {
    expected_revision: VISIBLE_REVISION,
    expected_mission_version: MISSION_VERSION,
    filename: NODE_FILENAME,
    content: EXPECTED_CONTENT,
    tasks: [
      expectedTask(FORM_FILENAME, FORM_TASK_ID),
      expectedTask(API_FILENAME),
    ],
    reason: REASON,
  });
});

test("node update leaves a current task with no file out of tasks", async (t) => {
  const { result, requests } = await run(
    t,
    "update",
    node([
      taskContent(FORM_TASK_ID, FORM_FILENAME),
      taskContent(DROPPED_TASK_ID, "drop-me.md"),
    ]),
    [
      [NODE_FILENAME, NODE_TEXT],
      [FORM_FILENAME, taskText(NODE_FILENAME)],
    ],
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  const body = writes(requests)[0]!.body as { tasks: { id: string }[] };
  assert.deepEqual(
    body.tasks.map((task) => task.id),
    [FORM_TASK_ID],
  );
  assert.ok(!JSON.stringify(body).includes(DROPPED_TASK_ID));
});

test("node unblock sends the attempt, the expected versions and the change", async (t) => {
  const { result, requests } = await run(
    t,
    "unblock",
    node([taskContent(FORM_TASK_ID, FORM_FILENAME)]),
    [
      [NODE_FILENAME, NODE_TEXT],
      [FORM_FILENAME, taskText(NODE_FILENAME)],
    ],
    ["--start-point", "base_branch"],
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  const sent = writes(requests);
  assert.equal(sent.length, ONE_WRITE);
  assert.equal(sent[0]!.method, POST);
  assert.deepEqual(sent[0]!.body, {
    blocked_attempt: ATTEMPT,
    expected_revision: VISIBLE_REVISION,
    expected_mission_version: MISSION_VERSION,
    change: {
      content: EXPECTED_CONTENT,
      tasks: [expectedTask(FORM_FILENAME, FORM_TASK_ID)],
      reason: REASON,
    },
    start_point: "base_branch",
  });
});

test("--file with --plan-file refuses and sends nothing", async (t) => {
  const directory = temporary(t);
  const requests: Request[] = [];
  const endpoint = await stubServer(t, node([]), requests, []);
  const result = await runKanthord(
    [
      "mission",
      "node",
      "update",
      NODE_ID,
      "--file",
      write(directory, "body.json", "{}"),
      "--plan-file",
      write(directory, NODE_FILENAME, NODE_TEXT),
      "--project",
      PROJECT_ID,
      "--reason",
      REASON,
      "--endpoint",
      endpoint,
      "--token",
      "t",
    ],
    process.env,
    t.signal,
  );
  assert.equal(result.code, ExitCode.Failure);
  assert.match(result.stderr, /^cli\.mission\.node\.plan_file_conflict:/);
  assert.deepEqual(requests, []);
});

test("a task file of another node refuses and sends nothing", async (t) => {
  const { result, requests } = await run(t, "update", node([]), [
    [NODE_FILENAME, NODE_TEXT],
    [FORM_FILENAME, taskText("other-node.md")],
  ]);
  assert.equal(result.code, ExitCode.Failure);
  assert.match(result.stderr, /^cli\.mission\.node\.plan_file_invalid:/);
  assert.match(result.stderr, new RegExp(FORM_FILENAME));
  assert.deepEqual(requests, []);
});

test("a task file in the first place refuses and sends nothing", async (t) => {
  const { result, requests } = await run(t, "unblock", node([]), [
    [FORM_FILENAME, taskText(NODE_FILENAME)],
    [NODE_FILENAME, NODE_TEXT],
  ]);
  assert.equal(result.code, ExitCode.Failure);
  assert.match(result.stderr, /^cli\.mission\.node\.plan_file_invalid:/);
  assert.match(result.stderr, new RegExp(FORM_FILENAME));
  assert.deepEqual(requests, []);
});

test("a parser failure refuses with the file name and sends nothing", async (t) => {
  const { result, requests } = await run(t, "update", node([]), [
    [NODE_FILENAME, NODE_TEXT],
    [FORM_FILENAME, "# Task without front matter\n"],
  ]);
  assert.equal(result.code, ExitCode.Failure);
  assert.match(result.stderr, /^cli\.mission\.node\.plan_file_invalid:/);
  assert.match(
    result.stderr,
    new RegExp(`${FORM_FILENAME}.*front_matter_missing`),
  );
  assert.deepEqual(requests, []);
});

test("node update reads the tasks at the visible revision when an attempt pins an older one", async (t) => {
  const { result, requests } = await run(
    t,
    "update",
    pinnedNode([taskContent(DROPPED_TASK_ID, FORM_FILENAME)]),
    [
      [NODE_FILENAME, NODE_TEXT],
      [FORM_FILENAME, taskText(NODE_FILENAME)],
    ],
    [],
    [taskContent(FORM_TASK_ID, FORM_FILENAME)],
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  const body = writes(requests)[0]!.body as { tasks: { id: string }[] };
  assert.deepEqual(
    body.tasks.map((task) => task.id),
    [FORM_TASK_ID],
  );
});

test("--project, --reason and --start-point with --file refuse and send nothing", async (t) => {
  const directory = temporary(t);
  const requests: Request[] = [];
  const endpoint = await stubServer(t, node([]), requests, []);
  const result = await runKanthord(
    [
      "mission",
      "node",
      "unblock",
      NODE_ID,
      "--file",
      write(directory, "body.json", "{}"),
      "--reason",
      REASON,
      "--start-point",
      "base_branch",
      "--endpoint",
      endpoint,
      "--token",
      "t",
    ],
    process.env,
    t.signal,
  );
  assert.equal(result.code, ExitCode.Failure);
  assert.match(
    result.stderr,
    /^cli\.mission\.node\.plan_file_options_alone: --reason, --start-point need --plan-file/,
  );
  assert.deepEqual(requests, []);
});
