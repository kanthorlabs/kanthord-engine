import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerProjectCreate } from "./create.ts";

const ID = "project_01HZY8QF3M4N5P6R7S8T9V0W1X";
const NAME = "kanthord-verify";

const view = (repositories: readonly string[]): unknown => ({
  id: ID,
  name: NAME,
  repositories: [...repositories],
  updatedAt: 1722800000000,
});

const harness = (
  options: {
    respond?: (operationId: string, body: unknown) => CallResult;
  } = {},
): {
  program: Command;
  calls: readonly Readonly<{
    operationId: string;
    body: unknown;
    parameters: Readonly<Record<string, string>> | undefined;
  }>[];
  stdoutText(): string;
  stderrText(): string;
  failCalls(): number;
  exitCodes(): readonly number[];
} => {
  const program = new Command();
  registerClientOptions(program);
  const calls: Readonly<{
    operationId: string;
    body: unknown;
    parameters: Readonly<Record<string, string>> | undefined;
  }>[] = [];
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
      return { ok: true as const, status: 200, body: view([]) };
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  const exitCalls: number[] = [];
  registerProjectCreate({
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
    calls,
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

describe("src/cli/project/create.test", () => {
  it("a successful create writes the three lines exactly and records the one call", async () => {
    const h = harness();
    await run(h.program, ["project", "create", "--name", NAME]);

    assert.equal(
      h.stdoutText(),
      `kanthord: project ${ID}\n` +
        `kanthord: name ${NAME}\n` +
        "kanthord: repositories <none>\n",
    );
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
    assert.deepEqual(h.calls, [
      {
        operationId: "project.create",
        body: { name: NAME },
        parameters: undefined,
      },
    ]);
  });

  it("no --name writes the invalid-request line and records zero calls", async () => {
    const h = harness();
    await run(h.program, ["project", "create"]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.calls.length, 0);
    assert.equal(
      h.stderrText(),
      "kanthord: invalid-request: --name is required\n",
    );
    assert.equal(h.stdoutText(), "");
  });

  it("a 400 with refusal name-taken writes the invalid-request line and fails", async () => {
    const h = harness({
      respond: () => ({
        ok: false as const,
        status: 400,
        code: "invalid-request",
        message: "a project named kanthord-verify already exists",
        details: { refusal: "name-taken" },
      }),
    });
    await run(h.program, ["project", "create", "--name", NAME]);

    assert.deepEqual(h.exitCodes(), [110]);
    assert.equal(
      h.stderrText(),
      "kanthord: invalid-request: a project named kanthord-verify already exists\n",
    );
    assert.equal(h.stdoutText(), "");
  });

  it("a body that fails projectCreateResponse.parse throws before any output", async () => {
    const h = harness({
      respond: () => ({ ok: true as const, status: 200, body: { id: 123 } }),
    });

    await assert.rejects(run(h.program, ["project", "create", "--name", NAME]));
    assert.equal(h.stdoutText(), "");
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
  });

  it("repositories prints <none> for an empty list, one id alone, and two joined with a comma", async () => {
    const h1 = harness();
    await run(h1.program, ["project", "create", "--name", NAME]);
    assert.ok(h1.stdoutText().includes("kanthord: repositories <none>\n"));

    const h2 = harness({
      respond: () => ({
        ok: true as const,
        status: 200,
        body: view(["repo_a"]),
      }),
    });
    await run(h2.program, ["project", "create", "--name", NAME]);
    assert.equal(
      h2.stdoutText(),
      `kanthord: project ${ID}\n` +
        `kanthord: name ${NAME}\n` +
        "kanthord: repositories repo_a\n",
    );
    assert.equal(h2.failCalls(), 0);

    const h3 = harness({
      respond: () => ({
        ok: true as const,
        status: 200,
        body: view(["repo_a", "repo_b"]),
      }),
    });
    await run(h3.program, ["project", "create", "--name", NAME]);
    assert.ok(
      h3.stdoutText().includes("kanthord: repositories repo_a,repo_b\n"),
    );
    assert.equal(h3.failCalls(), 0);
  });
});
