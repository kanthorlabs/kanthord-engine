import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";

import type { E2eEnv } from "./env.ts";
import {
  GitError,
  type GitCredential,
  type GitPaths,
} from "../../src/services/git/index.ts";
import { runAuthenticated } from "../../src/services/git/authenticated.ts";
import { classifyFailure } from "../../src/services/git/credential.ts";
import { stripUserinfo } from "../../src/services/git/redact.ts";
import { createGitRunner, type GitRunner } from "../../src/services/git/run.ts";

export const E2E_REF_PREFIX = "refs/heads/kanthord-e2e/007";

export class E2eSafetyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "E2eSafetyError";
  }
}

export function httpsUrl(env: E2eEnv): string {
  return `https://github.com/${env.ghRepo}.git`;
}

export function scratchRef(env: E2eEnv, scenario: string): string {
  return `${E2E_REF_PREFIX}/${scenario}-${env.runId}`;
}

export function assertScratchRef(env: E2eEnv, ref: string): void {
  if (!ref.startsWith(`${E2E_REF_PREFIX}/`)) {
    throw new E2eSafetyError(`${ref} is outside the ${E2E_REF_PREFIX} prefix`);
  }
  if (ref === `refs/heads/${env.ghBaseBranch}`) {
    throw new E2eSafetyError(`${ref} is the read-only base branch`);
  }
}

function httpBasic(env: E2eEnv, token: string): GitCredential {
  return {
    transport: "http-basic",
    forge: "github",
    username: "x-access-token",
    token,
  };
}

export function writerCredential(env: E2eEnv): GitCredential {
  return httpBasic(env, env.ghToken);
}

export function wrongCredential(env: E2eEnv): GitCredential {
  return httpBasic(env, `github_pat_${"0".repeat(22)}`);
}

export function emptyTokenCredential(env: E2eEnv): GitCredential {
  return httpBasic(env, "");
}

export async function listRemoteRefs(
  paths: GitPaths,
  env: E2eEnv,
  pattern: string,
  credential?: GitCredential,
): Promise<Readonly<Record<string, string>>> {
  const outcome = await runAuthenticated(createGitRunner(paths), paths, {
    credential: credential ?? writerCredential(env),
    args: ["ls-remote", httpsUrl(env), pattern],
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
  const refs: Record<string, string> = {};
  for (const line of outcome.stdout.split("\n")) {
    const tabIndex = line.indexOf("\t");
    if (tabIndex === -1) {
      continue;
    }
    const oid = line.slice(0, tabIndex);
    const ref = line.slice(tabIndex + 1);
    if (oid !== "" && ref !== "") {
      refs[ref] = oid;
    }
  }
  return refs;
}

async function runChecked(
  runner: GitRunner,
  paths: GitPaths,
  credential: GitCredential,
  args: readonly string[],
  cwd?: string,
): Promise<void> {
  const outcome = await runAuthenticated(runner, paths, {
    credential,
    args,
    cwd,
  });
  if (outcome.code !== 0) {
    throw new GitError(
      classifyFailure({
        code: outcome.code,
        stderr: outcome.stderr,
        eraseObserved: outcome.eraseObserved,
      }),
      `git ${args[0]} failed with code ${outcome.code}`,
      stripUserinfo(outcome.stderr),
    );
  }
}

async function withScratchBareRepo<T>(
  paths: GitPaths,
  credential: GitCredential,
  run: (runner: GitRunner, scratchDir: string) => Promise<T>,
): Promise<T> {
  const runner = createGitRunner(paths);
  const scratchDir = await mkdtemp(join(paths.runDirectory, "push-scratch-"));
  try {
    await runChecked(runner, paths, credential, ["init", "--bare", scratchDir]);
    return await run(runner, scratchDir);
  } finally {
    await rm(scratchDir, { recursive: true, force: true });
  }
}

export async function pushScratchRef(
  paths: GitPaths,
  env: E2eEnv,
  input: Readonly<{ ref: string; oid: string; credential?: GitCredential }>,
): Promise<void> {
  assertScratchRef(env, input.ref);
  const credential = input.credential ?? writerCredential(env);
  await withScratchBareRepo(paths, credential, async (runner, scratchDir) => {
    await runChecked(
      runner,
      paths,
      credential,
      ["fetch", "--", httpsUrl(env), `refs/heads/${env.ghBaseBranch}`],
      scratchDir,
    );
    await runChecked(
      runner,
      paths,
      credential,
      ["push", "--", httpsUrl(env), `${input.oid}:${input.ref}`],
      scratchDir,
    );
  });
}

export async function deleteScratchRefs(
  paths: GitPaths,
  env: E2eEnv,
): Promise<readonly string[]> {
  const refs = await listRemoteRefs(paths, env, `${E2E_REF_PREFIX}/*`);
  const candidates = Object.keys(refs).filter((ref) =>
    ref.endsWith(`-${env.runId}`),
  );
  if (candidates.length === 0) {
    return [];
  }
  const credential = writerCredential(env);
  await withScratchBareRepo(paths, credential, async (runner, scratchDir) => {
    await runChecked(
      runner,
      paths,
      credential,
      ["push", "--", httpsUrl(env), ...candidates.map((ref) => `:${ref}`)],
      scratchDir,
    );
  });
  return candidates;
}
