import { spawn } from "node:child_process";
import { closeSync, openSync, rmSync } from "node:fs";
import { join } from "node:path";
import { background, type Context } from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { ensureDirectory } from "../../kernel/files.ts";
import { killProcessGroup } from "../../kernel/process-group.ts";
import {
  ENVIRONMENT_DIRECTORY,
  ProofPhase,
  type CommandResult,
  type ProofInput,
} from "../../project/environment-state.ts";
import { COMMAND_LIMIT_MS } from "../../worker/unit/budget.ts";
import type { ContainerRuntime } from "../../worker/contract.ts";
import {
  CACHE_MOUNT,
  CONTAINER_UID,
  OWNER_LABEL,
  SLOT_HOME,
  SUCCESS_CODE,
  TMP_MOUNT,
  absentVolume,
  cacheVolumeArguments,
  cacheVolumeName,
  containerRemovalFailure,
  presentVolume,
  type RuntimeHost,
} from "./container-runtime.ts";

export const OUTPUT_TAIL_BYTES = 4096;
export const ENVIRONMENT_PROOF_FAILED = "worker.pool.environment_proof_failed";
const PROOF_COMMAND_TIMEOUT_MS = 60000;
const PREPARE_TIMEOUT_MS = 300000;
const RUN_DIRECTORY_PREFIX = "run-";
const CHECKOUT_DIRECTORY = "checkout";
const BUNDLE_FILE = "head.bundle";
const PROOF_NAME_PREFIX = "kanthord-proof-";
const CHECKOUT_PATH = `${SLOT_HOME}/${CHECKOUT_DIRECTORY}`;
const BASH = "bash";
const SHELL = "/bin/sh";
const TINI_PATH = "/usr/bin/tini";
const IDLE_COMMAND = ["sleep", "infinity"];
const FEED_SCRIPT = `cat > ${BUNDLE_FILE} && git clone --quiet ${BUNDLE_FILE} ${CHECKOUT_DIRECTORY} && rm ${BUNDLE_FILE}`;
const ABSENT_PROCESS = "ESRCH";
const FAILED_CODE = 1;
const SINGLE_CHUNK = 1;
const XDG_PREFIX = "XDG_";
const BUILD_VARIABLES = new Set([
  "PATH",
  "HOME",
  "TMPDIR",
  "CONTAINER_HOST",
  "CONTAINER_CONNECTION",
  "CONTAINER_SSHKEY",
  "DOCKER_HOST",
]);

export interface CommandOutput {
  code: number;
  timedOut: boolean;
  tail: string;
}

export interface ProofOptions {
  readonly host: RuntimeHost;
  readonly runtime: ContainerRuntime;
  readonly owner: string;
  readonly stateDirectory: string;
  exportRepository(
    bindingId: string,
    commit: string,
    directory: string,
    context: Context,
  ): Promise<void>;
  readonly commandLimitMs?: number;
  readonly environmentMemoryMb: number;
  readonly running?: Set<number>;
}

interface Command {
  readonly phase: ProofPhase;
  readonly command: string;
}

export function buildEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(environment).filter(
      ([name, value]) =>
        value !== undefined &&
        (BUILD_VARIABLES.has(name) || name.startsWith(XDG_PREFIX)),
    ),
  );
}

function tailOf(chunks: Buffer[]): string {
  return Buffer.concat(chunks).subarray(-OUTPUT_TAIL_BYTES).toString("utf8");
}

export function endGroup(leader: number): void {
  try {
    killProcessGroup(leader);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== ABSENT_PROCESS) throw error;
  }
}

