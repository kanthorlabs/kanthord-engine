import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  agentPort,
  type SessionModelFactory,
  type SessionPort,
  type SessionTrace,
} from "../../agent/agent-port.ts";
import { executionEvidence } from "../../agent/capabilities/execution-evidence.ts";
import type { SessionHostTools } from "../../agent/capabilities/host-tools.ts";
import { linkUpdates } from "../../agent/capabilities/link-updates.ts";
import {
  PI_DIRECTORY_NAME,
  piAgentDirectory,
  usePiDirectory,
} from "../../agent/pi.ts";
import { installPiTools } from "../../agent/pi-tools.ts";
import {
  background,
  CancellationContext,
  type Context,
} from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import { frozenStore } from "../../llm/refresh-watch.ts";
import { AssetKind } from "../../mission/contract.ts";
import { BudgetLimit } from "../../scheduler/contract.ts";
import { RecordKind } from "../../tracking/contract.ts";
import { ExecutionBudget } from "./budget.ts";
import type { ExecutionCtx, FoundryEnd, Key } from "./chain.ts";
import { FoundryEndKind } from "./chain.ts";
import { implementInputOf } from "./chain-implement.ts";
import {
  type ChainIo,
  type PhaseEnd,
  PhaseEndKind,
  PhaseSeedMissing,
  runPhase,
} from "./chain-runner.ts";
import { tasksPrepareChain } from "./chain-tasks-prepare.ts";
import { ExecutionRun } from "./execution-run.ts";
import { EndReason, ExecutionStop } from "./execution-stop.ts";
import {
  type EvidenceDraft,
  type EvidencePort,
  type ImplementHostPorts,
  PortResultKind,
} from "./foundry-ports.ts";
import { foundryImplement, type ImplementResult } from "./foundry-implement.ts";
import type { MethodClients } from "./method-clients.ts";
import type { ModelRuntimeFactory } from "./model-runtime.ts";
import { nativeSessionTrace, openNativeAgent } from "./native-agent.ts";
import type { NativeAgent } from "./native-agent-session.ts";
import { environmentDigestsOf, stopOnEnd } from "./native-method.ts";
import type { StartCheck } from "./steps-implement.ts";
import { workUnitsOf } from "./steps-implement.ts";
import {
  credentialValues,
  type LocalCredential,
  wallDeadlineOfPlan,
} from "./tasks-credential.ts";
import {
  HOME_DIRECTORY,
  OutputFile,
  STATE_DIRECTORY,
  type TasksOutput,
} from "./tasks-output.ts";
import { openWorldCapability } from "./tasks-open-world.ts";
import {
  type Seed,
  type SeedPlan,
  tasksDiagnostic,
  TasksErrorCode,
  type TasksPlan,
} from "./tasks-seed.ts";
import {
  localReleaseTreePort,
  localRepositoryPort,
  type LocalTrees,
  ORIGIN_DIRECTORY,
  prepareTrees,
  unlockTree,
} from "./tasks-trees.ts";
import { StepRecord } from "./tasks-steps.ts";
import { replayDiverged, Turns } from "./tasks-turns.ts";
import type { RecordedTurns, TurnsOverrides } from "./tasks-turns-file.ts";
import {
  type CheckResult,
  type RunEnd,
  RunEndKind,
  verifyRun,
} from "./tasks-verify.ts";
import { Phase, SpanOperation } from "./telemetry.ts";
import { agentOpenPort, commonPorts } from "./worker-ports.ts";

export const TasksExit = {
  Success: 0,
  Diagnostic: 1,
  Stopped: 2,
  VerifyFailed: 4,
  InternalError: 5,
} as const;
export type TasksExit = (typeof TasksExit)[keyof typeof TasksExit];

const RunMode = { Live: "live", Replay: "replay" } as const;

export const PI_AUTH_FILE = "auth.json";
const TASKS_FAILED = "tasks failed";
const FIXED_GIT_ENV = {
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_SSH_COMMAND:
    "ssh -F /dev/null -o IdentitiesOnly=yes -o IdentityFile=none",
};
const WORKING_AGENT = 0;
const NO_ROUTE = "A local tasks run calls no route.";
const BASE64 = "base64";

