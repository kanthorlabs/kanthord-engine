import { realpathSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
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
const GIT_STATUS_SUCCESS = 0;
const EMPTY_OUTPUT = "";

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

function checkGitWorktree(
  roots: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): StartRefusal | null {
  for (const root of roots) {
    let realRoot: string;
    try {
      realRoot = realpathSync(root);
    } catch {
      return refusal(SP.GitWorktree, REASON_GIT_WORKTREE);
    }
    const result = spawnSync(
      "git",
      ["-C", root, "rev-parse", "--show-toplevel"],
      { env, timeout: timeoutMs, encoding: "utf8" },
    );
    if (result.status !== GIT_STATUS_SUCCESS || result.error !== undefined) {
      return refusal(SP.GitWorktree, REASON_GIT_WORKTREE);
    }
    if ((result.stdout as string).trim() !== realRoot) {
      return refusal(SP.GitWorktree, REASON_GIT_WORKTREE);
    }
  }
  return null;
}

function checkGitClean(
  roots: readonly string[],
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
): StartRefusal | null {
  for (const root of roots) {
    const result = spawnSync(
      "git",
      [
        "-C",
        root,
        "--no-optional-locks",
        "status",
        "--porcelain=v1",
        "--untracked-files=normal",
      ],
      { env, timeout: timeoutMs, encoding: "utf8" },
    );
    if (result.status !== GIT_STATUS_SUCCESS || result.error !== undefined) {
      return refusal(SP.GitClean, REASON_GIT_CLEAN);
    }
    if ((result.stdout as string).trim() !== EMPTY_OUTPUT) {
      return refusal(SP.GitClean, REASON_GIT_CLEAN);
    }
  }
  return null;
}

export function checkPreconditions(
  input: PreconditionInput,
): StartRefusal | null {
  const timeoutMs = input.timeoutMs ?? RUNTIME_SETUP_DEADLINE_MS;
  const env = gitEnv(input.inputEnv);
  for (const precondition of input.preconditions) {
    let failure: StartRefusal | null = null;
    if (precondition === SP.WorkspaceDirectory) {
      failure = checkWorkspaceDirectory(input.cwd, input.roots);
    } else if (precondition === SP.GitWorktree) {
      failure = checkGitWorktree(input.roots, env, timeoutMs);
    } else if (precondition === SP.GitClean) {
      failure = checkGitClean(input.roots, env, timeoutMs);
    }
    if (failure !== null) return failure;
  }
  return null;
}
