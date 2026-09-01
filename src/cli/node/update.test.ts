import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerNodeUpdate } from "./update.ts";

const PROJECT = "project_01HZY8QF3M4N5P6R7S8T9V0W1X";
const TASK = "task_01HZY8QF3M4N5P6R7S8T9V0W1Y";
const OBJECTIVE = "objective_01HZY8QF3M4N5P6R7S8T9V0W1Z";
const REVISION_B = "revision_01HZY8QF3M4N5P6R7S8T9V0W1X";
const REVISION_C = "revision_01HZY8QF3M4N5P6R7S8T9V0W1Y";

const hash = (n: number): string =>
  `sha256:${"a".repeat(64 - n)}${"b".repeat(n)}`;

const INSTRUCTION_PATH = "instructions/add-health-route.md";
const INSTRUCTION = "Do the task work.\n";
const ACCEPTANCE_PATH = "acceptances/add-health-route.md";
const ACCEPTANCE = "## Acceptance criteria\n- The health route answers.\n";

const STORED_INSTRUCTION = "the stored instruction\n";
const STORED_ACCEPTANCE = "the stored acceptance\n";

const FILE_CONTENTS: Readonly<Record<string, string>> = {
  [INSTRUCTION_PATH]: INSTRUCTION,
  [ACCEPTANCE_PATH]: ACCEPTANCE,
};

const SHOW: CallResult = {
  ok: true,
  status: 200,
  body: {
    id: TASK,
    projectId: PROJECT,
    kind: "task",
    title: "the stored title",
    state: "ready",
    blockReason: null,
    discardReason: null,
    parentId: OBJECTIVE,
    dependencies: ["task_a"],
    instructionBlob: hash(4),
    acceptanceBlob: hash(5),
    instruction: STORED_INSTRUCTION,
    acceptance: STORED_ACCEPTANCE,
    worker: "tdd@1",
    assignment: null,
    deliverable: null,
    verify: null,
    repositoryId: null,
    repo: null,
    revision: REVISION_B,
    updatedAt: 100,
    attestedObjectId: null,
    projection: null,
  },
};

const SHOW_OBJECTIVE: CallResult = {
  ok: true,
  status: 200,
  body: {
    id: OBJECTIVE,
    projectId: PROJECT,
    kind: "objective",
    title: "the stored objective title",
    state: "ready",
    blockReason: null,
    discardReason: null,
    parentId: "initiative_01HZY8QF3M4N5P6R7S8T9V0W1B",
    dependencies: [],
    instructionBlob: hash(4),
    acceptanceBlob: null,
    instruction: STORED_INSTRUCTION,
    acceptance: null,
    worker: "tdd@1",
    assignment: null,
    deliverable: null,
    verify: null,
    repositoryId: "repo_01HZY8QF3M4N5P6R7S8T9V0W1C",
    repo: "kanthord-engine",
    revision: REVISION_B,
    updatedAt: 100,
    attestedObjectId: null,
    projection: null,
  },
};

const REVISIONS: CallResult = {
  ok: true,
  status: 200,
  body: {
    revisions: [
      {
        id: REVISION_C,
        parentId: REVISION_B,
        origin: "node-write",
        importId: null,
        submittedBlob: null,
        choicesBlob: null,
        acceptedBlob: hash(2),
      },
    ],
  },
};

const UPDATE_RESPONSE: CallResult = {
  ok: true,
  status: 200,
  body: { revision: REVISION_C, completeness: [] },
};

const STALE: CallResult = {
  ok: false,
  status: 409,
  code: "stale-revision",
  message: "the write names an older revision",
  details: { guard: "node", expected: REVISION_C, actual: REVISION_B },
};

const PLAN_INVALID: CallResult = {
  ok: false,
  status: 422,
  code: "plan-invalid",
  message: "the plan is invalid",
  details: {
    findings: [
      {
        code: "path-invalid",
        path: "plan/epic.md",
        id: TASK,
        message: "the path is invalid",
      },
    ],
  },
};

