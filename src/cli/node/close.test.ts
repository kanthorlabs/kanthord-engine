import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerNodeClose } from "./close.ts";

const OBJECTIVE = "objective_01JQ8Z7G3HZZZZZZZZZZZZZZZV";
const RUN_ID = "run_01JQ8Z7G3HZZZZZZZZZZZZZZZT";
const OBJECT_ID = "a".repeat(40);

const RESULT = {
  nodeId: OBJECTIVE,
  kind: "objective",
  state: "done",
  blockReason: null,
  attemptId: null,
  attemptNo: null,
  attemptsRemaining: null,
  objectId: OBJECT_ID,
  objectiveState: "done",
  objectiveProjection: "done",
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
  exitCodes(): readonly number[];
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
  const exitCalls: number[] = [];
  registerNodeClose({
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
    exit: (code) => {
      exitCalls.push(code);
    },
  });
  return {
    program,
    calls: () => calls,
    stdoutText: () => stdoutText,
    stderrText: () => stderrText,
    failCalls: () => failCalls,
    exitCodes: () => exitCalls,
  };
};

const run = async (
  program: Command,
  args: readonly string[],
): Promise<void> => {
  await program.parseAsync([...args], { from: "user" });
};

describe("src/cli/node/close.test", () => {
  it("node close with --acknowledge-partial sends acknowledgePartial true", async () => {
    const h = harness();
    await run(h.program, [
      "node",
      "close",
      "--id",
      OBJECTIVE,
      "--run-id",
      RUN_ID,
      "--run-fence",
      "3",
      "--acknowledge-partial",
    ]);

    assert.deepEqual(h.calls(), [
      {
        operationId: "node.report",
        body: {
          report: "closed",
          runId: RUN_ID,
          runFence: 3,
          acknowledgePartial: true,
        },
        parameters: { id: OBJECTIVE },
      },
    ]);
    assert.notEqual(h.stdoutText(), "");
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
  });

  it("node close without --acknowledge-partial sends acknowledgePartial false", async () => {
    const h = harness();
    await run(h.program, [
      "node",
      "close",
      "--id",
      OBJECTIVE,
      "--run-id",
      RUN_ID,
      "--run-fence",
      "3",
    ]);

    assert.deepEqual(h.calls()[0]?.body, {
      report: "closed",
      runId: RUN_ID,
      runFence: 3,
      acknowledgePartial: false,
    });
    assert.equal(h.failCalls(), 0);
  });

  it("node close without --id writes the invalid-request line and records zero calls", async () => {
    const h = harness();
    await run(h.program, [
      "node",
      "close",
      "--run-id",
      RUN_ID,
      "--run-fence",
      "3",
    ]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.calls().length, 0);
    assert.equal(
      h.stderrText(),
      "kanthord: invalid-request: --id is required\n",
    );
    assert.equal(h.stdoutText(), "");
  });

  it("node close prints the error code and calls fail on a refusal", async () => {
    const h = harness({
      respond: () => ({
        ok: false as const,
        status: 409,
        code: "acknowledgement-required",
        message: `the close of ${OBJECTIVE} derives partial and needs an acknowledgement`,
        details: undefined,
      }),
    });
    await run(h.program, [
      "node",
      "close",
      "--id",
      OBJECTIVE,
      "--run-id",
      RUN_ID,
      "--run-fence",
      "3",
    ]);

    assert.deepEqual(h.exitCodes(), [154]);
    assert.equal(
      h.stderrText(),
      `kanthord: acknowledgement-required: the close of ${OBJECTIVE} derives partial and needs an acknowledgement\n`,
    );
    assert.equal(h.stdoutText(), "");
  });
});
