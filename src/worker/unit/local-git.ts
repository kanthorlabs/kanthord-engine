import assert from "node:assert/strict";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { simpleGit, type SimpleGitOptions } from "simple-git";
import type { Context } from "../../kernel/context.ts";
import {
  GIT_UNSAFE_OPTIONS,
  isolatedGitEnvironment,
} from "../../kernel/git-environment.ts";
import { CodedError } from "../../kernel/errors.ts";
import { ensureDirectory } from "../../kernel/files.ts";
import { GIT_COMMIT_FAILED } from "./stop-codes.ts";
import { childEnvironment } from "./tool-table.ts";
const EXPIRED = 0;
const CLEAN_STATUS = "";
const NO_CONFLICTS = 0;
const EXIT_SUCCESS = 0;
const EXIT_NO_MATCH = 1;
const NO_EXIT = -1;
const NUL = "\0";
const NO_VALUE = "";
const NO_PATHS = 0;
const PATH_BATCH_BYTES = 262144;
const MODIFIED = "M";
const REGULAR_MODES = new Set(["100644", "100755"]);
const NEWLINE = "\n";
const STATUS_PREFIX_LENGTH = 3;
const EXCLUDE_SPECIAL = /[\\*?[\]!#]/g;
const COMMIT_PATTERN = /^[a-f0-9]{40,64}$/;
const RENAME_LETTER = "R";
const STATUS_LETTER_LENGTH = 1;
const FIRST_RECORD = 0;
const LETTER_START = 0;
const PATH_OFFSET = 1;
const RENAMED_PATH_OFFSET = 2;
const PLAIN_RECORD_WIDTH = 2;
const RENAME_RECORD_WIDTH = 3;
export const MERGE_HEAD = "MERGE_HEAD";
export const ChangeStatus = {
  Added: "added",
  Modified: "modified",
  Deleted: "deleted",
  Renamed: "renamed",
} as const;
export type ChangeStatus = (typeof ChangeStatus)[keyof typeof ChangeStatus];
export interface ChangeEntry {
  path: string;
  status: ChangeStatus;
  previous_path?: string;
}
const PLAIN_STATUSES: Readonly<Record<string, ChangeStatus>> = {
  A: ChangeStatus.Added,
  M: ChangeStatus.Modified,
  T: ChangeStatus.Modified,
  D: ChangeStatus.Deleted,
};
const GIT_OPERATIONS = [
  { state: "rebase-merge", quit: ["rebase", "--quit"] },
  { state: "rebase-apply/applying", quit: ["am", "--quit"] },
  { state: "rebase-apply", quit: ["rebase", "--quit"] },
  { state: "CHERRY_PICK_HEAD", quit: ["cherry-pick", "--quit"] },
  { state: "REVERT_HEAD", quit: ["revert", "--quit"] },
  { state: MERGE_HEAD, quit: ["merge", "--abort"] },
] as const;

const failNonzeroExit: NonNullable<SimpleGitOptions["errors"]> = (
  error,
  result,
) =>
  result.exitCode === EXIT_SUCCESS
    ? error
    : (error ?? new Error(`git exited with ${result.exitCode}`));

export async function commitWork(
  env: NodeJS.ProcessEnv,
  directory: string,
  message: string,
  context: Context,
  deadlineMs: number,
): Promise<string | null> {
  assert.ok(directory);
  assert.ok(message);
  const end = performance.now() + deadlineMs;
  const remaining = () => {
    const duration = end - performance.now();
    assert.ok(duration > EXPIRED, "Commit deadline reached");
    return duration;
  };
  if (!(await stageChanges(env, directory, context, remaining))) return null;
  await runCommit(env, directory, message, context, remaining());
  return headCommit(env, directory, context, remaining());
}

async function runCommit(
  env: NodeJS.ProcessEnv,
  directory: string,
  message: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  try {
    await run(
      env,
      directory,
      ["commit", "--message", message],
      context,
      deadlineMs,
    );
  } catch (error) {
    if (context.signal.aborted) throw error;
    throw new CodedError(GIT_COMMIT_FAILED, "Git commit failed.", {
      cause: error,
    });
  }
}

interface IndexEntry {
  mode: string;
  blob: string;
  path: string;
}

async function stageChanges(
  env: NodeJS.ProcessEnv,
  directory: string,
  context: Context,
  remaining: () => number,
): Promise<boolean> {
  await run(env, directory, ["add", "--all"], context, remaining());
  const converted = await conversionOnlyPaths(
    env,
    directory,
    context,
    remaining,
  );
  for (const batch of pathBatches(
    converted.map(({ mode, blob, path }) => `${mode},${blob},${path}`),
  ))
    await run(
      env,
      directory,
      ["update-index", ...batch.flatMap((entry) => ["--cacheinfo", entry])],
      context,
      remaining(),
    );
  return !(await indexMatchesHead(env, directory, context, remaining()));
}

async function conversionOnlyPaths(
  env: NodeJS.ProcessEnv,
  directory: string,
  context: Context,
  remaining: () => number,
): Promise<IndexEntry[]> {
  const fields = (
    await run(
      env,
      directory,
      ["diff", "--cached", "--raw", "-z", "--no-abbrev", "--no-renames"],
      context,
      remaining(),
    )
  ).split(NUL);
  const modified: IndexEntry[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const [oldMode, newMode, blob, , status] =
      fields[index]!.slice(1).split(" ");
    assert.ok(status !== undefined && blob !== undefined);
    if (
      status === MODIFIED &&
      oldMode === newMode &&
      REGULAR_MODES.has(oldMode!)
    )
      modified.push({ mode: oldMode!, blob, path: fields[index + 1]! });
  }
  const hashes: string[] = [];
  for (const batch of pathBatches(modified.map(({ path }) => path))) {
    const output = await run(
      env,
      directory,
      ["hash-object", "--no-filters", "--", ...batch],
      context,
      remaining(),
    );
    hashes.push(...output.trim().split("\n"));
  }
  assert.equal(hashes.length, modified.length);
  return modified.filter(({ blob }, index) => hashes[index] === blob);
}

function pathBatches(paths: readonly string[]): string[][] {
  const batches: string[][] = [];
  let batch: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    const size = Buffer.byteLength(path) + NUL.length;
    if (batch.length > NO_PATHS && bytes + size > PATH_BATCH_BYTES) {
      batches.push(batch);
      batch = [];
      bytes = 0;
    }
    batch.push(path);
    bytes += size;
  }
  if (batch.length > NO_PATHS) batches.push(batch);
  return batches;
}

