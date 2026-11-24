import { execFile } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { promisify } from "node:util";
import { isolatedGitEnvironment } from "../kernel/git-environment.ts";
import { childEnvironment } from "./environment.ts";
import { RUNTIME_SETUP_DEADLINE_MS } from "./agent-session.ts";
import { StartPrecondition as SP, type StartPrecondition } from "./catalog.ts";

export interface StartRefusal {
  precondition: StartPrecondition;
  reason: string;
}

export interface PreconditionInput {
  preconditions: readonly StartPrecondition[];
  cwd: string;
  roots: readonly string[];
  inputEnv: Readonly<Record<string, string>>;
  timeoutMs?: number;
}

const REASON_WORKSPACE_DIRECTORY =
  "the working directory or a root is no directory";
const REASON_GIT_WORKTREE = "a root is not the top level of a git worktree";
const REASON_GIT_CLEAN = "a root holds an uncommitted change";
const EMPTY_OUTPUT = "";
const execFileAsync = promisify(execFile);

function refusal(precondition: StartPrecondition, text: string): StartRefusal {
  return { precondition, reason: `${precondition}: ${text}` };
}

function gitEnv(inputEnv: Readonly<Record<string, string>>): NodeJS.ProcessEnv {
  const PATH = inputEnv["PATH"] ?? process.env["PATH"];
  const base: NodeJS.ProcessEnv = { ...inputEnv };
  if (PATH !== undefined) base["PATH"] = PATH;
  return isolatedGitEnvironment(childEnvironment(base));
}

function checkWorkspaceDirectory(
  cwd: string,
  roots: readonly string[],
): StartRefusal | null {
  const paths = [cwd, ...roots];
  for (const p of paths) {
    try {
      if (!statSync(p).isDirectory()) {
        return refusal(SP.WorkspaceDirectory, REASON_WORKSPACE_DIRECTORY);
      }
    } catch {
      return refusal(SP.WorkspaceDirectory, REASON_WORKSPACE_DIRECTORY);
    }
  }
  return null;
}

async function gitOutput(
  args: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync("git", args, {
      env,
      timeout: timeoutMs,
      encoding: "utf8",
    });
    return stdout;
  } catch {
    return null;
  }
}

async function checkGitWorktree(
  roots: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<StartRefusal | null> {
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      return refusal(SP.GitWorktree, REASON_GIT_WORKTREE);
    }
    const output = await gitOutput(
      ["-C", root, "rev-parse", "--show-toplevel"],
      env,
      timeoutMs,
    );
    if (output?.trim() !== realRoot) {
      return refusal(SP.GitWorktree, REASON_GIT_WORKTREE);
    }
  }
  return null;
}

async function checkGitClean(
  roots: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): Promise<StartRefusal | null> {
  for (const root of roots) {
    const output = await gitOutput(
      [
        "-C",
        root,
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
      ],
      env,
      timeoutMs,
    );
    if (output?.trim() !== EMPTY_OUTPUT) {
      return refusal(SP.GitClean, REASON_GIT_CLEAN);
    }
  }
  return null;
}

export async function checkPreconditions(
  input: PreconditionInput,
): Promise<StartRefusal | null> {
  const timeoutMs = input.timeoutMs ?? RUNTIME_SETUP_DEADLINE_MS;
  const env = gitEnv(input.inputEnv);
  for (const precondition of input.preconditions) {
    let failure: StartRefusal | null = null;
    if (precondition === SP.WorkspaceDirectory) {
      failure = checkWorkspaceDirectory(input.cwd, input.roots);
    } else if (precondition === SP.GitWorktree) {
      failure = await checkGitWorktree(input.roots, env, timeoutMs);
    } else if (precondition === SP.GitClean) {
      failure = await checkGitClean(input.roots, env, timeoutMs);
    }
    if (failure !== null) return failure;
  }
  return null;
}
