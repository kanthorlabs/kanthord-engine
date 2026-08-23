import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerNodeList } from "./list.ts";

const INITIATIVE = {
  id: "initiative_01JQ8Z7G3HZZZZZZZZZZZZZZZW",
  projectId: "project_01JQ8Z7G3HZZZZZZZZZZZZZZZQ",
  kind: "initiative",
  title: "harden the verify cli",
  state: "pending",
  blockReason: null,
  discardReason: null,
  parentId: null,
  dependencies: [],
};

const TASK = {
  id: "task_01JQ8Z7G3HZZZZZZZZZZZZZZZX",
  projectId: "project_01JQ8Z7G3HZZZZZZZZZZZZZZZQ",
  kind: "task",
  title: "add the health route",
  state: "ready",
  blockReason: "dirty-recovery",
  discardReason: null,
  parentId: "objective_01JQ8Z7G3HZZZZZZZZZZZZZZZV",
  dependencies: [],
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
      return { ok: true as const, status: 200, body: { nodes: [TASK] } };
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  const exitCalls: number[] = [];
  registerNodeList({
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

describe("src/cli/node/list.test", () => {
  it("node list calls node.list with no body, no parameters and no options", async () => {
    const h = harness();
    await run(h.program, ["node", "list"]);

    assert.deepEqual(h.calls(), [
      {
        operationId: "node.list",
        body: undefined,
        parameters: undefined,
        options: undefined,
      },
    ]);
    assert.equal(h.failCalls(), 0);
  });

  it("node list passes only the supplied filters", async () => {
    const h = harness();
    await run(h.program, [
      "node",
      "list",
      "--state",
      "ready",
      "--kind",
      "task",
    ]);

    assert.deepEqual(h.calls()[0]?.options, {
      query: { state: "ready", kind: "task" },
    });
    assert.equal(h.failCalls(), 0);
  });

  it("node list with no option passes no query", async () => {
    const h = harness();
    await run(h.program, ["node", "list"]);

    assert.equal(h.calls()[0]?.options, undefined);
  });

  it("node list prints one line per node in the returned order", async () => {
    const h = harness({
      respond: () => ({
        ok: true as const,
        status: 200,
        body: { nodes: [INITIATIVE, TASK] },
      }),
    });
    await run(h.program, ["node", "list"]);

    assert.equal(
      h.stdoutText(),
      "kanthord: node initiative_01JQ8Z7G3HZZZZZZZZZZZZZZZW initiative pending - -\n" +
        "kanthord: node task_01JQ8Z7G3HZZZZZZZZZZZZZZZX task ready dirty-recovery objective_01JQ8Z7G3HZZZZZZZZZZZZZZZV\n",
    );
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
  });

  it("node list prints the empty line when there is no node", async () => {
    const h = harness({
      respond: () => ({ ok: true as const, status: 200, body: { nodes: [] } }),
    });
    await run(h.program, ["node", "list"]);

    assert.equal(h.stdoutText(), "kanthord: no node\n");
    assert.equal(h.failCalls(), 0);
  });

  it("node list prints the error code and calls fail on a refusal", async () => {
    const h = harness({
      respond: () => ({
        ok: false as const,
        status: 400,
        code: "invalid-request",
        message: "the node filters are not valid",
        details: undefined,
      }),
    });
    await run(h.program, ["node", "list"]);

    assert.equal(h.stdoutText(), "");
    assert.equal(
      h.stderrText(),
      "kanthord: invalid-request: the node filters are not valid\n",
    );
    assert.deepEqual(h.exitCodes(), [110]);
  });
});
