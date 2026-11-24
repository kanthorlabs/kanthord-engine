import assert from "node:assert/strict";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import type { Command } from "commander";
import { CommanderError, Option } from "commander";
import { Diagnostic, diagnostic, diagnosticRows } from "../../kernel/errors.ts";
import { packageVersion } from "../../kernel/version.ts";
import {
  type AgentInput,
  AgentOpenError,
  AgentOpenKind,
  composeSystemPrompt,
  getProfile,
  type ModelSelection,
  openAgent,
  type ProfileName,
  profilePrompt,
  type RunBudget,
  type RunFailure,
  SessionKind,
  type TurnEnd,
} from "../../agent/agent-contract.ts";
import { childEnvironment } from "../../agent/environment.ts";
import { credentialSecrets } from "../../agent/known-secrets.ts";
import { installPiTools } from "../../agent/pi-tools.ts";
import { loadPi, piDirectory, usePiDirectory } from "../../agent/pi.ts";
import {
  createModelRuntime,
  frozenStore,
  type ModelConfiguration,
  resolveModel,
} from "../../llm/model-connector.ts";
import type { ReasoningLevel } from "../../llm/platforms.ts";
import {
  type AuthDevIno,
  buildPromptText,
  type InputContext,
  PROMPT_TEXT_PATH,
  resolveInputValue,
} from "./run-agent-input.ts";
import {
  checkAuthEntry,
  checkAuthExpiry,
  checkAuthFile,
  defaultAuthPath,
  piProviderIdOf,
  readAuthEntry,
} from "./run-agent-auth.ts";
import { budgetResultFields, parseBudget } from "./run-agent-budget.ts";
import { budgetDigestField, inputDigest } from "./run-agent-digest.ts";
import { withoutAmbientCredentials } from "./run-agent-environment.ts";
import {
  agentClassValue,
  agentExitCode,
  printOpenFailed,
  printPostResultDiagnostic,
  printSecretWarnings,
  RunExitCode,
} from "./run-agent-exit.ts";
import { type AgentModelForm, resolveAgentModel } from "./run-agent-model.ts";
import {
  checkRequiredOption,
  checkTokenRefused,
  checkWorkspaceDir,
  parseModelForm,
} from "./run-agent-options.ts";
import {
  checkOutputPath,
  openOutputFile,
  OutputKind,
  parseOutputTarget,
  resultLine,
  type RunAgentResult,
  textLayout,
} from "./run-agent-output.ts";
import {
  checkAuthNotInPiDirectory,
  checkPiDirectory,
  runPiToolInstall,
} from "./run-agent-pi.ts";
import { checkSessionPath } from "./run-agent-session.ts";
import { stopOnSignal } from "./run-agent-signal.ts";
import { checkProxySettings } from "./run-agent-start.ts";
import { CommandName, ExitCode } from "./constants.ts";

const RUN_AGENT_CREDENTIAL_ID = "run-agent";
const AGENT_UNKNOWN = "cli.run.agent.agent_unknown";
const OPEN_FAILED_CODE = "cli.run.agent.open_failed";
const STOPPED_CODE = "cli.run.agent.stopped";
const NONZERO_CODE = "cli.run.agent.nonzero";

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

interface RunAgentOptions {
  model?: string;
  workspace?: string;
  session?: string;
  prompt: string[];
  systemPrompt: string[];
  auth?: string;
  budget: string[];
  output?: string;
  token?: string;
}

interface AgentRunOutcome {
  turnEnd: TurnEnd;
  systemPromptDigest: string;
}

function failureReason(failure: RunFailure | null): string | null {
  return failure?.reason ?? null;
}