export function runCommand(
  command: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv,
  timeoutMs: number,
  running: Set<number>,
  signal: AbortSignal,
  input: number | "ignore" = "ignore",
): Promise<CommandOutput> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const chunks: Buffer[] = [];
    let size = 0;
    let timedOut = false;
    const keep = (chunk: Buffer) => {
      chunks.push(chunk);
      size += chunk.length;
      while (size > OUTPUT_TAIL_BYTES && chunks.length > SINGLE_CHUNK)
        size -= chunks.shift()!.length;
    };
    const child = spawn(command, args, {
      env: environment,
      stdio: [input, "pipe", "pipe"],
      detached: true,
    });
    const leader = child.pid;
    if (leader !== undefined) running.add(leader);
    const abort = () => {
      if (leader !== undefined) endGroup(leader);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      keep(
        Buffer.from(`\nThe command passed its time limit of ${timeoutMs} ms.`),
      );
      abort();
    }, timeoutMs);
    const finish = (code: number) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (leader !== undefined) running.delete(leader);
      if (signal.aborted) reject(signal.reason);
      else resolve({ code, timedOut, tail: tailOf(chunks) });
    };
    signal.addEventListener("abort", abort, { once: true });
    child.stdout!.on("data", keep);
    child.stderr!.on("data", keep);
    child.once("error", (error) => {
      keep(Buffer.from(error.message));
      finish(FAILED_CODE);
    });
    child.once("close", (code) => {
      finish(code ?? FAILED_CODE);
    });
  });
}

function proofFailure(step: string, detail: string): Diagnostic {
  const message = detail.trim();
  return new Diagnostic(
    ENVIRONMENT_PROOF_FAILED,
    message
      ? `The environment proof failed at ${step}: ${message}`
      : `The environment proof failed at ${step}.`,
    {
      fields: [
        ["step", step],
        ["detail", detail],
      ],
    },
  );
}

function startArguments(
  name: string,
  tag: string,
  owner: string,
  memoryMb: number,
  cacheVolume: string,
): readonly string[] {
  return [
    "run",
    "--detach",
    "--pull=never",
    "--name",
    name,
    "--label",
    `${OWNER_LABEL}=${owner}`,
    "--memory",
    `${memoryMb}m`,
    "--user",
    `${CONTAINER_UID}:${CONTAINER_UID}`,
    "--no-healthcheck",
    "--cap-drop=ALL",
    "--security-opt=no-new-privileges",
    "--ulimit",
    "core=0",
    "--read-only",
    "--tmpfs",
    TMP_MOUNT,
    "--volume",
    `${name}:${SLOT_HOME}`,
    "--volume",
    `${cacheVolume}:${CACHE_MOUNT}`,
    "--workdir",
    SLOT_HOME,
    "--env",
    `HOME=${SLOT_HOME}`,
    "--env",
    "LANG=C.UTF-8",
    "--entrypoint",
    TINI_PATH,
    tag,
    "--",
    ...IDLE_COMMAND,
  ];
}

function commandsOf(input: ProofInput): Command[] {
  return [
    ...input.setup.map((command) => ({ phase: ProofPhase.Setup, command })),
    ...input.checks.map((command) => ({ phase: ProofPhase.Check, command })),
  ];
}

async function requireSuccess(
  options: ProofOptions,
  step: string,
  args: readonly string[],
): Promise<void> {
  const answer = await options.host.run(
    options.runtime,
    args,
    PROOF_COMMAND_TIMEOUT_MS,
  );
  if (answer.code !== SUCCESS_CODE)
    throw proofFailure(step, answer.stderr.slice(-OUTPUT_TAIL_BYTES));
}

async function ensureCacheVolume(options: ProofOptions, input: ProofInput) {
  const answer = await options.host.run(
    options.runtime,
    cacheVolumeArguments(
      options.owner,
      input.project_id,
      input.resource_identity,
    ),
    PROOF_COMMAND_TIMEOUT_MS,
  );
  if (!presentVolume(answer))
    throw proofFailure("cache volume", answer.stderr.slice(-OUTPUT_TAIL_BYTES));
}

