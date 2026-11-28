import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { addAbortListener } from "node:events";
import { lstatSync } from "node:fs";
import { dirname } from "node:path";
import {
  type Api,
  type AssistantMessage,
  getSupportedThinkingLevels,
  type Model,
} from "@earendil-works/pi-ai";
import type {
  AgentSessionRuntime,
  InlineExtension,
  ModelRuntime,
  SessionManager,
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentMessage,
  ThinkingLevel,
} from "@earendil-works/pi-agent-core";
import {
  background,
  CancellationContext,
  type Context,
} from "../kernel/context.ts";
import { getProfile, type Profile, type ProfileName } from "./catalog.ts";
import {
  checkPreconditions,
  type StartRefusal,
} from "./start-preconditions.ts";
import { homeRelativeCwd } from "./hooks/home-relative-cwd.ts";
import { toolAllowlist } from "./hooks/tool-allowlist.ts";
import { markerRestore } from "./hooks/marker-restore.ts";
import { checkoutConfinement } from "./hooks/checkout-confinement.ts";
import { pinnedLayers } from "./pinned-layers.ts";
import { inputRedaction } from "./hooks/input-redaction.ts";
import { outputFinding } from "./hooks/output-finding.ts";
import {
  type AgentRedactionSummary,
  agentRedactionSummary,
  createRedaction,
  type KnownSecrets,
  type SessionRedaction,
} from "./redaction.ts";
import { loadPi, type PiCodingAgent } from "./pi.ts";
import { sessionTools, ToolProcesses } from "./tool-table.ts";
import {
  closeRuntime,
  type GuardList,
  openContractRuntime,
  RUNTIME_SETUP_DEADLINE_MS,
  withDeadline,
} from "./agent-session.ts";
import { type RunBudget, UsdTracker, WallTimer } from "./run-budget.ts";
import {
  addMessageTotals,
  BudgetLimit,
  buildTurnEnd,
  providerFailureClass,
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
export type {
  AgentRedactionSummary,
  KnownSecrets,
  SecretWarning,
} from "./redaction.ts";
export { getProfile } from "./catalog.ts";
export type { ProfileName } from "./catalog.ts";
export { composeSystemPrompt, profilePrompt } from "./prompt-chain.ts";

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

export type { StartRefusal } from "./start-preconditions.ts";

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
const ABORTED = "aborted";
const PROVIDER_ERROR = "error";
const ASSISTANT_ROLE = "assistant";
const MESSAGE_END = "message_end";

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface ExtensionFailure {
  reason: string | null;
}

function sessionManagerOf(
  pi: PiCodingAgent,
  record: SessionRecord,
  cwd: string,
): SessionManager {
  if (record.kind === SessionKind.NewFile) {
    assert.ok(record.path);
    const stat = lstatSync(record.path, { throwIfNoEntry: false });
    assert.equal(stat, undefined, "session file already exists");
    return pi.SessionManager.open(record.path, dirname(record.path), cwd);
  }
  return pi.SessionManager.inMemory(cwd);
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
  return {
    kind: providerFailureOf(last.errorMessage ?? ""),
    class: providerFailureClass(last, model.contextWindow),
    reason: last.errorMessage ?? "",
  };
}

interface RunContext {
  runtime: AgentSessionRuntime;
  redaction: SessionRedaction;
  pins: ReturnType<typeof pinnedLayers>;
  processes: ToolProcesses;
  timer: WallTimer;
  usdTracker: UsdTracker;
  model: Model<Api>;
  promptDigest: string;
  inputSignal: AbortSignal;
  extensionFailure: ExtensionFailure;
  cleanupCtx: () => CancellationContext;
}

function buildRun(ctx: RunContext): AgentRun {
  const {
    runtime,
    redaction,
    pins,
    processes,
    timer,
    usdTracker,
    model,
    promptDigest,
    inputSignal,
    extensionFailure,
    cleanupCtx,
  } = ctx;
  const session = runtime.session;
  let totals: RunTotals = zeroTotals();
  let budgetReached: BudgetLimit | null = null;
  let failedBeforeLimit = false;
  let failedBeforeStop = false;
  let assistantBeforeSend: AssistantMessage | undefined;
  let endAfterTurnFlag = false;
  let sending = false;
  let closed = false;

  let forceResolve: ((result: TurnEnd) => void) | null = null;
  const forceRace = (): Promise<TurnEnd> =>
    new Promise<TurnEnd>((resolve) => {
      forceResolve = resolve;
    });

  const originalFinishTurn = session.agent.finishTurn;
  session.agent.finishTurn = async (turn, signal) => {
    if (endAfterTurnFlag || budgetReached !== null || inputSignal.aborted)
      return { action: "end" };
    return (await originalFinishTurn?.(turn, signal)) ?? undefined;
  };

  function failedInSend(): boolean {
    const last = lastAssistantOf(session.messages);
    return last !== assistantBeforeSend && failureOf(last, model) !== null;
  }

  function reach(limit: BudgetLimit): void {
    if (budgetReached !== null) return;
    budgetReached = limit;
    failedBeforeLimit = failedInSend();
    if (sending) void session.abort();
  }

  const unsubscribeMessage = session.subscribe((event) => {
    if (event.type !== MESSAGE_END) return;
    if (event.message.role !== ASSISTANT_ROLE) return;
    totals = addMessageTotals(totals, event.message);
    usdTracker.check(totals.listPriceUsd, () => reach(BudgetLimit.Usd));
  });

  const unsubscribeSignal = addAbortListener(inputSignal, () => {
    if (!sending) return;
    failedBeforeStop = failedInSend();
    void session.abort();
  });

  timer.start(() => reach(BudgetLimit.Wall));

  function release(): void {
    closed = true;
    unsubscribeMessage();
    unsubscribeSignal[Symbol.dispose]();
    timer.dispose();
    processes.killAll();
  }

  function currentText(): string | null {
    const raw = session.getLastAssistantText();
    return raw === undefined ? null : redaction.exitText(raw);
  }

  function internalEnd(reason: string): TurnEnd {
    return buildTurnEnd({
      budgetReached: null,
      stopped: false,
      failure: { internal: true, reason: redaction.exitText(reason) },
      text: currentText(),
      totals,
      warnings: redaction.takeWarnings(),
    });
  }

  function loopEnd(): TurnEnd {
    if (extensionFailure.reason !== null)
      return internalEnd(extensionFailure.reason);
    const failure = failureOf(lastAssistantOf(session.messages), model);
    if (
      failure !== null &&
      (budgetReached === null || failedBeforeLimit) &&
      (!inputSignal.aborted || failedBeforeStop)
    ) {
      return {
        end: RunEnd.Failed,
        budgetReached: null,
        failure: { ...failure, reason: redaction.exitText(failure.reason) },
        text: currentText(),
        totals,
        warnings: redaction.takeWarnings(),
      };
    }
    return buildTurnEnd({
      budgetReached,
      stopped: inputSignal.aborted && budgetReached === null,
      failure: null,
      text: currentText(),
      totals,
      warnings: redaction.takeWarnings(),
    });
  }

  function snapshot(): TurnEnd {
    return buildTurnEnd({
      budgetReached,
      stopped: budgetReached === null,
      failure: null,
      text: currentText(),
      totals,
      warnings: redaction.takeWarnings(),
    });
  }

  return {
    get systemPromptDigest() {
      return promptDigest;
    },

    async send(text: string, options: SendOptions): Promise<TurnEnd> {
      assert.ok(!sending, "send called while a send is in progress");
      sending = true;
      endAfterTurnFlag = false;
      failedBeforeLimit = false;
      failedBeforeStop = false;
      assistantBeforeSend = lastAssistantOf(session.messages);
      extensionFailure.reason = null;

      try {
        const redactedText = await redaction.text(text);
        const redactedWork =
          options.work === null ? null : await redaction.text(options.work);
        pins.setWork(redactedWork !== null ? { text: redactedWork } : null);
        await redaction.refresh();
        if (budgetReached !== null || inputSignal.aborted) return loopEnd();

        let forcedResult: TurnEnd | null = null;
        try {
          await Promise.race([
            session
              .prompt(redactedText, { expandPromptTemplates: false })
              .then(() => session.waitForIdle()),
            forceRace().then((r) => {
              forcedResult = r;
            }),
          ]);
        } catch (error) {
          processes.killAll();
          return internalEnd(errorText(error));
        }

        if (forcedResult !== null) return forcedResult;
        processes.killAll();
        return loopEnd();
      } finally {
        sending = false;
      }
    },

    endAfterTurn(): void {
      endAfterTurnFlag = true;
    },

    forceStop(): TurnEnd {
      if (closed) return snapshot();
      release();
      const result = snapshot();
      forceResolve?.(result);
      forceResolve = null;
      session.dispose();
      return result;
    },

    redactionSummary(): AgentRedactionSummary {
      return agentRedactionSummary(redaction.counts());
    },

    async close(): Promise<void> {
      if (closed) return;
      release();
      await closeRuntime(runtime, cleanupCtx());
    },
  };
}

function validateInput(input: AgentInput): Profile {
  const profile = getProfile(input.profile);
  assert.ok(profile, "unknown profile");
  const declaredConsumer: readonly string[] = [
    ...profile.tools.host,
    ...profile.tools.environment,
  ];
  for (const tool of input.consumerTools) {
    if (!declaredConsumer.includes(tool.name)) {
      throw new AgentOpenError(
        OPEN_CODE_TOOL,
        `consumer tool not declared for profile ${input.profile}: ${tool.name}`,
      );
    }
  }
  const supported: readonly string[] = getSupportedThinkingLevels(
    input.model.model,
  );
  if (!supported.includes(input.model.thinkingLevel)) {
    throw new AgentOpenError(
      OPEN_CODE_LEVEL,
      `thinking level not supported: ${String(input.model.thinkingLevel)}`,
    );
  }
  return profile;
}

function declaredNamesOf(profile: Profile): string[] {
  return [
    ...profile.tools.builtin,
    ...profile.tools.host,
    ...profile.tools.environment,
  ];
}

export function contractGuards(
  input: AgentInput,
  profile: Profile,
  pinHook: InlineExtension,
): GuardList {
  return (redaction) => [
    homeRelativeCwd(input.hostHome),
    toolAllowlist(declaredNamesOf(profile)),
    markerRestore(redaction),
    ...(profile.confined
      ? [
          checkoutConfinement({
            cwd: input.workspace.cwd,
            roots: input.workspace.roots,
          }),
        ]
      : []),
    pinHook,
    inputRedaction(redaction),
    outputFinding(redaction),
  ];
}

async function openSteps(input: AgentInput): Promise<AgentOpen> {
  const profile = validateInput(input);
  const refusal = await checkPreconditions({
    preconditions: profile.preconditions,
    cwd: input.workspace.cwd,
    roots: input.workspace.roots,
    inputEnv: input.childEnvironment,
  });
  if (refusal !== null) return { kind: AgentOpenKind.Refused, refusal };
  const promptDigest = systemPromptDigest(input.systemPrompt);
  const inputContext: Context = {
    signal: input.signal,
    deadline: input.budget.deadline,
  };
  const pi = await withDeadline(loadPi(), inputContext);
  const processes = new ToolProcesses(pi.getShellConfig());
  const pins = pinnedLayers();
  const { customTools } = sessionTools(pi, input.profile, {
    cwd: input.workspace.cwd,
    budget: new WallTimer(input.budget.deadline),
    env: { ...input.childEnvironment },
    processes,
  });
  const extensionFailure: ExtensionFailure = { reason: null };
  const { runtime, redaction, systemPrompt } = await openContractRuntime(
    {
      cwd: input.workspace.cwd,
      modelRuntime: input.model.runtime,
      model: input.model.model,
      thinkingLevel: input.model.thinkingLevel,
      systemPrompt: input.systemPrompt,
      allowlist: declaredNamesOf(profile),
      customTools: [...customTools, ...input.consumerTools],
      hostHome: input.hostHome,
      context: inputContext,
      sessionManager: sessionManagerOf(pi, input.session, input.workspace.cwd),
      knownSecrets: input.knownSecrets,
    },
    contractGuards(input, profile, pins.hook),
    (error) => {
      extensionFailure.reason = error.error;
    },
  );
  pins.pinInference(runtime.session, systemPrompt);
  const run = buildRun({
    runtime,
    redaction,
    pins,
    processes,
    timer: new WallTimer(input.budget.deadline),
    usdTracker: new UsdTracker(input.budget.usd),
    model: input.model.model,
    promptDigest,
    inputSignal: input.signal,
    extensionFailure,
    cleanupCtx: () =>
      new CancellationContext(
        background,
        Date.now() + RUNTIME_SETUP_DEADLINE_MS,
      ),
  });
  return { kind: AgentOpenKind.Opened, run };
}

async function openError(
  input: AgentInput,
  error: unknown,
): Promise<AgentOpenError> {
  const redaction = createRedaction(input.knownSecrets, randomUUID());
  await redaction.refresh();
  if (error instanceof AgentOpenError)
    return new AgentOpenError(error.code, redaction.exitText(error.message));
  const message = input.signal.aborted ? ABORTED : errorText(error);
  return new AgentOpenError(OPEN_CODE_FAILED, redaction.exitText(message));
}

export async function openAgent(input: AgentInput): Promise<AgentOpen> {
  try {
    return await openSteps(input);
  } catch (error) {
    throw await openError(input, error);
  }
}
