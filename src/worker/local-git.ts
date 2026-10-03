import assert from "node:assert/strict";
import { simpleGit } from "simple-git";
import {
  abortSignal,
  throwIfCancelled,
  type Context,
} from "../kernel/context.ts";
import { childEnvironment } from "./tool-table.ts";
const EXPIRED = 0;

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
      .env(childEnvironment(process.env))
      .raw(args);
  } finally {
    bridge.dispose();
  }
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