export interface LocalReplay {
  turns: RecordedTurns;
  folder: string;
}

export interface LocalTasksInput {
  plan: TasksPlan;
  credential: LocalCredential;
  output: TasksOutput;
  env: Readonly<Record<string, string>>;
  passValues: readonly string[];
  capabilities: readonly InlineExtension[];
  replay: LocalReplay | null;
  modelRuntimeFactory: ModelRuntimeFactory;
  stop: Context;
  piDirectory: string | null;
}

export function defaultCapabilities(
  tools: SessionHostTools,
): InlineExtension[] {
  return [executionEvidence(tools), linkUpdates(tools)];
}

export interface LocalTasksEnd {
  end: RunEndKind;
  exitCode: TasksExit;
  output: string;
}

function refusing<T extends object>(): T {
  return new Proxy({} as T, {
    get: () => () => Promise.reject(new Error(NO_ROUTE)),
  });
}

const REFUSING_CLIENTS: MethodClients = {
  mission: refusing(),
  scheduler: refusing(),
  worker: refusing(),
};

function ok<T>(value: T) {
  return { kind: PortResultKind.Ok, value } as const;
}

function redactedDraft(
  draft: EvidenceDraft,
  output: TasksOutput,
): EvidenceDraft {
  return {
    ...draft,
    assets: draft.assets.map((asset) =>
      asset.kind === AssetKind.Produced
        ? {
            ...asset,
            content: {
              ...asset.content,
              data: output
                .redactedBytes(Buffer.from(asset.content.data, BASE64))
                .toString(BASE64),
            },
          }
        : asset,
    ),
  };
}

export function localEvidencePort(
  run: ExecutionRun,
  output: TasksOutput,
): EvidencePort {
  return {
    async submit(draft) {
      const ids = output.nextEvidence();
      for (const asset of draft.assets)
        if (asset.kind === AssetKind.Produced)
          output.upload(ids, Buffer.from(asset.content.data, BASE64));
      output.record({
        operation: "mission.evidence.submit",
        body: { ...redactedDraft(draft, output), ...run.context() },
      });
      return ok(ids.evidence_id);
    },
  };
}

function startCheckOf(seed: Seed, plan: SeedPlan): StartCheck {
  const units = workUnitsOf(seed.claim.node_id, seed.revision);
  return {
    pending: plan.pending.map(({ unit_id, instruction }) => {
      const task = units.find((unit) => unit.id === unit_id);
      if (!task)
        throw tasksDiagnostic(
          TasksErrorCode.SeedInvalid,
          "worker tasks run: the seed plan names a unit that the revision lacks.",
          [["paths", "plan.pending"]],
        );
      return { task, instruction };
    }),
    node:
      plan.node === null
        ? null
        : { text: plan.node.text, judged: [], round: plan.node.round },
    done: new Set(),
    budgetEnd: null,
  };
}

function plannedUnits(
  plan: StartCheck,
  units: readonly string[],
  nodeId: string,
): StartCheck {
  if (!units.length) return plan;
  const known = new Set([
    ...plan.pending.map(({ task }) => task.id),
    ...(plan.node === null ? [] : [nodeId]),
  ]);
  const unknown = units.find((unit) => !known.has(unit));
  if (unknown !== undefined)
    throw tasksDiagnostic(
      TasksErrorCode.UnitUnknown,
      "worker tasks run: a --unit names no unit of the plan.",
      [["unit", unknown]],
    );
  return {
    ...plan,
    pending: plan.pending.filter(({ task }) => units.includes(task.id)),
    node: units.includes(nodeId) ? plan.node : null,
  };
}

function phaseKeys(plan: TasksPlan, trees: LocalTrees): Partial<ExecutionCtx> {
  const { seed } = plan;
  return {
    claim: plan.claim,
    setup: plan.setup,
    sshAccess: new Map(),
    revision: seed.revision,
    workspace: trees.workspace,
    prior: seed.prior ?? { verdict: null, cleared: null },
    ...(seed.affectedTests === undefined
      ? {}
      : { affectedTests: seed.affectedTests }),
    ...(seed.plan === undefined ? {} : { plan: startCheckOf(seed, seed.plan) }),
  };
}

