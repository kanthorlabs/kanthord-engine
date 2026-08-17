import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerNodeReport } from "./report.ts";

const TASK = "task_01JQ8Z7G3HZZZZZZZZZZZZZZZW";
const OBJECT_ID = "a".repeat(40);
const REASON = "r";

const RESULT = {
  nodeId: TASK,
  kind: "task",
  state: "done",
  blockReason: null,
  attemptId: "attempt_01JQ8Z7G3HZZZZZZZZZZZZZZZR",
  attemptNo: 1,
  attemptsRemaining: 2,
  objectId: OBJECT_ID,
  objectiveState: "running",
  objectiveProjection: null,
};

type RecordedCall = Readonly<{
  operationId: string;
  body: unknown;
  parameters: Readonly<Record<string, string>> | undefined;
}>;

const harness = (
  options: {
    respond?: (operationId: string, body: unknown) => CallResult;
  } = {},
): {
  program: Command;
  calls(): readonly RecordedCall[];
  stdoutText(): string;
  stderrText(): string;
  failCalls(): number;
} => {
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
      if (options.respond !== undefined) {
        return options.respond(operationId, body);
      }
      return { ok: true as const, status: 200, body: RESULT };
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  registerNodeReport({
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
};

const run = async (
  program: Command,
  args: readonly string[],
): Promise<void> => {
  await program.parseAsync([...args], { from: "user" });
};

describe("src/cli/node/report.test", () => {
  it("node report sends the outcome, the fence and the reason with the id as the parameter map", async () => {
    const h = harness();
    await run(h.program, [
      "node",
      "report",
      "--id",
      TASK,
      "--outcome",
      "rejected",
      "--reason",
      REASON,
      "--fence",
      "3",
    ]);

    assert.deepEqual(h.calls(), [
      {
        operationId: "node.report",
        body: { report: "rejected", fence: 3, reason: REASON },
        parameters: { id: TASK },
      },
    ]);
    assert.notEqual(h.stdoutText(), "");
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
  });

  it("node report with --outcome accepted sends the object id", async () => {
    const h = harness();
    await run(h.program, [
      "node",
      "report",
      "--id",
      TASK,
      "--outcome",
      "accepted",
      "--fence",
      "3",
      "--object-id",
      OBJECT_ID,
    ]);

    assert.deepEqual(h.calls()[0]?.body, {
      report: "accepted",
      fence: 3,
      objectId: OBJECT_ID,
    });
    assert.equal(h.failCalls(), 0);
  });

  it("node report without --id writes the invalid-request line and records zero calls", async () => {
    const h = harness();
    await run(h.program, ["node", "report", "--outcome", "rejected"]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.calls().length, 0);
    assert.equal(
      h.stderrText(),
      "kanthord: invalid-request: --id is required\n",
    );
    assert.equal(h.stdoutText(), "");
  });

  it("node report with a non-integer fence refuses and records zero calls", async () => {
    const h = harness();
    await run(h.program, [
      "node",
      "report",
      "--id",
      TASK,
      "--outcome",
      "rejected",
      "--fence",
      "abc",
    ]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.calls().length, 0);
    assert.ok(h.stderrText().startsWith("kanthord: invalid-request: "));
    assert.equal(h.stdoutText(), "");
  });

  it("node report with a fence token that has a numeric prefix refuses and records zero calls", async () => {
    const h = harness();
    await run(h.program, [
      "node",
      "report",
      "--id",
      TASK,
      "--outcome",
      "rejected",
      "--fence",
      "3abc",
    ]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.calls().length, 0);
    assert.ok(h.stderrText().startsWith("kanthord: invalid-request: "));
    assert.equal(h.stdoutText(), "");
  });

  it("node report prints the error code and calls fail on a refusal", async () => {
    const h = harness({
      respond: () => ({
        ok: false as const,
        status: 409,
        code: "illegal-transition",
        message: `the report of ${TASK} is not legal in its state`,
        details: undefined,
      }),
    });
    await run(h.program, [
      "node",
      "report",
      "--id",
      TASK,
      "--outcome",
      "rejected",
      "--fence",
      "3",
    ]);

    assert.equal(h.failCalls(), 1);
    assert.equal(
      h.stderrText(),
      `kanthord: illegal-transition: the report of ${TASK} is not legal in its state\n`,
    );
    assert.equal(h.stdoutText(), "");
  });
});
