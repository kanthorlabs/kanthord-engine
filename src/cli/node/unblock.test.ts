import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerNodeUnblock } from "./unblock.ts";

const TASK = "task_01JQ8Z7G3HZZZZZZZZZZZZZZZZ";

const node = (state: "ready" | "pending") => ({
  id: TASK,
  projectId: "project_a",
  kind: "task" as const,
  title: "Task",
  state,
  blockReason: null,
  discardReason: null,
  parentId: "objective_a",
  dependencies: [],
  instructionBlob: `sha256:${"0".repeat(64)}`,
  acceptanceBlob: `sha256:${"1".repeat(64)}`,
  instruction: "Do the task work.\n",
  acceptance: "## Acceptance criteria\n- it works\n",
  worker: null,
  repositoryId: null,
  repo: null,
  revision: "revision_a",
  updatedAt: 1,
  attestedObjectId: null,
  projection: null,
});

type RecordedCall = Readonly<{
  operationId: string;
  body: unknown;
  parameters: Readonly<Record<string, string>> | undefined;
}>;

function harness(
  state: "ready" | "pending" = "ready",
  response?: CallResult,
): Readonly<{
  program: Command;
  calls(): readonly RecordedCall[];
  stdoutText(): string;
  stderrText(): string;
  failCalls(): number;
}> {
  const program = new Command();
  registerClientOptions(program);
  const calls: RecordedCall[] = [];
  const client = {
    call: async (
      operationId: string,
      body: unknown,
      parameters?: Readonly<Record<string, string>>,
    ): Promise<CallResult> => {
      calls.push({ operationId, body, parameters });
      return (
        response ?? {
          ok: true as const,
          status: 200,
          body: { node: node(state) },
        }
      );
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  registerNodeUnblock({
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
  });
  return {
    program,
    calls: () => calls,
    stdoutText: () => stdoutText,
    stderrText: () => stderrText,
    failCalls: () => failCalls,
  };
}

async function run(program: Command, args: readonly string[]): Promise<void> {
  await program.parseAsync([...args], { from: "user" });
}

describe("src/cli/node/unblock.test", () => {
  it("node unblock prints the returned state", async () => {
    for (const state of ["ready", "pending"] as const) {
      const h = harness(state);

      await run(h.program, ["node", "unblock", "--node", TASK]);

      assert.deepEqual(h.calls(), [
        {
          operationId: "node.unblock",
          body: undefined,
          parameters: { id: TASK },
        },
      ]);
      assert.equal(h.stdoutText(), `kanthord: node ${TASK} ${state}\n`);
      assert.equal(h.stderrText(), "");
      assert.equal(h.failCalls(), 0);
    }
  });

  it("node unblock prints a refusal and calls fail", async () => {
    const h = harness("ready", {
      ok: false as const,
      status: 409,
      code: "illegal-transition",
      message: `the task ${TASK} is not blocked`,
      details: { refusal: "not-blocked", blockReason: null },
    });

    await run(h.program, ["node", "unblock", "--node", TASK]);

    assert.equal(h.failCalls(), 1);
    assert.equal(
      h.stderrText(),
      `kanthord: illegal-transition: the task ${TASK} is not blocked\n`,
    );
    assert.equal(h.stdoutText(), "");
  });
});