function seededKeys(seed: Seed): Set<Key> {
  const keys = new Set<Key>();
  if (seed.affectedTests !== undefined) keys.add("affectedTests");
  if (seed.plan !== undefined) keys.add("plan");
  return keys;
}

interface Composed {
  plan: TasksPlan;
  output: TasksOutput;
  run: ExecutionRun;
  budget: ExecutionBudget;
  io: ChainIo<ImplementHostPorts>;
  env: Readonly<Record<string, string>>;
  turns: Turns;
  steps: StepRecord;
  replay: LocalReplay | null;
}

async function preparedPhase(
  composed: Composed,
  trees: LocalTrees,
): Promise<PhaseEnd> {
  const { plan, io } = composed;
  try {
    return await runPhase(
      tasksPrepareChain(seededKeys(plan.seed)),
      { phase: Phase.Prepare, seed: { keys: phaseKeys(plan, trees) } },
      io,
    );
  } catch (error) {
    if (!(error instanceof PhaseSeedMissing)) throw error;
    throw tasksDiagnostic(
      TasksErrorCode.SeedInvalid,
      "worker tasks run: the seed lacks a key that the phase reads.",
      [["paths", error.keys.join(", ")]],
    );
  }
}

function stopEnd(stop: ExecutionStop, step: string | null): RunEnd {
  return { end: RunEndKind.Stop, stop, step, result: null, input: null };
}

async function foundryEndOf(
  composed: Composed,
  end: FoundryEnd<ImplementResult>,
  input: unknown,
): Promise<RunEnd> {
  const base = { result: end.result, input, stop: null, step: null };
  if (end.kind === FoundryEndKind.Completed)
    return { ...base, end: RunEndKind.Completed };
  if (end.kind === FoundryEndKind.BudgetEnd)
    return { ...base, end: RunEndKind.BudgetEnd };
  const { run } = composed;
  if (end.kind === FoundryEndKind.Failed) {
    composed.output.log({
      msg: TASKS_FAILED,
      reason: await run.reasonOf(end.error),
    });
    return { ...base, end: RunEndKind.Failed };
  }
  if (end.kind === FoundryEndKind.Stop)
    return {
      ...base,
      end: RunEndKind.Stop,
      stop: run.halt(end.stop),
      step: end.step,
    };
  const stop = await run.stopOf(run.operationContext.signal.reason);
  return { ...base, end: RunEndKind.Stop, stop };
}

function serializedInput(input: ReturnType<typeof implementInputOf>): unknown {
  return {
    claim: input.claim,
    setup: input.setup,
    revision: input.revision,
    root: input.root,
    workspaceKey: input.workspaceKey,
    checkouts: input.checkouts,
    heads: input.heads,
    setupEntries: input.setupEntries.map((entry) => ({
      binding_id: entry.repository.binding_id,
      name: entry.repository.name,
      directory: entry.directory,
    })),
    affectedTests: input.affectedTests,
    plan: input.plan,
    setupPending: input.setupPending,
    setupInstruction: input.setupInstruction,
    progress: input.progress,
    until: input.until,
    env: Object.keys(input.env),
  };
}

async function tasksEnd(
  composed: Composed,
  trees: LocalTrees,
): Promise<RunEnd> {
  const phase = await preparedPhase(composed, trees);
  if (phase.kind === PhaseEndKind.Stop) return stopEnd(phase.stop, phase.step);
  if (phase.kind === PhaseEndKind.BudgetEnd)
    return stopEnd(
      new ExecutionStop(EndReason.BudgetEnd, BudgetLimit.WallTime),
      null,
    );
  const { ctx } = phase;
  const { plan, run, budget, io, env } = composed;
  ctx.plan = plannedUnits(ctx.plan, plan.units, plan.claim.node_id);
  const input = implementInputOf(ctx, {
    cancel: run.operationContext,
    budget,
    until: plan.until,
    env,
  });
  const end = await foundryImplement(input, {
    capabilities: io.capabilities,
    ports: io.ports,
    steps: composed.steps,
  });
  return foundryEndOf(composed, end, serializedInput(input));
}

