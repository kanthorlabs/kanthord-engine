import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ulid } from "ulid";

import { E2eEnvError, loadE2eEnv, type E2eEnv } from "../env.ts";
import { deleteScratchRefs, httpsUrl, writerCredential } from "../remote.ts";
import { buildGitPaths, probeTools } from "../../../src/services/git/probe.ts";
import { remoteRefValue } from "../../../src/services/git/preflight.ts";
import {
  createGitRunner,
  type GitRunner,
} from "../../../src/services/git/run.ts";
import type { GitPaths } from "../../../src/services/git/index.ts";
import {
  scenarios,
  type ScenarioDeclaration,
  type ScenarioId,
} from "./index.ts";
import { renderReport, type ScenarioOutcome } from "./report.ts";

export type RunOutcome = Readonly<{
  runId: string;
  baseOidBefore: string;
  baseOidAfter: string;
  outcomes: readonly ScenarioOutcome[];
  leaked: readonly string[];
}>;

export function mintRunId(): string {
  return ulid();
}

const REPO_ROOT = resolve(import.meta.dirname, "../../..");

async function probePaths(): Promise<{ paths: GitPaths; homeDir: string }> {
  const homeDir = await mkdtemp(join(tmpdir(), "kanthord-e2e-gate-"));
  const probed = await probeTools({
    tools: {
      git: "/usr/bin/git",
      ssh: "/usr/bin/ssh",
      sshKeyscan: "/usr/bin/ssh-keyscan",
    },
    runDirectory: join(homeDir, "git", "run"),
  });
  return { paths: buildGitPaths({ probed, home: homeDir }), homeDir };
}

async function readBaseOid(
  runner: GitRunner,
  paths: GitPaths,
  env: E2eEnv,
  baseRef: string,
): Promise<string> {
  const oid = await remoteRefValue(runner, paths, {
    remoteUrl: httpsUrl(env),
    ref: baseRef,
    credential: writerCredential(env),
  });
  if (oid === null) {
    throw new Error(`the base branch ${baseRef} does not exist on the remote`);
  }
  return oid;
}

async function runScenario(
  declaration: ScenarioDeclaration,
  runId: string,
): Promise<ScenarioOutcome> {
  const file = resolve(import.meta.dirname, declaration.file);
  const child = spawn(process.execPath, ["--test", file], {
    env: { ...process.env, E2E_RUN_ID: runId },
    cwd: REPO_ROOT,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => {
    stdout += chunk.toString("utf8");
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr += chunk.toString("utf8");
  });
  const code = await new Promise<number>((resolveCode, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolveCode(exitCode ?? 1);
    });
  });
  if (code === 0) {
    return { id: declaration.id, passed: true, detail: "" };
  }
  const combined = `${stdout}\n${stderr}`.trim();
  const tail = combined.split("\n").slice(-3).join("\n");
  return {
    id: declaration.id,
    passed: false,
    detail: `exit ${code}${tail === "" ? "" : `: ${tail}`}`,
  };
}

function writeReport(runId: string, report: string): void {
  const directory = resolve(
    import.meta.dirname,
    "../../../.agent/e2e",
    `007-${runId}`,
  );
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, "report.md"), report);
}

export async function driveGate(
  input?: Readonly<{
    runId?: string;
    scenarios?: readonly ScenarioDeclaration[];
    env?: E2eEnv;
  }>,
): Promise<RunOutcome> {
  const runId = input?.runId ?? mintRunId();
  const env = input?.env ?? loadE2eEnv({ runId });
  const selected = input?.scenarios ?? scenarios;
  const { paths, homeDir } = await probePaths();
  const runner = createGitRunner(paths);
  const baseRef = `refs/heads/${env.ghBaseBranch}`;
  const baseOidBefore = await readBaseOid(runner, paths, env, baseRef);
  const outcomes: ScenarioOutcome[] = [];
  let leaked: readonly string[] = [];
  let baseOidAfter = baseOidBefore;
  let loopError: unknown;
  try {
    for (const declaration of selected) {
      outcomes[outcomes.length] = await runScenario(declaration, runId);
    }
  } catch (error) {
    loopError = error;
  } finally {
    leaked = await deleteScratchRefs(paths, env);
    baseOidAfter = await readBaseOid(runner, paths, env, baseRef);
    await rm(homeDir, { recursive: true, force: true });
  }
  const report = renderReport(env, outcomes, {
    baseOidBefore,
    baseOidAfter,
    leaked,
  });
  writeReport(runId, report);
  if (loopError !== undefined) {
    throw loopError;
  }
  const failed = outcomes.filter((outcome) => !outcome.passed);
  if (failed.length > 0) {
    throw new Error(
      `the gate failed ${failed.length} scenario(s): ${failed
        .map((outcome) => outcome.id)
        .join(", ")}`,
    );
  }
  if (leaked.length > 0) {
    throw new Error(
      `the gate leaked ${leaked.length} remote ref(s): ${leaked.join(", ")}`,
    );
  }
  if (baseOidBefore !== baseOidAfter) {
    throw new Error(
      `the base branch moved: ${baseOidBefore} -> ${baseOidAfter}`,
    );
  }
  return { runId, baseOidBefore, baseOidAfter, outcomes, leaked };
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMain) {
  try {
    await driveGate();
  } catch (error) {
    if (error instanceof E2eEnvError) {
      process.stderr.write(
        `${error.message}\nmissing: ${error.missing.join(", ")}\n`,
      );
    } else if (error instanceof Error) {
      process.stderr.write(`${error.message}\n`);
    } else {
      process.stderr.write(`${String(error)}\n`);
    }
    process.exitCode = 1;
  }
}
