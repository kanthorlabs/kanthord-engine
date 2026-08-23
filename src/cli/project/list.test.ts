import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerProjectList } from "./list.ts";

const P1 = {
  id: "project_01HZY8QF3M4N5P6R7S8T9V0W1X",
  name: "alpha",
  repositories: ["repo_a"],
  updatedAt: 1722800000000,
};
const P2 = {
  id: "project_01JQ8Z7G3H4N5P6R7S8T9V0W1Y",
  name: "beta",
  repositories: [],
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
      return { ok: true as const, status: 200, body: { projects: [P1, P2] } };
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  const exitCalls: number[] = [];
  registerProjectList({
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

describe("src/cli/project/list.test", () => {
  it("two projects write two lines in the response order", async () => {
    const h = harness();
    await run(h.program, ["project", "list"]);

    assert.equal(
      h.stdoutText(),
      "kanthord: project project_01HZY8QF3M4N5P6R7S8T9V0W1X alpha repo_a\n" +
        "kanthord: project project_01JQ8Z7G3H4N5P6R7S8T9V0W1Y beta <none>\n",
    );
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
  });

  it("an empty list writes no project and does not fail", async () => {
    const h = harness({
      respond: () => ({
        ok: true as const,
        status: 200,
        body: { projects: [] },
      }),
    });
    await run(h.program, ["project", "list"]);

    assert.equal(h.stdoutText(), "kanthord: no project\n");
    assert.equal(h.failCalls(), 0);
  });

  it("records the one call as project.list with no body and no parameters", async () => {
    const h = harness();
    await run(h.program, ["project", "list"]);

    assert.deepEqual(h.calls, [
      {
        operationId: "project.list",
        body: undefined,
        parameters: undefined,
      },
    ]);
  });
});
