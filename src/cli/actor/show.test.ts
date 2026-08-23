import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerActorShow } from "./show.ts";

const BOOTSTRAP_ID = "actor_" + "0".repeat(26);
const ACTOR_ID = "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQR";

const VIEW = {
  id: ACTOR_ID,
  kind: "harness",
  name: "a",
  registeredBy: BOOTSTRAP_ID,
  createdAt: 1722800000000,
  revokedAt: null,
  revokedBy: null,
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
      parameters: Readonly<Record<string, string>> | undefined,
    ): Promise<CallResult> => {
      calls.push({ operationId, body, parameters });
      if (options.respond !== undefined) {
        return options.respond(operationId, body);
      }
      if (operationId === "actor.show") {
        return { ok: true, status: 200, body: VIEW };
      }
      throw new Error(`unexpected operation: ${operationId}`);
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  const exitCalls: number[] = [];
  registerActorShow({
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

describe("src/cli/actor/show.test", () => {
  it("shows the view of a known actor through exactly one actor.show call", async () => {
    const h = harness();

    await run(h.program, ["actor", "show", "--id", ACTOR_ID]);

    assert.equal(h.failCalls(), 0);
    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["actor.show"],
    );
    assert.deepEqual(h.calls[0]?.parameters, { id: ACTOR_ID });
    assert.ok(h.stdoutText().includes(ACTOR_ID));
    assert.ok(h.stdoutText().includes("a"));
    assert.equal(h.stdoutText().includes(" revoked"), false);
  });

  it("marks a revoked actor in the rendered line", async () => {
    const h = harness({
      respond: () => ({
        ok: true as const,
        status: 200,
        body: { ...VIEW, revokedAt: 1722800002000, revokedBy: BOOTSTRAP_ID },
      }),
    });

    await run(h.program, ["actor", "show", "--id", ACTOR_ID]);

    assert.ok(h.stdoutText().includes(" revoked"));
  });

  it("an unknown id prints the daemon refusal and fails", async () => {
    const h = harness({
      respond: () => ({
        ok: false,
        status: 404,
        code: "not-found",
        message: "no actor actor_01JQ8ZAN9P0ABCDEFGHJKMNPQR",
        details: undefined,
      }),
    });

    await run(h.program, [
      "actor",
      "show",
      "--id",
      "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQR",
    ]);

    assert.deepEqual(h.exitCodes(), [140]);
    assert.ok(h.stderrText().includes("not-found"));
    assert.ok(h.stderrText().includes("no actor"));
    assert.equal(h.stdoutText(), "");
  });

  it("omitting --id fails before any request and names the option", async () => {
    const h = harness();

    await run(h.program, ["actor", "show"]);

    assert.equal(h.calls.length, 0);
    assert.equal(h.failCalls(), 1);
    assert.ok(h.stderrText().includes("--id"));
  });
});
