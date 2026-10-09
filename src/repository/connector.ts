import { simpleGit, type SimpleGit, type SimpleGitOptions } from "simple-git";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { throwIfCancelled, type Context } from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import {
  RepositoryFileState,
  SSH_RESOLVE_FAILED_STATUS,
  type RepositoryFile,
} from "./contract.ts";
import { CheckEndState, ExpectedEndState, type CheckFold } from "./github.ts";
import {
  parseSshIdentity,
  SshErrorCode,
  type SshIdentity,
} from "./ssh-identity.ts";

const GIT_FAILED = "repository.connector.git_failed";
const EMPTY_STRING = "";
const EXPIRED = 0;
const EMPTY_BYTES = 0;
const REPOSITORY_FILES_DIRECTORY_PREFIX = "kanthord-repository-files-";
const OBJECT_ID_PATTERN = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const LS_REMOTE_FIELD_SEPARATOR = "\t";
const LS_TREE_ENTRY_SEPARATOR = "\0";
const LS_TREE_NAME_SEPARATOR = "\t";
const LS_TREE_FIELD_SEPARATOR = " ";
const LS_TREE_MODE_FIELD = 0;
const LS_TREE_OBJECT_FIELD = 2;
const BATCH_LINE_END = "\n";
const BATCH_FIELD_SEPARATOR = " ";
const BATCH_OBJECT_FIELD = 0;
const BATCH_TYPE_FIELD = 1;
const BATCH_SIZE_FIELD = 2;
const BLOB_TYPE = "blob";
const BATCH_HEADER_BYTES_MAX = 128;
const GIT_MESSAGE_BYTES_MAX = 65536;
const NOT_FOUND_INDEX = -1;
const NEXT_INDEX = 1;
const REGULAR_FILE_MODES = ["100644", "100755"];
const UTF8_LABEL = "utf-8";
const SYMLINK_MODE = "120000";
const SYMLINK_HOPS_MAX = 40;
const TREE_ROUND_LAST = SYMLINK_HOPS_MAX + 1;
const SYMLINK_TARGET_BYTES_MAX = 4096;
const BATCH_ENTRY_BYTES_MAX =
  BATCH_HEADER_BYTES_MAX + SYMLINK_TARGET_BYTES_MAX + BATCH_LINE_END.length;
const REPOSITORY_ROOT = ".";
const PARENT_DIRECTORY = "..";
const COMMIT_FIELD = 0;
const REF_FIELD = 1;
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
  return runGitTask(
    directory,
    context,
    deadlineMs,
    operation,
    (git) => git.raw(args),
    options,
  );
}

