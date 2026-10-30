import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readlink,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const SCRIPT = fileURLToPath(new URL("./test-path.mjs", import.meta.url));
const TOOLS = [
  "git",
  "bash",
  "ssh",
  "sh",
  "ssh-add",
  "ssh-agent",
  "ssh-keyscan",
  "ssh-keygen",
  "podman",
  "sleep",
  "ps",
  "mkdir",
  "which",
];
const ROUNDS = 25;
const PARALLEL = 8;
const EXECUTABLE = 0o755;
const SUCCESS = 0;
const MISSING = ["podman", "mkdir", "which"];
const RETIRED = "pnpm";
const SHADOWED = "git";
const RETIRED_DIRECTORY = "retired";

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

function endedPid() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
    child.on("error", reject);
    child.on("close", () => resolve(child.pid));
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

test("a tool that PATH does not have or that TOOLS does not list gets no link and the script still succeeds", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kanthord-test-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "scripts", "test-path.mjs");
  await mkdir(join(root, "scripts"));
  await copyFile(SCRIPT, script);
  const full = join(root, "full");
  const partial = join(root, "partial");
  await mkdir(full);
  await mkdir(partial);
  for (const tool of TOOLS) {
    await writeFile(join(full, tool), "#!/bin/sh\n", { mode: EXECUTABLE });
    if (!MISSING.includes(tool))
      await writeFile(join(partial, tool), "#!/bin/sh\n", {
        mode: EXECUTABLE,
      });
  }

  assert.deepEqual(await run(script, full), { status: SUCCESS, stderr: "" });
  const directory = join(root, "node_modules", ".cache", "test-path");
  await symlink(join(full, SHADOWED), join(directory, RETIRED));
  assert.deepEqual(await run(script, partial), {
    status: SUCCESS,
    stderr: "",
  });

  await assert.rejects(readlink(join(directory, RETIRED)), { code: "ENOENT" });
  for (const tool of TOOLS) {
    if (MISSING.includes(tool))
      await assert.rejects(readlink(join(directory, tool)), { code: "ENOENT" });
    else
      assert.equal(await readlink(join(directory, tool)), join(partial, tool));
  }
});

test("a directory with the name of a tool is not a target", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "kanthord-test-path-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const script = join(root, "scripts", "test-path.mjs");
  await mkdir(join(root, "scripts"));
  await copyFile(SCRIPT, script);
  const shadow = join(root, "shadow");
  const bin = join(root, "bin");
  await mkdir(join(shadow, SHADOWED), { recursive: true, mode: EXECUTABLE });
  await mkdir(bin);
  for (const tool of TOOLS) {
    await writeFile(join(bin, tool), "#!/bin/sh\n", { mode: EXECUTABLE });
  }

  assert.deepEqual(await run(script, [shadow, bin].join(delimiter)), {
    status: SUCCESS,
    stderr: "",
  });

  const directory = join(root, "node_modules", ".cache", "test-path");
  assert.equal(await readlink(join(directory, SHADOWED)), join(bin, SHADOWED));
});

test("a directory in the link directory does not stop the script", async (t) => {
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
  const directory = join(root, "node_modules", ".cache", "test-path");
  await mkdir(join(directory, RETIRED_DIRECTORY, RETIRED_DIRECTORY), {
    recursive: true,
  });

  assert.deepEqual(await run(script, bin), { status: SUCCESS, stderr: "" });

  await assert.rejects(readlink(join(directory, RETIRED_DIRECTORY)), {
    code: "ENOENT",
  });
  assert.equal(await readlink(join(directory, SHADOWED)), join(bin, SHADOWED));
});

test("the pending name of an ended run is removed and the pending name of a live run is kept", async (t) => {
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
  const directory = join(root, "node_modules", ".cache", "test-path");
  await mkdir(directory, { recursive: true });
  const ended = join(directory, `${SHADOWED}.${await endedPid()}`);
  const live = join(directory, `${SHADOWED}.${process.pid}`);
  await symlink(join(bin, SHADOWED), ended);
  await symlink(join(bin, SHADOWED), live);

  assert.deepEqual(await run(script, bin), { status: SUCCESS, stderr: "" });

  await assert.rejects(readlink(ended), { code: "ENOENT" });
  assert.equal(await readlink(live), join(bin, SHADOWED));
  assert.equal(await readlink(join(directory, SHADOWED)), join(bin, SHADOWED));
});
