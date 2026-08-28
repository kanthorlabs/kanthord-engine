import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerNodeDelete } from "./delete.ts";

const PROJECT = "project_01HZY8QF3M4N5P6R7S8T9V0W1X";
const TASK = "task_01HZY8QF3M4N5P6R7S8T9V0W1Y";
const OBJECTIVE = "objective_01HZY8QF3M4N5P6R7S8T9V0W1Z";
const REVISION_B = "revision_01HZY8QF3M4N5P6R7S8T9V0W1X";
const REVISION_C = "revision_01HZY8QF3M4N5P6R7S8T9V0W1Y";

const hash = (n: number): string =>
  `sha256:${"a".repeat(64 - n)}${"b".repeat(n)}`;

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
    instruction: "the stored instruction\n",
    acceptance: "the stored acceptance\n",
    worker: "tdd@1",
    repositoryId: null,
    repo: null,
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

const DELETE_RESPONSE: CallResult = {
  ok: true,
  status: 200,
  body: {
    revision: REVISION_C,
    deleted: ["task_x", "task_y"],
    completeness: [],
  },
};

const STALE: CallResult = {
  ok: false,
  status: 409,
  code: "stale-revision",
  message: "the write names an older revision",
  details: { guard: "project", expected: REVISION_C, actual: REVISION_B },
};

const PLAN_INVALID: CallResult = {
  ok: false,
  status: 422,
  code: "plan-invalid",
  message: "the plan is invalid",
  details: {
    findings: [
      {
        code: "dependency-cycle",
        path: "plan/epic/task.md",
        id: TASK,
        message: "the plan has a dependency cycle",
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
  registerNodeDelete({
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
  });
  return {
    program,
    calls,
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

describe("src/cli/node/delete.test", () => {
  it("node delete sends the newest project revision", async () => {
    const h = harness({ script: [SHOW, REVISIONS, DELETE_RESPONSE] });
    await run(h.program, ["node", "delete", "--id", TASK]);

    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["node.show", "plan.revisions", "node.delete"],
    );
    const show = h.calls[0];
    assert.ok(show !== undefined);
    assert.deepEqual(show.parameters, { id: TASK });
    const revisions = h.calls[1];
    assert.ok(revisions !== undefined);
    assert.deepEqual(revisions.parameters, { id: PROJECT });
    const del = h.calls[2];
    assert.ok(del !== undefined);
    assert.deepEqual(del.parameters, { id: TASK });
    assert.deepEqual(del.body, { fromRevision: REVISION_C });
    assert.equal(h.fails(), 0);
  });

  it("node delete prints each deleted id on its own line", async () => {
    const h = harness({ script: [SHOW, REVISIONS, DELETE_RESPONSE] });
    await run(h.program, ["node", "delete", "--id", TASK]);

    assert.equal(h.stdout(), "task_x\ntask_y\n");
    assert.equal(h.fails(), 0);
    assert.deepEqual(h.exits(), []);
  });

  it("node delete prints a completeness finding on standard error and exits zero", async () => {
    const h = harness({
      script: [
        SHOW,
        REVISIONS,
        {
          ok: true,
          status: 200,
          body: {
            revision: REVISION_C,
            deleted: ["task_x"],
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
    await run(h.program, ["node", "delete", "--id", TASK]);

    assert.equal(
      h.stderr(),
      "kanthord: completeness: objective-without-task an objective holds no task\n",
    );
    assert.equal(h.fails(), 0);
    assert.deepEqual(h.exits(), []);
  });

  it("node delete exits non-zero on a stale-revision refusal", async () => {
    const h = harness({ script: [SHOW, REVISIONS, STALE] });
    await run(h.program, ["node", "delete", "--id", TASK]);

    assert.deepEqual(h.exits(), [150]);
    assert.equal(
      h.stderr(),
      "kanthord: stale-revision: the write names an older revision\n",
    );
  });

  it("node delete prints plan-invalid findings and exits 160", async () => {
    const h = harness({ script: [SHOW, REVISIONS, PLAN_INVALID] });
    await run(h.program, ["node", "delete", "--id", TASK]);

    assert.equal(
      h.stderr(),
      "kanthord: plan-invalid: the plan is invalid\n" +
        "kanthord: plan-invalid: dependency-cycle plan/epic/task.md the plan has a dependency cycle\n",
    );
    assert.deepEqual(h.exits(), [160]);
  });
});
