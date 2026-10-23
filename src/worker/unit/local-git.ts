import assert from "node:assert/strict";
import { simpleGit, type SimpleGitOptions } from "simple-git";
import type { Context } from "../../kernel/context.ts";
import {
  GIT_UNSAFE_OPTIONS,
  isolatedGitEnvironment,
} from "../../kernel/git-environment.ts";
import { childEnvironment } from "./tool-table.ts";
const EXPIRED = 0;
const CLEAN_STATUS = "";
const FIRST_ATTEMPT = 1;
const NO_CONFLICTS = 0;
const EXIT_SUCCESS = 0;

const failNonzeroExit: SimpleGitOptions["errors"] = (error, result) =>
  result.exitCode === EXIT_SUCCESS
    ? error
    : (error ?? new Error(`git exited with ${result.exitCode}`));

export function taskCommitMessage(taskId: string, attempt: number): string {
  assert.ok(taskId);
  assert.ok(Number.isSafeInteger(attempt) && attempt >= FIRST_ATTEMPT);
  return `kanthord: task ${taskId} attempt ${attempt}`;
}

export function checkpointCommitMessage(
  taskId: string,
  attempt: number,
): string {
  assert.ok(taskId);
  assert.ok(Number.isSafeInteger(attempt) && attempt >= FIRST_ATTEMPT);
  return `kanthord: checkpoint of task ${taskId} attempt ${attempt}`;
}

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
  await run(env, directory, ["add", "--all"], context, remaining());
  const status = await run(
    env,
    directory,
    ["status", "--porcelain"],
    context,
    remaining(),
  );
  if (status.trim() === CLEAN_STATUS) return null;
  await run(
    env,
    directory,
    ["commit", "--message", message],
    context,
    remaining(),
  );
  return headCommit(env, directory, context, remaining());
}

async function run(
  env: NodeJS.ProcessEnv,
  directory: string,
  args: string[],
  context: Context,
  deadlineMs: number,
): Promise<string> {
  assert.ok(directory);
  assert.ok(deadlineMs > EXPIRED);
  context.signal.throwIfAborted();
  return await simpleGit({
    baseDir: directory,
    abort: context.signal,
    timeout: { block: deadlineMs },
    unsafe: GIT_UNSAFE_OPTIONS,
    errors: failNonzeroExit,
  })
    .env(gitEnvironment(env))
    .raw(args);
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
  context: Context,
  deadlineMs: number,
): Promise<string[]> {
  const end = performance.now() + deadlineMs;
  let failure: unknown = null;
  await run(
    env,
    directory,
    ["merge", "--no-edit", "--no-ff", ref],
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
  context: Context,
  deadlineMs: number,
): Promise<void> {
  const end = performance.now() + deadlineMs;
  await run(env, directory, ["add", "--all"], context, end - performance.now());
  await run(
    env,
    directory,
    ["commit", "--no-edit"],
    context,
    end - performance.now(),
  );
}

export async function abortMerge(
  env: NodeJS.ProcessEnv,
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  await run(env, directory, ["merge", "--abort"], context, deadlineMs);
}

export async function resetTo(
  env: NodeJS.ProcessEnv,
  directory: string,
  commit: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  await run(env, directory, ["reset", "--hard", commit], context, deadlineMs);
}

export async function conflictMarkerFiles(
  env: NodeJS.ProcessEnv,
  directory: string,
  files: readonly string[],
  context: Context,
  deadlineMs: number,
): Promise<string[]> {
  assert.ok(files.length > NO_CONFLICTS);
  const output = await run(
    env,
    directory,
    ["grep", "--no-index", "-l", "-E", "^(<{7}|>{7})( |$)", "--", ...files],
    context,
    deadlineMs,
  ).catch(() => CLEAN_STATUS);
  return output.split("\n").filter((line) => line.trim() !== CLEAN_STATUS);
}
