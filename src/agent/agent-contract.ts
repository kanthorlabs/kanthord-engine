import assert from "node:assert/strict";
import { addAbortListener } from "node:events";
import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Api,
  getSupportedThinkingLevels,
  type Model,
} from "@earendil-works/pi-ai";
import { isContextOverflow } from "@earendil-works/pi-ai/utils/overflow";
import { isRetryableAssistantError } from "@earendil-works/pi-ai/utils/retry";
import type {
  AgentSessionRuntime,
  CreateAgentSessionRuntimeFactory,
  ModelRuntime,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type {
  AgentMessage,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import { CancellationContext, type Context } from "../kernel/context.ts";
import {
  getProfile,
  type Profile,
  type ProfileName,
  type StartPrecondition,
} from "./catalog.ts";
import { homeRelativeCwd } from "./hooks/home-relative-cwd.ts";
import { toolAllowlist } from "./hooks/tool-allowlist.ts";
import { markerRestore } from "./hooks/marker-restore.ts";
import { checkoutConfinement } from "./hooks/checkout-confinement.ts";
import { pinnedLayers } from "./pinned-layers.ts";
import { inputRedaction } from "./hooks/input-redaction.ts";
import { outputFinding } from "./hooks/output-finding.ts";
import {
  createRedaction,
  type KnownSecrets,
  type SessionRedaction,
} from "./redaction.ts";
import { loadPi, piAgentDirectory } from "./pi.ts";
import { sessionTools, ToolProcesses } from "./tool-table.ts";
import {
  closeRuntime,
  RUNTIME_SETUP_DEADLINE_MS,
  withDeadline,
} from "./agent-session.ts";
import { type RunBudget, WallTimer } from "./run-budget.ts";
import {
  addMessageTotals,
  BudgetLimit,
  buildTurnEnd,
  FailureClass,
  InternalFailure,
  RunEnd,
  type RunFailure,
  type RunTotals,
  type TurnEnd,
  zeroTotals,
} from "./run-outcome.ts";
import { systemPromptDigest } from "./prompt-chain.ts";
import { providerFailureOf } from "../scheduler/contract.ts";

export type { RunBudget } from "./run-budget.ts";
export type {
  TurnEnd,
  RunFailure,
  RunTotals,
  TokenUsage,
} from "./run-outcome.ts";
export {
  RunEnd,
  BudgetLimit,
  FailureClass,
  InternalFailure,
} from "./run-outcome.ts";
export type { KnownSecrets, SecretWarning } from "./redaction.ts";

export interface ModelSelection {
  runtime: ModelRuntime;
  model: Model<Api>;
  thinkingLevel: ThinkingLevel;
}

export interface Workspace {
  cwd: string;
  roots: readonly string[];
}

export const SessionKind = {
  NewFile: "new_file",
  Memory: "memory",
} as const;

export interface NewFileSession {
  kind: typeof SessionKind.NewFile;
  path: string;
}

export interface MemorySession {
  kind: typeof SessionKind.Memory;
}

export type SessionRecord = NewFileSession | MemorySession;

export interface AgentInput {
  profile: ProfileName;
  model: ModelSelection;
  systemPrompt: string;
  workspace: Workspace;
  budget: RunBudget;
  session: SessionRecord;
  knownSecrets: KnownSecrets;
  childEnvironment: Readonly<Record<string, string>>;
  hostHome: string;
  consumerTools: readonly ToolDefinition[];
  signal: AbortSignal;
}

export const AgentOpenKind = {
  Refused: "refused",
  Opened: "opened",
} as const;

export interface StartRefusal {
  precondition: StartPrecondition;
  reason: string;
}

export interface AgentRefused {
  kind: typeof AgentOpenKind.Refused;
  refusal: StartRefusal;
}

export interface AgentOpened {
  kind: typeof AgentOpenKind.Opened;
  run: AgentRun;
}

export type AgentOpen = AgentRefused | AgentOpened;

export interface SendOptions {
  work: string | null;
}

export interface AgentRedactionSummary {
  redaction_count: number;
  redaction_rules: string[];
  redaction_failed: number;
  unkept: number;
  restore_blocked: number;
  output_found_count: number;
  output_found_rules: string[];
}

export interface AgentRun {
  readonly systemPromptDigest: string;
  send(text: string, options: SendOptions): Promise<TurnEnd>;
  endAfterTurn(): void;
  forceStop(): TurnEnd;
  redactionSummary(): AgentRedactionSummary;
  close(): Promise<void>;
}

export class AgentOpenError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
    this.name = "AgentOpenError";
  }
}

