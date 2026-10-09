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
