import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerNodeCreate } from "./create.ts";

const PROJECT = "project_01HZY8QF3M4N5P6R7S8T9V0W1X";
const TASK = "task_01HZY8QF3M4N5P6R7S8T9V0W1Y";
const REVISION_B = "revision_01HZY8QF3M4N5P6R7S8T9V0W1X";
const REVISION_C = "revision_01HZY8QF3M4N5P6R7S8T9V0W1Y";

const hash = (n: number): string =>
  `sha256:${"a".repeat(64 - n)}${"b".repeat(n)}`;

const INSTRUCTION_PATH = "instructions/add-health-route.md";
const INSTRUCTION = "Do the task work.\n";
const ACCEPTANCE_PATH = "acceptances/add-health-route.md";
const ACCEPTANCE = "## Acceptance criteria\n- The health route answers.\n";
const OBJECTIVE_INSTRUCTION_PATH = "instructions/objective.md";
const OBJECTIVE_INSTRUCTION = "Do the objective work.\n";
const INITIATIVE_INSTRUCTION_PATH = "instructions/initiative.md";
const INITIATIVE_INSTRUCTION = "Do the initiative work.\n";

const FILE_CONTENTS: Readonly<Record<string, string>> = {
  [INSTRUCTION_PATH]: INSTRUCTION,
  [ACCEPTANCE_PATH]: ACCEPTANCE,
  [OBJECTIVE_INSTRUCTION_PATH]: OBJECTIVE_INSTRUCTION,
  [INITIATIVE_INSTRUCTION_PATH]: INITIATIVE_INSTRUCTION,
};

const REVISIONS: CallResult = {
  ok: true,
  status: 200,
  body: {
    revisions: [
      {
        id: REVISION_B,
        parentId: "revision_01HZY8QF3M4N5P6R7S8T9V0W1W",
        origin: "node-write",
        importId: null,
        submittedBlob: null,
        choicesBlob: null,
        acceptedBlob: hash(2),
      },
    ],
  },
};

const EMPTY_REVISIONS: CallResult = {
  ok: true,
  status: 200,
  body: { revisions: [] },
};