async function runGitTask<T>(
  directory: string | undefined,
  context: Context,
  deadlineMs: number,
  operation: string,
  task: (git: SimpleGit, signal: AbortSignal) => Promise<T>,
  options: GitOptions = {},
): Promise<T> {
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
    const output = await task(
      options.environment === undefined ? git : git.env(options.environment),
      controller.signal,
    );
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
    throwIfCancelled(context);
    throw new OperationError(
      SSH_RESOLVE_FAILED_STATUS,
      SshErrorCode.ResolveFailed,
      "The SSH host does not resolve through ssh -G.",
      { host },
    );
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

function freshDirectory(): Promise<string> {
  return mkdtemp(join(tmpdir(), FRESH_CLONE_PREFIX));
}

async function freshWriteDirectory(): Promise<string> {
  try {
    return await freshDirectory();
  } catch (error) {
    throw new GitWriteError(
      GitStage.BeforePush,
      new Diagnostic(GIT_FAILED, "The fresh directory is not available.", {
        cause: error,
      }),
    );
  }
}

async function inFreshDirectory<T>(
  create: () => Promise<string>,
  work: (directory: string) => Promise<T>,
): Promise<T> {
  const directory = await create();
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
  return inFreshDirectory(freshWriteDirectory, async (directory) => {
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
  await inFreshDirectory(freshWriteDirectory, async (directory) => {
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
  return inFreshDirectory(freshDirectory, async (directory) => {
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

export async function resolveBranchCommit(
  address: string,
  branch: string,
  context: Context,
  deadlineMs: number,
): Promise<string | null> {
  assert.ok(address !== EMPTY_STRING);
  assert.ok(branch !== EMPTY_STRING);
  const ref = `refs/heads/${branch}`;
  const listing = await runGit(
    undefined,
    ["ls-remote", "--heads", "--", address, ref],
    context,
    deadlineMs,
    "resolve branch commit",
  );
  for (const line of listing.split("\n")) {
    const fields = line.split(LS_REMOTE_FIELD_SEPARATOR);
    if (fields[REF_FIELD] !== ref) continue;
    const commit = fields[COMMIT_FIELD]!;
    assert.match(commit, OBJECT_ID_PATTERN);
    return commit;
  }
  return null;
}

type GitRun = (args: string[]) => Promise<string>;
type GitBlobRun = (object: string) => Promise<Buffer>;
type GitInputRun = (
  args: string[],
  input: string,
  maxBytes: number,
) => Promise<Buffer>;
type TreeEntry = { mode: string; object: string };
type RepositoryTree = {
  entries: Map<string, TreeEntry>;
  listedPaths: Set<string>;
  listedDirectories: Set<string>;
  targets: Map<string, string | null>;
};

const LinkStepKind = {
  Answered: "answered",
  Regular: "regular",
  Unlisted: "unlisted",
  Unread: "unread",
} as const;
type LinkStepKind = (typeof LinkStepKind)[keyof typeof LinkStepKind];
type LinkStep =
  | { kind: typeof LinkStepKind.Answered; file: RepositoryFile }
  | {
      kind: Exclude<LinkStepKind, typeof LinkStepKind.Answered>;
      current: string;
    };

function addTreeEntries(tree: RepositoryTree, listing: string): void {
  for (const entry of listing.split(LS_TREE_ENTRY_SEPARATOR)) {
    const nameIndex = entry.indexOf(LS_TREE_NAME_SEPARATOR);
    if (nameIndex === NOT_FOUND_INDEX) continue;
    const fields = entry
      .slice(LS_TREE_MODE_FIELD, nameIndex)
      .split(LS_TREE_FIELD_SEPARATOR);
    assert.ok(fields[LS_TREE_MODE_FIELD] && fields[LS_TREE_OBJECT_FIELD]);
    tree.entries.set(entry.slice(nameIndex + NEXT_INDEX), {
      mode: fields[LS_TREE_MODE_FIELD],
      object: fields[LS_TREE_OBJECT_FIELD],
    });
  }
}

async function listPaths(
  run: GitRun,
  commit: string,
  tree: RepositoryTree,
  paths: readonly string[],
): Promise<void> {
  assert.ok(paths.length);
  addTreeEntries(
    tree,
    await run(["--literal-pathspecs", "ls-tree", "-z", commit, "--", ...paths]),
  );
  for (const path of paths)
    if (!paths.some((other) => other.startsWith(`${path}/`)))
      tree.listedPaths.add(path);
}

async function listDirectory(
  run: GitRun,
  commit: string,
  tree: RepositoryTree,
  directory: string,
): Promise<void> {
  assert.ok(directory !== EMPTY_STRING);
  assert.ok(!tree.listedDirectories.has(directory));
  const pathspec = directory === REPOSITORY_ROOT ? [] : ["--", `${directory}/`];
  addTreeEntries(
    tree,
    await run(["--literal-pathspecs", "ls-tree", "-z", commit, ...pathspec]),
  );
  tree.listedDirectories.add(directory);
}

function treeEntry(
  tree: RepositoryTree,
  path: string,
): TreeEntry | null | undefined {
  assert.ok(path !== EMPTY_STRING);
  const entry = tree.entries.get(path);
  if (entry !== undefined) return entry;
  if (
    tree.listedPaths.has(path) ||
    tree.listedDirectories.has(posix.dirname(path))
  )
    return null;
  return undefined;
}

function batchSizes(output: Buffer): Map<string, number> {
  const sizes = new Map<string, number>();
  for (const line of output.toString(UTF8_LABEL).split(BATCH_LINE_END)) {
    if (line === EMPTY_STRING) continue;
    const fields = line.split(BATCH_FIELD_SEPARATOR);
    assert.equal(fields[BATCH_TYPE_FIELD], BLOB_TYPE);
    const size = Number(fields[BATCH_SIZE_FIELD]);
    assert.ok(Number.isSafeInteger(size));
    sizes.set(fields[BATCH_OBJECT_FIELD]!, size);
  }
  return sizes;
}

function batchContents(output: Buffer): Map<string, string> {
  const contents = new Map<string, string>();
  let offset = EMPTY_BYTES;
  while (offset < output.length) {
    const headerEnd = output.indexOf(BATCH_LINE_END, offset);
    assert.notEqual(headerEnd, NOT_FOUND_INDEX);
    const fields = output
      .toString(UTF8_LABEL, offset, headerEnd)
      .split(BATCH_FIELD_SEPARATOR);
    assert.equal(fields[BATCH_TYPE_FIELD], BLOB_TYPE);
    const start = headerEnd + NEXT_INDEX;
    const end = start + Number(fields[BATCH_SIZE_FIELD]);
    assert.ok(Number.isSafeInteger(end) && end <= output.length);
    contents.set(
      fields[BATCH_OBJECT_FIELD]!,
      output.toString(UTF8_LABEL, start, end),
    );
    offset = end + NEXT_INDEX;
  }
  return contents;
}

function batchInput(objects: readonly string[]): string {
  return objects.map((object) => object + BATCH_LINE_END).join(EMPTY_STRING);
}

async function readSymlinkTargets(
  runInput: GitInputRun,
  tree: RepositoryTree,
  objects: readonly string[],
): Promise<void> {
  assert.ok(objects.length);
  assert.ok(objects.every((object) => !tree.targets.has(object)));
  await runInput(
    [
      "fetch",
      "--quiet",
      "--no-tags",
      "--no-write-fetch-head",
      "--stdin",
      "origin",
    ],
    batchInput(objects),
    GIT_MESSAGE_BYTES_MAX,
  );
  const sizes = batchSizes(
    await runInput(
      ["cat-file", "--batch-check"],
      batchInput(objects),
      objects.length * BATCH_HEADER_BYTES_MAX,
    ),
  );
  const bounded = objects.filter(
    (object) => sizes.get(object)! <= SYMLINK_TARGET_BYTES_MAX,
  );
  for (const object of objects)
    if (sizes.get(object)! > SYMLINK_TARGET_BYTES_MAX)
      tree.targets.set(object, null);
  if (!bounded.length) return;
  const contents = batchContents(
    await runInput(
      ["cat-file", "--batch"],
      batchInput(bounded),
      bounded.length * BATCH_ENTRY_BYTES_MAX,
    ),
  );
  for (const object of bounded) tree.targets.set(object, contents.get(object)!);
}

function repositoryFile(
  path: string,
  state: RepositoryFileState,
  text: string | null = null,
): RepositoryFile {
  return { path, state, text };
}

async function regularRepositoryFile(
  run: GitRun,
  readBlob: GitBlobRun,
  object: string,
  path: string,
  maxBytes: number,
): Promise<RepositoryFile> {
  const size = Number((await run(["cat-file", "-s", object])).trim());
  assert.ok(Number.isSafeInteger(size));
  if (size > maxBytes)
    return repositoryFile(path, RepositoryFileState.TooLarge);
  try {
    return repositoryFile(
      path,
      RepositoryFileState.Present,
      new TextDecoder(UTF8_LABEL, { fatal: true }).decode(
        await readBlob(object),
      ),
    );
  } catch (error) {
    if (error instanceof TypeError)
      return repositoryFile(path, RepositoryFileState.NotUtf8);
    throw error;
  }
}

function answered(path: string, state: RepositoryFileState): LinkStep {
  return { kind: LinkStepKind.Answered, file: repositoryFile(path, state) };
}

function followLinks(tree: RepositoryTree, path: string): LinkStep {
  assert.ok(path !== EMPTY_STRING);
  let current = path;
  const visited = new Set<string>();
  for (let hops = 0; hops <= SYMLINK_HOPS_MAX; hops++) {
    if (visited.has(current))
      return answered(path, RepositoryFileState.Unreadable);
    visited.add(current);
    const entry = treeEntry(tree, current);
    if (entry === undefined) return { kind: LinkStepKind.Unlisted, current };
    if (entry === null) return answered(path, RepositoryFileState.Absent);
    if (REGULAR_FILE_MODES.includes(entry.mode))
      return { kind: LinkStepKind.Regular, current };
    if (entry.mode !== SYMLINK_MODE)
      return answered(path, RepositoryFileState.NotRegularFile);
    const target = tree.targets.get(entry.object);
    if (target === undefined) return { kind: LinkStepKind.Unread, current };
    if (target === null) return answered(path, RepositoryFileState.Unreadable);
    const resolved = posix.normalize(
      posix.join(posix.dirname(current), target),
    );
    if (
      posix.isAbsolute(target) ||
      resolved === PARENT_DIRECTORY ||
      resolved.startsWith(`${PARENT_DIRECTORY}/`)
    )
      return answered(path, RepositoryFileState.OutsideRoot);
    if (resolved === REPOSITORY_ROOT)
      return answered(path, RepositoryFileState.NotRegularFile);
    current = resolved;
  }
  return answered(path, RepositoryFileState.Unreadable);
}

function unreadSymlinks(tree: RepositoryTree, current: string): string[] {
  const entry = tree.entries.get(current);
  assert.ok(entry?.mode === SYMLINK_MODE);
  assert.ok(!tree.targets.has(entry.object));
  const directory = posix.dirname(current);
  if (!tree.listedDirectories.has(directory)) return [entry.object];
  const objects: string[] = [];
  for (const [path, { mode, object }] of tree.entries)
    if (
      mode === SYMLINK_MODE &&
      posix.dirname(path) === directory &&
      !tree.targets.has(object)
    )
      objects.push(object);
  return objects;
}

function blockedSteps(
  tree: RepositoryTree,
  paths: readonly string[],
  kind: typeof LinkStepKind.Unlisted | typeof LinkStepKind.Unread,
): Set<string> {
  assert.ok(paths.length);
  const currents = new Set<string>();
  for (const path of paths) {
    const step = followLinks(tree, path);
    if (step.kind === kind) currents.add(step.current);
  }
  assert.ok(currents.size <= paths.length);
  return currents;
}

async function completeRepositoryTree(
  run: GitRun,
  runInput: GitInputRun,
  commit: string,
  tree: RepositoryTree,
  paths: readonly string[],
): Promise<void> {
  assert.ok(paths.length);
  for (let round = 0; round <= TREE_ROUND_LAST; round++) {
    const directories = new Set<string>();
    for (const current of blockedSteps(tree, paths, LinkStepKind.Unlisted))
      directories.add(posix.dirname(current));
    for (const directory of directories)
      await listDirectory(run, commit, tree, directory);
    const objects = new Set<string>();
    for (const current of blockedSteps(tree, paths, LinkStepKind.Unread))
      for (const object of unreadSymlinks(tree, current)) objects.add(object);
    if (objects.size) await readSymlinkTargets(runInput, tree, [...objects]);
    if (!directories.size && !objects.size) return;
  }
  assert.fail("The symlink resolution exceeded its round bound.");
}

async function resolveRepositoryFiles(
  run: GitRun,
  runInput: GitInputRun,
  readBlob: GitBlobRun,
  commit: string,
  paths: readonly string[],
  maxBytes: number,
): Promise<RepositoryFile[]> {
  const tree: RepositoryTree = {
    entries: new Map(),
    listedPaths: new Set(),
    listedDirectories: new Set(),
    targets: new Map(),
  };
  await listPaths(run, commit, tree, paths);
  await completeRepositoryTree(run, runInput, commit, tree, paths);
  const files: RepositoryFile[] = [];
  for (const path of paths) {
    const step = followLinks(tree, path);
    if (step.kind === LinkStepKind.Answered) {
      files.push(step.file);
      continue;
    }
    assert.equal(step.kind, LinkStepKind.Regular);
    files.push(
      await regularRepositoryFile(
        run,
        readBlob,
        `${commit}:${step.current}`,
        path,
        maxBytes,
      ),
    );
  }
  assert.equal(files.length, paths.length);
  return files;
}

export async function readFilesAtCommit(
  address: string,
  commit: string,
  paths: readonly string[],
  maxBytes: number,
  context: Context,
  deadlineMs: number,
  parent: string = tmpdir(),
): Promise<RepositoryFile[]> {
  assert.ok(address !== EMPTY_STRING);
  assert.match(commit, OBJECT_ID_PATTERN);
  assert.ok(paths.length);
  assert.ok(Number.isSafeInteger(maxBytes) && maxBytes > EMPTY_BYTES);
  const end = performance.now() + deadlineMs;
  const directory = await mkdtemp(
    join(parent, REPOSITORY_FILES_DIRECTORY_PREFIX),
  );
  const run: GitRun = (args) =>
    runGit(
      directory,
      args,
      context,
      end - performance.now(),
      "read repository files",
    );
  const readBlob: GitBlobRun = (object) =>
    runGitTask(
      directory,
      context,
      end - performance.now(),
      "read repository files",
      async (git) => Buffer.from(await git.binaryCatFile(["blob", object])),
    );
  const runInput: GitInputRun = (args, input, maxBytes) =>
    runGitTask(
      directory,
      context,
      end - performance.now(),
      "read repository files",
      async (_git, signal) => {
        const child = execFileAsync("git", args, {
          cwd: directory,
          signal,
          encoding: "buffer",
          maxBuffer: maxBytes,
        });
        const [, { stdout }] = await Promise.all([
          pipeline(Readable.from([input]), child.child.stdin!),
          child,
        ]);
        return stdout;
      },
    );
  try {
    await run(["init", "--quiet"]);
    await run(["remote", "add", "origin", "--", address]);
    await run([
      "fetch",
      "--depth=1",
      "--filter=blob:none",
      "--no-tags",
      "origin",
      commit,
    ]);
    return await resolveRepositoryFiles(
      run,
      runInput,
      readBlob,
      commit,
      paths,
      maxBytes,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