function exitOf(end: RunEnd, checks: readonly CheckResult[] | null): TasksExit {
  if (end.end === RunEndKind.Failed) return TasksExit.InternalError;
  if (end.end === RunEndKind.Stop) return TasksExit.Stopped;
  return checks?.some((check) => !check.passed)
    ? TasksExit.VerifyFailed
    : TasksExit.Success;
}

function stopRecord(stop: ExecutionStop | null) {
  return stop === null
    ? null
    : { reason: stop.reason, code: stop.code, detail: stop.detail };
}

interface Written {
  end: RunEnd;
  checks: readonly CheckResult[] | null;
  exitCode: TasksExit;
}

function resultRecord(target: RunTarget, written: Written) {
  const { plan, replay } = target;
  const { end, checks, exitCode } = written;
  const agent = plan.setup.agents[WORKING_AGENT]!;
  return {
    end: end.end,
    exit_code: exitCode,
    stop: stopRecord(end.stop),
    step: end.step,
    mode: replay === null ? RunMode.Live : RunMode.Replay,
    provider_id: agent.effective_configuration.provider,
    overrides: plan.overrides,
    seed_digest: plan.digest,
    checks,
  };
}

function writeOutputs(composed: Composed, written: Written): void {
  const { output } = composed;
  const { end } = written;
  output.writeJson(OutputFile.Result, resultRecord(composed, written));
  output.writeJson(OutputFile.Context, {
    input: end.input,
    result: end.result,
  });
  output.writeJson(OutputFile.Progress, {
    progress: end.result?.progress ?? null,
    current_unit: end.result?.currentUnit?.id ?? null,
    completed_units: end.result?.completedUnits ?? [],
    units: composed.steps.unitScopes(),
  });
  output.writeJson(OutputFile.Metrics, {
    ...metricsOf(output),
    steps: composed.steps.stepTimes(),
  });
}

function metricsOf(output: TasksOutput): object {
  const spans = new Map<
    string,
    {
      operation: string;
      start?: number;
      end?: number;
      attributes: Record<string, unknown>;
    }
  >();
  for (const record of output.spans()) {
    if (record.kind !== RecordKind.Span) continue;
    const span = spans.get(record.span_id) ?? {
      operation: record.operation,
      attributes: {},
    };
    span.start ??= record.start_time;
    span.end = record.end_time ?? span.end;
    Object.assign(span.attributes, record.attributes ?? {});
    spans.set(record.span_id, span);
  }
  const timed = [...spans.values()].filter(
    (span) => span.start !== undefined && span.end !== undefined,
  );
  const ms = (span: (typeof timed)[number]) => span.end! - span.start!;
  return {
    phases: timed
      .filter((span) => span.operation === SpanOperation.Phase)
      .map((span) => ({
        phase: span.attributes["kanthord.phase"],
        ms: ms(span),
      })),
    units: timed
      .filter((span) => span.operation === SpanOperation.Task)
      .map((span) => ({
        unit_id: span.attributes["kanthord.task.id"],
        ms: ms(span),
      })),
  };
}

function recordedSessions<T extends SessionTrace>(
  port: SessionPort<T>,
  turns: Turns,
): SessionPort<T> {
  return {
    async open(request, context) {
      const opened = await port.open(request, context);
      const { agent } = opened.session;
      agent.streamFunction = turns.stream(agent.streamFunction);
      return opened;
    },
  };
}

