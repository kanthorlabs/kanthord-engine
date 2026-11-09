import assert from "node:assert/strict";
import { CancellationContext, type Context } from "../../kernel/context.ts";
import { CodedError, Diagnostic } from "../../kernel/errors.ts";
import {
  type OperationResult,
  OperationResultType,
} from "../../kernel/operation.ts";
import type { ExecutionRecord } from "../../scheduler/contract.ts";
import type { SshAccess } from "../../repository/contract.ts";
import {
  EndReason,
  type ExecutionEnd,
  ExecutionEndKind,
  handedSshAccess,
  isExecutionEnd,
  type ModelRuntimeFactory,
  type NativeExecutionInput,
  releaseSetupRefusal,
  type RepositoryTransport,
  runNativeExecution,
  type WorkspaceRoot,
} from "../../worker/unit/index.ts";
import { completed, HandoverRefused, takeHandover } from "./handover.ts";
import type { CopyKeys } from "./copy-keys.ts";
import { retryIndeterminate } from "./api.ts";
import type { WorkerTransport } from "./transport.ts";
import { uploadEvidence } from "./evidence-upload.ts";
import { relaySigner } from "./ssh-relay.ts";
import { HttpTelemetrySink } from "./telemetry-sink.ts";
import { SETUP_UNAVAILABLE } from "./pull-loop.ts";

export interface HostExecutionInput {
  claim: ExecutionRecord;
  api: WorkerTransport;
  clientSecret: string;
  copyKeys?: CopyKeys;
  workspaces: WorkspaceRoot;
  transport: RepositoryTransport;
  modelRuntimeFactory: ModelRuntimeFactory;
  hostHome: string;
  env: NodeJS.ProcessEnv;
  context: Context;
  stop?: Context;
  sessionRoot?: string;
  log(record: Record<string, unknown>): void;
}

const GATEWAY_CODE_PREFIX = "gateway.";
const SETUP_UNAVAILABLE_RECORD = "worker.execution.setup_unavailable";
const NO_CREDENTIALS = { items: [], release: async () => {} };

function setupRefusalOf(answer: OperationResult<unknown>): Diagnostic | null {
  if (
    answer.type !== OperationResultType.Failure ||
    isExecutionEnd(answer) ||
    answer.error.error.code.startsWith(GATEWAY_CODE_PREFIX)
  )
    return null;
  return new Diagnostic(answer.error.error.code, answer.error.error.message, {
    details: answer.error.error.details ?? null,
  });
}

function handoverRefusalOf(error: unknown): Diagnostic | null {
  if (error instanceof HandoverRefused)
    return error.result ? setupRefusalOf(error.result) : null;
  return error instanceof Diagnostic ? error : null;
}

function detailOf(result: ExecutionEnd): string | undefined {
  if (result.kind === ExecutionEndKind.Ended) return result.detail;
  if (result.kind === ExecutionEndKind.Released) return result.stop?.detail;
  return undefined;
}

function endOf(
  input: HostExecutionInput,
  context: Context,
  result: ExecutionEnd,
): Diagnostic | null {
  context.signal.throwIfAborted();
  const detail = detailOf(result);
  input.log({
    msg: "execution ended",
    execution_id: input.claim.execution_id,
    kind: result.kind,
    ...(result.kind === ExecutionEndKind.Ended
      ? { reason: result.reason, code: result.code }
      : {}),
    ...(result.kind === ExecutionEndKind.Released && result.stop
      ? { reason: result.stop.reason, code: result.stop.code }
      : {}),
    ...(detail === undefined ? {} : { detail }),
  });
  if (
    result.kind !== ExecutionEndKind.Ended ||
    result.reason === EndReason.Revoked
  )
    return null;
  return new Diagnostic(
    result.code ?? "system.operation.unknown",
    "worker: execution cannot progress.",
  );
}

type HandedOver = Awaited<ReturnType<typeof takeHandover>>;
type HostStep = Diagnostic | null | typeof SETUP_UNAVAILABLE;

interface HostExecutionState {
  handover?: HandedOver;
  sshAccess?: Map<string, SshAccess>;
  revoked: boolean;
}

interface HostRun {
  input: HostExecutionInput;
  context: CancellationContext;
  telemetry: HttpTelemetrySink;
  state: HostExecutionState;
  execute: typeof runNativeExecution;
}

interface SetupExecution {
  handover: HandedOver;
  setup: NativeExecutionInput["setup"];
}

function endsExecution(error: unknown): boolean {
  if (!(error instanceof HandoverRefused) || !error.result) return false;
  return isExecutionEnd(error.result);
}

function hostToolCaller(run: HostRun) {
  return async <T>(
    signal: AbortSignal | undefined,
    work: (callContext: CancellationContext) => Promise<T>,
  ): Promise<T> => {
    const callContext = new CancellationContext(run.context);
    const abort = () => callContext.cancel();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try {
      return await work(callContext);
    } catch (error) {
      if (endsExecution(error)) {
        run.state.revoked = true;
        run.context.cancel();
      }
      throw error;
    } finally {
      signal?.removeEventListener("abort", abort);
      callContext.cancel();
    }
  };
}

