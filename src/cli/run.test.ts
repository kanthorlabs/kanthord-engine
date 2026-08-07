import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import type { CallResult } from "./client.ts";
import { registerRun } from "./run.ts";

const NOT_IMPLEMENTED: CallResult = {
  ok: false,
  status: 501,
  code: "not-implemented",
  message: "run.start ships in phase-2",
  details: undefined,
};

const harness = (
  options: {
    respond?: (
      operationId: string,
      body: unknown,
      parameters: unknown,
    ) => CallResult;
  } = {},
): {
  program: Command;
  calls: readonly Readonly<{
    operationId: string;
    body: unknown;
    parameters: unknown;
  }>[];
  stdoutText(): string;
  stderrText(): string;
  exitCodes(): readonly number[];
} => {
  const program = new Command();
  const calls: Readonly<{
    operationId: string;
    body: unknown;
    parameters: unknown;
  }>[] = [];
  const client = {
    call: async (
      operationId: string,
      body: unknown,
      parameters?: Readonly<Record<string, string>>,
    ): Promise<CallResult> => {
      calls.push({ operationId, body, parameters });
      if (options.respond !== undefined) {
        return options.respond(operationId, body, parameters);
      }
      return NOT_IMPLEMENTED;
    },
  };
  let stdoutText = "";
  let stderrText = "";
  const exitCodes: number[] = [];
  registerRun({
    program,
    client,
    stdout: (text) => {
      stdoutText += text;
    },
    stderr: (text) => {
      stderrText += text;
    },
    exit: (code) => {
      exitCodes.push(code);
    },
  });
  return {
    program,
    calls,
    stdoutText: () => stdoutText,
    stderrText: () => stderrText,
    exitCodes: () => exitCodes,
  };
};

const run = async (
  program: Command,
  args: readonly string[],
): Promise<void> => {
  await program.parseAsync([...args], { from: "user" });
};

describe("src/cli/run.test", () => {
  it("the 501 refusal writes the not-implemented line, writes no stdout and exits 220", async () => {
    const h = harness();
    await run(h.program, ["run", "--project", "project_a"]);

    assert.equal(
      h.stderrText(),
      "kanthord: not-implemented: run.start ships in phase-2\n",
    );
    assert.equal(h.stdoutText(), "");
    assert.deepEqual(h.exitCodes(), [220]);
  });

  it("calls run.start once with the project id as the path parameter", async () => {
    const h = harness();
    await run(h.program, ["run", "--project", "project_a"]);

    assert.deepEqual(h.calls, [
      {
        operationId: "run.start",
        body: undefined,
        parameters: { id: "project_a" },
      },
    ]);
  });

  it("a run without --project refuses locally with exit 1 and makes no call", async () => {
    const h = harness();
    await run(h.program, ["run"]);

    assert.equal(
      h.stderrText(),
      "kanthord: invalid-request: --project is required\n",
    );
    assert.deepEqual(h.exitCodes(), [1]);
    assert.deepEqual(h.calls, []);
    assert.equal(h.stdoutText(), "");
  });

  it("a 404 refusal exits 140 and a 401 refusal exits 120", async () => {
    const notFound = harness({
      respond: () => ({
        ok: false as const,
        status: 404,
        code: "not-found",
        message: "the project does not exist",
        details: undefined,
      }),
    });
    const unauthenticated = harness({
      respond: () => ({
        ok: false as const,
        status: 401,
        code: "unauthenticated",
        message: "the bearer token is not valid",
        details: undefined,
      }),
    });
    await run(notFound.program, ["run", "--project", "project_a"]);
    await run(unauthenticated.program, ["run", "--project", "project_a"]);

    assert.deepEqual(notFound.exitCodes(), [140]);
    assert.deepEqual(unauthenticated.exitCodes(), [120]);
  });

  it("routes on the exit code, never on the message", async () => {
    const first = harness({
      respond: () => ({
        ok: false as const,
        status: 501,
        code: "not-implemented",
        message: "first message",
        details: undefined,
      }),
    });
    const second = harness({
      respond: () => ({
        ok: false as const,
        status: 501,
        code: "not-implemented",
        message: "second message",
        details: undefined,
      }),
    });
    await run(first.program, ["run", "--project", "project_a"]);
    await run(second.program, ["run", "--project", "project_a"]);

    assert.deepEqual(first.exitCodes(), [220]);
    assert.deepEqual(second.exitCodes(), [220]);
    assert.equal(
      first.stderrText(),
      "kanthord: not-implemented: first message\n",
    );
    assert.equal(
      second.stderrText(),
      "kanthord: not-implemented: second message\n",
    );
  });

  it("an unknown code with a 503 status exits 200", async () => {
    const h = harness({
      respond: () => ({
        ok: false as const,
        status: 503,
        code: "some-unknown-code",
        message: "the daemon is on fire",
        details: undefined,
      }),
    });
    await run(h.program, ["run", "--project", "project_a"]);

    assert.deepEqual(h.exitCodes(), [200]);
  });

  it("a 200 result writes started and exits with no code", async () => {
    const h = harness({
      respond: () => ({ ok: true as const, status: 200, body: {} }),
    });
    await run(h.program, ["run", "--project", "project_a"]);

    assert.equal(h.stdoutText(), "kanthord: started\n");
    assert.equal(h.stderrText(), "");
    assert.deepEqual(h.exitCodes(), []);
  });
});
