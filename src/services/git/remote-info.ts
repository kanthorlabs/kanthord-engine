import {
  GitError,
  type GitCredential,
  type GitPaths,
  type RemoteInfo,
} from "./index.ts";
import type { GitRunner } from "./run.ts";
import { runAuthenticated } from "./authenticated.ts";
import { classifyFailure } from "./credential.ts";
import { stripUserinfo } from "./redact.ts";
import { remoteUrlVerdict } from "./url.ts";

export const SYMREF_PATTERN = /^ref: (refs\/heads\/[^\t\n]+)\tHEAD$/;

const BRANCH_PATTERN = /^[0-9a-f]{40}\trefs\/heads\/(.+)$/;

export function parseSymref(stdout: string): string | null {
  for (const line of stdout.split("\n")) {
    const match = SYMREF_PATTERN.exec(line);
    if (match !== null && match[1] !== undefined) {
      return match[1].slice("refs/heads/".length);
    }
  }
  return null;
}

export function parseBranches(stdout: string): readonly string[] {
  const branches: string[] = [];
  for (const line of stdout.split("\n")) {
    const match = BRANCH_PATTERN.exec(line);
    if (match !== null && match[1] !== undefined) {
      branches.push(match[1]);
    }
  }
  branches.sort((left, right) =>
    Buffer.compare(Buffer.from(left), Buffer.from(right)),
  );
  return branches;
}

export async function remoteInfo(
  runner: GitRunner,
  paths: GitPaths,
  input: Readonly<{ remoteUrl: string; credential: GitCredential }>,
): Promise<RemoteInfo> {
  const verdict = remoteUrlVerdict(input.remoteUrl);
  if (!verdict.allowed) {
    throw new GitError("url-refused", verdict.reason, "");
  }
  if (verdict.transport !== input.credential.transport) {
    throw new GitError(
      "url-refused",
      "the url transport and the credential transport disagree",
      "",
    );
  }
  const symref = await runAuthenticated(runner, paths, {
    args: ["ls-remote", "--symref", "--", input.remoteUrl, "HEAD"],
    credential: input.credential,
  });
  if (symref.code !== 0) {
    throw new GitError(
      classifyFailure({
        code: symref.code,
        stderr: symref.stderr,
        eraseObserved: symref.eraseObserved,
      }),
      `git ls-remote failed with code ${symref.code}`,
      stripUserinfo(symref.stderr),
    );
  }
  const heads = await runAuthenticated(runner, paths, {
    args: ["ls-remote", "--heads", "--", input.remoteUrl],
    credential: input.credential,
  });
  if (heads.code !== 0) {
    throw new GitError(
      classifyFailure({
        code: heads.code,
        stderr: heads.stderr,
        eraseObserved: heads.eraseObserved,
      }),
      `git ls-remote failed with code ${heads.code}`,
      stripUserinfo(heads.stderr),
    );
  }
  return {
    defaultBranch: parseSymref(symref.stdout),
    branches: parseBranches(heads.stdout),
  };
}