async function indexMatchesHead(
  env: NodeJS.ProcessEnv,
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<boolean> {
  const { matched } = await runMatch(
    env,
    directory,
    ["diff", "--cached", "--quiet", "--"],
    context,
    deadlineMs,
  );
  return matched;
}

async function run(
  env: NodeJS.ProcessEnv,
  directory: string,
  args: string[],
  context: Context,
  deadlineMs: number,
  errors: SimpleGitOptions["errors"] = failNonzeroExit,
): Promise<string> {
  assert.ok(directory);
  assert.ok(deadlineMs > EXPIRED);
  context.signal.throwIfAborted();
  return await simpleGit({
    baseDir: directory,
    abort: context.signal,
    timeout: { block: deadlineMs },
    unsafe: GIT_UNSAFE_OPTIONS,
    errors,
  })
    .env(gitEnvironment(env))
    .raw(args);
}

async function runMatch(
  env: NodeJS.ProcessEnv,
  directory: string,
  args: string[],
  context: Context,
  deadlineMs: number,
): Promise<{ matched: boolean; output: string }> {
  const observed = { exitCode: NO_EXIT };
  const output = await run(
    env,
    directory,
    args,
    context,
    deadlineMs,
    (error, result) => {
      observed.exitCode = result.exitCode;
      if (result.exitCode === EXIT_NO_MATCH) return undefined;
      return failNonzeroExit(error, result);
    },
  );
  assert.ok(
    observed.exitCode === EXIT_SUCCESS || observed.exitCode === EXIT_NO_MATCH,
  );
  return { matched: observed.exitCode === EXIT_SUCCESS, output };
}

function gitEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return isolatedGitEnvironment(childEnvironment(env));
}

