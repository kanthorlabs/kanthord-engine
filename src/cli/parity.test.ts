import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { findOperation, registry } from "../http/contract/registry.ts";
import { commandPaths, declaredCommands } from "./inventory.ts";
import { compareCommandSets, programCommandPaths } from "./parity.ts";
import { buildProgram, type ProgramDependencies } from "./program.ts";

const fakeDependencies = (): ProgramDependencies => ({
  env: {},
  fetch: async () => {
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
  stdout: () => {
    throw new Error("the fake stdout must never be called");
  },
  stderr: () => {
    throw new Error("the fake stderr must never be called");
  },
  fail: () => {
    throw new Error("the fake fail must never be called");
  },
  exit: () => {
    throw new Error("the fake exit must never be called");
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
  migrate: () => [],
  serve: async () => {
    throw new Error("the fake serve must never be called");
  },
});

describe("src/cli/parity.test", () => {
  it("parity holds between the inventory and the program in both directions", () => {
    const program = buildProgram(fakeDependencies());

    assert.deepEqual(
      compareCommandSets(commandPaths(), programCommandPaths(program)),
      { missingFromProgram: [], missingFromInventory: [] },
    );
  });

  it("programCommandPaths returns exactly the declared paths, by name", () => {
    const paths = programCommandPaths(buildProgram(fakeDependencies()));

    assert.deepEqual(paths, commandPaths());
    assert.deepEqual(commandPaths(), [
      "actor list",
      "actor register",
      "actor revoke",
      "actor rotate",
      "actor show",
      "config generate",
      "credential register",
      "db migrate",
      "db status",
      "event list",
      "node attest",
      "node claim",
      "node close",
      "node create",
      "node delete",
      "node heartbeat",
      "node list",
      "node release",
      "node report",
      "node show",
      "node unblock",
      "node update",
      "plan export",
      "plan import",
      "project create",
      "project list",
      "project repository",
      "project show",
      "repository register",
      "repository show",
      "run",
      "serve",
      "status",
    ]);
  });

  it("never lists a group command as a path", () => {
    const paths = programCommandPaths(buildProgram(fakeDependencies()));

    assert.equal(paths.includes("actor"), false);
    assert.equal(paths.includes("db"), false);
    assert.equal(paths.includes("credential"), false);
    assert.equal(paths.includes("project"), false);
    assert.equal(paths.includes("plan"), false);
    assert.equal(paths.includes("repository"), false);
    assert.equal(paths.includes("node"), false);
  });

  it("no command calls an operation absent from the registry", () => {
    for (const entry of declaredCommands) {
      for (const id of entry.operationIds) {
        assert.ok(findOperation(id), `registry lacks ${id}`);
      }
    }
  });

  it("only run reaches a stubbed operation", () => {
    const stubbedPaths = declaredCommands
      .filter((entry) =>
        entry.operationIds.some(
          (id) => findOperation(id)!.status === "stubbed",
        ),
      )
      .map((entry) => entry.path.join(" "));

    assert.deepEqual(stubbedPaths, ["run"]);
  });

  it("every calling entry names at least one operation id", () => {
    assert.deepEqual(
      declaredCommands
        .filter((entry) => entry.operationIds.length === 0)
        .map((entry) => entry.path.join(" "))
        .sort(),
      ["config generate", "db migrate", "serve"],
    );
  });

  it("reaches ids only as a step of another command", () => {
    const stepOnlyIds = new Set(
      declaredCommands
        .filter((entry) => entry.operationIds.length > 1)
        .flatMap((entry) => entry.operationIds.slice(0, -1)),
    );

    assert.deepEqual([...stepOnlyIds].sort(), [
      "node.show",
      "plan.revisions",
      "plan.validate",
      "provider.list",
      "repository.inspect",
      "repository.list",
    ]);
  });

  it("reports a command in the inventory but missing from the program", () => {
    const program = buildProgram(fakeDependencies());

    assert.deepEqual(
      compareCommandSets(
        [...commandPaths(), "zeta"],
        programCommandPaths(program),
      ),
      { missingFromProgram: ["zeta"], missingFromInventory: [] },
    );
  });

  it("reports a command in the program but missing from the inventory", () => {
    const program = buildProgram(fakeDependencies());

    assert.deepEqual(
      compareCommandSets(commandPaths(), [
        ...programCommandPaths(program),
        "zeta",
      ]),
      { missingFromProgram: [], missingFromInventory: ["zeta"] },
    );
  });

  it("reports both differences at once, sorted bytewise", () => {
    assert.deepEqual(compareCommandSets(["b", "a"], ["c", "a"]), {
      missingFromProgram: ["b"],
      missingFromInventory: ["c"],
    });
  });

  it("ignores the order of its inputs", () => {
    assert.deepEqual(compareCommandSets(["b", "a"], ["a", "b"]), {
      missingFromProgram: [],
      missingFromInventory: [],
    });
  });

  it("every operation id every command names resolves through findOperation", () => {
    for (const entry of declaredCommands) {
      for (const id of entry.operationIds) {
        assert.ok(
          findOperation(id),
          `${entry.path.join(" ")} names missing operation ${id}`,
        );
      }
    }
  });

  it("the routed operations that no command names are exactly the ten accepted ones", () => {
    const named = new Set(
      declaredCommands.flatMap((entry) => entry.operationIds),
    );
    const uncovered = registry
      .filter((entry) => entry.status === "routed")
      .map((entry) => entry.operationId)
      .filter((id) => !named.has(id))
      .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

    assert.deepEqual(uncovered, [
      "blob.show",
      "edge.list",
      "project.status",
      "provider.catalog",
      "provider.inspect",
      "provider.remove",
      "provider.rename",
      "provider.setDefault",
      "provider.show",
      "system.health",
    ]);
    assert.equal(uncovered.includes("event.list"), false);
    assert.equal(uncovered.includes("node.unblock"), false);
  });
});
