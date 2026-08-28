import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { nodeReportRequest } from "../../http/contract/outcome.ts";
import { registerNodeReport } from "./report.ts";

const TASK = "task_01JQ8Z7G3HZZZZZZZZZZZZZZZW";
const OBJECT_ID = "a".repeat(40);
const OBJECT_ID_64 = "b".repeat(64);
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

describe("src/cli/node/report.test", () => {
  it("node report help names the task outcomes and conditional fields", () => {
    const h = harness();
    const node = h.program.commands.find(
      (command) => command.name() === "node",
    );
    assert.ok(node);
    const report = node.commands.find((command) => command.name() === "report");
    assert.ok(report);

    const help = report.helpInformation();
    assert.match(
      help,
      /task outcome: accepted, rejected, failed, or cancelled/,
    );
    assert.match(help, /40- or 64-hex object id; required for accepted/);
    assert.match(help, /required for rejected\/failed; optional for cancelled/);
  });

  const localRefusals = [
    {
      name: "an absent outcome",
      args: ["--id", TASK, "--fence", "3"],
      message: "--outcome is required",
    },
    {
      name: "an unknown outcome",
      args: ["--id", TASK, "--outcome", "other", "--fence", "3"],
      message: "--outcome must be accepted, rejected, failed or cancelled",
    },
    {
      name: "an accepted outcome without an object id",
      args: ["--id", TASK, "--outcome", "accepted", "--fence", "3"],
      message: "--object-id is required for --outcome accepted",
    },
    {
      name: "an accepted outcome with an invalid object id",
      args: [
        "--id",
        TASK,
        "--outcome",
        "accepted",
        "--fence",
        "3",
        "--object-id",
        "not-an-object-id",
      ],
      message: "--object-id must be 40 or 64 lowercase hexadecimal characters",
    },
    {
      name: "an accepted outcome with a reason",
      args: [
        "--id",
        TASK,
        "--outcome",
        "accepted",
        "--fence",
        "3",
        "--object-id",
        OBJECT_ID,
        "--reason",
        REASON,
      ],
      message: "--reason is not valid for --outcome accepted",
    },
    {
      name: "a rejected outcome without a reason",
      args: ["--id", TASK, "--outcome", "rejected", "--fence", "3"],
      message: "--reason is required for --outcome rejected",
    },
    {
      name: "a failed outcome without a reason",
      args: ["--id", TASK, "--outcome", "failed", "--fence", "3"],
      message: "--reason is required for --outcome failed",
    },
    {
      name: "a rejected outcome with an empty reason",
      args: [
        "--id",
        TASK,
        "--outcome",
        "rejected",
        "--fence",
        "3",
        "--reason",
        "",
      ],
      message: "--reason is required for --outcome rejected",
    },
    {
      name: "a failed outcome with an empty reason",
      args: [
        "--id",
        TASK,
        "--outcome",
        "failed",
        "--fence",
        "3",
        "--reason",
        "",
      ],
      message: "--reason is required for --outcome failed",
    },
    {
      name: "a cancelled outcome with an empty reason",
      args: [
        "--id",
        TASK,
        "--outcome",
        "cancelled",
        "--fence",
        "3",
        "--reason",
        "",
      ],
      message: "--reason is required for --outcome cancelled",
    },
    {
      name: "a rejected outcome with an object id",
      args: [
        "--id",
        TASK,
        "--outcome",
        "rejected",
        "--fence",
        "3",
        "--reason",
        REASON,
        "--object-id",
        OBJECT_ID,
      ],
      message: "--object-id is not valid for --outcome rejected",
    },
    {
      name: "a failed outcome with an object id",
      args: [
        "--id",
        TASK,
        "--outcome",
        "failed",
        "--fence",
        "3",
        "--reason",
        REASON,
        "--object-id",
        OBJECT_ID,
      ],
      message: "--object-id is not valid for --outcome failed",
    },
    {
      name: "a cancelled outcome with an object id",
      args: [
        "--id",
        TASK,
        "--outcome",
        "cancelled",
        "--fence",
        "3",
        "--object-id",
        OBJECT_ID,
      ],
      message: "--object-id is not valid for --outcome cancelled",
    },
    ...["done", "timed-out", "attested", "closed"].map((outcome) => ({
      name: `the unsupported ${outcome} outcome`,
      args: ["--id", TASK, "--outcome", outcome, "--fence", "3"],
      message: "--outcome must be accepted, rejected, failed or cancelled",
    })),
  ] as const;

  for (const refusal of localRefusals) {
    it(`node report refuses ${refusal.name} locally`, async () => {
      const h = harness();
      await run(h.program, ["node", "report", ...refusal.args]);

      assert.equal(
        h.stderrText(),
        `kanthord: invalid-request: ${refusal.message}\n`,
      );
      assert.equal(h.stdoutText(), "");
      assert.equal(h.failCalls(), 1);
      assert.deepEqual(h.exitCodes(), []);
      assert.deepEqual(h.calls(), []);
    });
  }

  const validReports = [
    {
      name: "accepted with a 40-character object id",
      args: ["--outcome", "accepted", "--object-id", OBJECT_ID],
      body: { report: "accepted", fence: 3, objectId: OBJECT_ID },
    },
    {
      name: "accepted with a 64-character object id",
      args: ["--outcome", "accepted", "--object-id", OBJECT_ID_64],
      body: { report: "accepted", fence: 3, objectId: OBJECT_ID_64 },
    },
    {
      name: "rejected with a reason",
      args: ["--outcome", "rejected", "--reason", REASON],
      body: { report: "rejected", fence: 3, reason: REASON },
    },
    {
      name: "failed with a reason",
      args: ["--outcome", "failed", "--reason", REASON],
      body: { report: "failed", fence: 3, reason: REASON },
    },
    {
      name: "cancelled without a reason",
      args: ["--outcome", "cancelled"],
      body: { report: "cancelled", fence: 3 },
    },
    {
      name: "cancelled with a reason",
      args: ["--outcome", "cancelled", "--reason", REASON],
      body: { report: "cancelled", fence: 3, reason: REASON },
    },
  ] as const;

  for (const report of validReports) {
    it(`node report sends ${report.name}`, async () => {
      const h = harness();
      await run(h.program, [
        "node",
        "report",
        "--id",
        TASK,
        ...report.args,
        "--fence",
        "3",
      ]);

      const call = h.calls()[0];
      assert.ok(call);
      assert.equal(call.operationId, "node.report");
      assert.deepEqual(call.body, report.body);
      assert.doesNotThrow(() => nodeReportRequest.parse(call.body));
      assert.equal(h.failCalls(), 0);
      assert.deepEqual(h.exitCodes(), []);
    });
  }

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
      "--reason",
      REASON,
      "--fence",
      "3",
    ]);

    assert.deepEqual(h.exitCodes(), [151]);
    assert.equal(
      h.stderrText(),
      `kanthord: illegal-transition: the report of ${TASK} is not legal in its state\n`,
    );
    assert.equal(h.stdoutText(), "");
  });
});
