import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "./options.ts";
import type { CallResult } from "./client.ts";
import { registerStatus } from "./status.ts";

const FULL_BODY = {
  version: "27.8.1",
  bind: "127.0.0.1:7421",
  startedAt: "2026-08-06T00:00:00.000Z",
  status: "ok",
  dependencies: [
    { name: "storage", status: "ok" },
    { name: "git", status: "not-implemented" },
  ],
  nodes: [
    { kind: "initiative", state: "pending", blockReason: null, count: 1 },
    { kind: "objective", state: "pending", blockReason: null, count: 1 },
    { kind: "task", state: "blocked", blockReason: "attempt-limit", count: 2 },
  ],
  repositories: [
    {
      id: "repo_a",
      name: "kanthord-verify",
      divergedLandingOid: "a".repeat(40),
      divergedUpstreamOid: "b".repeat(40),
    },
  ],
  leases: [
    {
      subjectKind: "node",
      subjectId: "node_a",
      owner: "worker-1",
      fence: 3,
      expiresAt: 1700000000000,
    },
    {
      subjectKind: "repository",
      subjectId: "repo_a",
      owner: null,
      fence: 1,
      expiresAt: 1699999999999,
    },
  ],
};

const EMPTY_BODY = {
  version: "27.8.1",
  bind: "127.0.0.1:7421",
  startedAt: "2026-08-06T00:00:00.000Z",
  status: "ok",
  dependencies: [],
  nodes: [],
  repositories: [],
  leases: [],
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
  failCalls(): number;
} => {
  const program = new Command();
  registerClientOptions(program);
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
      return { ok: true as const, status: 200, body: FULL_BODY };
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  registerStatus({
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

describe("src/cli/status.test", () => {
  it("renders every section in response order as one exact literal", async () => {
    const h = harness();
    await run(h.program, ["status"]);

    assert.equal(
      h.stdoutText(),
      "kanthord: version 27.8.1\n" +
        "kanthord: bind 127.0.0.1:7421\n" +
        "kanthord: started 2026-08-06T00:00:00.000Z\n" +
        "kanthord: health ok\n" +
        "kanthord: dependency storage ok\n" +
        "kanthord: dependency git not-implemented\n" +
        "kanthord: node initiative pending - 1\n" +
        "kanthord: node objective pending - 1\n" +
        "kanthord: node task blocked attempt-limit 2\n" +
        `kanthord: repository repo_a kanthord-verify ${"a".repeat(40)} ${"b".repeat(40)}\n` +
        "kanthord: lease node node_a worker-1 3 1700000000000\n" +
        "kanthord: lease repository repo_a - 1 1699999999999\n",
    );
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
  });

  it("renders the P1-E1 node lines with a dash for a null block reason", async () => {
    const h = harness({
      respond: () => ({
        ok: true as const,
        status: 200,
        body: {
          ...EMPTY_BODY,
          nodes: [
            {
              kind: "objective",
              state: "pending",
              blockReason: null,
              count: 2,
            },
            { kind: "task", state: "pending", blockReason: null, count: 4 },
          ],
        },
      }),
    });
    await run(h.program, ["status"]);

    assert.deepEqual(
      h
        .stdoutText()
        .split("\n")
        .filter((line) => line.startsWith("kanthord: node ")),
      [
        "kanthord: node objective pending - 2",
        "kanthord: node task pending - 4",
      ],
    );
  });

  it("an empty body writes the four no lines and never fails", async () => {
    const h = harness({
      respond: () => ({
        ok: true as const,
        status: 200,
        body: EMPTY_BODY,
      }),
    });
    await run(h.program, ["status"]);

    assert.equal(
      h.stdoutText(),
      "kanthord: version 27.8.1\n" +
        "kanthord: bind 127.0.0.1:7421\n" +
        "kanthord: started 2026-08-06T00:00:00.000Z\n" +
        "kanthord: health ok\n" +
        "kanthord: no dependency\n" +
        "kanthord: no node\n" +
        "kanthord: no repository needs reconcile\n" +
        "kanthord: no expired lease\n",
    );
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
  });

  it("calls system.status exactly once with no body and no parameters", async () => {
    const h = harness();
    await run(h.program, ["status"]);

    assert.deepEqual(h.calls, [
      { operationId: "system.status", body: undefined, parameters: undefined },
    ]);
  });

  it("a 401 refusal writes the code line, fails once and writes no stdout", async () => {
    const h = harness({
      respond: () => ({
        ok: false as const,
        status: 401,
        code: "unauthenticated",
        message: "the bearer token is not valid",
        details: undefined,
      }),
    });
    await run(h.program, ["status"]);

    assert.equal(
      h.stderrText(),
      "kanthord: unauthenticated: the bearer token is not valid\n",
    );
    assert.equal(h.failCalls(), 1);
    assert.equal(h.stdoutText(), "");
  });

  it("a 501 refusal writes the not-implemented line, fails once and writes no stdout", async () => {
    const h = harness({
      respond: () => ({
        ok: false as const,
        status: 501,
        code: "not-implemented",
        message: "system.status is not implemented yet",
        details: undefined,
      }),
    });
    await run(h.program, ["status"]);

    assert.equal(
      h.stderrText(),
      "kanthord: not-implemented: system.status is not implemented yet\n",
    );
    assert.equal(h.failCalls(), 1);
    assert.equal(h.stdoutText(), "");
  });

  it("a body that fails the contract schema rejects and writes no partial line", async () => {
    const h = harness({
      respond: () => ({
        ok: true as const,
        status: 200,
        body: { version: "27.8.1" },
      }),
    });

    await assert.rejects(() => run(h.program, ["status"]));

    assert.equal(h.stdoutText(), "");
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
  });

  it("with --project <id> calls project.status with the id as a path parameter, never system.status", async () => {
    const h = harness({
      respond: () => ({ ok: true as const, status: 200, body: { nodes: [] } }),
    });
    await run(h.program, ["status", "--project", "project_a"]);

    assert.deepEqual(h.calls, [
      {
        operationId: "project.status",
        body: undefined,
        parameters: { id: "project_a" },
      },
    ]);
  });

  it("with --project <id> renders one node line per entry, in response order", async () => {
    const h = harness({
      respond: () => ({
        ok: true as const,
        status: 200,
        body: {
          nodes: [
            {
              kind: "objective",
              state: "pending",
              blockReason: null,
              count: 2,
            },
            { kind: "task", state: "pending", blockReason: null, count: 4 },
          ],
        },
      }),
    });
    await run(h.program, ["status", "--project", "project_a"]);

    assert.equal(
      h.stdoutText(),
      "kanthord: node objective pending - 2\n" +
        "kanthord: node task pending - 4\n",
    );
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
  });

  it("with --project <id> and an empty nodes list writes the one no-node line", async () => {
    const h = harness({
      respond: () => ({ ok: true as const, status: 200, body: { nodes: [] } }),
    });
    await run(h.program, ["status", "--project", "project_a"]);

    assert.equal(h.stdoutText(), "kanthord: no node\n");
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
  });

  it("with --project <id> a 404 refusal writes the code line and fails once", async () => {
    const h = harness({
      respond: () => ({
        ok: false as const,
        status: 404,
        code: "not-found",
        message: "no project project_a",
        details: undefined,
      }),
    });
    await run(h.program, ["status", "--project", "project_a"]);

    assert.equal(h.stderrText(), "kanthord: not-found: no project project_a\n");
    assert.equal(h.failCalls(), 1);
    assert.equal(h.stdoutText(), "");
  });

  it("routes on the code, never on the message", async () => {
    const first = harness({
      respond: () => ({
        ok: false as const,
        status: 400,
        code: "bad-request",
        message: "first message",
        details: undefined,
      }),
    });
    const second = harness({
      respond: () => ({
        ok: false as const,
        status: 400,
        code: "bad-request",
        message: "second message",
        details: undefined,
      }),
    });
    await run(first.program, ["status"]);
    await run(second.program, ["status"]);

    assert.equal(first.failCalls(), 1);
    assert.equal(second.failCalls(), 1);
    assert.equal(first.stderrText(), "kanthord: bad-request: first message\n");
    assert.equal(
      second.stderrText(),
      "kanthord: bad-request: second message\n",
    );
    assert.equal(first.stdoutText(), "");
    assert.equal(second.stdoutText(), "");
  });
});