const OPEN_CODE_TOOL = "agent.tool_undeclared";
const OPEN_CODE_LEVEL = "agent.level_unsupported";
const OPEN_CODE_FAILED = "agent.open_failed";
const PROVIDER_ERROR = "error";
const ASSISTANT_ROLE = "assistant";
const MESSAGE_END = "message_end";

function sessionManagerOf(
  pi: Awaited<ReturnType<typeof loadPi>>,
  record: SessionRecord,
  cwd: string,
) {
  if (record.kind === SessionKind.NewFile) {
    assert.ok(record.path);
    const stat = lstatSync(record.path, { throwIfNoEntry: false });
    assert.equal(
      stat,
      undefined,
      `session file already exists: ${record.path}`,
    );
    return pi.SessionManager.open(record.path, dirname(record.path), cwd);
  }
  return pi.SessionManager.inMemory(cwd);
}

function agentRedactionSummary(state: SessionRedaction): AgentRedactionSummary {
  const counts = state.counts();
  const redacted = counts.redacted;
  const outputFound = counts.output_found;
  const redactedRules = (Object.keys(redacted) as string[])
    .filter((r) => redacted[r as keyof typeof redacted])
    .sort();
  const outputRules = (Object.keys(outputFound) as string[])
    .filter((r) => outputFound[r as keyof typeof outputFound])
    .sort();
  return {
    redaction_count: redactedRules.reduce(
      (n, r) => n + (redacted[r as keyof typeof redacted] ?? 0),
      0,
    ),
    redaction_rules: redactedRules,
    redaction_failed: counts.scan_failed,
    unkept: counts.unkept,
    restore_blocked: counts.restore_blocked,
    output_found_count: outputRules.reduce(
      (n, r) => n + (outputFound[r as keyof typeof outputFound] ?? 0),
      0,
    ),
    output_found_rules: outputRules,
  };
}

function lastAssistantOf(
  messages: readonly AgentMessage[],
): AssistantMessage | undefined {
  return messages.findLast(
    (m): m is AssistantMessage =>
      (m as AssistantMessage).role === ASSISTANT_ROLE,
  );
}

function failureOf(
  last: AssistantMessage | undefined,
  model: Model<Api>,
): RunFailure | null {
  if (!last || last.stopReason !== PROVIDER_ERROR) return null;
  const retryable =
    !isContextOverflow(last, model.contextWindow) &&
    isRetryableAssistantError(last);
  return {
    kind: providerFailureOf(last.errorMessage ?? ""),
    class: retryable ? FailureClass.Retryable : FailureClass.Terminal,
    reason: last.errorMessage ?? "",
  };
}

interface RunContext {
  runtime: AgentSessionRuntime;
  redaction: SessionRedaction;
  pins: ReturnType<typeof pinnedLayers>;
  processes: ToolProcesses;
  timer: WallTimer;
  model: Model<Api>;
  promptDigest: string;
  inputSignal: AbortSignal;
  cleanupCtx: () => CancellationContext;
}

