import { existsSync, readSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { isatty } from "node:tty";
import { type Command, CommanderError } from "commander";
import { CancellationContext, type Context } from "../../kernel/context.ts";
import { Diagnostic, diagnostic, diagnosticRows } from "../../kernel/errors.ts";
import {
  checkFileOptions,
  checkHeader,
  checkOutputFolder,
  credentialInvalid,
  credentialOf,
  credentialValues,
  defaultCapabilities,
  defaultModelRuntimeFactory,
  EndReason,
  ExecutionStop,
  knownPassValues,
  type LocalCredential,
  localHostTools,
  type LocalTasksEnd,
  type LocalTasksInput,
  type ModelRuntimeFactory,
  readTurns,
  recordedOptions,
  replayCredential,
  RunEndKind,
  runTasksLocal,
  tasksDiagnostic,
  TasksErrorCode,
  TasksExit,
  type TasksOptions,
  TasksOutput,
  type TasksPlan,
  tasksPlanOf,
  withoutAmbientCredentials,
} from "../worker/index.ts";

const STDIN_DESCRIPTOR = 0;
const SIGINT = "SIGINT";
const EXIT_CODE = "cli.worker.tasks.exit";
const SHELL_NAMES = ["PATH", "LANG", "TMPDIR"];
const NEWLINE = "\n";

export interface TasksCommandIo {
  cwd: string;
  shellEnv: NodeJS.ProcessEnv;
  stdinTerminal: boolean;
  readStdin(): Buffer;
  stdout(text: string): void;
  stderr(text: string): void;
  modelRuntimeFactory: ModelRuntimeFactory;
  capabilities: typeof defaultCapabilities;
  stop: Context;
  piDirectory: string | null;
}

export interface TasksRunOptions {
  credentialStdin?: boolean;
  replay?: string;
  tree: string[];
  passEnv: string[];
  model?: string;
  reasoning?: string;
  systemPrompt?: string;
  templates?: string;
  unit: string[];
  budgetTurns?: string;
  budgetWall?: string;
  skipReleaseGate?: boolean;
  output?: string;
  force?: boolean;
  verify?: boolean;
}

function planOptions(
  seedFolder: string,
  options: TasksRunOptions,
  cwd: string,
): TasksOptions {
  return {
    cwd,
    seedFolder,
    trees: options.tree,
    passEnv: options.passEnv,
    model: options.model,
    reasoning: options.reasoning,
    systemPrompt: options.systemPrompt,
    templates: options.templates,
    units: options.unit,
    budgetTurns: options.budgetTurns,
    budgetWall: options.budgetWall,
    skipReleaseGate: !!options.skipReleaseGate,
    output: options.output,
    force: !!options.force,
    verify: !!options.verify,
  };
}

function passedValues(
  names: readonly string[],
  shellEnv: NodeJS.ProcessEnv,
): Record<string, string> {
  return Object.fromEntries(
    names.map((name) => {
      const value = shellEnv[name];
      if (value === undefined)
        throw tasksDiagnostic(
          TasksErrorCode.OptionInvalid,
          "worker tasks run: --pass-env names an unset variable.",
          [["option", "--pass-env"]],
        );
      return [name, value];
    }),
  );
}

function stdinOf(io: TasksCommandIo): Buffer {
  if (io.stdinTerminal) throw credentialInvalid("stdin");
  try {
    return io.readStdin();
  } catch {
    throw credentialInvalid("stdin");
  }
}

function shellOf(shellEnv: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    SHELL_NAMES.flatMap((name) => {
      const value = shellEnv[name];
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function printInternalError(io: TasksCommandIo): void {
  const failed = tasksDiagnostic(
    TasksErrorCode.InternalError,
    "worker tasks run: the tasks phase ended with an unknown error.",
  );
  io.stderr(`${diagnostic(failed)}${NEWLINE}${diagnosticRows(failed)}`);
}

const RECORDED_OPTIONS: readonly (keyof TasksRunOptions)[] = [
  "model",
  "reasoning",
  "budgetTurns",
  "budgetWall",
  "skipReleaseGate",
];

function modeInvalid(): Diagnostic {
  return tasksDiagnostic(
    TasksErrorCode.ModeInvalid,
    "worker tasks run: pass exactly one of --replay and --credential-stdin, and no recorded override with --replay.",
  );
}

function replayPathOf(options: TasksRunOptions, cwd: string): string | null {
  const live = !!options.credentialStdin;
  if (live === (options.replay !== undefined)) throw modeInvalid();
  if (live) return null;
  if (
    options.unit.length ||
    RECORDED_OPTIONS.some((name) => options[name] !== undefined)
  )
    throw modeInvalid();
  return resolve(cwd, options.replay!);
}

function realPathOf(path: string): string {
  const parent = dirname(path);
  if (existsSync(path) || parent === path) return realpathSync.native(path);
  return join(realPathOf(parent), basename(path));
}

function within(path: string, folder: string): boolean {
  return path === folder || path.startsWith(`${folder}${sep}`);
}

function checkReplayOutput(folder: string, output: string): void {
  const recorded = realPathOf(folder);
  const target = realPathOf(output);
  if (within(recorded, target) || within(target, recorded))
    throw tasksDiagnostic(
      TasksErrorCode.OptionInvalid,
      "worker tasks run: --output and the folder of the --replay file hold one another.",
      [["option", "--output"]],
    );
}

interface ModeInput {
  replay: LocalTasksInput["replay"];
  plan: TasksPlan;
  io: TasksCommandIo;
}

function credentialOfMode(input: ModeInput): LocalCredential {
  const { replay, plan, io } = input;
  return replay === null
    ? credentialOf(stdinOf(io), plan)
    : replayCredential(plan);
}

function recordedReplay(replayPath: string | null): LocalTasksInput["replay"] {
  if (replayPath === null) return null;
  return { turns: readTurns(replayPath), folder: dirname(replayPath) };
}

async function localEnd(input: LocalTasksInput): Promise<LocalTasksEnd> {
  try {
    return await runTasksLocal(input);
  } catch (error) {
    if (error instanceof Diagnostic) throw error;
    return {
      end: RunEndKind.Failed,
      exitCode: TasksExit.InternalError,
      output: input.output.folder,
    };
  }
}

export async function tasksRun(
  seedFolder: string,
  options: TasksRunOptions,
  io: TasksCommandIo,
): Promise<TasksExit> {
  const replay = recordedReplay(replayPathOf(options, io.cwd));
  if (replay !== null) checkFileOptions(replay.turns.header, options);
  const plan = await tasksPlanOf(
    planOptions(
      seedFolder,
      replay === null
        ? options
        : { ...options, ...recordedOptions(replay.turns.header) },
      io.cwd,
    ),
    Date.now(),
  );
  if (replay !== null) {
    checkHeader(replay.turns.header, plan);
    checkReplayOutput(replay.folder, plan.output);
  }
  checkOutputFolder(plan.output, plan.force);
  const passed = passedValues(plan.passEnv, io.shellEnv);
  const passValues = knownPassValues(Object.values(passed));
  const credential = credentialOfMode({ replay, plan, io });
  const env = { ...shellOf(io.shellEnv), ...passed };
  const output = TasksOutput.create(
    plan.output,
    {
      credential:
        replay === null ? credentialValues(credential.credential) : [],
      passed: passValues,
    },
    io.stderr,
  );
  withoutAmbientCredentials(io.shellEnv, output);
  const end = await localEnd({
    plan,
    credential,
    output,
    env,
    passValues,
    capabilities: io.capabilities(
      localHostTools({
        output,
        claim: plan.claim,
        linkUpdates: plan.seed.link_updates ?? [],
      }),
    ),
    replay,
    modelRuntimeFactory: io.modelRuntimeFactory,
    stop: io.stop,
    piDirectory: io.piDirectory,
  });
  io.stdout(
    `${JSON.stringify({ output: end.output, end: end.end, exit_code: end.exitCode })}${NEWLINE}`,
  );
  if (end.end === RunEndKind.Failed) printInternalError(io);
  return end.exitCode;
}

export function stopOnSignal(stop: CancellationContext): () => void {
  const onSignal = () =>
    stop.cancel(new ExecutionStop(EndReason.WorkerStopped, null));
  process.once(SIGINT, onSignal);
  return () => void process.off(SIGINT, onSignal);
}

const READ_CHUNK_BYTES = 65536;
const END_OF_INPUT = 0;
const RETRY_WAIT_MS = 10;
const WOULD_BLOCK = "EAGAIN";
const ZERO_BYTE = 0;
const WAIT_CELL = new Int32Array(
  new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT),
);

function readChunk(descriptor: number, chunk: Buffer): number | null {
  try {
    return readSync(descriptor, chunk);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== WOULD_BLOCK) throw error;
    Atomics.wait(WAIT_CELL, ZERO_BYTE, ZERO_BYTE, RETRY_WAIT_MS);
    return null;
  }
}

function readDescriptor(descriptor: number): Buffer {
  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  const chunks: Buffer[] = [];
  try {
    for (;;) {
      const read = readChunk(descriptor, chunk);
      if (read === END_OF_INPUT) return Buffer.concat(chunks);
      if (read !== null) chunks.push(Buffer.from(chunk.subarray(0, read)));
    }
  } finally {
    chunk.fill(ZERO_BYTE);
    for (const part of chunks) part.fill(ZERO_BYTE);
  }
}

async function runAction(seedFolder: string, command: Command): Promise<void> {
  const stop = new CancellationContext();
  const release = stopOnSignal(stop);
  try {
    const code = await tasksRun(seedFolder, command.opts<TasksRunOptions>(), {
      cwd: process.cwd(),
      shellEnv: process.env,
      stdinTerminal: isatty(STDIN_DESCRIPTOR),
      readStdin: () => readDescriptor(STDIN_DESCRIPTOR),
      stdout: (text) => void process.stdout.write(text),
      stderr: (text) => void process.stderr.write(text),
      modelRuntimeFactory: defaultModelRuntimeFactory,
      capabilities: defaultCapabilities,
      stop,
      piDirectory: null,
    });
    if (code !== TasksExit.Success)
      throw new CommanderError(code, EXIT_CODE, "");
  } finally {
    release();
  }
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

export function addWorkerTasksCommands(worker: Command): void {
  const tasks = worker
    .command("tasks")
    .description("Local runs of the tasks phase of an implement execution");
  tasks.action(() => tasks.help());
  tasks
    .command("run")
    .description(
      "Run the tasks phase of an implement execution on this machine from a seed. env.setup, the verification commands and agent bash run on this host with its network.",
    )
    .argument("<seed-folder>", "Folder that holds seed.json")
    .option(
      "--credential-stdin",
      "Read the LLM credential as one JSON object from standard input",
    )
    .option(
      "--replay <turns.jsonl>",
      "Answer each model request from the turns of a recorded run; read no credential and call no provider",
    )
    .option("--tree <binding_id=path>", "Tree source of a binding", collect, [])
    .option(
      "--pass-env <name>",
      "Pass this environment variable to each child process",
      collect,
      [],
    )
    .option("--model <provider/model>", "Replace the provider and the model")
    .option("--reasoning <level>", "Replace the reasoning effort")
    .option("--system-prompt <file>", "Replace the final system prompt")
    .option("--templates <folder>", "Read prompt templates from this folder")
    .option("--unit <unit_id>", "Keep only this unit of the plan", collect, [])
    .option("--budget-turns <count>", "Replace the turn budget")
    .option(
      "--budget-wall <duration>",
      "Replace the wall-time budget (90s, 30m, 2h)",
    )
    .option(
      "--skip-release-gate",
      "End the phase after the units of round 1 with no release route",
    )
    .option(
      "--output <folder>",
      "Output folder (default ./tasks-run-<execution_id>)",
    )
    .option("--force", "Replace an earlier run folder")
    .option(
      "--verify",
      "Run the checks of the run and record them in result.json",
    )
    .action((seedFolder: string, _options, command: Command) =>
      runAction(seedFolder, command),
    );
}