async function feedBundle(
  options: ProofOptions,
  name: string,
  directory: string,
  signal: AbortSignal,
): Promise<void> {
  const environment = buildEnvironment(options.host.environment);
  const running = options.running ?? new Set<number>();
  const bundle = join(directory, BUNDLE_FILE);
  const created = await runCommand(
    "git",
    [
      "-C",
      join(directory, CHECKOUT_DIRECTORY),
      "bundle",
      "create",
      "--quiet",
      bundle,
      "HEAD",
    ],
    environment,
    PREPARE_TIMEOUT_MS,
    running,
    signal,
  );
  if (created.code !== SUCCESS_CODE) throw proofFailure("bundle", created.tail);
  const descriptor = openSync(bundle, "r");
  try {
    const fed = await runCommand(
      options.runtime,
      ["exec", "-i", "-w", SLOT_HOME, name, SHELL, "-c", FEED_SCRIPT],
      environment,
      PREPARE_TIMEOUT_MS,
      running,
      signal,
      descriptor,
    );
    if (fed.code !== SUCCESS_CODE) throw proofFailure("clone", fed.tail);
  } finally {
    closeSync(descriptor);
  }
}

async function runCommands(
  options: ProofOptions,
  name: string,
  input: ProofInput,
  signal: AbortSignal,
): Promise<CommandResult[]> {
  const environment = buildEnvironment(options.host.environment);
  const running = options.running ?? new Set<number>();
  const results: CommandResult[] = [];
  for (const { phase, command } of commandsOf(input)) {
    const output = await runCommand(
      options.runtime,
      ["exec", "-w", CHECKOUT_PATH, name, BASH, "-c", command],
      environment,
      options.commandLimitMs ?? COMMAND_LIMIT_MS,
      running,
      signal,
    );
    results.push({
      phase,
      command,
      exit_code: output.timedOut ? null : output.code,
      timed_out: output.timedOut,
      output: output.tail,
    });
    const failed = output.timedOut || output.code !== SUCCESS_CODE;
    if (failed && phase === ProofPhase.Setup) break;
  }
  return results;
}

async function removeRun(options: ProofOptions, name: string, root: string) {
  const container = await containerRemovalFailure(
    (args) => options.host.run(options.runtime, args, PROOF_COMMAND_TIMEOUT_MS),
    name,
  );
  const volume = await options.host.run(
    options.runtime,
    ["volume", "rm", "--force", name],
    PROOF_COMMAND_TIMEOUT_MS,
  );
  rmSync(root, { recursive: true, force: true });
  if (container !== null)
    throw proofFailure(
      "remove container",
      container.stderr.slice(-OUTPUT_TAIL_BYTES),
    );
  if (!absentVolume(volume))
    throw proofFailure(
      "remove volume",
      volume.stderr.slice(-OUTPUT_TAIL_BYTES),
    );
}

export async function proveInImage(
  options: ProofOptions,
  input: ProofInput & { tag: string },
  signal: AbortSignal,
): Promise<CommandResult[]> {
  const root = join(
    options.stateDirectory,
    ENVIRONMENT_DIRECTORY,
    `${RUN_DIRECTORY_PREFIX}${input.run_id}`,
  );
  const name = `${PROOF_NAME_PREFIX}${input.run_id}`;
  try {
    signal.throwIfAborted();
    const checkout = join(root, CHECKOUT_DIRECTORY);
    ensureDirectory(checkout);
    await options.exportRepository(
      input.binding_id,
      input.commit,
      checkout,
      background,
    );
    await requireSuccess(options, "volume", [
      "volume",
      "create",
      "--label",
      `${OWNER_LABEL}=${options.owner}`,
      name,
    ]);
    await ensureCacheVolume(options, input);
    await requireSuccess(
      options,
      "start",
      startArguments(
        name,
        input.tag,
        options.owner,
        options.environmentMemoryMb,
        cacheVolumeName(
          options.owner,
          input.project_id,
          input.resource_identity,
        ),
      ),
    );
    await feedBundle(options, name, root, signal);
    return await runCommands(options, name, input, signal);
  } finally {
    await removeRun(options, name, root);
  }
}