function buildRun(ctx: RunContext): AgentRun {
  const {
    runtime,
    redaction,
    pins,
    processes,
    timer,
    model,
    promptDigest,
    inputSignal,
    cleanupCtx,
  } = ctx;
  const session = runtime.session;
  let totals: RunTotals = zeroTotals();
  let budgetReached: BudgetLimit | null = null;
  let endAfterTurnFlag = false;
  let sending = false;
  let closed = false;
  const errors: { last: Error | null } = { last: null };

  let forceResolve: ((result: TurnEnd) => void) | null = null;
  const forceRace = (): Promise<TurnEnd> =>
    new Promise<TurnEnd>((resolve) => {
      forceResolve = resolve;
    });

  const originalFinishTurn = session.agent.finishTurn;
  session.agent.finishTurn = async (turn, signal) => {
    if (endAfterTurnFlag) return { action: "end" };
    return (await originalFinishTurn?.(turn, signal)) ?? undefined;
  };

  void session.bindExtensions({
    onError: (err) => {
      errors.last = err instanceof Error ? err : new Error(String(err));
    },
  });

  const unsubscribeMessage = session.subscribe((event) => {
    if (event.type !== MESSAGE_END) return;
    const msg = (event as { type: string; message: unknown }).message as Record<
      string,
      unknown
    >;
    if (msg.role !== ASSISTANT_ROLE) return;
    const assistant = msg as unknown as AssistantMessage;
    totals = addMessageTotals(totals, assistant);
    if (budgetReached !== null) return;
    if (timer.budgetReached() === BudgetLimit.Wall) {
      budgetReached = BudgetLimit.Wall;
      void session.abort();
    }
  });

  const unsubscribeSignal = addAbortListener(inputSignal, () => {
    if (!sending) return;
    void session.abort();
  });

  timer.start(() => {
    if (budgetReached !== null) return;
    budgetReached = BudgetLimit.Wall;
    if (sending) void session.abort();
  });

  function currentText(): string | null {
    const raw = session.getLastAssistantText();
    return raw === undefined ? null : redaction.exitText(raw);
  }

  function snapshot(): TurnEnd {
    return {
      end: RunEnd.Stopped,
      budgetReached: null,
      failure: null,
      text: currentText(),
      totals,
      warnings: redaction.takeWarnings(),
    };
  }

  return {
    get systemPromptDigest() {
      return promptDigest;
    },

    async send(text: string, options: SendOptions): Promise<TurnEnd> {
      assert.ok(!sending, "send called while a send is in progress");
      sending = true;
      endAfterTurnFlag = false;
      errors.last = null;

      try {
        const redactedText = await redaction.text(text);
        const redactedWork =
          options.work === null ? null : await redaction.text(options.work);
        pins.setWork(redactedWork !== null ? { text: redactedWork } : null);
        await redaction.refresh();

        let forcedResult: TurnEnd | null = null;
        await Promise.race([
          session
            .prompt(redactedText, { expandPromptTemplates: false })
            .then(() => session.waitForIdle()),
          forceRace().then((r) => {
            forcedResult = r;
          }),
        ]);

        if (forcedResult !== null) return forcedResult;

        processes.killAll();

        const extErr = errors.last as Error | null;
        if (extErr) {
          const reason = redaction.exitText(extErr.message);
          return {
            end: RunEnd.Failed,
            budgetReached: null,
            failure: {
              kind: InternalFailure.Internal,
              class: FailureClass.Terminal,
              reason,
            },
            text: currentText(),
            totals,
            warnings: redaction.takeWarnings(),
          };
        }

        const last = lastAssistantOf(session.messages);
        const failure = failureOf(last, model);

        if (failure !== null) {
          return {
            end: RunEnd.Failed,
            budgetReached: null,
            failure: {
              ...failure,
              reason: redaction.exitText(failure.reason),
            },
            text: currentText(),
            totals,
            warnings: redaction.takeWarnings(),
          };
        }

        const stopped = inputSignal.aborted && budgetReached === null;
        return buildTurnEnd({
          budgetReached,
          stopped,
          failure: null,
          text: currentText(),
          totals,
          warnings: redaction.takeWarnings(),
        });
      } finally {
        sending = false;
      }
    },

    endAfterTurn(): void {
      endAfterTurnFlag = true;
    },

    forceStop(): TurnEnd {
      processes.killAll();
      const result = snapshot();
      forceResolve?.(result);
      forceResolve = null;
      session.dispose();
      closed = true;
      return result;
    },

    redactionSummary(): AgentRedactionSummary {
      return agentRedactionSummary(redaction);
    },

    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      unsubscribeMessage();
      unsubscribeSignal[Symbol.dispose]();
      timer.dispose();
      processes.killAll();
      await closeRuntime(runtime, cleanupCtx());
    },
  };
}

function validateInput(input: AgentInput): Profile {
  const profile = getProfile(input.profile);
  if (!profile) {
    throw new AgentOpenError(
      OPEN_CODE_TOOL,
      `unknown profile: ${input.profile}`,
    );
  }
  const declaredConsumer = [
    ...(profile.tools.host as readonly string[]),
    ...(profile.tools.environment as readonly string[]),
  ];
  for (const tool of input.consumerTools) {
    const name = (tool as { name: string }).name;
    if (!declaredConsumer.includes(name)) {
      throw new AgentOpenError(
        OPEN_CODE_TOOL,
        `consumer tool not declared for profile ${input.profile}: ${name}`,
      );
    }
  }
  const supported = getSupportedThinkingLevels(input.model.model);
  if (
    !supported.includes(input.model.thinkingLevel as (typeof supported)[number])
  ) {
    throw new AgentOpenError(
      OPEN_CODE_LEVEL,
      `thinking level not supported: ${String(input.model.thinkingLevel)}`,
    );
  }
  return profile;
}

interface PiSetup {
  pi: Awaited<ReturnType<typeof loadPi>>;
  settingsManager: ReturnType<
    Awaited<ReturnType<typeof loadPi>>["SettingsManager"]["inMemory"]
  >;
  sessionManager: ReturnType<
    Awaited<ReturnType<typeof loadPi>>["SessionManager"]["inMemory"]
  >;
  redaction: SessionRedaction;
  redactedSystemPrompt: string;
}

