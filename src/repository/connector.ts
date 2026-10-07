import { simpleGit } from "simple-git";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { throwIfCancelled, type Context } from "../kernel/context.ts";
import { Diagnostic, OperationError } from "../kernel/errors.ts";
import { SSH_RESOLVE_FAILED_STATUS } from "./contract.ts";
import {
  parseSshIdentity,
  SshErrorCode,
  type SshIdentity,
} from "./ssh-identity.ts";

const GIT_FAILED = "repository.connector.git_failed";
const EMPTY_STRING = "";
const EXPIRED = 0;
const execFileAsync = promisify(execFile);

async function runGit(
  directory: string | undefined,
  args: string[],
  context: Context,
  deadlineMs: number,
  operation: string,
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
    return await simpleGit({
      ...(directory === undefined ? {} : { baseDir: directory }),
      abort: controller.signal,
      timeout: { block: deadlineMs },
    }).raw(args);
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
