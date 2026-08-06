import { GitError } from "./index.ts";
import type { GitRunner } from "./run.ts";

export type WorktreeCleanInput = Readonly<{ workDir: string }>;

export async function worktreeClean(
  runner: GitRunner,
  input: WorktreeCleanInput,
): Promise<boolean> {
  const result = await runner({
    args: ["status", "--porcelain=v1", "--untracked-files=all"],
    cwd: input.workDir,
  });
  if (result.code !== 0) {
    throw new GitError(
      "unknown",
      `git status failed in ${input.workDir}`,
      result.stderr,
    );
  }
  return result.stdout.length === 0;
}
