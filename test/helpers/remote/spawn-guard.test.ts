import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { join } from "node:path";

function spawnCallSlice(source: string, callIndex: number): string {
  const open = source.indexOf("(", callIndex);
  assert.ok(open !== -1, `no open paren after spawn at index ${callIndex}`);
  let depth = 0;
  for (let index = open; index < source.length; index += 1) {
    const char = source[index];
    if (char === "(") {
      depth += 1;
    } else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(callIndex, index + 1);
      }
    }
  }
  throw new Error(`unbalanced spawn call at index ${callIndex}`);
}

function findSpawnCallsInSource(source: string): string[] {
  const calls: string[] = [];
  for (
    let index = source.indexOf("spawn(");
    index !== -1;
    index = source.indexOf("spawn(", index + 1)
  ) {
    calls.push(spawnCallSlice(source, index));
  }
  return calls;
}

// The single long-lived exception: the sshd daemon spawn in ssh.ts, which
// must run for the lifetime of the fixture and therefore carries no
// lifetime `timeout` (a lifetime timeout would SIGKILL a healthy sshd once
// it elapses). Every other spawn call in this directory is short-lived and
// must carry both `timeout` and `killSignal`.
const longLivedAllowList = new Set<string>(["ssh.ts"]);

function checkModuleSpawns(moduleName: string, source: string): void {
  const calls = findSpawnCallsInSource(source);
  if (calls.length === 0) {
    return;
  }
  const isLongLived = longLivedAllowList.has(moduleName);
  for (const call of calls) {
    if (isLongLived) {
      assert.ok(
        !call.includes("timeout"),
        `${moduleName} is on the long-lived allow list and its daemon spawn ${JSON.stringify(call.slice(0, 70))} must carry no lifetime timeout`,
      );
    } else {
      for (const key of ["timeout", "killSignal"]) {
        assert.ok(
          call.includes(key),
          `${moduleName} is not on the long-lived allow list, so its spawn ${JSON.stringify(call.slice(0, 70))} must carry ${key}`,
        );
      }
    }
  }
}

function moduleFiles(directory: string): string[] {
  return fs
    .readdirSync(directory)
    .filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
    .sort();
}

describe("test/helpers/remote/spawn-guard.test", () => {
  const directory = import.meta.dirname;
  const files = moduleFiles(directory);

  it("finds at least one module that actually spawns, so the walk below is not vacuous", () => {
    const withSpawns = files.filter(
      (file) =>
        findSpawnCallsInSource(fs.readFileSync(join(directory, file), "utf8"))
          .length > 0,
    );
    assert.ok(
      withSpawns.length >= 2,
      `expected at least two modules under ${directory} to call spawn(), found: ${JSON.stringify(withSpawns)}`,
    );
  });

  it("requires every spawn call in every module under the directory to be allow-listed as long-lived or to carry timeout and killSignal", () => {
    for (const file of files) {
      const source = fs.readFileSync(join(directory, file), "utf8");
      checkModuleSpawns(file, source);
    }
  });

  it("pins the long-lived allow list to exactly the ssh.ts daemon spawn", () => {
    assert.deepEqual([...longLivedAllowList], ["ssh.ts"]);
  });

  it("fails closed on a spawn call in a module outside the allow list that carries no timeout", () => {
    const hostileSource =
      "const child = spawn(tools.paths.git, [], { env: {} });";
    assert.throws(() =>
      checkModuleSpawns("hostile-new-module.ts", hostileSource),
    );
  });

  it("fails closed on an allow-listed module whose spawn call regains a lifetime timeout", () => {
    const regressedSource =
      "const child = spawn(tools.paths.sshd, [], { env: {}, timeout: 5000 });";
    assert.throws(() => checkModuleSpawns("ssh.ts", regressedSource));
  });

  it("passes a compliant short-lived spawn call outside the allow list", () => {
    const compliantSource =
      'const child = spawn(tools.httpBackend, [], { env: {}, timeout: 5000, killSignal: "SIGKILL" });';
    assert.doesNotThrow(() =>
      checkModuleSpawns("some-new-cgi-module.ts", compliantSource),
    );
  });
});
