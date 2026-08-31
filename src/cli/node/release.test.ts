import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerNodeRelease } from "./release.ts";

const TASK = "task_01JQ8Z7G3HZZZZZZZZZZZZZZZW";

const NODE = {
  id: TASK,
  projectId: "project_01JQ8Z7G3HZZZZZZZZZZZZZZZQ",
  kind: "task",
  title: "add the health route",
  state: "ready",
  blockReason: null,
  discardReason: null,
  parentId: "objective_01JQ8Z7G3HZZZZZZZZZZZZZZZV",
  dependencies: [],
  instructionBlob: `sha256:${"a".repeat(64)}`,
  acceptanceBlob: null,
  instruction: "# atlas\n",
  acceptance: null,
  worker: null,
  deliverable: null,
  verify: null,
  repositoryId: "repo_01JQ8Z7G3HZZZZZZZZZZZZZZZU",
  repo: "atlas",
  revision: "revision_01JQ8Z7G3HZZZZZZZZZZZZZZZT",
  updatedAt: 1738368000000,
  attestedObjectId: null,
  projection: null,
};

type CallOptions = Readonly<{
  query?: Readonly<Record<string, string | undefined>>;
  idempotencyKey?: string;
}>;

type RecordedCall = Readonly<{
  operationId: string;
  body: unknown;
  parameters: Readonly<Record<string, string>> | undefined;
  options: CallOptions | undefined;
}>;

const harness = (
  opts: { respond?: (operationId: string, body: unknown) => CallResult } = {},
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
      options?: CallOptions,
    ): Promise<CallResult> => {
      calls.push({ operationId, body, parameters, options });
      if (opts.respond !== undefined) {
        return opts.respond(operationId, body);
      }
      return { ok: true as const, status: 200, body: { node: NODE } };
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  const exitCalls: number[] = [];
  registerNodeRelease({
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

describe("src/cli/node/release.test", () => {
  it("node release calls node.release with the id parameter and the fence body", async () => {
    const h = harness();
    await run(h.program, ["node", "release", "--id", TASK, "--fence", "1"]);

    assert.deepEqual(h.calls()[0]?.operationId, "node.release");
    assert.deepEqual(h.calls()[0]?.parameters, { id: TASK });
    assert.deepEqual(h.calls()[0]?.body, { fence: 1 });
    assert.equal(h.failCalls(), 0);
  });

  it("node release prints the released line", async () => {
    const h = harness();
    await run(h.program, ["node", "release", "--id", TASK, "--fence", "1"]);

    assert.equal(h.stdoutText(), `kanthord: released ${TASK} state ready\n`);
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
  });

  it("node release refuses a non-numeric fence without calling the daemon", async () => {
    for (const value of ["abc", "0", "-1"]) {
      const h = harness();
      await run(h.program, ["node", "release", "--id", TASK, "--fence", value]);

      assert.equal(
        h.stderrText(),
        "kanthord: invalid-request: --fence must be a positive integer\n",
        `--fence ${value}`,
      );
      assert.equal(h.stdoutText(), "", `--fence ${value}`);
      assert.equal(h.failCalls(), 1, `--fence ${value}`);
      assert.equal(h.calls().length, 0, `--fence ${value}`);
    }
  });

  it("node release requires a fence", async () => {
    const h = harness();
    const overrideExits = (command: Command): void => {
      command.exitOverride();
      for (const child of command.commands) {
        overrideExits(child);
      }
    };
    overrideExits(h.program);

    await assert.rejects(
      () => run(h.program, ["node", "release", "--id", TASK]),
      (err: unknown) =>
        err instanceof Error &&
        (err as Readonly<{ code?: string }>).code ===
          "commander.missingMandatoryOptionValue",
    );
    assert.equal(h.calls().length, 0);
  });

  it("node release prints the error code and calls fail on a refusal", async () => {
    const h = harness({
      respond: () => ({
        ok: false as const,
        status: 409,
        code: "lease-held",
        message: `the lease of ${TASK} is not held at fence 2`,
        details: undefined,
      }),
    });
    await run(h.program, ["node", "release", "--id", TASK, "--fence", "2"]);

    assert.equal(h.stdoutText(), "");
    assert.equal(
      h.stderrText(),
      `kanthord: lease-held: the lease of ${TASK} is not held at fence 2\n`,
    );
    assert.deepEqual(h.exitCodes(), [155]);
  });

  it("node release without --id writes the invalid-request line and records zero calls", async () => {
    const h = harness();
    await run(h.program, ["node", "release", "--fence", "1"]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.calls().length, 0);
    assert.equal(
      h.stderrText(),
      "kanthord: invalid-request: --id is required\n",
    );
    assert.equal(h.stdoutText(), "");
  });
});
