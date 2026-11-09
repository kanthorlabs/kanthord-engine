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
  NodeChange,
  Revision,
} from "../../mission/contract.ts";
import { ExitCode } from "./constants.ts";
import { missionExamples } from "./mission-examples.ts";
import { runKanthord } from "./test-support.ts";

const EMPTY_OUTPUT = "";
const NODE_ID = createIdentity("node");
const MISSION_ID = createIdentity("mission");
const FILENAME = "add-login.md";
const NOTE = (attempt: number, kept: number, applied: number) =>
  `note: attempt ${attempt} of ${NODE_ID} keeps revision ${kept}; block, then unblock with change, to apply revision ${applied}\n`;
const ACTOR: Actor = { kind: "human", account: "account", name: "name" };
const CONTENT: Content = {
  name: "Add login",
  requirement: "Users sign in with a password.",
  criterion: "A user signs in with a valid password.",
  verifications: ["pnpm test"],
  bindings: ["main-repo"],
  intent: "implement",
  tags: [],
  external_links: [],
  commit_type: "feat",
};

function environment(directory: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    KANTHORD_CONFIG: join(directory, "kanthord.yaml"),
    XDG_CONFIG_HOME: directory,
    XDG_DATA_HOME: join(directory, "data"),
    XDG_STATE_HOME: join(directory, "state"),
    KANTHORD_ENDPOINT: undefined,
    KANTHORD_TOKEN: undefined,
  };
}

function revision(number: number): Revision {
  return {
    node_id: NODE_ID,
    filename: FILENAME,
    revision: number,
    reason: "Describe the reason of the change.",
    actor: ACTOR,
    created_at: 1,
    content: CONTENT,
    tasks: [],
    change: {
      write: "node.update",
      previous_revision: number - 1,
      changed_fields: ["content"],
    },
    pinned_by_attempts: [],
  };
}

function nodeChange(
  openAttempts: NodeChange["open_attempts_unchanged"],
): NodeChange {
  return {
    mission_version: 2,
    revisions: [revision(2)],
    retired_node_ids: [],
    added_edges: [],
    removed_edges: [],
    open_attempts_unchanged: openAttempts,
  };
}

function controlResult(nodeRevision: number): ControlResult {
  return {
    node: {
      id: NODE_ID,
      filename: FILENAME,
      mission_id: MISSION_ID,
      visible_revision: 2,
      content: CONTENT,
      tasks: [],
      retired_at: null,
      pinned_by_attempts: [nodeRevision],
      state: "Available",
      attempt: 1,
      pinned_revision: nodeRevision,
      priority: 0,
      depends_on: [],
      intent: "implement",
      tags: [],
    },
    attempt: {
      node_id: NODE_ID,
      attempt: 1,
      node_revision: nodeRevision,
      start_point: "node_branch",
      required_external_actions: [],
      opened_at: 1,
      closed_at: null,
      outcome_ids: [],
      opened_by: ACTOR,
    },
    outcome: null,
    actor: ACTOR,
    accepted_at: 1,
  };
}

async function stubServer(t: TestContext, answer: unknown): Promise<string> {
  const server = createServer((_request, response) => {
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  stopAfter(t, () => server.close());
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

async function control(
  t: TestContext,
  args: string[],
  body: unknown,
  answer: unknown,
) {
  const directory = temporary(t);
  const file = join(directory, "body.json");
  writeFileSync(file, JSON.stringify(body));
  const endpoint = await stubServer(t, answer);
  return runKanthord(
    [
      "mission",
      ...args,
      NODE_ID,
      "--file",
      file,
      "--endpoint",
      endpoint,
      "--token",
      "t",
    ],
    environment(directory),
    t.signal,
  );
}

test("node update writes a note to stderr and keeps stdout unchanged", async (t) => {
  const answer = nodeChange([{ node_id: NODE_ID, attempt: 1 }]);
  const result = await control(
    t,
    ["node", "update"],
    missionExamples.nodeUpdate,
    answer,
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(result.stderr, NOTE(1, 1, 2));
  assert.deepEqual(JSON.parse(result.stdout), {
    ...answer,
    idempotency_key: JSON.parse(result.stdout).idempotency_key,
  });
});

test("node resume writes a note when the attempt keeps an older revision", async (t) => {
  const answer = controlResult(1);
  const result = await control(
    t,
    ["node", "resume"],
    missionExamples.resume,
    answer,
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(result.stderr, NOTE(1, 1, 2));
  assert.deepEqual(JSON.parse(result.stdout), {
    ...answer,
    idempotency_key: JSON.parse(result.stdout).idempotency_key,
  });
});

test("node resume writes nothing to stderr when the attempt holds the visible revision", async (t) => {
  const result = await control(
    t,
    ["node", "resume"],
    missionExamples.resume,
    controlResult(2),
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(result.stderr, EMPTY_OUTPUT);
});