async function openAndRunAgent(
  agentInput: AgentInput,
  signal: AbortSignal,
  promptText: string,
): Promise<AgentRunOutcome> {
  let agentOpen;
  try {
    agentOpen = await openAgent(agentInput);
  } catch (error) {
    if (error instanceof AgentOpenError) {
      if (signal.aborted) {
        throw new CommanderError(
          RunExitCode.Stopped,
          STOPPED_CODE,
          "stopped by signal",
        );
      }
      printOpenFailed(error);
      throw new CommanderError(1, OPEN_FAILED_CODE, error.message);
    }
    throw error;
  }
  assert.ok(
    agentOpen.kind === AgentOpenKind.Opened,
    "unexpected agent refused",
  );
  const agentRun = agentOpen.run;
  try {
    const turnEnd = await agentRun.send(promptText, { work: null });
    return { turnEnd, systemPromptDigest: agentRun.systemPromptDigest };
  } finally {
    await agentRun.close().catch(() => {});
  }
}

async function cleanupResources(
  releaseSignal: (() => void) | null,
  R: string | null,
  outputFd: number | null,
): Promise<void> {
  releaseSignal?.();
  if (R !== null) {
    try {
      rmSync(R, { recursive: true, force: true });
    } catch {}
  }
  if (outputFd !== null) {
    try {
      closeSync(outputFd);
    } catch {}
  }
}

