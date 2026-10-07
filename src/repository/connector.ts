import { simpleGit, type SimpleGitOptions } from "simple-git";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { throwIfCancelled, type Context } from "../kernel/context.ts";
import { Diagnostic } from "../kernel/errors.ts";
import { CheckEndState, ExpectedEndState, type CheckFold } from "./github.ts";
import { parseSshIdentity, type SshIdentity } from "./ssh-identity.ts";

const GIT_FAILED = "repository.connector.git_failed";
const SSH_RESOLVE_FAILED = "repository.connector.ssh_resolve_failed";
const EMPTY_STRING = "";
const EXPIRED = 0;
const execFileAsync = promisify(execFile);
const FRESH_CLONE_PREFIX = "kanthord-git-";
const FRESH_CLONE_MODE = 0o700;
const PERMISSION_BITS = 0o777;
const COMMIT_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const EXIT_SUCCESS = 0;
const EXIT_NOT_ANCESTOR = 1;
const NO_EXIT = -1;
const MERGE_IDENTITY = {
  GIT_AUTHOR_NAME: "kanthord",
  GIT_AUTHOR_EMAIL: "kanthord@localhost",
  GIT_COMMITTER_NAME: "kanthord",
  GIT_COMMITTER_EMAIL: "kanthord@localhost",
} as const;

export const GitStage = {
  BeforePush: "before_push",
  Push: "push",
} as const;
export type GitStage = (typeof GitStage)[keyof typeof GitStage];

export class GitWriteError extends Diagnostic {
  readonly stage: GitStage;

  constructor(stage: GitStage, cause: Diagnostic) {
    super(cause.code, cause.message, { cause });
    assert.equal(cause.code, GIT_FAILED);
    assert.ok(Object.values(GitStage).includes(stage));
    this.stage = stage;
  }
}

export interface MergePushInput {
  address: string;
  base_branch: string;
  commit: string;
}

export interface BranchCommitInput {
  address: string;
  branch: string;
  commit: string;
}

export interface Landing {
  landed: boolean;
  first_parent: string | null;
}

interface GitOptions {
  environment?: NodeJS.ProcessEnv;
  errors?: SimpleGitOptions["errors"];
}