function composedOf(input: LocalTasksInput): {
  composed: Composed;
  opened: Set<NativeAgent>;
} {
  const { plan, output, credential } = input;
  const state = output.directory(STATE_DIRECTORY);
  const env = {
    ...input.env,
    ...FIXED_GIT_ENV,
    HOME: output.directory(STATE_DIRECTORY, HOME_DIRECTORY),
  };
  bindPiDirectory(
    input.piDirectory ?? output.directory(STATE_DIRECTORY, PI_DIRECTORY_NAME),
    env,
  );
  const secrets = [
    ...(input.replay === null ? credentialValues(credential.credential) : []),
    ...input.passValues,
  ];
  const knownSecrets = async () => secrets;
  const stop = new CancellationContext(input.stop);
  const steps = new StepRecord(output);
  const turns = new Turns({
    output,
    header: {
      seed_digest: plan.digest,
      overrides: plan.overrides as TurnsOverrides,
    },
    replay: input.replay?.turns ?? null,
    onDiverged: () =>
      stop.cancel(new ExecutionStop(EndReason.WorkerStopped, null)),
  });
  const run = new ExecutionRun({
    claim: plan.claim,
    clients: REFUSING_CLIENTS,
    credentials: { release: async () => {} },
    context: background,
    stop,
    log: (record) => output.log(record),
    telemetry: output.telemetry(),
    workerName: plan.setup.worker_name,
    secrets: knownSecrets,
    environmentDigests: environmentDigestsOf(plan.setup.repositories),
  });
  const budget = new ExecutionBudget({
    ...plan.claim,
    resource_budget: plan.setup.resource_budget,
  });
  const agent = plan.setup.agents[WORKING_AGENT]!;
  const store = {
    credential_id: agent.credential_id,
    provider_id: credential.provider_id,
    store: frozenStore(credential.provider_id, credential.credential),
  };
  const modelRuntimeFactory: SessionModelFactory = (request) =>
    input.modelRuntimeFactory({ ...request, credential: store });
  const capabilities = input.capabilities.map((capability) =>
    openWorldCapability(capability, turns),
  );
  const agentSessions = agentPort({
    capabilities,
    modelRuntimeFactory,
    knownSecrets,
    trace: nativeSessionTrace(run.spans),
    sessionRoot: null,
    budget,
    env,
    hostHome: env.HOME,
  });
  const sessions = recordedSessions(agentSessions, turns);
  const opened = new Set<NativeAgent>();
  const open = async (
    request: Parameters<typeof openNativeAgent>[0]["request"],
  ) => {
    const native = await openNativeAgent({
      sessions,
      request,
      budget,
      knownSecrets,
      context: run.operationContext,
    });
    opened.add(native);
    stopOnEnd(run, native);
    return native;
  };
  const host = { state, setup: plan.setup, env, run };
  const ports: ImplementHostPorts = {
    ...commonPorts(run),
    evidence: localEvidencePort(run, output),
    repository: localRepositoryPort(host),
    releaseTrees: localReleaseTreePort(host),
    claim: { check: async () => ok(null) },
    agent: agentOpenPort({ run, budget, open }),
  };
  return {
    composed: {
      plan,
      output,
      run,
      budget,
      env,
      turns,
      steps,
      replay: input.replay,
      io: {
        steps,
        run,
        budget,
        capabilities,
        resources: new AsyncDisposableStack(),
        host: { workspaces: null, transport: null, env },
        ports,
      },
    },
    opened,
  };
}

function bindPiDirectory(pi: string, env: NodeJS.ProcessEnv): void {
  installPiTools({ directory: pi, env });
  usePiDirectory(pi);
  if (piAgentDirectory() !== pi)
    throw new Error("The pi directory of the process is another directory.");
  if (existsSync(join(pi, PI_AUTH_FILE)))
    throw tasksDiagnostic(
      TasksErrorCode.CredentialInvalid,
      "worker tasks run: the pi directory holds a credential file.",
      [["field", PI_AUTH_FILE]],
    );
}

async function settled(work: () => Promise<void>): Promise<unknown> {
  try {
    await work();
    return null;
  } catch (error) {
    return error;
  }
}

async function disposed(
  composed: Composed,
  opened: ReadonlySet<NativeAgent>,
): Promise<unknown> {
  const failures: unknown[] = [];
  for (const agent of opened)
    failures.push(
      await settled(async () => {
        await agent.abort();
        await agent.close();
      }),
    );
  failures.push(await settled(() => composed.io.resources.disposeAsync()));
  unlockTree(join(composed.output.state, ORIGIN_DIRECTORY));
  composed.run.dispose();
  return failures.find((failure) => failure !== null) ?? null;
}

