import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Command } from "commander";

import { dbCommand } from "./index.ts";
import { registerDbMigrate } from "./migrate.ts";
import { registerDbStatus } from "./status.ts";

describe("src/cli/db/index.test", () => {
  it("dbCommand creates a single db subcommand on a fresh program", () => {
    const program = new Command();
    const db = dbCommand(program);

    assert.equal(db.name(), "db");
    assert.equal(program.commands.filter((c) => c.name() === "db").length, 1);
  });

  it("two calls return the identical object and the count stays one", () => {
    const program = new Command();
    const first = dbCommand(program);
    const second = dbCommand(program);

    assert.strictEqual(first, second);
    assert.equal(program.commands.filter((c) => c.name() === "db").length, 1);
  });

  it("registerDbMigrate leaves one db command carrying exactly migrate", () => {
    const program = new Command();
    registerDbMigrate({
      program,
      env: {},
      migrate: () => [],
      stdout: () => {},
      stderr: () => {},
      fail: () => {},
    });

    const names = program.commands
      .filter((c) => c.name() === "db")
      .flatMap((db) => db.commands.map((c) => c.name()))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(names, ["migrate"]);
    assert.equal(program.commands.filter((c) => c.name() === "db").length, 1);
  });

  it("db migrate stays reachable through the shared command", async () => {
    let migrateCalls = 0;
    const program = new Command();
    registerDbMigrate({
      program,
      env: {},
      migrate: () => {
        migrateCalls += 1;
        return [];
      },
      stdout: () => {},
      stderr: () => {},
      fail: () => {},
    });

    await program.parseAsync(["db", "migrate", "--home", "/tmp/h"], {
      from: "user",
    });
    assert.equal(migrateCalls, 1);
  });

  it("registerDbMigrate and registerDbStatus leave one db command carrying both", () => {
    const program = new Command();
    registerDbMigrate({
      program,
      env: {},
      migrate: () => [],
      stdout: () => {},
      stderr: () => {},
      fail: () => {},
    });
    registerDbStatus({
      program,
      client: () => ({
        baseUrl: "http://127.0.0.1:7421",
        token: "t",
        fetch: async () => new Response(null),
      }),
      stdout: () => {},
      stderr: () => {},
      exit: () => {},
    });

    const names = program.commands
      .filter((c) => c.name() === "db")
      .flatMap((db) => db.commands.map((c) => c.name()))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    assert.deepEqual(names, ["migrate", "status"]);
    assert.equal(program.commands.filter((c) => c.name() === "db").length, 1);
  });

  it('["db", "status"] runs the status action through the shared command', async () => {
    let statusCalls = 0;
    const program = new Command();
    registerDbStatus({
      program,
      client: () => {
        statusCalls += 1;
        return {
          baseUrl: "http://127.0.0.1:7421",
          token: "t",
          fetch: async () =>
            new Response(JSON.stringify({ migrations: [] }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            }),
        };
      },
      stdout: () => {},
      stderr: () => {},
      exit: () => {},
    });

    await program.parseAsync(["db", "status"], { from: "user" });
    assert.equal(statusCalls, 1);
  });
});
