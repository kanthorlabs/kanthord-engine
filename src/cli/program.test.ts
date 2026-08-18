import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { KANTHORD_VERSION } from "../domain/version.ts";
import type { AppliedMigrationLine } from "./db/migrate.ts";
import {
  buildProgram,
  type ProgramDependencies,
  type ServeOptions,
} from "./program.ts";

const fakeDependencies = (): {
  dependencies: ProgramDependencies;
  serveCalls: readonly ServeOptions[];
  migrateCalls: readonly Readonly<{
    home: string | undefined;
    config: string | undefined;
  }>[];
  fetchCalls: () => number;
  stdoutText: () => string;
  stderrText: () => string;
  failCalls: () => number;
  exitCodes: readonly number[];
} => {
  const serveCalls: ServeOptions[] = [];
  const migrateCalls: Readonly<{
    home: string | undefined;
    config: string | undefined;
  }>[] = [];
  let fetchCalls = 0;
  let stdoutText = "";
  let stderrText = "";
  let failCalls = 0;
  const exitCodes: number[] = [];
  const dependencies: ProgramDependencies = {
    env: {},
    fetch: async () => {
      fetchCalls += 1;
      throw new Error("the fake fetch must never be called");
    },
    cwd: "/tmp",
    username: "test-user",
    randomBytes,
    writeFile: () => {
      throw new Error("the fake writeFile must never be called");
    },
    createSecretFile: () => {
      throw new Error("the fake createSecretFile must never be called");
    },
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
      exitCodes.push(code);
    },
    confirm: {
      isTty: false,
      prompt: async () => {
        throw new Error("the fake confirm must never be called");
      },
    },
    readFile: () => {
      throw new Error("the fake readFile must never be called");
    },
    fs: {
      readDirectory: () => {
        throw new Error("the fake fs must never be called");
      },
      readFile: () => {
        throw new Error("the fake fs must never be called");
      },
      writeFile: () => {
        throw new Error("the fake fs must never be called");
      },
      makeDirectory: () => {
        throw new Error("the fake fs must never be called");
      },
      removeFile: () => {
        throw new Error("the fake fs must never be called");
      },
    },
    migrate: (input) => {
      migrateCalls.push(input);
      return [] satisfies readonly AppliedMigrationLine[];
    },
    serve: async (options) => {
      serveCalls.push(options);
    },
  };
  return {
    dependencies,
    serveCalls,
    migrateCalls,
    fetchCalls: () => fetchCalls,
    stdoutText: () => stdoutText,
    stderrText: () => stderrText,
    failCalls: () => failCalls,
    exitCodes,
  };
};

const run = async (
  program: ReturnType<typeof buildProgram>,
  args: readonly string[],
): Promise<void> => {
  await program.parseAsync([...args], { from: "user" });
};

describe("src/cli/program.test", () => {
  it("builds a program named kanthord carrying the version", () => {
    const { dependencies } = fakeDependencies();
    const program = buildProgram(dependencies);

    assert.equal(program.name(), "kanthord");
    assert.equal(program.version(), KANTHORD_VERSION);
  });

  it("registers the twelve declared top-level commands, sorted bytewise", () => {
    const { dependencies } = fakeDependencies();
    const program = buildProgram(dependencies);

    const names = program.commands.map((command) => command.name());
    assert.deepEqual(
      names.slice().sort((a, b) => {
        const left = Buffer.from(a);
        const right = Buffer.from(b);
        return Buffer.compare(left, right);
      }),
      [
        "actor",
        "config",
        "credential",
        "db",
        "event",
        "node",
        "plan",
        "project",
        "repository",
        "run",
        "serve",
        "status",
      ],
    );
  });

  it("serve calls the injected serve once with no options", async () => {
    const { dependencies, serveCalls } = fakeDependencies();
    const program = buildProgram(dependencies);

    await run(program, ["serve"]);

    assert.deepEqual(serveCalls, [{ config: undefined, home: undefined }]);
  });

  it("serve forwards the parsed --config and --home options", async () => {
    const { dependencies, serveCalls } = fakeDependencies();
    const program = buildProgram(dependencies);

    await run(program, ["--config", "/c.json", "--home", "/h", "serve"]);

    assert.deepEqual(serveCalls, [{ config: "/c.json", home: "/h" }]);
  });

  it("db migrate calls the injected migrate once with the parsed home and no config", async () => {
    const { dependencies, migrateCalls } = fakeDependencies();
    const program = buildProgram(dependencies);

    await run(program, ["db", "migrate", "--home", "/h"]);

    assert.deepEqual(migrateCalls, [{ home: "/h", config: undefined }]);
  });

  it("db status with no base url and empty env refuses, exits 1 and never fetches", async () => {
    const { dependencies, fetchCalls, stderrText, exitCodes } =
      fakeDependencies();
    const program = buildProgram(dependencies);

    await run(program, ["db", "status"]);

    assert.equal(fetchCalls(), 0);
    assert.ok(stderrText().startsWith("kanthord: cli-base-url-missing: "));
    assert.deepEqual(exitCodes, [1]);
  });

  it("two buildProgram calls return two distinct programs", () => {
    const first = buildProgram(fakeDependencies().dependencies);
    const second = buildProgram(fakeDependencies().dependencies);

    assert.notEqual(first, second);
  });

  it("buildProgram registers node list, node show, node claim, node heartbeat and node release", () => {
    const { dependencies } = fakeDependencies();
    const program = buildProgram(dependencies);

    const node = program.commands.find((command) => command.name() === "node");
    assert.ok(node, "the node group exists");
    const names = node.commands.map((command) => command.name());
    for (const name of [
      "create",
      "update",
      "delete",
      "list",
      "show",
      "claim",
      "heartbeat",
      "release",
    ]) {
      assert.ok(names.includes(name), `the node group registers ${name}`);
    }
  });

  it("buildProgram registers node report, node attest and node close", () => {
    const { dependencies } = fakeDependencies();
    const program = buildProgram(dependencies);

    const node = program.commands.find((command) => command.name() === "node");
    assert.ok(node, "the node group exists");
    const names = node.commands.map((command) => command.name());
    for (const name of ["report", "attest", "close"]) {
      assert.ok(names.includes(name), `the node group registers ${name}`);
    }
  });
});
