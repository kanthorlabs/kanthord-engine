import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerNodeShow } from "./show.ts";

const NODE = {
  id: "task_01JQ8Z7G3HZZZZZZZZZZZZZZZW",
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
  repositoryId: "repo_01JQ8Z7G3HZZZZZZZZZZZZZZZU",
  repo: "atlas",
  revision: "revision_01JQ8Z7G3HZZZZZZZZZZZZZZZT",
  updatedAt: 1738368000000,
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
      return { ok: true as const, status: 200, body: NODE };
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  registerNodeShow({
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
  });
  return {
    program,
    calls: () => calls,
    stdoutText: () => stdoutText,
    stderrText: () => stderrText,
    failCalls: () => failCalls,
  };
};

const run = async (
  program: Command,
  args: readonly string[],
): Promise<void> => {
  await program.parseAsync([...args], { from: "user" });
};

describe("src/cli/node/show.test", () => {
  it("node show calls node.show with the id parameter and no body", async () => {
    const h = harness();
    await run(h.program, ["node", "show", NODE.id]);

    assert.deepEqual(h.calls(), [
      {
        operationId: "node.show",
        body: undefined,
        parameters: { id: NODE.id },
        options: undefined,
      },
    ]);
    assert.equal(h.failCalls(), 0);
  });

  it("node show prints the node line", async () => {
    const h = harness();
    await run(h.program, ["node", "show", NODE.id]);

    assert.equal(
      h.stdoutText(),
      "kanthord: node task_01JQ8Z7G3HZZZZZZZZZZZZZZZW task ready add the health route\n",
    );
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
  });

  it("node show prints the error code and calls fail on a refusal", async () => {
    const h = harness({
      respond: () => ({
        ok: false as const,
        status: 404,
        code: "not-found",
        message: `no node ${NODE.id}`,
        details: undefined,
      }),
    });
    await run(h.program, ["node", "show", NODE.id]);

    assert.equal(h.stdoutText(), "");
    assert.equal(h.stderrText(), `kanthord: not-found: no node ${NODE.id}\n`);
    assert.equal(h.failCalls(), 1);
  });
});
