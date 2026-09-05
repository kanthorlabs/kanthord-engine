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

type FakeOverrides = Readonly<{
  fetch?: typeof globalThis.fetch;
  loadClientConfig?: () =>
    Readonly<{ bind: string; port: number; token: string }> | undefined;
}>;

const fakeDependencies = (
  overrides: FakeOverrides = {},
): {
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
    fetch:
      overrides.fetch ??
      (async () => {
        fetchCalls += 1;
        throw new Error("the fake fetch must never be called");
      }),
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
    loadClientConfig: overrides.loadClientConfig ?? (() => undefined),
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

  it("buildProgram registers plan convert, import and export once", () => {
    const { dependencies } = fakeDependencies();
    const program = buildProgram(dependencies);
    const plan = program.commands.find((command) => command.name() === "plan");
    assert.ok(plan, "the plan group exists");

    assert.deepEqual(
      plan.commands.map((command) => command.name()),
      ["convert", "import", "export"],
    );
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

  it("status uses the injected client configuration callback for base url and token", async () => {
    let loadCalls = 0;
    const requests: Array<Readonly<{ url: string; init: RequestInit }>> = [];
    const fake = fakeDependencies({
      loadClientConfig: () => {
        loadCalls += 1;
        return { bind: "daemon.test", port: 9123, token: "callback-token" };
      },
      fetch: async (input, init) => {
        const url =
          typeof input === "string"
            ? input
            : input instanceof URL
              ? input.href
              : input.url;
        requests.push({ url, init: init ?? {} });
        return new Response(
          JSON.stringify({
            version: KANTHORD_VERSION,
            bind: "daemon.test:9123",
            startedAt: "2026-08-28T00:00:00.000Z",
            status: "ok",
            dependencies: [],
            nodes: [],
            repositories: [],
            leases: [],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });
    const program = buildProgram(fake.dependencies);

    await run(program, ["status"]);

    assert.equal(loadCalls, 1);
    assert.equal(requests.length, 1);
    const request = requests[0];
    assert.ok(request);
    assert.equal(request.url, "http://daemon.test:9123/v1/status");
    const headers = request.init.headers as Readonly<Record<string, string>>;
    assert.equal(headers.Authorization, "Bearer callback-token");
  });

  it("help does not load client configuration", async () => {
    let loadCalls = 0;
    const fake = fakeDependencies({
      loadClientConfig: () => {
        loadCalls += 1;
        return { bind: "daemon.test", port: 9123, token: "callback-token" };
      },
    });
    const program = buildProgram(fake.dependencies);
    program.configureOutput({ writeOut: () => {}, writeErr: () => {} });
    program.exitOverride();

    await assert.rejects(() => run(program, ["--help"]));

    assert.equal(loadCalls, 0);
  });

  it("two buildProgram calls return two distinct programs", () => {
    const first = buildProgram(fakeDependencies().dependencies);
    const second = buildProgram(fakeDependencies().dependencies);

    assert.notEqual(first, second);
  });

  it("buildProgram registers node list, node show, node claim, node renew and node release", () => {
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
      "renew",
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

  it("buildProgram registers project graph and project node", () => {
    const { dependencies } = fakeDependencies();
    const program = buildProgram(dependencies);

    const project = program.commands.find(
      (command) => command.name() === "project",
    );
    assert.ok(project, "the project group exists");
    const names = project.commands.map((command) => command.name());
    for (const name of [
      "create",
      "graph",
      "list",
      "node",
      "repository",
      "show",
    ]) {
      assert.ok(names.includes(name), `the project group registers ${name}`);
    }
  });
});
