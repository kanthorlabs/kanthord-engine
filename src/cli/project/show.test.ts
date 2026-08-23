import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerProjectShow } from "./show.ts";

const ID = "project_01HZY8QF3M4N5P6R7S8T9V0W1X";
const NAME = "kanthord-verify";

const VIEW = {
  id: ID,
  name: NAME,
  repositories: ["repo_a"],
  updatedAt: 1722800000000,
};

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
      return { ok: true as const, status: 200, body: VIEW };
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  const exitCalls: number[] = [];
  registerProjectShow({
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

describe("src/cli/project/show.test", () => {
  it("a successful show writes the three lines exactly", async () => {
    const h = harness();
    await run(h.program, ["project", "show", "--id", ID]);

    assert.equal(
      h.stdoutText(),
      `kanthord: project ${ID}\n` +
        `kanthord: name ${NAME}\n` +
        "kanthord: repositories repo_a\n",
    );
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
  });

  it("records the call with id as the parameter map, not as a body", async () => {
    const h = harness();
    await run(h.program, ["project", "show", "--id", ID]);

    assert.deepEqual(h.calls, [
      {
        operationId: "project.show",
        body: undefined,
        parameters: { id: ID },
      },
    ]);
  });

  it("no --id writes the invalid-request line and records zero calls", async () => {
    const h = harness();
    await run(h.program, ["project", "show"]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.calls.length, 0);
    assert.equal(
      h.stderrText(),
      "kanthord: invalid-request: --id is required\n",
    );
    assert.equal(h.stdoutText(), "");
  });

  it("a 404 writes the not-found line and calls fail", async () => {
    const h = harness({
      respond: () => ({
        ok: false as const,
        status: 404,
        code: "not-found",
        message: `no project ${ID}`,
        details: undefined,
      }),
    });
    await run(h.program, ["project", "show", "--id", ID]);

    assert.deepEqual(h.exitCodes(), [140]);
    assert.equal(h.stderrText(), `kanthord: not-found: no project ${ID}\n`);
    assert.equal(h.stdoutText(), "");
  });
});
