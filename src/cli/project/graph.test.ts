import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerProjectGraph } from "./graph.ts";

const ID = "project_01HZY8QF3M4N5P6R7S8T9V0W1X";

const GRAPH_RESPONSE = {
  attributes: {
    projectId: ID,
    revision: "revision_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E",
  },
  options: {
    allowSelfLoops: false,
    multi: false,
    type: "directed",
  },
  nodes: [
    {
      key: "initiative_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E",
      attributes: {
        kind: "initiative",
        title: "Platform",
        state: "pending",
        blockReason: null,
        discardReason: null,
        parentId: null,
        repositoryId: null,
      },
    },
    {
      key: "objective_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E",
      attributes: {
        kind: "objective",
        title: "Build API",
        state: "pending",
        blockReason: null,
        discardReason: null,
        parentId: "initiative_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E",
        repositoryId: null,
      },
    },
    {
      key: "task_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E",
      attributes: {
        kind: "task",
        title: "Implement feature",
        state: "ready",
        blockReason: null,
        discardReason: null,
        parentId: "objective_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E",
        repositoryId: "repo_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E",
      },
    },
  ],
  edges: [
    {
      key: "edge_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E",
      source: "task_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E",
      target: "objective_01JQ8ZDV5W6X7Y8Z9A0B1C2D3E",
      attributes: {
        relation: "depends-on",
        waivedAt: null,
      },
    },
  ],
};

const EMPTY_GRAPH = {
  attributes: {
    projectId: ID,
    revision: null,
  },
  options: {
    allowSelfLoops: false,
    multi: false,
    type: "directed",
  },
  nodes: [],
  edges: [],
};

const defaultRespond = (operationId: string): CallResult => {
  if (operationId === "project.graph") {
    return { ok: true, status: 200, body: GRAPH_RESPONSE };
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
  registerProjectGraph({
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

describe("src/cli/project/graph.test", () => {
  it("project graph --id calls project.graph and prints canonical JSON", async () => {
    const h = harness();
    await run(h.program, ["project", "graph", "--id", ID]);

    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["project.graph"],
    );
    assert.deepEqual(h.calls[0]?.parameters, { id: ID });
    assert.equal(h.failCalls(), 0);

    const output = h.stdoutText();
    const parsed = JSON.parse(output);
    assert.deepEqual(parsed, GRAPH_RESPONSE);
    assert.equal(output.endsWith("\n"), true);
    assert.ok(
      output.split("\n").length > 2,
      "pretty-printed with two-space indent",
    );
  });

  it("project graph on empty project prints canonical JSON with empty arrays", async () => {
    const h = harness({
      respond: () => ({ ok: true, status: 200, body: EMPTY_GRAPH }),
    });
    await run(h.program, ["project", "graph", "--id", ID]);

    assert.equal(h.failCalls(), 0);
    const output = h.stdoutText();
    const parsed = JSON.parse(output);
    assert.deepEqual(parsed.nodes, []);
    assert.deepEqual(parsed.edges, []);
    assert.equal(parsed.attributes.revision, null);
  });

  it("project graph with no --id prints error and fails", async () => {
    const h = harness();
    await run(h.program, ["project", "graph"]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.calls.length, 0);
    assert.equal(
      h.stderrText(),
      "kanthord: invalid-request: --id is required\n",
    );
  });

  it("project graph on 404 prints error and fails", async () => {
    const h = harness({
      respond: () => ({
        ok: false as const,
        status: 404,
        code: "not-found",
        message: `no project ${ID}`,
        details: undefined,
      }),
    });
    await run(h.program, ["project", "graph", "--id", ID]);

    assert.equal(h.failCalls(), 1);
    assert.equal(h.stderrText(), `kanthord: not-found: no project ${ID}\n`);
  });

  it("project graph renders exact canonical form: two-space indent, one trailing newline, nothing else", async () => {
    const h = harness();
    await run(h.program, ["project", "graph", "--id", ID]);

    assert.equal(h.failCalls(), 0);

    const output = h.stdoutText();

    const expected = JSON.stringify(GRAPH_RESPONSE, null, 2) + "\n";

    assert.equal(output, expected);

    assert.ok(output.startsWith("{"), "output starts with '{'");
    assert.equal(
      output.endsWith("\n"),
      true,
      "output ends with exactly one newline",
    );
    assert.equal(
      output.endsWith("\n\n"),
      false,
      "output does not end with double newline",
    );
    assert.ok(output.includes("\n  "), "output uses two-space indent");
    assert.equal(output.includes("\t"), false, "output contains no tabs");
    const lines = output.split("\n");
    for (const line of lines) {
      assert.equal(
        line.endsWith(" "),
        false,
        `no trailing space on line: "${line}"`,
      );
    }
    assert.equal(h.stderrText(), "", "stderr is empty on success");
  });
});