function hostToolsOf(run: HostRun): NativeExecutionInput["hostTools"] {
  const callTool = hostToolCaller(run);
  const { input } = run;
  return (workspace) => ({
    evidenceUpload: (path, signal) =>
      callTool(signal, (callContext) =>
        uploadEvidence({
          workspace,
          path,
          claim: input.claim,
          api: input.api,
          context: callContext,
        }),
      ),
    linkUpdateList: (page, signal) =>
      callTool(signal, async (callContext) =>
        completed(
          await input.api.worker["execution.link_update.get"](
            {
              params: { execution_id: input.claim.execution_id },
              query: page,
              body: null,
            },
            { context: callContext },
          ),
        ),
      ),
  });
}

function releaseRefusal(
  run: HostRun,
  refusal: Diagnostic,
): Promise<ExecutionEnd> {
  return releaseSetupRefusal(
    {
      ...run.input,
      clients: run.input.api,
      credentials: run.state.handover?.credentials ?? NO_CREDENTIALS,
      context: run.context,
      telemetry: run.telemetry,
    },
    refusal,
  );
}

async function takeHandoverOrRefusal(
  run: HostRun,
): Promise<HandedOver | Diagnostic> {
  try {
    return await takeHandover({ ...run.input, context: run.context });
  } catch (error) {
    const refusal = handoverRefusalOf(error);
    if (!refusal) throw error;
    return refusal;
  }
}

function executeSetup(
  run: HostRun,
  { handover, setup }: SetupExecution,
): Promise<ExecutionEnd> {
  const { input } = run;
  run.state.sshAccess = handedSshAccess(
    handover.sshIdentities,
    setup.repositories,
    (bindingId) => relaySigner({ ...input, bindingId }),
  );
  return run.execute({
    ...input,
    setup,
    clients: input.api,
    credentials: handover.credentials,
    sshAccess: run.state.sshAccess,
    context: run.context,
    telemetry: run.telemetry,
    hostTools: hostToolsOf(run),
  });
}

async function executeHandedOver(
  run: HostRun,
  handover: HandedOver,
): Promise<ExecutionEnd> {
  const { input, context } = run;
  input.log({
    msg: "credential handover received",
    execution_id: input.claim.execution_id,
    credential_ids: handover.credentials.items.map(
      (item) => item.credential_id,
    ),
  });
  const answer = await retryIndeterminate(
    () =>
      input.api.worker["execution.setup.get"](
        {
          params: { execution_id: input.claim.execution_id },
          query: {},
          body: null,
        },
        { context },
      ),
    input.claim.expired_at,
    context,
  );
  const refusal = setupRefusalOf(answer);
  if (refusal) return releaseRefusal(run, refusal);
  return executeSetup(run, { handover, setup: completed(answer) });
}

function failureOf(run: HostRun, error: unknown): HostStep {
  const { input } = run;
  if (run.state.revoked || endsExecution(error)) return null;
  if (
    error instanceof HandoverRefused &&
    error.code.startsWith(GATEWAY_CODE_PREFIX)
  ) {
    input.log({
      msg: SETUP_UNAVAILABLE_RECORD,
      execution_id: input.claim.execution_id,
      code: error.code,
    });
    return SETUP_UNAVAILABLE;
  }
  if (error instanceof Diagnostic) return error;
  return new Diagnostic(
    error instanceof CodedError ? error.code : "system.operation.unknown",
    "worker: execution cannot progress.",
  );
}

export async function hostExecution(
  input: HostExecutionInput,
  execute = runNativeExecution,
): Promise<HostStep> {
  assert.ok(input.claim.execution_id);
  assert.ok(input.clientSecret);
  const context = new CancellationContext(
    input.context,
    input.claim.expired_at,
  );
  const run: HostRun = {
    input,
    context,
    execute,
    state: { revoked: false },
    telemetry: new HttpTelemetrySink({
      executionId: input.claim.execution_id,
      send: (request, options) =>
        input.api.tracking.telemetryWrite(request, options),
      log: input.log,
    }),
  };
  try {
    context.signal.throwIfAborted();
    const taken = await takeHandoverOrRefusal(run);
    if (taken instanceof Diagnostic)
      return endOf(input, context, await releaseRefusal(run, taken));
    run.state.handover = taken;
    const result = await executeHandedOver(run, taken);
    if (run.state.revoked) return null;
    return endOf(input, context, result);
  } catch (error) {
    return failureOf(run, error);
  } finally {
    run.state.sshAccess?.clear();
    run.state.handover?.credentials.discard();
    run.telemetry.close();
    context.cancel();
  }
}
