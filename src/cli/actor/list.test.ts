import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { registerClientOptions } from "../options.ts";
import type { CallResult } from "../client.ts";
import { registerActorList } from "./list.ts";

const BOOTSTRAP_ID = "actor_" + "0".repeat(26);

const FIRST = {
  id: "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQR",
  kind: "harness",
  name: "a",
  registeredBy: BOOTSTRAP_ID,
  createdAt: 1722800000000,
  revokedAt: null,
  revokedBy: null,
};

const SECOND = {
  id: "actor_01JQ8ZAN9P0ABCDEFGHJKMNPQS",
  kind: "harness",
  name: "b",
  registeredBy: BOOTSTRAP_ID,
  createdAt: 1722800001000,
  revokedAt: 1722800002000,
  revokedBy: BOOTSTRAP_ID,
};

const harness = (): {
  program: Command;
  calls: readonly Readonly<{ operationId: string; body: unknown }>[];
  stdoutText(): string;
  stderrText(): string;
  failCalls(): number;
  exitCodes(): readonly number[];
} => {
  const program = new Command();
  registerClientOptions(program);
  const calls: Readonly<{ operationId: string; body: unknown }>[] = [];
  const client = {
    call: async (operationId: string, body: unknown): Promise<CallResult> => {
      calls.push({ operationId, body });
      if (operationId === "actor.list") {
        return { ok: true, status: 200, body: { actors: [FIRST, SECOND] } };
      }
      throw new Error(`unexpected operation: ${operationId}`);
    },
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  const exitCalls: number[] = [];
  registerActorList({
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

describe("src/cli/actor/list.test", () => {
  it("lists one line per actor including the revoked one, and no line holds a token", async () => {
    const h = harness();

    await run(h.program, ["actor", "list"]);

    assert.equal(h.failCalls(), 0);
    assert.deepEqual(
      h.calls.map((call) => call.operationId),
      ["actor.list"],
    );
    const lines = h
      .stdoutText()
      .split("\n")
      .filter((line) => line !== "");
    assert.equal(lines.length, 2);
    assert.ok(lines[0]?.includes(FIRST.id));
    assert.ok(lines[1]?.includes(SECOND.id));
    assert.equal(lines[0]?.includes(" revoked"), false);
    assert.ok(lines[1]?.includes(" revoked"));
    assert.equal(h.stdoutText().toLowerCase().includes("token"), false);
  });
});