async function runAgent(
  profile: string,
  options: RunAgentOptions,
): Promise<void> {
  checkTokenRefused(options.token);
  checkProxySettings(process.env, process.execArgv);

  checkRequiredOption(options.model, "--model");
  const parsedModel = parseModelForm(options.model!);
  const rawBudget = options.budget;
  const parsedBudget = parseBudget(rawBudget);
  const outputTarget = parseOutputTarget(options.output);
  const workspaceRaw = checkWorkspaceDir(options.workspace, process.cwd());
  checkRequiredOption(options.session, "--session");
  checkRequiredOption(options.prompt, "--prompt");

  const authPath = options.auth ?? defaultAuthPath();
  const authStat = lstatSync(authPath, { throwIfNoEntry: false });
  const authDevIno: AuthDevIno | null =
    authStat !== undefined ? { dev: authStat.dev, ino: authStat.ino } : null;

  const piDirRaw = piDirectory(process.env);
  const rawPrompts = options.prompt;
  const rawSystemPrompts = options.systemPrompt;
  const inputCtx: InputContext = {
    currentDir: process.cwd(),
    authDevIno,
    piDirectory: piDirRaw,
    configDirectories: [dirname(resolve(authPath))],
  };
  const resolvedPrompts = rawPrompts.map((p) => resolveInputValue(p, inputCtx));
  const resolvedSystemPrompts = rawSystemPrompts.map((p) =>
    resolveInputValue(p, inputCtx),
  );
  resolvedPrompts.forEach(({ text, notice }) => {
    if (notice) {
      const diag = new Diagnostic(
        PROMPT_TEXT_PATH,
        "run agent: the prompt path was not found; using as literal text.",
        { fields: [["path", text]] },
      );
      process.stderr.write(`${diagnostic(diag)}\n${diagnosticRows(diag)}`);
    }
  });
  const promptText = buildPromptText(resolvedPrompts.map((r) => r.text));

  const profileObj = getProfile(profile);
  if (!profileObj) {
    throw new Diagnostic(AGENT_UNKNOWN, "run agent: the profile is unknown.", {
      fields: [["profile", profile]],
    });
  }

  const workspaceRealPath = realpathSync(workspaceRaw);
  const sessionAbsPath = resolve(options.session!);
  usePiDirectory(piDirRaw);
  let authRealPath: string | null = null;
  try {
    authRealPath = join(
      realpathSync(dirname(resolve(authPath))),
      basename(resolve(authPath)),
    );
  } catch {}
  checkSessionPath(sessionAbsPath, workspaceRealPath, piDirRaw);
  checkPiDirectory(piDirRaw);
  checkAuthNotInPiDirectory(piDirRaw);
  if (outputTarget.kind === OutputKind.Path) {
    checkOutputPath(outputTarget.path, {
      workspaceRealPath,
      piDirectoryPath: piDirRaw,
      authRealPath,
      sessionAbsPath,
    });
  }

  checkAuthFile(authPath, workspaceRealPath);
  const piProviderIdValue = piProviderIdOf(parsedModel.provider);
  const rawEntry = await readAuthEntry(piProviderIdValue, authPath);
  const checkedAuthEntry = checkAuthEntry(
    rawEntry,
    parsedModel.provider,
    authPath,
  );

  let R: string | null = null;
  let outputFd: number | null = null;
  let releaseSignal: (() => void) | null = null;

  try {
    R = mkdtempSync(join(tmpdir(), "kanthord-run-"));
    const rHome = join(R, "home");
    const rTmp = join(R, "tmp");
    mkdirSync(rHome);
    mkdirSync(rTmp);
    if (outputTarget.kind === OutputKind.Path) {
      outputFd = openOutputFile(outputTarget.path);
    }
    withoutAmbientCredentials(process.env, rHome, rTmp);
    const controller = new AbortController();
    releaseSignal = stopOnSignal(controller);
    const { signal } = controller;

    runPiToolInstall(() => installPiTools({ directory: piDirRaw }));

    const piModule = await loadPi();
    const store = frozenStore(piProviderIdValue, checkedAuthEntry.credential);
    const preConfig: ModelConfiguration = {
      agent_provider: parsedModel.provider,
      provider: parsedModel.provider,
      model_identifier: parsedModel.model,
      reasoning_effort: parsedModel.level as ReasoningLevel,
    };
    const runtime = await createModelRuntime(piModule, {
      credentials: store,
      handoverItem: {
        credential_id: RUN_AGENT_CREDENTIAL_ID,
        provider_id: piProviderIdValue,
      },
      credentialId: RUN_AGENT_CREDENTIAL_ID,
      configuration: preConfig,
      metadata: checkedAuthEntry.metadata,
      signal,
    });

    const clockStart = Date.now();
    const wallDeadlineMs = clockStart + parsedBudget.wallMs;
    checkAuthExpiry(checkedAuthEntry.credential, wallDeadlineMs, authPath);

    const modelForm: AgentModelForm = {
      provider: parsedModel.provider,
      model: parsedModel.model,
      level: parsedModel.level,
    };
    const resolvedModel = await resolveAgentModel(modelForm, runtime);
    const resolvedConfig: ModelConfiguration = {
      agent_provider: resolvedModel.provider,
      provider: resolvedModel.provider,
      model_identifier: resolvedModel.model,
      reasoning_effort: resolvedModel.reasoning_effort as ReasoningLevel,
    };
    const modelObj = resolveModel(runtime, resolvedConfig);
    const systemPromptText = composeSystemPrompt(
      profilePrompt(profile as ProfileName),
      resolvedSystemPrompts.map(({ text }) => ({ heading: null, text })),
    );
    const knownSecrets = credentialSecrets(store, piProviderIdValue);
    const childEnv = childEnvironment(process.env);
    const cleanChildEnv = Object.fromEntries(
      Object.entries(childEnv).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    );
    const budget: RunBudget = { deadline: wallDeadlineMs, usd: null };
    const modelSelection: ModelSelection = {
      runtime,
      model: modelObj,
      thinkingLevel:
        resolvedModel.reasoning_effort as unknown as ModelSelection["thinkingLevel"],
    };
    const agentInput: AgentInput = {
      profile: profile as ProfileName,
      model: modelSelection,
      systemPrompt: systemPromptText,
      workspace: { cwd: workspaceRealPath, roots: [workspaceRealPath] },
      budget,
      session: { kind: SessionKind.NewFile, path: sessionAbsPath },
      knownSecrets,
      childEnvironment: cleanChildEnv,
      hostHome: rHome,
      consumerTools: [],
      signal,
    };

    const digestValue = inputDigest({
      prompt: rawPrompts,
      system_prompt: rawSystemPrompts,
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      reasoning_effort: resolvedModel.reasoning_effort,
      budget: budgetDigestField(parsedBudget),
    });

    const { turnEnd, systemPromptDigest } = await openAndRunAgent(
      agentInput,
      signal,
      promptText,
    );

    const durationMs = Date.now() - clockStart;
    const exitCode = agentExitCode(turnEnd.end, turnEnd.failure);
    const classValue = agentClassValue(turnEnd.end, turnEnd.failure);
    const budgetFields = budgetResultFields(parsedBudget, rawBudget);

    const result: RunAgentResult = {
      agent: profile,
      engine_version: packageVersion(),
      provider: resolvedModel.provider,
      model: resolvedModel.model,
      reasoning_effort: resolvedModel.reasoning_effort,
      budget: budgetDigestField(parsedBudget),
      budget_reached: turnEnd.budgetReached,
      input_digest: digestValue,
      system_prompt_digest: systemPromptDigest,
      workspace: workspaceRealPath,
      session: sessionAbsPath,
      end: turnEnd.end,
      class: classValue,
      failure: failureReason(turnEnd.failure),
      duration_ms: durationMs,
      model_calls: turnEnd.totals.modelCalls,
      tool_calls: turnEnd.totals.toolCalls,
      usage: {
        input: turnEnd.totals.usage.input,
        output: turnEnd.totals.usage.output,
        cache_read: turnEnd.totals.usage.cacheRead,
        cache_write: turnEnd.totals.usage.cacheWrite,
      },
      list_price_usd: turnEnd.totals.listPriceUsd,
      text: turnEnd.text,
    };

    const resultText = resultLine(result);
    if (outputTarget.kind === OutputKind.Path) {
      assert.ok(outputFd !== null);
      writeSync(outputFd, Buffer.from(resultText));
    } else {
      process.stdout.write(
        `${textLayout({
          agent: profile,
          end: turnEnd.end,
          model: resolvedModel.model,
          reasoning_effort: resolvedModel.reasoning_effort,
          exitCode,
          classValue,
          failure: failureReason(turnEnd.failure),
          budget_reached: turnEnd.budgetReached,
          budgetDisplay: budgetFields.display,
          duration_ms: durationMs,
          model_calls: turnEnd.totals.modelCalls,
          tool_calls: turnEnd.totals.toolCalls,
          usage: {
            input: turnEnd.totals.usage.input,
            output: turnEnd.totals.usage.output,
            cache_read: turnEnd.totals.usage.cacheRead,
            cache_write: turnEnd.totals.usage.cacheWrite,
          },
          list_price_usd: turnEnd.totals.listPriceUsd,
          session: sessionAbsPath,
          workspace: workspaceRealPath,
          text: turnEnd.text,
          provider: resolvedModel.provider,
        })}\n`,
      );
    }

    printSecretWarnings(turnEnd.warnings);
    if (turnEnd.failure !== null) printPostResultDiagnostic(turnEnd.failure);

    if (exitCode !== ExitCode.Success) {
      throw new CommanderError(
        exitCode,
        NONZERO_CODE,
        `run agent: exit ${exitCode}`,
      );
    }
  } finally {
    await cleanupResources(releaseSignal, R, outputFd);
  }
}

export function addRunCommand(program: Command): void {
  assert.ok(
    !program.commands.some((c) => c.name() === CommandName.Run),
    "run command already registered",
  );
  const run = program
    .command(CommandName.Run)
    .description("Local agent and task runs");
  run.action(() => run.help());

  run
    .command("agent")
    .description("Run an agent locally against a prompt")
    .argument("<profile>", "Agent profile name (e.g. swe@1)")
    .option("--model <value>", "Model selection: provider/model:level")
    .option("--workspace <path>", "Working directory")
    .option("--session <path>", "Session file path")
    .option("--prompt <value>", "Prompt text or path", collect, [] as string[])
    .option(
      "--system-prompt <value>",
      "Additional system prompt text or path",
      collect,
      [] as string[],
    )
    .option("--auth <path>", "Authentication file path")
    .option(
      "--budget <value>",
      "Budget: wall duration (e.g. 1h, 30m) or cost (e.g. 0.5usd)",
      collect,
      [] as string[],
    )
    .option("--output <path|stdout>", "Output file path or stdout")
    .addOption(new Option("--token <value>", "").hideHelp())
    .action(runAgent);
}