export async function discardChanges(
  env: NodeJS.ProcessEnv,
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  assert.ok(directory);
  assert.ok(Number.isFinite(deadlineMs));
  const end = performance.now() + deadlineMs;
  await run(env, directory, ["reset", "--hard", "HEAD"], context, deadlineMs);
  await run(
    env,
    directory,
    ["clean", "-ffd"],
    context,
    Math.max(1, end - performance.now()),
  );
}
export async function headCommit(
  env: NodeJS.ProcessEnv,
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<string> {
  const commit = (
    await run(env, directory, ["rev-parse", "HEAD"], context, deadlineMs)
  ).trim();
  assert.match(commit, /^[a-f0-9]{40,64}$/);
  assert.ok(directory);
  return commit;
}

export async function commitOf(
  env: NodeJS.ProcessEnv,
  directory: string,
  revision: string,
  context: Context,
  deadlineMs: number,
): Promise<string> {
  assert.ok(directory);
  assert.ok(revision && !revision.startsWith("-"));
  const commit = (
    await run(
      env,
      directory,
      ["rev-parse", "--verify", `${revision}^{commit}`],
      context,
      deadlineMs,
    )
  ).trim();
  assert.match(commit, /^[a-f0-9]{40,64}$/);
  return commit;
}

export async function symbolicHead(
  env: NodeJS.ProcessEnv,
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<string | null> {
  const { matched, output } = await runMatch(
    env,
    directory,
    ["symbolic-ref", "--quiet", "HEAD"],
    context,
    deadlineMs,
  );
  return matched ? output.trim() : null;
}

export async function containsCommit(
  env: NodeJS.ProcessEnv,
  directory: string,
  commit: string,
  context: Context,
  deadlineMs: number,
): Promise<boolean> {
  assert.match(commit, /^[a-f0-9]{40,64}$/);
  const { matched } = await runMatch(
    env,
    directory,
    ["merge-base", "--is-ancestor", commit, "HEAD"],
    context,
    deadlineMs,
  );
  return matched;
}

export async function hasCommit(
  env: NodeJS.ProcessEnv,
  directory: string,
  commit: string,
  context: Context,
  deadlineMs: number,
): Promise<boolean> {
  assert.match(commit, /^[a-f0-9]{40,64}$/);
  const { matched } = await runMatch(
    env,
    directory,
    ["rev-parse", "--quiet", "--verify", `${commit}^{commit}`],
    context,
    deadlineMs,
  );
  return matched;
}

export async function hasWorkSince(
  env: NodeJS.ProcessEnv,
  directory: string,
  commit: string,
  context: Context,
  deadlineMs: number,
): Promise<boolean> {
  assert.match(commit, /^[a-f0-9]{40,64}$/);
  const output = await run(
    env,
    directory,
    [
      "rev-list",
      "--first-parent",
      "--ancestry-path",
      "--no-merges",
      "--max-count=1",
      `${commit}..HEAD`,
    ],
    context,
    deadlineMs,
  );
  return output.trim() !== CLEAN_STATUS;
}

export async function softReset(
  env: NodeJS.ProcessEnv,
  directory: string,
  commit: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  assert.match(commit, /^[a-f0-9]{40,64}$/);
  await run(env, directory, ["reset", "--soft", commit], context, deadlineMs);
}

export async function forceBranch(
  env: NodeJS.ProcessEnv,
  directory: string,
  branch: string,
  commit: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  assert.ok(branch && !branch.startsWith("-"));
  assert.match(commit, /^[a-f0-9]{40,64}$/);
  await run(
    env,
    directory,
    ["checkout", "--force", "-B", branch, commit, "--"],
    context,
    deadlineMs,
  );
}

export async function isCommitted(
  env: NodeJS.ProcessEnv,
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<boolean> {
  const end = performance.now() + deadlineMs;
  if (!(await indexMatchesHead(env, directory, context, deadlineMs)))
    return false;
  const untracked = await run(
    env,
    directory,
    ["ls-files", "--others", "--exclude-standard", "-z"],
    context,
    end - performance.now(),
  );
  return untracked === CLEAN_STATUS;
}

async function gitPaths(
  env: NodeJS.ProcessEnv,
  directory: string,
  names: readonly string[],
  context: Context,
  deadlineMs: number,
): Promise<string[]> {
  const output = await run(
    env,
    directory,
    ["rev-parse", ...names.flatMap((name) => ["--git-path", name])],
    context,
    deadlineMs,
  );
  const paths = output.trim().split("\n");
  assert.equal(paths.length, names.length);
  return paths.map((path) => resolve(directory, path));
}

async function operationPaths(
  env: NodeJS.ProcessEnv,
  directory: string,
  context: Context,
  deadlineMs: number,
) {
  const paths = await gitPaths(
    env,
    directory,
    GIT_OPERATIONS.map(({ state }) => state),
    context,
    deadlineMs,
  );
  return GIT_OPERATIONS.map((operation, index) => ({
    ...operation,
    path: paths[index]!,
  }));
}

export async function operationsInProgress(
  env: NodeJS.ProcessEnv,
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<string[]> {
  return (await operationPaths(env, directory, context, deadlineMs))
    .filter(({ path }) => existsSync(path))
    .map(({ state }) => state);
}

export async function mergeHeadOf(
  env: NodeJS.ProcessEnv,
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<string | null> {
  const [path] = await gitPaths(
    env,
    directory,
    [MERGE_HEAD],
    context,
    deadlineMs,
  );
  return existsSync(path!) ? readFileSync(path!, "utf8").trim() : null;
}

export async function quitOperations(
  env: NodeJS.ProcessEnv,
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  const end = performance.now() + deadlineMs;
  for (const { path, quit } of await operationPaths(
    env,
    directory,
    context,
    deadlineMs,
  ))
    if (existsSync(path))
      await run(env, directory, [...quit], context, end - performance.now());
}

export async function diffText(
  env: NodeJS.ProcessEnv,
  directory: string,
  from: string,
  to: string,
  context: Context,
  deadlineMs: number,
): Promise<string> {
  assert.match(from, /^[a-f0-9]{40,64}$/);
  assert.match(to, /^[a-f0-9]{40,64}$/);
  return run(env, directory, ["diff", from, to], context, deadlineMs);
}

export async function unmergedFiles(
  env: NodeJS.ProcessEnv,
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<string[]> {
  const output = await run(
    env,
    directory,
    ["diff", "--name-only", "--diff-filter=U"],
    context,
    deadlineMs,
  );
  return output.split("\n").filter((line) => line.trim() !== CLEAN_STATUS);
}

export async function addedFiles(
  env: NodeJS.ProcessEnv,
  directory: string,
  base: string,
  context: Context,
  deadlineMs: number,
): Promise<string[]> {
  assert.ok(base);
  assert.ok(!base.startsWith("-"));
  const output = await run(
    env,
    directory,
    ["diff", "--name-only", "--diff-filter=A", `${base}...HEAD`, "--"],
    context,
    deadlineMs,
  );
  return output.split("\n").filter((line) => line.trim() !== CLEAN_STATUS);
}

export async function changedFiles(
  env: NodeJS.ProcessEnv,
  directory: string,
  from: string,
  to: string,
  context: Context,
  deadlineMs: number,
): Promise<string[]> {
  assert.ok(from && !from.startsWith("-"));
  assert.ok(to && !to.startsWith("-"));
  const output = await run(
    env,
    directory,
    ["diff", "--name-only", "-z", "--no-renames", from, to, "--"],
    context,
    deadlineMs,
  );
  return output.split(NUL).filter(Boolean);
}

export async function changedEntries(
  env: NodeJS.ProcessEnv,
  directory: string,
  from: string,
  to: string,
  context: Context,
  deadlineMs: number,
): Promise<ChangeEntry[]> {
  assert.ok(from && !from.startsWith("-"));
  assert.ok(to && !to.startsWith("-"));
  const fields = (
    await run(
      env,
      directory,
      ["diff", "--name-status", "-z", "--find-renames", from, to, "--"],
      context,
      deadlineMs,
    )
  )
    .split(NUL)
    .filter(Boolean);
  const entries: ChangeEntry[] = [];
  let index = FIRST_RECORD;
  while (index < fields.length) {
    const letter = fields[index]!.slice(LETTER_START, STATUS_LETTER_LENGTH);
    const path = fields[index + PATH_OFFSET];
    assert.ok(path !== undefined, "A change record holds a path.");
    if (letter === RENAME_LETTER) {
      const renamed = fields[index + RENAMED_PATH_OFFSET];
      assert.ok(renamed !== undefined, "A rename record holds a new path.");
      entries.push({
        path: renamed,
        status: ChangeStatus.Renamed,
        previous_path: path,
      });
      index += RENAME_RECORD_WIDTH;
      continue;
    }
    const status = PLAIN_STATUSES[letter];
    if (status === undefined)
      throw new Error(`Unsupported git change status ${letter}`);
    entries.push({ path, status });
    index += PLAIN_RECORD_WIDTH;
  }
  return entries;
}

export async function mergeBase(
  env: NodeJS.ProcessEnv,
  directory: string,
  left: string,
  right: string,
  context: Context,
  deadlineMs: number,
): Promise<string> {
  assert.ok(left && !left.startsWith("-"));
  assert.ok(right && !right.startsWith("-"));
  const commit = (
    await run(env, directory, ["merge-base", left, right], context, deadlineMs)
  ).trim();
  assert.match(commit, COMMIT_PATTERN);
  return commit;
}

export async function isAncestor(
  env: NodeJS.ProcessEnv,
  directory: string,
  ancestor: string,
  context: Context,
  deadlineMs: number,
): Promise<boolean> {
  const end = performance.now() + deadlineMs;
  const target = await run(
    env,
    directory,
    ["rev-parse", ancestor],
    context,
    end - performance.now(),
  );
  const base = await run(
    env,
    directory,
    ["merge-base", "HEAD", ancestor],
    context,
    end - performance.now(),
  );
  return base.trim() === target.trim();
}

export async function mergeRef(
  env: NodeJS.ProcessEnv,
  directory: string,
  ref: string,
  message: string,
  context: Context,
  deadlineMs: number,
): Promise<string[]> {
  assert.ok(message);
  const end = performance.now() + deadlineMs;
  let failure: unknown = null;
  await run(
    env,
    directory,
    ["merge", "--no-edit", "--no-ff", "--message", message, ref],
    context,
    end - performance.now(),
  ).catch((error: unknown) => {
    failure = error;
  });
  const conflicts = await unmergedFiles(
    env,
    directory,
    context,
    end - performance.now(),
  );
  if (conflicts.length === NO_CONFLICTS && failure !== null) throw failure;
  return conflicts;
}

export async function concludeMerge(
  env: NodeJS.ProcessEnv,
  directory: string,
  message: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  assert.ok(message);
  const end = performance.now() + deadlineMs;
  const remaining = () => end - performance.now();
  await stageChanges(env, directory, context, remaining);
  await runCommit(env, directory, message, context, remaining());
}

export async function amendTrailer(
  env: NodeJS.ProcessEnv,
  directory: string,
  trailer: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  assert.ok(trailer && !trailer.startsWith("-"));
  await run(
    env,
    directory,
    ["commit", "--amend", "--no-edit", "--trailer", trailer],
    context,
    deadlineMs,
  );
}

export async function trailerValues(
  env: NodeJS.ProcessEnv,
  directory: string,
  key: string,
  base: string,
  context: Context,
  deadlineMs: number,
): Promise<string[]> {
  assert.ok(key && !key.startsWith("-"));
  assert.ok(base && !base.startsWith("-"));
  const output = await run(
    env,
    directory,
    ["log", `--format=%(trailers:key=${key},valueonly)`, `${base}..HEAD`, "--"],
    context,
    deadlineMs,
  );
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== NO_VALUE);
}

export async function abortMerge(
  env: NodeJS.ProcessEnv,
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  await run(env, directory, ["merge", "--abort"], context, deadlineMs);
}

export async function cloneLocal(
  env: NodeJS.ProcessEnv,
  source: string,
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  assert.ok(source && !source.startsWith("-"));
  assert.ok(directory && !directory.startsWith("-"));
  await run(
    env,
    dirname(directory),
    ["clone", "--local", "--no-checkout", "--", source, directory],
    context,
    deadlineMs,
  );
}

export async function matchRemote(
  env: NodeJS.ProcessEnv,
  directory: string,
  source: string,
  address: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  assert.ok(source && !source.startsWith("-"));
  assert.ok(address && !address.startsWith("-"));
  const end = performance.now() + deadlineMs;
  await run(
    env,
    directory,
    [
      "fetch",
      "--prune",
      "--no-tags",
      "--",
      source,
      "+refs/remotes/origin/*:refs/remotes/origin/*",
    ],
    context,
    deadlineMs,
  );
  await run(
    env,
    directory,
    ["remote", "set-url", "origin", "--", address],
    context,
    end - performance.now(),
  );
}

export async function checkoutDetached(
  env: NodeJS.ProcessEnv,
  directory: string,
  commit: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  assert.match(commit, /^[a-f0-9]{40,64}$/);
  await run(
    env,
    directory,
    ["checkout", "--detach", commit, "--"],
    context,
    deadlineMs,
  );
}

export async function conflictMarkerFiles(
  env: NodeJS.ProcessEnv,
  directory: string,
  files: readonly string[],
  context: Context,
  deadlineMs: number,
): Promise<string[]> {
  assert.ok(files.length > NO_CONFLICTS);
  const { output } = await runMatch(
    env,
    directory,
    ["grep", "--no-index", "-l", "-E", "^(<{7}|>{7})( |$)", "--", ...files],
    context,
    deadlineMs,
  );
  return output.split("\n").filter((line) => line.trim() !== CLEAN_STATUS);
}

export async function fileAtRevision(
  env: NodeJS.ProcessEnv,
  directory: string,
  revision: string,
  path: string,
  context: Context,
  deadlineMs: number,
): Promise<string | null> {
  assert.ok(revision && !revision.startsWith("-"));
  assert.ok(path && !path.startsWith("-"));
  const end = performance.now() + deadlineMs;
  const [entry] = (
    await run(
      env,
      directory,
      ["ls-tree", "-z", revision, "--", path],
      context,
      deadlineMs,
    )
  )
    .split(NUL)
    .filter(Boolean);
  if (entry === undefined) return null;
  const [mode, , object] = entry.split(/[ \t]/);
  if (!REGULAR_MODES.has(mode!) || object === undefined) return null;
  return await run(
    env,
    directory,
    ["cat-file", "blob", object],
    context,
    end - performance.now(),
  );
}

export async function excludeUntracked(
  env: NodeJS.ProcessEnv,
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<string[]> {
  const end = performance.now() + deadlineMs;
  const paths = (
    await run(
      env,
      directory,
      ["ls-files", "-z", "--others", "--exclude-standard", "--directory"],
      context,
      deadlineMs,
    )
  )
    .split(NUL)
    .filter(Boolean);
  if (!paths.length) return paths;
  const excludeFile = resolve(
    directory,
    (
      await run(
        env,
        directory,
        ["rev-parse", "--git-path", "info/exclude"],
        context,
        end - performance.now(),
      )
    ).trim(),
  );
  ensureDirectory(dirname(excludeFile));
  appendFileSync(
    excludeFile,
    NEWLINE +
      paths
        .map((path) => `/${path.replace(EXCLUDE_SPECIAL, "\\$&")}\n`)
        .join(""),
  );
  return paths;
}

export async function restoreTracked(
  env: NodeJS.ProcessEnv,
  directory: string,
  paths: readonly string[],
  context: Context,
  deadlineMs: number,
): Promise<void> {
  assert.ok(paths.length);
  await run(
    env,
    directory,
    ["--literal-pathspecs", "checkout", "HEAD", "--", ...paths],
    context,
    deadlineMs,
  );
}

export async function trackedChanges(
  env: NodeJS.ProcessEnv,
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<string[]> {
  return (
    await run(
      env,
      directory,
      ["status", "--porcelain=v1", "-z", "--untracked-files=no"],
      context,
      deadlineMs,
    )
  )
    .split(NUL)
    .filter((entry) => entry.length > STATUS_PREFIX_LENGTH)
    .map((entry) => entry.slice(STATUS_PREFIX_LENGTH));
}
