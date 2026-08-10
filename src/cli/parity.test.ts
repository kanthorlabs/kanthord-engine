import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";

import { findOperation } from "../http/contract/registry.ts";
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

  it("programCommandPaths returns the fifteen inventory paths", () => {
    const paths = programCommandPaths(buildProgram(fakeDependencies()));

    assert.equal(paths.length, 15);
    assert.deepEqual(paths, commandPaths());
  });

  it("never lists a group command as a path", () => {
    const paths = programCommandPaths(buildProgram(fakeDependencies()));

    assert.equal(paths.includes("db"), false);
    assert.equal(paths.includes("credential"), false);
    assert.equal(paths.includes("project"), false);
    assert.equal(paths.includes("plan"), false);
    assert.equal(paths.includes("repository"), false);
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

  it("pins seventeen distinct ids across twelve calling entries", () => {
    const calling = declaredCommands.filter(
      (entry) => entry.operationIds.length > 0,
    );

    assert.equal(calling.length, 12);
    assert.equal(
      new Set(calling.flatMap((entry) => entry.operationIds)).size,
      17,
    );
  });

  it("reaches five ids only as a step of another command", () => {
    const stepOnlyIds = new Set(
      declaredCommands
        .filter((entry) => entry.operationIds.length > 1)
        .flatMap((entry) => entry.operationIds.slice(0, -1)),
    );

    assert.deepEqual([...stepOnlyIds].sort(), [
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
});
