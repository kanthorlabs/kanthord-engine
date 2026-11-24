import assert from "node:assert/strict";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { simpleGit } from "simple-git";
import { overrideEnvironment, temporary } from "../kernel/test-support.ts";
import { StartPrecondition as SP } from "./catalog.ts";
import { checkPreconditions } from "./start-preconditions.ts";

const COMMIT_IDENTITY = [
  "-c",
  "user.name=Test",
  "-c",
  "user.email=test@example.invalid",
];
const EMPTY_LENGTH = 0;
const SECRET_ENV_NAME = "__KANTHORD_TEST_UNIQUE_SECRET__";

async function buildWorktree(root: string): Promise<string> {
  const W = join(root, "w");
  mkdirSync(W);
  await simpleGit(W).raw(["init", "-b", "main"]);
  writeFileSync(join(W, "README.md"), "init");
  const git = simpleGit(W);
  await git.add(".");
  await git.raw([...COMMIT_IDENTITY, "commit", "-m", "init"]);
  return W;
}

function writeFakeGit(dir: string, script: string): void {
  writeFileSync(join(dir, "git"), `#!/bin/sh\n${script}`, { mode: 0o755 });
}

function buildRecordingFakeGit(
  t: TestContext,
  toplevel: string,
): { binDir: string; argsFile: string; envNamesFile: string } {
  const base = temporary(t);
  const binDir = join(base, "bin");
  mkdirSync(binDir);
  const argsFile = join(base, "args");
  const envNamesFile = join(base, "env");
  writeFakeGit(
    binDir,
    [
      `echo "$@" >> "${argsFile}"`,
      `printenv | sed 's/=.*//' | sort > "${envNamesFile}"`,
      "for arg; do",
      '  case "$arg" in',
      `    --show-toplevel) echo "${toplevel}"; exit 0 ;;`,
      "    --porcelain=v1) exit 0 ;;",
      "  esac",
      "done",
      "exit 0",
    ].join("\n"),
  );
  return { binDir, argsFile, envNamesFile };
}

function buildSlowFakeGit(t: TestContext): string {
  const base = temporary(t);
  const binDir = join(base, "bin");
  mkdirSync(binDir);
  writeFakeGit(binDir, "sleep 10");
  return binDir;
}

test("L3-U4: workspace_directory passes when cwd and all roots are directories", async (t) => {
  const root = temporary(t);
  const W = await buildWorktree(root);
  const result = checkPreconditions({
    preconditions: [SP.WorkspaceDirectory],
    cwd: W,
    roots: [W],
    inputEnv: {},
  });
  assert.equal(result, null);
});

test("L3-U4: workspace_directory fails when cwd is not a directory", (t) => {
  const root = temporary(t);
  const file = join(root, "not-a-dir");
  writeFileSync(file, "x");
  const result = checkPreconditions({
    preconditions: [SP.WorkspaceDirectory],
    cwd: file,
    roots: [root],
    inputEnv: {},
  });
  assert.ok(result !== null);
  assert.equal(result.precondition, SP.WorkspaceDirectory);
});

test("L3-U4: workspace_directory fails when a root does not exist", (t) => {
  const root = temporary(t);
  const missing = join(root, "missing");
  const result = checkPreconditions({
    preconditions: [SP.WorkspaceDirectory],
    cwd: root,
    roots: [missing],
    inputEnv: {},
  });
  assert.ok(result !== null);
  assert.equal(result.precondition, SP.WorkspaceDirectory);
});

test("L3-U4: git_worktree passes when root is the top level of a git worktree", async (t) => {
  const root = temporary(t);
  const W = await buildWorktree(root);
  const result = checkPreconditions({
    preconditions: [SP.GitWorktree],
    cwd: W,
    roots: [W],
    inputEnv: { PATH: process.env["PATH"] ?? "" },
  });
  assert.equal(result, null);
});

test("L3-U4: git_worktree fails when root is a subdirectory of a worktree", async (t) => {
  const root = temporary(t);
  const W = await buildWorktree(root);
  const sub = join(W, "src");
  mkdirSync(sub);
  const result = checkPreconditions({
    preconditions: [SP.GitWorktree],
    cwd: sub,
    roots: [sub],
    inputEnv: { PATH: process.env["PATH"] ?? "" },
  });
  assert.ok(result !== null);
  assert.equal(result.precondition, SP.GitWorktree);
});

test("L3-U4: git_clean passes when root has no uncommitted changes", async (t) => {
  const root = temporary(t);
  const W = await buildWorktree(root);
  const result = checkPreconditions({
    preconditions: [SP.GitClean],
    cwd: W,
    roots: [W],
    inputEnv: { PATH: process.env["PATH"] ?? "" },
  });
  assert.equal(result, null);
});

