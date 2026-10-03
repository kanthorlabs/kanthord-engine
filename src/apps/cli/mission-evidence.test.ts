import assert from "node:assert/strict";
import { test } from "node:test";
import { Command } from "commander";
import { createIdentity } from "../../kernel/identity.ts";
import { addEvidenceCommands } from "./mission-evidence.ts";
import { HttpMethod } from "../../kernel/http.ts";
const STRING_TYPE = "string";
const DELETE_CASES = 4;

test("both evidence delete commands send an explicit boolean force through the HTTP client", async (t) => {
  const bodies: unknown[] = [];
  t.mock.method(
    globalThis,
    "fetch",
    async (_url: unknown, init: RequestInit) => {
      assert.equal(init.method, HttpMethod.Delete);
      assert.equal(typeof init.body, STRING_TYPE);
      bodies.push(JSON.parse(init.body as string));
      return new Response(null, { status: 204 });
    },
  );
  t.mock.method(process.stdout, "write", () => true);
  for (const asset of [false, true]) {
    for (const force of [false, true]) {
      const command = new Command("mission")
        .option("--endpoint <url>", "endpoint", "http://localhost:31415")
        .option("--token <token>", "token", "human-token");
      addEvidenceCommands(command);
      await command.parseAsync(
        [
          "evidence",
          ...(asset ? ["asset"] : []),
          "delete",
          createIdentity(asset ? "evidence_asset" : "evidence"),
          "--expected-mission-version",
          "1",
          ...(force ? ["--force", "--reason", "Remove exposed material"] : []),
        ],
        { from: "user" },
      );
      assert.deepEqual(bodies.at(-1), {
        expectedMissionVersion: 1,
        force,
        ...(force ? { reason: "Remove exposed material" } : {}),
      });
    }
  }
  assert.equal(bodies.length, DELETE_CASES);
});
