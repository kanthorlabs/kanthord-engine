import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import {
  registerDbMigrate,
  type AppliedMigrationLine,
  type MigrateHandler,
} from "./migrate.ts";

const twoApplied: readonly AppliedMigrationLine[] = [
  { version: 1, name: "0001-core-entities" },
  { version: 2, name: "0002-graph-and-plan" },
];

const harness = (
  env: Readonly<Record<string, string | undefined>> = {},
  applied: readonly AppliedMigrationLine[] = [],
): {
  program: Command;
  migrateCalls: readonly Readonly<{ home: string | undefined }>[];
  stdoutText(): string;
  stderrText(): string;
  failCalls(): number;
} => {
  const program = new Command();
  const migrateCalls: Readonly<{ home: string | undefined }>[] = [];
  const migrate: MigrateHandler = (call) => {
    migrateCalls.push(call);
    return applied;
  };
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  registerDbMigrate({
    program,
    migrate,
    env,
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
    migrateCalls,
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

describe("src/cli/db/migrate.test", () => {
  it("with --home and two applied migrations prints one kanthord: applied line per entry", async () => {
    const h = harness({}, twoApplied);
    await run(h.program, ["db", "migrate", "--home", "/tmp/h"]);

    assert.deepEqual(h.migrateCalls, [{ home: "/tmp/h" }]);
    assert.equal(
      h.stdoutText(),
      "kanthord: applied 1 0001-core-entities\nkanthord: applied 2 0002-graph-and-plan\n",
    );
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
  });

  it("with no applied migrations prints kanthord: no change", async () => {
    const h = harness();
    await run(h.program, ["db", "migrate", "--home", "/tmp/h"]);

    assert.equal(h.stdoutText(), "kanthord: no change\n");
    assert.equal(h.stderrText(), "");
    assert.equal(h.failCalls(), 0);
  });

  it("without --home calls the handler with home undefined", async () => {
    const h = harness();
    await run(h.program, ["db", "migrate"]);

    assert.deepEqual(h.migrateCalls, [{ home: undefined }]);
  });

  it("a non-loopback --base-url refuses without calling the handler", async () => {
    const h = harness();
    await run(h.program, [
      "db",
      "migrate",
      "--base-url",
      "https://daemon.example.com",
    ]);

    assert.deepEqual(h.migrateCalls, []);
    assert.equal(h.failCalls(), 1);
    assert.ok(h.stderrText().startsWith("kanthord: db-remote-base-url:"));
    assert.equal(h.stdoutText(), "");
  });

  it("a non-loopback KANTHORD_BASE_URL env refuses without calling the handler", async () => {
    const h = harness({ KANTHORD_BASE_URL: "https://daemon.example.com" });
    await run(h.program, ["db", "migrate"]);

    assert.deepEqual(h.migrateCalls, []);
    assert.equal(h.failCalls(), 1);
    assert.ok(h.stderrText().startsWith("kanthord: db-remote-base-url:"));
  });

  it("a loopback --base-url flag wins over a non-loopback KANTHORD_BASE_URL env", async () => {
    const h = harness({ KANTHORD_BASE_URL: "https://daemon.example.com" });
    await run(h.program, ["db", "migrate", "--base-url", "http://127.0.0.1:1"]);

    assert.deepEqual(h.migrateCalls, [{ home: undefined }]);
    assert.equal(h.failCalls(), 0);
  });

  it("a loopback --base-url calls the handler", async () => {
    const h = harness();
    await run(h.program, [
      "db",
      "migrate",
      "--base-url",
      "http://127.0.0.1:7421",
    ]);

    assert.deepEqual(h.migrateCalls, [{ home: undefined }]);
    assert.equal(h.failCalls(), 0);
  });
});
