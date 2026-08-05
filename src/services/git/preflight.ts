import {
  GitError,
  type GitCredential,
  type GitPaths,
  type PushPreflight,
} from "./index.ts";
import type { GitRunner } from "./run.ts";
import { runAuthenticated } from "./authenticated.ts";
import { classifyFailure } from "./credential.ts";
import { stripUserinfo } from "./redact.ts";
import { remoteUrlVerdict } from "./url.ts";

export type CanPushInput = Readonly<{
  gitDir: string;
  remoteUrl: string;
  publishRef: string;
  proposedOid: string;
  credential: GitCredential;
}>;

export type RemoteRefProbe = Readonly<{
  before: string | null;
  after: string | null;
}>;

export async function canPush(
  runner: GitRunner,
  paths: GitPaths,
  input: CanPushInput,
): Promise<PushPreflight> {
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
  const refspec = `${input.proposedOid}:${input.publishRef}`;
  const outcome = await runAuthenticated(runner, paths, {
    args: [
      `--git-dir=${input.gitDir}`,
      "push",
      "--dry-run",
      "--",
      input.remoteUrl,
      refspec,
    ],
    credential: input.credential,
  });
  if (outcome.code === 0) {
    return { allowed: true };
  }
  return {
    allowed: false,
    failure: classifyFailure({
      code: outcome.code,
      stderr: outcome.stderr,
      eraseObserved: outcome.eraseObserved,
    }),
    detail: stripUserinfo(outcome.stderr),
  };
}

export async function remoteRefValue(
  runner: GitRunner,
  paths: GitPaths,
  input: Readonly<{
    remoteUrl: string;
    ref: string;
    credential: GitCredential;
  }>,
): Promise<string | null> {
  const outcome = await runAuthenticated(runner, paths, {
    args: ["ls-remote", "--", input.remoteUrl, input.ref],
    credential: input.credential,
  });
  if (outcome.code !== 0) {
    throw new GitError(
      classifyFailure({
        code: outcome.code,
        stderr: outcome.stderr,
        eraseObserved: outcome.eraseObserved,
      }),
      `git ls-remote failed with code ${outcome.code}`,
      stripUserinfo(outcome.stderr),
    );
  }
  for (const line of outcome.stdout.split("\n")) {
    const tab = line.indexOf("\t");
    if (tab === -1) {
      continue;
    }
    const oid = line.slice(0, tab);
    const ref = line.slice(tab + 1);
    if (ref === input.ref) {
      return oid;
    }
  }
  return null;
}