const harness = (
  options: { script?: readonly CallResult[] } = {},
): {
  program: Command;
  calls: readonly Readonly<{
    operationId: string;
    body: unknown;
    parameters: Readonly<Record<string, string>> | undefined;
  }>[];
  reads(): readonly string[];
  stdout(): string;
  stderr(): string;
  fails(): number;
  exits(): readonly number[];
} => {
  const program = new Command();
  registerClientOptions(program);
  const calls: Readonly<{
    operationId: string;
    body: unknown;
    parameters: Readonly<Record<string, string>> | undefined;
  }>[] = [];
  const reads: string[] = [];
  const queue = [...(options.script ?? [])];
  const client = {
    call: async (
      operationId: string,
      body: unknown,
      parameters?: Readonly<Record<string, string>>,
    ): Promise<CallResult> => {
      calls.push({ operationId, body, parameters });
      const next = queue.shift();
      if (next === undefined) {
        throw new Error(`unexpected call: ${operationId}`);
      }
      return next;
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  const exitCalls: number[] = [];
  registerNodeUpdate({
    program,
    client,
    stdout: (text) => {
      stdoutText += text;
    },
    stderr: (text) => {
      stderrText += text;
    },
    fail: () => {
      failCalls += 1;
    },
    exit: (code: number) => {
      exitCalls.push(code);
    },
    readFile: (path: string): string => {
      reads.push(path);
      const content = FILE_CONTENTS[path];
      if (content === undefined) {
        throw new Error(`unexpected file read: ${path}`);
      }
      return content;
    },
  });
  return {
    program,
    calls,
    reads: () => reads,
    stdout: () => stdoutText,
    stderr: () => stderrText,
    fails: () => failCalls,
    exits: () => exitCalls,
  };
};

const run = async (
  program: Command,
  args: readonly string[],
): Promise<void> => {
  await program.parseAsync([...args], { from: "user" });
};

describe("src/cli/node/update.test", () => {
  it("node update fills the whole field set from node.show", async () => {
    const h = harness({ script: [SHOW, UPDATE_RESPONSE] });
    await run(h.program, [
      "node",
      "update",
      "--id",
      TASK,
      "--title",
      "the new title",
    ]);

    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["node.show", "node.update"],
    );
    const show = h.calls[0];
    assert.ok(show !== undefined);
    assert.deepEqual(show.parameters, { id: TASK });
    const update = h.calls[1];
    assert.ok(update !== undefined);
    assert.deepEqual(update.parameters, { id: TASK });
    const body = update.body as Readonly<{
      fromRevision: unknown;
      node: Record<string, unknown>;
    }>;
    assert.equal(body.fromRevision, REVISION_B);
    assert.equal(body.node.kind, "task");
    assert.equal(body.node.title, "the new title");
    assert.equal(body.node.parentId, OBJECTIVE);
    assert.equal(body.node.worker, "tdd@1");
    assert.deepEqual(body.node.dependsOn, ["task_a"]);
    assert.equal(body.node.instruction, STORED_INSTRUCTION);
    assert.equal(body.node.acceptance, STORED_ACCEPTANCE);
    assert.deepEqual(h.reads(), []);
    assert.equal(h.fails(), 0);
  });

  it("node update keeps the stored repository name when --repo is omitted", async () => {
    const h = harness({ script: [SHOW_OBJECTIVE, UPDATE_RESPONSE] });
    await run(h.program, [
      "node",
      "update",
      "--id",
      OBJECTIVE,
      "--title",
      "the new title",
    ]);

    const update = h.calls[1];
    assert.ok(update !== undefined);
    const body = update.body as Readonly<{ node: Record<string, unknown> }>;
    assert.equal(body.node.kind, "objective");
    assert.equal(body.node.repo, "kanthord-engine");
    assert.equal(body.node.instruction, STORED_INSTRUCTION);
    assert.equal(h.fails(), 0);
  });

  it("node update with --no-worker clears the worker at the node revision", async () => {
    const h = harness({ script: [SHOW, UPDATE_RESPONSE] });
    await run(h.program, ["node", "update", "--id", TASK, "--no-worker"]);

    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["node.show", "node.update"],
    );
    const update = h.calls[1];
    assert.ok(update !== undefined);
    const body = update.body as Readonly<{
      fromRevision: unknown;
      node: Record<string, unknown>;
    }>;
    assert.equal(body.fromRevision, REVISION_B);
    assert.equal(body.node.worker, null);
    assert.deepEqual(body.node.dependsOn, ["task_a"]);
    assert.equal(h.fails(), 0);
  });

  it("node update with --no-depends-on clears the dependency list at the project revision", async () => {
    const h = harness({ script: [SHOW, REVISIONS, UPDATE_RESPONSE] });
    await run(h.program, ["node", "update", "--id", TASK, "--no-depends-on"]);

    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["node.show", "plan.revisions", "node.update"],
    );
    const update = h.calls[2];
    assert.ok(update !== undefined);
    const body = update.body as Readonly<{
      fromRevision: unknown;
      node: Record<string, unknown>;
    }>;
    assert.equal(body.fromRevision, REVISION_C);
    assert.deepEqual(body.node.dependsOn, []);
    assert.equal(body.node.worker, "tdd@1");
    assert.equal(h.fails(), 0);
  });

  it("node update reads --instruction and --acceptance paths and sends the file contents", async () => {
    const h = harness({ script: [SHOW, UPDATE_RESPONSE] });
    await run(h.program, [
      "node",
      "update",
      "--id",
      TASK,
      "--instruction",
      INSTRUCTION_PATH,
      "--acceptance",
      ACCEPTANCE_PATH,
    ]);

    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["node.show", "node.update"],
    );
    assert.deepEqual(
      [...new Set(h.reads())].sort(),
      [ACCEPTANCE_PATH, INSTRUCTION_PATH].sort(),
      "the option values name files that the command reads",
    );
    const update = h.calls[1];
    assert.ok(update !== undefined);
    const body = update.body as Readonly<{
      fromRevision: unknown;
      node: Record<string, unknown>;
    }>;
    assert.equal(body.fromRevision, REVISION_B);
    assert.equal(body.node.instruction, INSTRUCTION);
    assert.equal(body.node.acceptance, ACCEPTANCE);
    assert.equal(h.fails(), 0);
  });

  it("node update sends the node revision on a field-only change and never calls plan.revisions", async () => {
    const h = harness({ script: [SHOW, UPDATE_RESPONSE] });
    await run(h.program, [
      "node",
      "update",
      "--id",
      TASK,
      "--title",
      "the new title",
    ]);

    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["node.show", "node.update"],
    );
    const update = h.calls[1];
    assert.ok(update !== undefined);
    assert.equal(
      (update.body as { fromRevision: unknown }).fromRevision,
      REVISION_B,
    );
  });

  it("node update sends the project revision on a parent change", async () => {
    const h = harness({ script: [SHOW, REVISIONS, UPDATE_RESPONSE] });
    await run(h.program, [
      "node",
      "update",
      "--id",
      TASK,
      "--parent",
      "objective_01HZY8QF3M4N5P6R7S8T9V0W1A",
    ]);

    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["node.show", "plan.revisions", "node.update"],
    );
    const revisions = h.calls[1];
    assert.ok(revisions !== undefined);
    assert.deepEqual(revisions.parameters, { id: PROJECT });
    const update = h.calls[2];
    assert.ok(update !== undefined);
    assert.equal(
      (update.body as { fromRevision: unknown }).fromRevision,
      REVISION_C,
    );
    assert.equal(
      (update.body as { node: { parentId: unknown } }).node.parentId,
      "objective_01HZY8QF3M4N5P6R7S8T9V0W1A",
    );
  });

  it("node update sends the project revision on a depends_on change", async () => {
    const h = harness({ script: [SHOW, REVISIONS, UPDATE_RESPONSE] });
    await run(h.program, [
      "node",
      "update",
      "--id",
      TASK,
      "--depends-on",
      "task_b",
    ]);

    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["node.show", "plan.revisions", "node.update"],
    );
    const update = h.calls[2];
    assert.ok(update !== undefined);
    assert.equal(
      (update.body as { fromRevision: unknown }).fromRevision,
      REVISION_C,
    );
    assert.deepEqual(
      (update.body as { node: { dependsOn: unknown } }).node.dependsOn,
      ["task_b"],
    );
  });

  it("node update prints the returned revision", async () => {
    const h = harness({ script: [SHOW, UPDATE_RESPONSE] });
    await run(h.program, [
      "node",
      "update",
      "--id",
      TASK,
      "--title",
      "the new title",
    ]);

    assert.equal(h.stdout(), `kanthord: revision ${REVISION_C}\n`);
    assert.equal(h.fails(), 0);
    assert.deepEqual(h.exits(), []);
  });

  it("node update prints a completeness finding on standard error and exits zero", async () => {
    const h = harness({
      script: [
        SHOW,
        {
          ok: true,
          status: 200,
          body: {
            revision: REVISION_C,
            completeness: [
              {
                code: "objective-without-task",
                path: null,
                id: null,
                message: "an objective holds no task",
              },
            ],
          },
        },
      ],
    });
    await run(h.program, [
      "node",
      "update",
      "--id",
      TASK,
      "--title",
      "the new title",
    ]);

    assert.equal(
      h.stderr(),
      "kanthord: completeness: objective-without-task an objective holds no task\n",
    );
    assert.equal(h.fails(), 0);
    assert.deepEqual(h.exits(), []);
  });

  it("node update exits non-zero on a stale-revision refusal", async () => {
    const h = harness({ script: [SHOW, STALE] });
    await run(h.program, [
      "node",
      "update",
      "--id",
      TASK,
      "--title",
      "the new title",
    ]);

    assert.deepEqual(h.exits(), [150]);
    assert.equal(
      h.stderr(),
      "kanthord: stale-revision: the write names an older revision\n",
    );
  });

  it("node update prints plan-invalid findings and exits 160", async () => {
    const h = harness({ script: [SHOW, PLAN_INVALID] });
    await run(h.program, [
      "node",
      "update",
      "--id",
      TASK,
      "--title",
      "the new title",
    ]);

    assert.equal(
      h.stderr(),
      "kanthord: plan-invalid: the plan is invalid\n" +
        "kanthord: plan-invalid: path-invalid plan/epic.md the path is invalid\n",
    );
    assert.deepEqual(h.exits(), [160]);
  });
});