interface RunTarget {
  plan: TasksPlan;
  output: TasksOutput;
  replay: LocalReplay | null;
}

function endOf(kind: RunEndKind): RunEnd {
  return { end: kind, stop: null, step: null, result: null, input: null };
}

function failedRun(target: RunTarget, reason: string | null): LocalTasksEnd {
  target.output.log({ msg: TASKS_FAILED, reason });
  target.output.writeJson(
    OutputFile.Result,
    resultRecord(target, {
      end: endOf(RunEndKind.Failed),
      checks: null,
      exitCode: TasksExit.InternalError,
    }),
  );
  return {
    end: RunEndKind.Failed,
    exitCode: TasksExit.InternalError,
    output: target.output.folder,
  };
}

function diagnosticEnd(target: RunTarget, error: Diagnostic): Diagnostic {
  target.output.writeJson(OutputFile.Result, {
    ...resultRecord(target, {
      end: endOf(RunEndKind.Diagnostic),
      checks: null,
      exitCode: TasksExit.Diagnostic,
    }),
    code: error.code,
    fields: Object.fromEntries(error.fields),
  });
  return error;
}

function endedBefore(input: LocalTasksInput, error: unknown): LocalTasksEnd {
  if (error instanceof Diagnostic) throw diagnosticEnd(input, error);
  return failedRun(input, error instanceof Error ? error.message : null);
}

async function preparedTrees(composed: Composed): Promise<LocalTrees | null> {
  const { plan, output, run, env } = composed;
  try {
    return await prepareTrees(
      {
        state: output.state,
        setup: plan.setup,
        nodeBranch: plan.claim.node_branch,
        sources: plan.trees,
        heads: plan.seed.heads,
      },
      {
        env,
        context: run.operationContext,
        deadline: wallDeadlineOfPlan(plan),
      },
    );
  } catch (error) {
    if (run.operationContext.signal.aborted) return null;
    throw error;
  }
}

export async function runTasksLocal(
  input: LocalTasksInput,
): Promise<LocalTasksEnd> {
  let built: ReturnType<typeof composedOf>;
  try {
    built = composedOf(input);
  } catch (error) {
    return endedBefore(input, error);
  }
  const { composed, opened } = built;
  let ended: LocalTasksEnd | null = null;
  let failure: unknown = null;
  try {
    ended = await endedRun(composed);
  } catch (error) {
    if (error instanceof Diagnostic) {
      await disposed(composed, opened);
      throw diagnosticEnd(composed, error);
    }
    failure = error;
  }
  const disposal = await disposed(composed, opened);
  failure ??= disposal;
  return failure === null
    ? ended!
    : failedRun(composed, await composed.run.reasonOf(failure));
}

async function endedRun(composed: Composed): Promise<LocalTasksEnd> {
  const { plan, output, run } = composed;
  const trees = await preparedTrees(composed);
  if (trees === null) {
    const end = stopEnd(
      await run.stopOf(run.operationContext.signal.reason),
      null,
    );
    writeOutputs(composed, {
      end,
      checks: null,
      exitCode: exitOf(end, null),
    });
    return {
      end: end.end,
      exitCode: exitOf(end, null),
      output: output.folder,
    };
  }
  const end = await tasksEnd(composed, trees);
  if (composed.turns.failure !== null) throw composed.turns.failure;
  const { turns } = composed;
  if (end.end === RunEndKind.Completed && turns.unused()) turns.markUnused();
  if (turns.diverged !== null) throw replayDiverged(turns.diverged);
  const checks = plan.verify
    ? await verifyRun({
        end,
        trees,
        plan,
        env: composed.env,
        until: plan.until,
        output: output.folder,
        recorded: composed.replay === null ? null : composed.replay.folder,
      })
    : null;
  const exitCode = exitOf(end, checks);
  writeOutputs(composed, { end, checks, exitCode });
  assert.ok(exitCode !== TasksExit.Diagnostic);
  return { end: end.end, exitCode, output: output.folder };
}
