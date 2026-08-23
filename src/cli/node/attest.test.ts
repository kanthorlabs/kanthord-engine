import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerNodeAttest } from "./attest.ts";

const OBJECTIVE = "objective_01JQ8Z7G3HZZZZZZZZZZZZZZZV";
const OBJECT_ID = "a".repeat(40);

const RESULT = {
  nodeId: OBJECTIVE,
  kind: "objective",
  state: "awaiting_approval",
  blockReason: null,
  attemptId: null,
  attemptNo: null,
  attemptsRemaining: null,
  objectId: OBJECT_ID,
  objectiveState: "awaiting_approval",
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
  registerNodeAttest({
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

describe("src/cli/node/attest.test", () => {
  it("node attest sends the attested body with the fence and the object id", async () => {
    const h = harness();
    await run(h.program, [
      "node",
      "attest",
      "--id",
      OBJECTIVE,
      "--fence",
      "3",
      "--object-id",
      OBJECT_ID,
    ]);

    assert.deepEqual(h.calls(), [
      {
        operationId: "node.report",
        body: { report: "attested", fence: 3, objectId: OBJECT_ID },
        parameters: { id: OBJECTIVE },
      },
    ]);
    assert.notEqual(h.stdoutText(), "");
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
  });

  it("node attest without --id writes the invalid-request line and records zero calls", async () => {
    const h = harness();
    await run(h.program, [
      "node",
      "attest",
      "--fence",
      "3",
      "--object-id",
      OBJECT_ID,
    ]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.calls().length, 0);
    assert.equal(
      h.stderrText(),
      "kanthord: invalid-request: --id is required\n",
    );
    assert.equal(h.stdoutText(), "");
  });

  it("node attest with a fence token that has a numeric prefix refuses and records zero calls", async () => {
    const h = harness();
    await run(h.program, [
      "node",
      "attest",
      "--id",
      OBJECTIVE,
      "--fence",
      "3.0",
      "--object-id",
      OBJECT_ID,
    ]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.calls().length, 0);
    assert.ok(h.stderrText().startsWith("kanthord: invalid-request: "));
    assert.equal(h.stdoutText(), "");
  });

  it("node attest prints the error code and exits with the lease-held code on a refusal", async () => {
    const h = harness({
      respond: () => ({
        ok: false as const,
        status: 409,
        code: "lease-held",
        message: `the attestation of ${OBJECTIVE} conflicts with a lease held by another owner`,
        details: undefined,
      }),
    });
    await run(h.program, [
      "node",
      "attest",
      "--id",
      OBJECTIVE,
      "--fence",
      "3",
      "--object-id",
      OBJECT_ID,
    ]);

    assert.deepEqual(h.exitCodes(), [155]);
    assert.equal(
      h.stderrText(),
      `kanthord: lease-held: the attestation of ${OBJECTIVE} conflicts with a lease held by another owner\n`,
    );
    assert.equal(h.stdoutText(), "");
  });
});
