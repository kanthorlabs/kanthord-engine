import assert from "node:assert/strict";
import { simpleGit } from "simple-git";
import {
  abortSignal,
  throwIfCancelled,
  type Context,
} from "../kernel/context.ts";
import { childEnvironment } from "./tool-table.ts";
const EXPIRED = 0;
const CLEAN_STATUS = "";
const FIRST_ATTEMPT = 1;
const NO_CONFLICTS = 0;
const INTERACTIVE_HELPERS = [
  "PAGER",
  "GIT_PAGER",
  "EDITOR",
  "GIT_EDITOR",
  "GIT_SEQUENCE_EDITOR",
  "GIT_ASKPASS",
  "SSH_ASKPASS",
];

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
  await run(directory, ["add", "--all"], context, remaining());
  const status = await run(
    directory,
    ["status", "--porcelain"],
    context,
    remaining(),
  );
  if (status.trim() === CLEAN_STATUS) return null;
  await run(directory, ["commit", "--message", message], context, remaining());
  return headCommit(directory, context, remaining());
}

async function run(
  directory: string,
  args: string[],
  context: Context,
  deadlineMs: number,
): Promise<string> {
  assert.ok(directory);
  assert.ok(deadlineMs > EXPIRED);
  throwIfCancelled(context);
  const bridge = abortSignal(context);
  try {
    return await simpleGit({
      baseDir: directory,
      abort: bridge.signal,
      timeout: { block: deadlineMs },
    })
      .env(gitEnvironment())
      .raw(args);
  } finally {
    bridge.dispose();
  }
}

function gitEnvironment(): NodeJS.ProcessEnv {
  const env = childEnvironment(process.env);
  for (const name of INTERACTIVE_HELPERS) delete env[name];
  return env;
}

export async function discardChanges(
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  assert.ok(directory);
  assert.ok(Number.isFinite(deadlineMs));
  const end = performance.now() + deadlineMs;
  await run(directory, ["reset", "--hard", "HEAD"], context, deadlineMs);
  await run(
    directory,
    ["clean", "-ffd"],
    context,
    Math.max(1, end - performance.now()),
  );
}
export async function headCommit(
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<string> {
  const commit = (
    await run(directory, ["rev-parse", "HEAD"], context, deadlineMs)
  ).trim();
  assert.match(commit, /^[a-f0-9]{40,64}$/);
  assert.ok(directory);
  return commit;
}

export async function diffText(
  directory: string,
  from: string,
  to: string,
  context: Context,
  deadlineMs: number,
): Promise<string> {
  assert.match(from, /^[a-f0-9]{40,64}$/);
  assert.match(to, /^[a-f0-9]{40,64}$/);
  return run(directory, ["diff", from, to], context, deadlineMs);
}

export async function unmergedFiles(
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<string[]> {
  const output = await run(
    directory,
    ["diff", "--name-only", "--diff-filter=U"],
    context,
    deadlineMs,
  );
  return output.split("\n").filter((line) => line.trim() !== CLEAN_STATUS);
}

export async function isAncestor(
  directory: string,
  ancestor: string,
  context: Context,
  deadlineMs: number,
): Promise<boolean> {
  const end = performance.now() + deadlineMs;
  const target = await run(
    directory,
    ["rev-parse", ancestor],
    context,
    end - performance.now(),
  );
  const base = await run(
    directory,
    ["merge-base", "HEAD", ancestor],
    context,
    end - performance.now(),
  );
  return base.trim() === target.trim();
}

export async function mergeRef(
  directory: string,
  ref: string,
  context: Context,
  deadlineMs: number,
): Promise<string[]> {
  const end = performance.now() + deadlineMs;
  let failure: unknown = null;
  await run(
    directory,
    ["merge", "--no-edit", "--no-ff", ref],
    context,
    end - performance.now(),
  ).catch((error: unknown) => {
    failure = error;
  });
  const conflicts = await unmergedFiles(
    directory,
    context,
    end - performance.now(),
  );
  if (conflicts.length === NO_CONFLICTS && failure !== null) throw failure;
  return conflicts;
}

export async function concludeMerge(
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  const end = performance.now() + deadlineMs;
  await run(directory, ["add", "--all"], context, end - performance.now());
  await run(
    directory,
    ["commit", "--no-edit"],
    context,
    end - performance.now(),
  );
}

export async function abortMerge(
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  await run(directory, ["merge", "--abort"], context, deadlineMs);
}

export async function resetTo(
  directory: string,
  commit: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  await run(directory, ["reset", "--hard", commit], context, deadlineMs);
}

export async function conflictMarkerFiles(
  directory: string,
  files: readonly string[],
  context: Context,
  deadlineMs: number,
): Promise<string[]> {
  assert.ok(files.length > NO_CONFLICTS);
  const output = await run(
    directory,
    ["grep", "--no-index", "-l", "-E", "^(<{7}|>{7})( |$)", "--", ...files],
    context,
    deadlineMs,
  ).catch(() => CLEAN_STATUS);
  return output.split("\n").filter((line) => line.trim() !== CLEAN_STATUS);
}
