import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerActorRevoke } from "./revoke.ts";

const BOOTSTRAP_ID = "actor_" + "0".repeat(26);
const ACTOR_ID = "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQR";

const VIEW = {
  id: ACTOR_ID,
  kind: "harness",
  name: "a",
  registeredBy: BOOTSTRAP_ID,
  createdAt: 1722800000000,
  revokedAt: 1722800001000,
  revokedBy: BOOTSTRAP_ID,
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
      if (operationId === "actor.revoke") {
        return { ok: true, status: 200, body: VIEW };
      }
      throw new Error(`unexpected operation: ${operationId}`);
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  const exitCalls: number[] = [];
  registerActorRevoke({
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

describe("src/cli/actor/revoke.test", () => {
  it("revokes through exactly one actor.revoke call and prints the view fields", async () => {
    const h = harness();

    await run(h.program, ["actor", "revoke", "--id", ACTOR_ID]);

    assert.equal(h.failCalls(), 0);
    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["actor.revoke"],
    );
    assert.deepEqual(h.calls[0]?.parameters, { id: ACTOR_ID });
    assert.equal(h.calls[0]?.body, undefined);
    assert.ok(h.stdoutText().includes(ACTOR_ID));
  });

  it("a daemon refusal prints the code and fails", async () => {
    const h = harness({
      respond: () => ({
        ok: false,
        status: 400,
        code: "invalid-request",
        message: "the bootstrap actor cannot be revoked",
        details: { refusal: "bootstrap-actor" },
      }),
    });

    await run(h.program, ["actor", "revoke", "--id", ACTOR_ID]);

    assert.deepEqual(h.exitCodes(), [110]);
    assert.ok(h.stderrText().includes("invalid-request"));
    assert.equal(h.stdoutText(), "");
  });

  it("omitting --id fails before any request and names the option", async () => {
    const h = harness();

    await run(h.program, ["actor", "revoke"]);

    assert.equal(h.calls.length, 0);
    assert.equal(h.failCalls(), 1);
    assert.ok(h.stderrText().includes("--id"));
  });
});
