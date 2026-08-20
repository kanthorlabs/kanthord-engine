import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerProjectNode } from "./node.ts";

const ID = "project_01HZY8QF3M4N5P6R7S8T9V0W1X";

const NODE_LIST = {
  nodes: [
    {
      id: "task_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E",
      projectId: ID,
      kind: "task",
      title: "Implement feature",
      state: "ready",
      blockReason: null,
      discardReason: null,
      parentId: "objective_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E",
      dependencies: [],
    },
    {
      id: "objective_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E",
      projectId: ID,
      kind: "objective",
      title: "Build API",
      state: "pending",
      blockReason: null,
      discardReason: null,
      parentId: "initiative_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E",
      dependencies: [],
    },
    {
      id: "initiative_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E",
      projectId: ID,
      kind: "initiative",
      title: "Platform",
      state: "pending",
      blockReason: null,
      discardReason: null,
      parentId: null,
      dependencies: [],
    },
  ],
};

const EMPTY_NODE_LIST = { nodes: [] };

const defaultRespond = (operationId: string): CallResult => {
  if (operationId === "project.nodes") {
    return { ok: true, status: 200, body: NODE_LIST };
  }
  throw new Error(`unexpected operation: ${operationId}`);
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
      return options.respond !== undefined
        ? options.respond(operationId, body)
        : defaultRespond(operationId);
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  registerProjectNode({
    program,
    client,
    stdout: (text: string) => {
      stdoutText += text;
    },
    stderr: (text: string) => {
      stderrText += text;
    },
    fail: () => {
      failCalls += 1;
    },
  });
  return {
    program,
    calls,
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

describe("src/cli/project/node.test", () => {
  it("project node --id calls project.nodes and prints each node", async () => {
    const h = harness();
    await run(h.program, ["project", "node", "--id", ID]);

    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["project.nodes"],
    );
    assert.deepEqual(h.calls[0]?.parameters, { id: ID });
    assert.equal(h.failCalls(), 0);

    const lines = h.stdoutText().trim().split("\n");
    assert.equal(lines.length, 3);
    assert.match(
      lines[0]!,
      /^kanthord: node task_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E task ready Implement feature$/,
    );
    assert.match(
      lines[1]!,
      /^kanthord: node objective_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E objective pending Build API$/,
    );
    assert.match(
      lines[2]!,
      /^kanthord: node initiative_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E initiative pending Platform$/,
    );
  });

  it("project node on empty project prints 'kanthord: no node'", async () => {
    const h = harness({
      respond: () => ({ ok: true, status: 200, body: EMPTY_NODE_LIST }),
    });
    await run(h.program, ["project", "node", "--id", ID]);

    assert.equal(h.failCalls(), 0);
    assert.equal(h.stdoutText(), "kanthord: no node\n");
  });

  it("project node with no --id prints error and fails", async () => {
    const h = harness();
    await run(h.program, ["project", "node"]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.calls.length, 0);
    assert.equal(
      h.stderrText(),
      "kanthord: invalid-request: --id is required\n",
    );
  });

  it("project node on 404 prints error and fails", async () => {
    const h = harness({
      respond: () => ({
        ok: false as const,
        status: 404,
        code: "not-found",
        message: `no project ${ID}`,
        details: undefined,
      }),
    });
    await run(h.program, ["project", "node", "--id", ID]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.stderrText(), `kanthord: not-found: no project ${ID}\n`);
  });
});
