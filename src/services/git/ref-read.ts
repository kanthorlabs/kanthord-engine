import { GitError } from "./index.ts";
import type { GitRunner } from "./run.ts";

export async function resolveRef(
  runner: GitRunner,
  input: Readonly<{ gitDir: string; ref: string }>,
): Promise<string | null> {
  const result = await runner({
    args: [
      `--git-dir=${input.gitDir}`,
      "rev-parse",
      "--verify",
      "--quiet",
      input.ref,
    ],
  });
  if (result.code !== 0) {
    return null;
  }
  const value = result.stdout.trim();
  if (!/^[0-9a-f]{40}$/.test(value)) {
    throw new GitError(
      "unknown",
      `rev-parse returned an unexpected value for ${input.ref}`,
      "",
    );
  }
  return value;
}