const CREATE_RESPONSE: CallResult = {
  ok: true,
  status: 200,
  body: { revision: REVISION_C, id: TASK, completeness: [] },
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
        code: "parent-missing",
        path: null,
        id: TASK,
        message: "the parent node is missing",
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
  registerNodeCreate({
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

describe("src/cli/node/create.test", () => {
  it("node create sends the newest revision as fromRevision with the body the kind selects", async () => {
    const h = harness({ script: [REVISIONS, CREATE_RESPONSE] });
    await run(h.program, [
      "node",
      "create",
      "--project",
      PROJECT,
      "--kind",
      "task",
      "--title",
      "Add the health route",
      "--parent",
      "objective_01HZY8QF3M4N5P6R7S8T9V0W1Z",
      "--instruction",
      INSTRUCTION_PATH,
      "--acceptance",
      ACCEPTANCE_PATH,
      "--worker",
      "tdd@1",
      "--depends-on",
      "task_a",
      "task_b",
    ]);

    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["plan.revisions", "node.create"],
    );
    const revisions = h.calls[0];
    assert.ok(revisions !== undefined);
    assert.deepEqual(revisions.parameters, { id: PROJECT });
    const create = h.calls[1];
    assert.ok(create !== undefined);
    assert.deepEqual(create.parameters, { id: PROJECT });
    const body = create.body as Readonly<{
      fromRevision: unknown;
      node: unknown;
    }>;
    assert.equal(body.fromRevision, REVISION_B);
    assert.deepEqual(body.node, {
      kind: "task",
      title: "Add the health route",
      parentId: "objective_01HZY8QF3M4N5P6R7S8T9V0W1Z",
      instruction: "Do the task work.\n",
      acceptance: "## Acceptance criteria\n- The health route answers.\n",
      worker: "tdd@1",
      dependsOn: ["task_a", "task_b"],
    });
    assert.deepEqual(
      [...new Set(h.reads())].sort(),
      [ACCEPTANCE_PATH, INSTRUCTION_PATH].sort(),
      "the option values name files that the command reads",
    );
    assert.equal(h.fails(), 0);
  });

  it("node create in an empty project sends null as fromRevision", async () => {
    const h = harness({ script: [EMPTY_REVISIONS, CREATE_RESPONSE] });
    await run(h.program, [
      "node",
      "create",
      "--project",
      PROJECT,
      "--kind",
      "task",
      "--title",
      "Add the health route",
      "--parent",
      "objective_01HZY8QF3M4N5P6R7S8T9V0W1Z",
      "--instruction",
      INSTRUCTION_PATH,
      "--acceptance",
      ACCEPTANCE_PATH,
    ]);

    const create = h.calls[1];
    assert.ok(create !== undefined);
    assert.equal((create.body as { fromRevision: unknown }).fromRevision, null);
  });

  it("node create sends an objective body with parentId and repo and an initiative body with neither", async () => {
    const objective = harness({ script: [REVISIONS, CREATE_RESPONSE] });
    await run(objective.program, [
      "node",
      "create",
      "--project",
      PROJECT,
      "--kind",
      "objective",
      "--title",
      "the objective",
      "--parent",
      "initiative_01HZY8QF3M4N5P6R7S8T9V0W1V",
      "--repo",
      "kanthord-verify",
      "--instruction",
      OBJECTIVE_INSTRUCTION_PATH,
    ]);
    const objectiveCreate = objective.calls[1];
    assert.ok(objectiveCreate !== undefined);
    assert.deepEqual((objectiveCreate.body as { node: unknown }).node, {
      kind: "objective",
      title: "the objective",
      parentId: "initiative_01HZY8QF3M4N5P6R7S8T9V0W1V",
      repo: "kanthord-verify",
      instruction: "Do the objective work.\n",
      worker: null,
      dependsOn: [],
    });

    const initiative = harness({ script: [REVISIONS, CREATE_RESPONSE] });
    await run(initiative.program, [
      "node",
      "create",
      "--project",
      PROJECT,
      "--kind",
      "initiative",
      "--title",
      "the initiative",
      "--instruction",
      INITIATIVE_INSTRUCTION_PATH,
    ]);
    const initiativeCreate = initiative.calls[1];
    assert.ok(initiativeCreate !== undefined);
    const node = (initiativeCreate.body as { node: Record<string, unknown> })
      .node;
    assert.deepEqual(node, {
      kind: "initiative",
      title: "the initiative",
      instruction: "Do the initiative work.\n",
      worker: null,
      dependsOn: [],
    });
    assert.equal(Object.hasOwn(node, "parentId"), false);
    assert.equal(Object.hasOwn(node, "repo"), false);
  });

  it("node create prints the id and the revision", async () => {
    const h = harness({ script: [REVISIONS, CREATE_RESPONSE] });
    await run(h.program, [
      "node",
      "create",
      "--project",
      PROJECT,
      "--kind",
      "task",
      "--title",
      "Add the health route",
      "--parent",
      "objective_01HZY8QF3M4N5P6R7S8T9V0W1Z",
      "--instruction",
      INSTRUCTION_PATH,
      "--acceptance",
      ACCEPTANCE_PATH,
    ]);

    assert.equal(
      h.stdout(),
      `kanthord: id ${TASK}\nkanthord: revision ${REVISION_C}\n`,
    );
    assert.equal(h.fails(), 0);
    assert.deepEqual(h.exits(), []);
  });

  it("node create refuses an unreadable instruction file without any request", async () => {
    const h = harness({ script: [REVISIONS] });
    await run(h.program, [
      "node",
      "create",
      "--project",
      PROJECT,
      "--kind",
      "task",
      "--title",
      "Add the health route",
      "--parent",
      "objective_01HZY8QF3M4N5P6R7S8T9V0W1Z",
      "--instruction",
      "/missing/instruction.md",
      "--acceptance",
      ACCEPTANCE_PATH,
    ]);

    assert.equal(h.fails(), 1);
    assert.deepEqual(h.exits(), []);
    assert.equal(h.calls.length, 0);
    assert.equal(
      h.stderr(),
      "kanthord: invalid-request: cannot read /missing/instruction.md\n",
    );
  });

  it("node create prints a completeness finding on standard error and exits zero", async () => {
    const h = harness({
      script: [
        REVISIONS,
        {
          ok: true,
          status: 200,
          body: {
            revision: REVISION_C,
            id: TASK,
            completeness: [
              {
                code: "initiative-without-objective",
                path: null,
                id: null,
                message: "an initiative holds no objective",
              },
            ],
          },
        },
      ],
    });
    await run(h.program, [
      "node",
      "create",
      "--project",
      PROJECT,
      "--kind",
      "initiative",
      "--title",
      "the initiative",
      "--instruction",
      INITIATIVE_INSTRUCTION_PATH,
    ]);

    assert.equal(
      h.stderr(),
      "kanthord: completeness: initiative-without-objective an initiative holds no objective\n",
    );
    assert.equal(h.fails(), 0);
    assert.deepEqual(h.exits(), []);
  });

  it("node create exits non-zero on a stale-revision refusal", async () => {
    const h = harness({ script: [REVISIONS, STALE] });
    await run(h.program, [
      "node",
      "create",
      "--project",
      PROJECT,
      "--kind",
      "task",
      "--title",
      "Add the health route",
      "--parent",
      "objective_01HZY8QF3M4N5P6R7S8T9V0W1Z",
      "--instruction",
      INSTRUCTION_PATH,
      "--acceptance",
      ACCEPTANCE_PATH,
    ]);

    assert.deepEqual(h.exits(), [150]);
    assert.equal(
      h.stderr(),
      "kanthord: stale-revision: the write names an older revision\n",
    );
  });

  it("node create prints plan-invalid findings and exits 160", async () => {
    const h = harness({ script: [REVISIONS, PLAN_INVALID] });
    await run(h.program, [
      "node",
      "create",
      "--project",
      PROJECT,
      "--kind",
      "task",
      "--title",
      "Add the health route",
      "--parent",
      "objective_01HZY8QF3M4N5P6R7S8T9V0W1Z",
      "--instruction",
      INSTRUCTION_PATH,
      "--acceptance",
      ACCEPTANCE_PATH,
    ]);

    assert.equal(
      h.stderr(),
      "kanthord: plan-invalid: the plan is invalid\n" +
        "kanthord: plan-invalid: parent-missing - the parent node is missing\n",
    );
    assert.deepEqual(h.exits(), [160]);
  });
});