async function setupPi(
  input: AgentInput,
  inputContext: Context,
): Promise<PiSetup> {
  let pi: Awaited<ReturnType<typeof loadPi>>;
  try {
    pi = await withDeadline(loadPi(), inputContext);
  } catch {
    const msg = input.signal.aborted ? "aborted" : "failed to load pi";
    throw new AgentOpenError(OPEN_CODE_FAILED, msg);
  }
  const settingsManager = pi.SettingsManager.inMemory({
    enableInstallTelemetry: false,
    enableAnalytics: false,
  });
  let sessionManager: ReturnType<typeof pi.SessionManager.inMemory>;
  try {
    sessionManager = sessionManagerOf(pi, input.session, input.workspace.cwd);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "session error";
    throw new AgentOpenError(OPEN_CODE_FAILED, msg);
  }
  const redaction = createRedaction(
    input.knownSecrets,
    sessionManager.getSessionId(),
  );
  let redactedSystemPrompt: string;
  try {
    redactedSystemPrompt = await withDeadline(
      redaction.text(input.systemPrompt),
      inputContext,
    );
  } catch {
    const msg = input.signal.aborted ? "aborted" : "setup timeout";
    throw new AgentOpenError(OPEN_CODE_FAILED, msg);
  }
  return {
    pi,
    settingsManager,
    sessionManager,
    redaction,
    redactedSystemPrompt,
  };
}

export async function openAgent(input: AgentInput): Promise<AgentOpen> {
  const profile = validateInput(input);

  const promptDigest = systemPromptDigest(input.systemPrompt);
  const inputContext: Context = {
    signal: input.signal,
    deadline: input.budget.deadline,
  };

  const {
    pi,
    settingsManager,
    sessionManager,
    redaction,
    redactedSystemPrompt,
  } = await setupPi(input, inputContext);

  const processes = new ToolProcesses(pi.getShellConfig());
  const pins = pinnedLayers();

  const allDeclaredNames = [
    ...profile.tools.builtin,
    ...profile.tools.host,
    ...profile.tools.environment,
  ];

  const sessionToolsResult = sessionTools(pi, input.profile, {
    cwd: input.workspace.cwd,
    budget: new WallTimer(input.budget.deadline),
    env: { ...input.childEnvironment },
    processes,
  });

  const hooks = [
    homeRelativeCwd(input.hostHome),
    toolAllowlist(allDeclaredNames),
    markerRestore(redaction),
    ...(profile.confined
      ? [
          checkoutConfinement({
            cwd: input.workspace.cwd,
            roots: input.workspace.roots,
          }),
        ]
      : []),
    pins.hook,
    inputRedaction(redaction),
    outputFinding(redaction),
  ];

  const resourceLoader = new pi.DefaultResourceLoader({
    cwd: input.workspace.cwd,
    agentDir: piAgentDirectory(),
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPrompt: redactedSystemPrompt,
    extensionFactories: hooks,
  });

  try {
    await withDeadline(resourceLoader.reload(), inputContext);
  } catch {
    const msg = input.signal.aborted ? "aborted" : "setup timeout";
    throw new AgentOpenError(OPEN_CODE_FAILED, msg);
  }

  const factory: CreateAgentSessionRuntimeFactory = async (options) => {
    const services = {
      cwd: options.cwd,
      agentDir: options.agentDir,
      modelRuntime: input.model.runtime,
      settingsManager,
      resourceLoader,
      diagnostics: [],
    };
    const created = await pi.createAgentSessionFromServices({
      services,
      sessionManager: options.sessionManager,
      model: input.model.model,
      thinkingLevel: input.model.thinkingLevel,
      tools: allDeclaredNames,
      customTools: [...sessionToolsResult.customTools, ...input.consumerTools],
    });
    return { ...created, services, diagnostics: [] };
  };

  let runtime: AgentSessionRuntime;
  try {
    runtime = await withDeadline(
      pi.createAgentSessionRuntime(factory, {
        cwd: input.workspace.cwd,
        agentDir: piAgentDirectory(),
        sessionManager,
      }),
      inputContext,
      (late) => {
        const cleanup = new CancellationContext(
          inputContext,
          Date.now() + RUNTIME_SETUP_DEADLINE_MS,
        );
        void closeRuntime(late, cleanup);
      },
    );
  } catch {
    const msg = input.signal.aborted ? "aborted" : "session open failed";
    throw new AgentOpenError(OPEN_CODE_FAILED, msg);
  }

  pins.pinInference(runtime.session, redactedSystemPrompt);

  const timer = new WallTimer(input.budget.deadline);
  const cleanupCtx = () =>
    new CancellationContext(
      inputContext,
      Date.now() + RUNTIME_SETUP_DEADLINE_MS,
    );

  const run = buildRun({
    runtime,
    redaction,
    pins,
    processes,
    timer,
    model: input.model.model,
    promptDigest,
    inputSignal: input.signal,
    cleanupCtx,
  });

  return { kind: AgentOpenKind.Opened, run };
}
