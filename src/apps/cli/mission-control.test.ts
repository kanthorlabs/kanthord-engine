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

const WHITESPACE = /\s+/g;
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

async function help(t: TestContext, args: string[]): Promise<string> {
  const result = await runKanthord(
    ["mission", ...args, "--help"],
    environment(temporary(t)),
    t.signal,
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  return result.stdout.replace(WHITESPACE, " ");
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

test("node resume help names target, Waiting and rework_limit", async (t) => {
  const text = await help(t, ["node", "resume"]);
  assert.match(text, /target/);
  assert.match(text, /"Waiting" sends the node to review with no coder run/);
  assert.match(text, /rework_limit/);
  assert.match(text, /keeps the pinned revision and the consecutive failure/);
});

test("node block help states that block closes the open attempt", async (t) => {
  assert.match(
    await help(t, ["node", "block"]),
    /Block closes the open attempt of a Paused node/,
  );
});

test("node unblock help names change and start_point", async (t) => {
  const text = await help(t, ["node", "unblock"]);
  assert.match(text, /"change" holds a full revision/);
  assert.match(text, /"start_point" takes "node_branch" \(default\)/);
});

test("node override help names landed_commit", async (t) => {
  const text = await help(t, ["node", "override"]);
  assert.match(text, /does not merge it/);
  assert.match(text, /landed_commit/);
});

test("node update and criterion set help state the block and unblock recipe", async (t) => {
  for (const args of [
    ["node", "update"],
    ["criterion", "set"],
  ]) {
    const text = await help(t, args);
    assert.match(text, /does not reach an open attempt/, args.join(" "));
    assert.match(text, /block, then unblock with "change"/, args.join(" "));
  }
});

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

test("criterion set writes the same note to stderr", async (t) => {
  const result = await control(
    t,
    ["criterion", "set"],
    missionExamples.criterionSet,
    nodeChange([{ node_id: NODE_ID, attempt: 3 }]),
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(result.stderr, NOTE(3, 1, 2));
});

test("node update writes nothing to stderr when no open attempt keeps a revision", async (t) => {
  const result = await control(
    t,
    ["node", "update"],
    missionExamples.nodeUpdate,
    nodeChange([]),
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(result.stderr, EMPTY_OUTPUT);
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