test("L3-U4: git_clean fails when root has an uncommitted tracked change", async (t) => {
  const root = temporary(t);
  const W = await buildWorktree(root);
  writeFileSync(join(W, "README.md"), "changed");
  const result = checkPreconditions({
    preconditions: [SP.GitClean],
    cwd: W,
    roots: [W],
    inputEnv: { PATH: process.env["PATH"] ?? "" },
  });
  assert.ok(result !== null);
  assert.equal(result.precondition, SP.GitClean);
});

test("L3-U4: the first failing precondition in the list is returned", async (t) => {
  const root = temporary(t);
  const file = join(root, "f");
  writeFileSync(file, "x");
  const resultWD = checkPreconditions({
    preconditions: [SP.WorkspaceDirectory, SP.GitWorktree],
    cwd: file,
    roots: [root],
    inputEnv: { PATH: process.env["PATH"] ?? "" },
  });
  assert.ok(resultWD !== null);
  assert.equal(resultWD.precondition, SP.WorkspaceDirectory);

  const resultGT = checkPreconditions({
    preconditions: [SP.GitWorktree, SP.WorkspaceDirectory],
    cwd: file,
    roots: [file],
    inputEnv: { PATH: process.env["PATH"] ?? "" },
  });
  assert.ok(resultGT !== null);
  assert.equal(resultGT.precondition, SP.GitWorktree);
});

test("L3-U4: reason text includes the precondition id", async (t) => {
  const root = temporary(t);
  const W = await buildWorktree(root);
  writeFileSync(join(W, "README.md"), "dirty");
  const result = checkPreconditions({
    preconditions: [SP.GitClean],
    cwd: W,
    roots: [W],
    inputEnv: { PATH: process.env["PATH"] ?? "" },
  });
  assert.ok(result !== null);
  assert.ok(result.reason.startsWith(`${SP.GitClean}:`));
});

test("L3-U4: git_clean command includes --no-optional-locks", (t) => {
  const root = temporary(t);
  const workspace = join(root, "w");
  mkdirSync(workspace);
  const realWorkspace = realpathSync(workspace);
  const fake = buildRecordingFakeGit(t, realWorkspace);
  checkPreconditions({
    preconditions: [SP.WorkspaceDirectory, SP.GitWorktree, SP.GitClean],
    cwd: workspace,
    roots: [workspace],
    inputEnv: { PATH: `${fake.binDir}:${process.env["PATH"] ?? ""}` },
  });
  const args = readFileSync(fake.argsFile, "utf8");
  assert.ok(args.includes("--no-optional-locks"));
});

test("L3-U4: a name of process.env not in inputEnv is absent from the git command environment", (t) => {
  overrideEnvironment(t, { [SECRET_ENV_NAME]: "leaked" });
  const root = temporary(t);
  const workspace = join(root, "w");
  mkdirSync(workspace);
  const realWorkspace = realpathSync(workspace);
  const fake = buildRecordingFakeGit(t, realWorkspace);
  checkPreconditions({
    preconditions: [SP.WorkspaceDirectory, SP.GitWorktree],
    cwd: workspace,
    roots: [workspace],
    inputEnv: { PATH: `${fake.binDir}:${process.env["PATH"] ?? ""}` },
  });
  const envNames = readFileSync(fake.envNamesFile, "utf8")
    .split("\n")
    .filter(Boolean);
  assert.ok(!envNames.includes(SECRET_ENV_NAME));
});

test("L3-U4: PATH from inputEnv is used for git commands", (t) => {
  const root = temporary(t);
  const workspace = join(root, "w");
  mkdirSync(workspace);
  const realWorkspace = realpathSync(workspace);
  const fake = buildRecordingFakeGit(t, realWorkspace);
  const result = checkPreconditions({
    preconditions: [SP.WorkspaceDirectory, SP.GitWorktree, SP.GitClean],
    cwd: workspace,
    roots: [workspace],
    inputEnv: { PATH: fake.binDir },
  });
  assert.equal(result, null);
  assert.equal(readdirSync(workspace).length, EMPTY_LENGTH);
});

test("L3-U4: a timeout fails the precondition", (t) => {
  const root = temporary(t);
  const workspace = join(root, "w");
  mkdirSync(workspace);
  const slowBinDir = buildSlowFakeGit(t);
  const result = checkPreconditions({
    preconditions: [SP.WorkspaceDirectory, SP.GitWorktree],
    cwd: workspace,
    roots: [workspace],
    inputEnv: { PATH: `${slowBinDir}:${process.env["PATH"] ?? ""}` },
    timeoutMs: 1,
  });
  assert.ok(result !== null);
  assert.equal(result.precondition, SP.GitWorktree);
});