async function runGit(
  directory: string | undefined,
  args: string[],
  context: Context,
  deadlineMs: number,
  operation: string,
  options: GitOptions = {},
): Promise<string> {
  assert.ok(args.length);
  assert.ok(operation);
  const controller = new AbortController();
  const unsubscribe = context.onCancel(() => controller.abort());
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(EXPIRED, deadlineMs),
  );
  try {
    throwIfCancelled(context);
    if (deadlineMs <= EXPIRED) throw new Error("Git deadline exceeded");
    const git = simpleGit({
      ...(directory === undefined ? {} : { baseDir: directory }),
      ...(options.errors === undefined ? {} : { errors: options.errors }),
      abort: controller.signal,
      timeout: { block: deadlineMs },
    });
    const configured =
      options.environment === undefined ? git : git.env(options.environment);
    const output = await configured.raw(args);
    if (controller.signal.aborted) throw new Error("Git aborted");
    return output;
  } catch {
    throw new Diagnostic(GIT_FAILED, `${operation}: git failed.`);
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

export async function resolveSshHostname(
  host: string,
  context: Context,
  deadlineMs: number,
): Promise<string> {
  return (await resolveSshIdentity(host, context, deadlineMs)).hostname;
}

export async function resolveSshIdentity(
  host: string,
  context: Context,
  deadlineMs: number,
): Promise<SshIdentity> {
  assert.ok(host !== EMPTY_STRING);
  assert.ok(!host.startsWith("-"));
  const controller = new AbortController();
  const unsubscribe = context.onCancel(() => controller.abort());
  const timer = setTimeout(
    () => controller.abort(),
    Math.max(EXPIRED, deadlineMs),
  );
  try {
    throwIfCancelled(context);
    if (deadlineMs <= EXPIRED) throw new Error("SSH deadline exceeded");
    const { stdout } = await execFileAsync("ssh", ["-G", "--", host], {
      signal: controller.signal,
    });
    return parseSshIdentity(stdout);
  } catch {
    throw new Diagnostic(SSH_RESOLVE_FAILED, "ssh -G: resolution failed.");
  } finally {
    clearTimeout(timer);
    unsubscribe();
  }
}

export async function gitLsRemote(
  sshUrl: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  await runGit(
    undefined,
    ["ls-remote", sshUrl],
    context,
    deadlineMs,
    "ls-remote",
  );
}

export async function clone(
  address: string,
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  assert.ok(address);
  assert.ok(directory);
  await runGit(
    directory,
    ["clone", "--no-checkout", "--", address, "."],
    context,
    deadlineMs,
    "clone",
  );
}

export async function fetchAndCheckout(
  directory: string,
  branch: string,
  baseBranch: string,
  context: Context,
  deadlineMs: number,
): Promise<string> {
  assert.ok(branch);
  assert.ok(baseBranch);
  const end = performance.now() + deadlineMs;
  const run = (args: string[]) =>
    runGit(
      directory,
      args,
      context,
      end - performance.now(),
      "fetch and checkout",
    );
  await run(["check-ref-format", "--branch", branch]);
  await run(["check-ref-format", "--branch", baseBranch]);
  await run(["fetch", "--prune", "origin"]);
  const ref = `refs/remotes/origin/${branch}`;
  const found = (
    await run(["for-each-ref", "--format=%(refname)", ref])
  ).trim();
  const target = found.split("\n").includes(ref) ? branch : baseBranch;
  await run(["checkout", "--force", "-B", branch, `origin/${target}`, "--"]);
  await run(["clean", "-ffd"]);
  return (await run(["rev-parse", "HEAD"])).trim();
}

export async function pushNodeBranch(
  directory: string,
  branch: string,
  context: Context,
  deadlineMs: number,
): Promise<void> {
  assert.match(branch, /^kanthord\/node_[0-7][0-9A-HJKMNP-TV-Z]{25}$/);
  assert.ok(directory !== EMPTY_STRING);
  await runGit(
    directory,
    ["push", "origin", `refs/heads/${branch}:refs/heads/${branch}`],
    context,
    deadlineMs,
    "push node branch",
  );
}

export async function cloneSnapshot(
  address: string,
  revision: string,
  directory: string,
  context: Context,
  deadlineMs: number,
): Promise<string> {
  assert.ok(revision);
  assert.ok(!revision.startsWith("-"));
  const end = performance.now() + deadlineMs;
  await clone(address, directory, context, deadlineMs);
  await runGit(
    directory,
    ["checkout", "--detach", revision, "--"],
    context,
    end - performance.now(),
    "clone snapshot",
  );
  return (
    await runGit(
      directory,
      ["rev-parse", "HEAD"],
      context,
      end - performance.now(),
      "clone snapshot",
    )
  ).trim();
}

async function runGitExit(
  directory: string,
  args: string[],
  context: Context,
  deadlineMs: number,
  operation: string,
  accepted: readonly number[],
  environment?: NodeJS.ProcessEnv,
): Promise<{ exitCode: number; output: string }> {
  assert.ok(accepted.includes(EXIT_SUCCESS));
  assert.ok(directory !== EMPTY_STRING);
  const observed = { exitCode: NO_EXIT };
  const errors: SimpleGitOptions["errors"] = (error, result) => {
    observed.exitCode = result.exitCode;
    if (result.exitCode === EXIT_SUCCESS) return error;
    if (accepted.includes(result.exitCode)) return undefined;
    return error ?? new Error(`git exited with ${result.exitCode}`);
  };
  const output = await runGit(directory, args, context, deadlineMs, operation, {
    errors,
    ...(environment === undefined ? {} : { environment }),
  });
  assert.ok(accepted.includes(observed.exitCode));
  return { exitCode: observed.exitCode, output };
}

function remainingMs(deadlineAt: number): number {
  assert.ok(Number.isFinite(deadlineAt));
  return deadlineAt - Date.now();
}

async function inFreshDirectory<T>(
  work: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await mkdtemp(join(tmpdir(), FRESH_CLONE_PREFIX));
  try {
    assert.equal(
      (await stat(directory)).mode & PERMISSION_BITS,
      FRESH_CLONE_MODE,
    );
    return await work(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function atStage<T>(stage: GitStage, work: () => Promise<T>): Promise<T> {
  assert.ok(Object.values(GitStage).includes(stage));
  try {
    return await work();
  } catch (error) {
    if (error instanceof Diagnostic && error.code === GIT_FAILED)
      throw new GitWriteError(stage, error);
    throw error;
  }
}

function gitIn(
  directory: string,
  context: Context,
  deadlineAt: number,
  operation: string,
): (args: string[], environment?: NodeJS.ProcessEnv) => Promise<string> {
  assert.ok(directory !== EMPTY_STRING);
  assert.ok(operation !== EMPTY_STRING);
  return async (args, environment) =>
    (
      await runGitExit(
        directory,
        args,
        context,
        remainingMs(deadlineAt),
        operation,
        [EXIT_SUCCESS],
        environment,
      )
    ).output;
}

export async function mergePushFresh(
  input: MergePushInput,
  context: Context,
  deadlineAt: number,
): Promise<{ commit: string }> {
  assert.match(input.commit, COMMIT_PATTERN);
  assert.ok(!input.base_branch.startsWith("-"));
  return inFreshDirectory(async (directory) => {
    const git = gitIn(directory, context, deadlineAt, "merge push");
    await atStage(GitStage.BeforePush, async () => {
      await clone(input.address, directory, context, remainingMs(deadlineAt));
      await git(["check-ref-format", "--branch", input.base_branch]);
      await git(["fetch", "origin", input.commit]);
      await git([
        "checkout",
        "--force",
        "-B",
        input.base_branch,
        `origin/${input.base_branch}`,
        "--",
      ]);
      await git(["merge", "--no-ff", "--no-edit", input.commit], {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        ...MERGE_IDENTITY,
      });
    });
    return atStage(GitStage.Push, async () => {
      await git(["push", "origin", `HEAD:refs/heads/${input.base_branch}`]);
      return { commit: (await git(["rev-parse", "HEAD"])).trim() };
    });
  });
}

export async function pushSnapshotFresh(
  input: BranchCommitInput,
  context: Context,
  deadlineAt: number,
): Promise<void> {
  assert.match(input.commit, COMMIT_PATTERN);
  assert.ok(!input.branch.startsWith("-"));
  await inFreshDirectory(async (directory) => {
    const git = gitIn(directory, context, deadlineAt, "push snapshot");
    await atStage(GitStage.BeforePush, async () => {
      await clone(input.address, directory, context, remainingMs(deadlineAt));
      await git(["check-ref-format", "--branch", input.branch]);
      await git(["fetch", "origin", input.commit]);
    });
    await atStage(GitStage.Push, () =>
      git(["push", "origin", `${input.commit}:refs/heads/${input.branch}`]),
    );
  });
}

export async function landedOn(
  input: BranchCommitInput,
  context: Context,
  deadlineAt: number,
): Promise<Landing> {
  assert.match(input.commit, COMMIT_PATTERN);
  assert.ok(!input.branch.startsWith("-"));
  return inFreshDirectory(async (directory) => {
    const operation = "landed on";
    const git = gitIn(directory, context, deadlineAt, operation);
    await clone(input.address, directory, context, remainingMs(deadlineAt));
    await git(["check-ref-format", "--branch", input.branch]);
    const ref = `refs/remotes/origin/${input.branch}`;
    const { exitCode } = await runGitExit(
      directory,
      ["merge-base", "--is-ancestor", input.commit, ref],
      context,
      remainingMs(deadlineAt),
      operation,
      [EXIT_SUCCESS, EXIT_NOT_ANCESTOR],
    );
    if (exitCode === EXIT_NOT_ANCESTOR)
      return { landed: false, first_parent: null };
    return {
      landed: true,
      first_parent: await oldestFirstParent(git, input.commit, ref),
    };
  });
}

async function oldestFirstParent(
  git: (args: string[]) => Promise<string>,
  commit: string,
  ref: string,
): Promise<string> {
  assert.match(commit, COMMIT_PATTERN);
  assert.ok(ref.startsWith("refs/remotes/origin/"));
  const descendants = await git([
    "rev-list",
    "--first-parent",
    "--ancestry-path",
    "--reverse",
    `${commit}..${ref}`,
  ]);
  const oldest = descendants.split("\n")[0]?.trim() ?? EMPTY_STRING;
  if (oldest === EMPTY_STRING) return commit;
  const parent = (await git(["rev-parse", "--verify", `${oldest}^1`])).trim();
  return parent === commit ? commit : oldest;
}

export function foldBranchPush(
  landed: boolean,
  commit: string,
  expectedEndState: ExpectedEndState,
): CheckFold {
  assert.equal(expectedEndState, ExpectedEndState.BaseBranchPushed);
  assert.match(commit, COMMIT_PATTERN);
  if (!landed) return { end_state: CheckEndState.Other, landed_commits: [] };
  return { end_state: CheckEndState.Expected, landed_commits: [commit] };
}
