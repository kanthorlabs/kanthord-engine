import assert from "node:assert/strict";
import {
  CancellationContext,
  type Context,
  throwIfCancelled,
} from "../../kernel/context.ts";
import { CodedError, Diagnostic } from "../../kernel/errors.ts";
import type { ExecutionRecord } from "../../scheduler/contract.ts";
import type { SshAccess } from "../../repository/contract.ts";
import {
  runNativeExecution,
  type TranscriptSink,
  isExecutionEnd,
  EndReason,
  ExecutionEndKind,
  type WorkspaceRoot,
  type RepositoryTransport,
  type ModelRuntimeFactory,
  handedSshAccess,
} from "../../worker/unit/index.ts";
import { completed, HandoverRefused, takeHandover } from "./handover.ts";
import { retryIndeterminate } from "./api.ts";
import type { WorkerTransport } from "./transport.ts";
import { uploadEvidence } from "./evidence-upload.ts";
import { HttpTelemetrySink } from "./telemetry-sink.ts";

export interface HostExecutionInput {
  claim: ExecutionRecord;
  api: WorkerTransport;
  clientSecret: string;
  workspaces: WorkspaceRoot;
  transport: RepositoryTransport;
  modelRuntimeFactory: ModelRuntimeFactory;
  hostHome: string;
  env: NodeJS.ProcessEnv;
  context: Context;
  transcript: TranscriptSink;
  log(record: Record<string, unknown>): void;
}

export async function hostExecution(
  input: HostExecutionInput,
  execute = runNativeExecution,
): Promise<Diagnostic | null> {
  assert.ok(input.claim.execution_id);
  assert.ok(input.clientSecret);
  let handover: Awaited<ReturnType<typeof takeHandover>> | undefined;
  let sshAccess: Map<string, SshAccess> | undefined;
  let revoked = false;
  const context = new CancellationContext(
    input.context,
    input.claim.expired_at,
  );
  const telemetry = new HttpTelemetrySink({
    executionId: input.claim.execution_id,
    send: (request, options) =>
      input.api.tracking.telemetryWrite(request, options),
    log: input.log,
  });
  try {
    throwIfCancelled(context);
    handover = await takeHandover({ ...input, context });
    input.log({
      msg: "credential handover received",
      execution_id: input.claim.execution_id,
      credential_ids: handover.credentials.items.map(
        (item) => item.credential_id,
      ),
    });
    const setup = completed(
      await retryIndeterminate(
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
      ),
    );
    sshAccess = handedSshAccess(handover.sshIdentities, setup.repositories);
    const result = await execute({
      ...input,
      setup,
      clients: input.api,
      credentials: handover.credentials,
      sshAccess,
      context,
      telemetry,
      hostTools: (workspace) => ({
        evidenceUpload: async (path, signal) => {
          const uploadContext = new CancellationContext(context);
          const abort = () => uploadContext.cancel();
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
          try {
            return await uploadEvidence({
              workspace,
              path,
              claim: input.claim,
              api: input.api,
              context: uploadContext,
            });
          } catch (error) {
            if (
              error instanceof HandoverRefused &&
              error.result &&
              isExecutionEnd(error.result)
            ) {
              revoked = true;
              context.cancel();
            }
            throw error;
          } finally {
            signal?.removeEventListener("abort", abort);
            uploadContext.cancel();
          }
        },
      }),
    });
    if (revoked) return null;
    if (context.err()) throw context.err();
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
  } catch (error) {
    if (revoked) return null;
    if (
      error instanceof HandoverRefused &&
      error.result &&
      isExecutionEnd(error.result)
    )
      return null;
    if (error instanceof Diagnostic) return error;
    return new Diagnostic(
      error instanceof CodedError ? error.code : "system.operation.unknown",
      "worker: execution cannot progress.",
    );
  } finally {
    sshAccess?.clear();
    handover?.credentials.discard();
    telemetry.close();
    context.cancel();
  }
}
