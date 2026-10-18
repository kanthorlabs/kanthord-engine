import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("./test-path.mjs", import.meta.url));
const TOOLS = ["git", "bash", "ssh"];
const ROUNDS = 25;
const PARALLEL = 8;
const EXECUTABLE = 0o755;
const SUCCESS = 0;

function run(script, path) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [script], {
      env: { ...process.env, PATH: path },
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (status) => resolve({ status, stderr }));
  });
}

test("concurrent invocations all succeed and link each tool to its target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kanthord-test-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "scripts", "test-path.mjs");
  await mkdir(join(root, "scripts"));
  await copyFile(SCRIPT, script);
  const bin = join(root, "bin");
  await mkdir(bin);
  for (const tool of TOOLS) {
    await writeFile(join(bin, tool), "#!/bin/sh\n", { mode: EXECUTABLE });
  }

  for (let round = 0; round < ROUNDS; round += 1) {
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, () => run(script, bin)),
    );
    for (const result of results) {
      assert.equal(result.stderr, "");
      assert.equal(result.status, SUCCESS);
    }
  }

  const directory = join(root, "node_modules", ".cache", "test-path");
  for (const tool of TOOLS) {
    assert.equal(await readlink(join(directory, tool)), join(bin, tool));
  }
});
