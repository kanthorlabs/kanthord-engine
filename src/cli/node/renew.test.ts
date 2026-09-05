import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerNodeRenew } from "./renew.ts";

const TASK = "task_01JQ8Z7G3HZZZZZZZZZZZZZZZW";
const OBJECTIVE = "objective_01JQ8Z7G3HZZZZZZZZZZZZZZZV";
const ACTOR = "actor_01JQ8Z7G3HZZZZZZZZZZZZZZZU";
const RUN_ID = "run_01JQ8Z7G3HZZZZZZZZZZZZZZZT";

const RENEWED = {
  lease: {
    subjectId: TASK,
    owner: ACTOR,
    ownerKind: "actor",
    fence: 3,
    expiresAt: 1722800900000,
  },
  objectiveLease: {
    subjectId: OBJECTIVE,
    owner: ACTOR,
    ownerKind: "actor",
    fence: 2,
    expiresAt: 1722800900000,
  },
  expiresAt: 1722800900000,
  renewAfterMs: 100000,
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
  opts: {
    respond?: (operationId: string, body: unknown) => CallResult;
    randomBytes?: (size: number) => Buffer;
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
      options?: CallOptions,
    ): Promise<CallResult> => {
      calls.push({ operationId, body, parameters, options });
      if (opts.respond !== undefined) {
        return opts.respond(operationId, body);
      }
      return { ok: true as const, status: 200, body: RENEWED };
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  const exitCalls: number[] = [];
  registerNodeRenew({
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
    randomBytes: opts.randomBytes ?? ((size) => Buffer.alloc(size, 0xab)),
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

describe("src/cli/node/renew.test", () => {
  it("node renew calls node.renew with the id parameter and the fence body", async () => {
    const h = harness();
    await run(h.program, [
      "node",
      "renew",
      "--id",
      TASK,
      "--fence",
      "3",
      "--run-id",
      RUN_ID,
      "--run-fence",
      "3",
    ]);

    assert.deepEqual(h.calls()[0]?.operationId, "node.renew");
    assert.deepEqual(h.calls()[0]?.parameters, { id: TASK });
    assert.deepEqual(h.calls()[0]?.body, {
      fence: 3,
      runId: RUN_ID,
      runFence: 3,
    });
    assert.equal(h.failCalls(), 0);
  });

  it("node renew prints the renewed line", async () => {
    const h = harness();
    await run(h.program, [
      "node",
      "renew",
      "--id",
      TASK,
      "--fence",
      "3",
      "--run-id",
      RUN_ID,
      "--run-fence",
      "3",
    ]);

    assert.equal(
      h.stdoutText(),
      `kanthord: renewed ${TASK} fence 3 expires 1722800900000\n`,
    );
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
  });

  it("node renew sends an Idempotency-Key of 32 lowercase hex characters", async () => {
    const h = harness();
    await run(h.program, [
      "node",
      "renew",
      "--id",
      TASK,
      "--fence",
      "3",
      "--run-id",
      RUN_ID,
      "--run-fence",
      "3",
    ]);

    const key = h.calls()[0]?.options?.idempotencyKey ?? "";
    assert.match(key, /^[0-9a-f]{32}$/);
    assert.equal(h.failCalls(), 0);
  });

  it("node renew mints a different Idempotency-Key on two consecutive calls", async () => {
    let counter = 0;
    const h = harness({
      randomBytes: (size) => Buffer.alloc(size, counter++),
    });
    await run(h.program, [
      "node",
      "renew",
      "--id",
      TASK,
      "--fence",
      "3",
      "--run-id",
      RUN_ID,
      "--run-fence",
      "3",
    ]);
    await run(h.program, [
      "node",
      "renew",
      "--id",
      TASK,
      "--fence",
      "3",
      "--run-id",
      RUN_ID,
      "--run-fence",
      "3",
    ]);

    const first = h.calls()[0]?.options?.idempotencyKey ?? "";
    const second = h.calls()[1]?.options?.idempotencyKey ?? "";
    assert.match(first, /^[0-9a-f]{32}$/);
    assert.match(second, /^[0-9a-f]{32}$/);
    assert.notEqual(first, second);
  });

  it("node renew refuses a non-numeric fence without calling the daemon", async () => {
    for (const value of ["abc", "0", "-1", "1x"]) {
      const h = harness();
      await run(h.program, [
        "node",
        "renew",
        "--id",
        TASK,
        "--fence",
        value,
        "--run-id",
        RUN_ID,
        "--run-fence",
        "3",
      ]);

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

  it("node renew refuses a run-fence token with a numeric prefix without calling the daemon", async () => {
    const h = harness();
    await run(h.program, [
      "node",
      "renew",
      "--id",
      TASK,
      "--fence",
      "3",
      "--run-id",
      RUN_ID,
      "--run-fence",
      "1x",
    ]);

    assert.equal(
      h.stderrText(),
      "kanthord: invalid-request: --run-fence must be a positive integer\n",
    );
    assert.equal(h.stdoutText(), "");
    assert.equal(h.failCalls(), 1);
    assert.equal(h.calls().length, 0);
  });

  it("node renew requires a fence", async () => {
    const h = harness();
    const overrideExits = (command: Command): void => {
      command.exitOverride();
      for (const child of command.commands) {
        overrideExits(child);
      }
    };
    overrideExits(h.program);

    await assert.rejects(
      () =>
        run(h.program, [
          "node",
          "renew",
          "--id",
          TASK,
          "--run-id",
          RUN_ID,
          "--run-fence",
          "3",
        ]),
      (err: unknown) =>
        err instanceof Error &&
        (err as Readonly<{ code?: string }>).code ===
          "commander.missingMandatoryOptionValue",
    );
    assert.equal(h.calls().length, 0);
  });

  it("node renew prints the error code and calls fail on a refusal", async () => {
    const h = harness({
      respond: () => ({
        ok: false as const,
        status: 409,
        code: "lease-held",
        message: `the lease of ${TASK} is not held at fence 2`,
        details: undefined,
      }),
    });
    await run(h.program, [
      "node",
      "renew",
      "--id",
      TASK,
      "--fence",
      "2",
      "--run-id",
      RUN_ID,
      "--run-fence",
      "2",
    ]);

    assert.equal(h.stdoutText(), "");
    assert.equal(
      h.stderrText(),
      `kanthord: lease-held: the lease of ${TASK} is not held at fence 2\n`,
    );
    assert.deepEqual(h.exitCodes(), [155]);
  });

  it("node renew without --id writes the invalid-request line and records zero calls", async () => {
    const h = harness();
    await run(h.program, [
      "node",
      "renew",
      "--fence",
      "3",
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
});
