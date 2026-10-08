import { simpleGit, type SimpleGit } from "simple-git";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { promisify } from "node:util";
import { throwIfCancelled, type Context } from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import {
  RepositoryFileState,
  SSH_RESOLVE_FAILED_STATUS,
  type RepositoryFile,
} from "./contract.ts";
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
const LS_TREE_MODE_FIELD = 0;
const NOT_FOUND_INDEX = -1;
const NEXT_INDEX = 1;
const REGULAR_FILE_MODES = ["100644", "100755"];
const UTF8_LABEL = "utf-8";
const SYMLINK_MODE = "120000";
const SYMLINK_HOPS_MAX = 40;
const REPOSITORY_ROOT = ".";
const PARENT_DIRECTORY = "..";
const COMMIT_FIELD = 0;
const REF_FIELD = 1;
const execFileAsync = promisify(execFile);

async function runGit(
  directory: string | undefined,
  args: string[],
  context: Context,
  deadlineMs: number,
  operation: string,
): Promise<string> {
  assert.ok(args.length);
  return runGitTask(directory, context, deadlineMs, operation, (git) =>
    git.raw(args),
  );
}

async function runGitTask<T>(
  directory: string | undefined,
  context: Context,
  deadlineMs: number,
  operation: string,
  task: (git: SimpleGit) => Promise<T>,
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
    return await task(
      simpleGit({
        ...(directory === undefined ? {} : { baseDir: directory }),
        abort: controller.signal,
        timeout: { block: deadlineMs },
      }),
    );
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

async function treeMode(
  run: GitRun,
  commit: string,
  path: string,
): Promise<string | null> {
  const listing = await run(["ls-tree", "-z", commit, "--", path]);
  for (const entry of listing.split(LS_TREE_ENTRY_SEPARATOR)) {
    const nameIndex = entry.indexOf(LS_TREE_NAME_SEPARATOR);
    if (nameIndex === NOT_FOUND_INDEX) continue;
    if (entry.slice(nameIndex + NEXT_INDEX) === path)
      return entry.slice(LS_TREE_MODE_FIELD, entry.indexOf(" "));
  }
  return null;
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

async function resolveRepositoryFile(
  run: GitRun,
  readBlob: GitBlobRun,
  commit: string,
  path: string,
  maxBytes: number,
): Promise<RepositoryFile> {
  let current = path;
  for (let hops = 0; hops <= SYMLINK_HOPS_MAX; hops++) {
    const mode = await treeMode(run, commit, current);
    if (mode === null) return repositoryFile(path, RepositoryFileState.Absent);
    const object = `${commit}:${current}`;
    if (REGULAR_FILE_MODES.includes(mode))
      return regularRepositoryFile(run, readBlob, object, path, maxBytes);
    if (mode !== SYMLINK_MODE)
      return repositoryFile(path, RepositoryFileState.NotRegularFile);
    const target = await run(["show", object]);
    const resolved = posix.normalize(
      posix.join(posix.dirname(current), target),
    );
    if (
      posix.isAbsolute(target) ||
      resolved === PARENT_DIRECTORY ||
      resolved.startsWith(`${PARENT_DIRECTORY}/`)
    )
      return repositoryFile(path, RepositoryFileState.OutsideRoot);
    if (resolved === REPOSITORY_ROOT)
      return repositoryFile(path, RepositoryFileState.NotRegularFile);
    current = resolved;
  }
  return repositoryFile(path, RepositoryFileState.Unreadable);
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
    const files: RepositoryFile[] = [];
    for (const path of paths)
      files.push(
        await resolveRepositoryFile(run, readBlob, commit, path, maxBytes),
      );
    return files;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
