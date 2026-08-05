import {
  GitError,
  TRACKING_REFSPEC,
  type GitCredential,
  type GitPaths,
} from "./index.ts";
import { classifyFailure } from "./credential.ts";
import { stripUserinfo } from "./redact.ts";
import { runAuthenticated } from "./authenticated.ts";
import type { GitRunner } from "./run.ts";

export type FetchInput = Readonly<{
  gitDir: string;
  credential: GitCredential;
  pidFile: string;
}>;

export async function fetchTracking(
  runner: GitRunner,
  paths: GitPaths,
  input: FetchInput,
): Promise<void> {
  const outcome = await runAuthenticated(runner, paths, {
    credential: input.credential,
    pidFile: input.pidFile,
    args: [
      `--git-dir=${input.gitDir}`,
      "fetch",
      "origin",
      "--prune",
      "--no-tags",
      TRACKING_REFSPEC,
    ],
  });
  if (outcome.code === 0) {
    return;
  }
  throw new GitError(
    classifyFailure({
      code: outcome.code,
      stderr: outcome.stderr,
      eraseObserved: outcome.eraseObserved,
    }),
    `git fetch failed with code ${outcome.code}`,
    stripUserinfo(outcome.stderr),
  );
}
