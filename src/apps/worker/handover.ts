import assert from "node:assert/strict";
import { CancellationContext, type Context } from "../../kernel/context.ts";
import { Diagnostic } from "../../kernel/errors.ts";
import {
  deriveHandoverKeys,
  handoverAad,
  openEnvelope,
  sealEnvelope,
  HandoverOpenError,
} from "../../kernel/handover.ts";
import {
  OperationResultType,
  type OperationResult,
} from "../../kernel/operation.ts";
import { handoverPayloadSchema } from "../../custody/contract.ts";
import { executionCredentialStore } from "../../custody/client.ts";
import type { ExecutionRecord } from "../../scheduler/contract.ts";
import { retryIndeterminate, type WorkerApi } from "./api.ts";

export class HandoverRefused extends Diagnostic {
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(code, message);
    this.status = status;
  }
}

export function completed<T>(result: OperationResult<T>): T {
  if (result.type === OperationResultType.Completed) return result.data;
  if (result.type === OperationResultType.Failure)
    throw new HandoverRefused(
      result.error.error.code,
      result.error.error.message,
      result.status,
    );
  throw new HandoverRefused(
    "gateway.invocation.timeout",
    "worker: operation answer is indeterminate.",
    504,
  );
}

export async function takeHandover(input: {
  api: WorkerApi;
  claim: ExecutionRecord;
  clientSecret: string;
  context: Context;
}) {
  const { api, claim } = input;
  assert.ok(claim.executionId);
  assert.ok(input.clientSecret);
  const context = new CancellationContext(input.context, claim.expiredAt);
  const keys = deriveHandoverKeys(input.clientSecret);
  const aad = handoverAad(claim.executionId, claim.claimant.runtimeIdentity);
  try {
    const envelope = completed(
      await retryIndeterminate(
        (key) =>
          api.worker.handover(
            { params: {}, query: {}, body: { executionId: claim.executionId } },
            { context, idempotencyKey: key },
          ),
        claim.expiredAt,
        context,
      ),
    );
    const payload = handoverPayloadSchema.parse(
      openEnvelope(keys.handover, aad, envelope),
    );
    const item = payload.items[0]!;
    const credentials = executionCredentialStore(payload, async (report) => {
      const sealed = sealEnvelope(keys.report, aad, report);
      completed(
        await retryIndeterminate(
          (key) =>
            api.worker.credential(
              {
                params: {},
                query: {},
                body: { executionId: claim.executionId, ...sealed },
              },
              { context, idempotencyKey: key },
            ),
          claim.expiredAt,
          context,
        ),
      );
    });
    keys.handover.fill(0);
    return {
      credentials: {
        store: credentials.store,
        release: () => credentials.release(),
        discard() {
          credentials.discard();
          keys.report.fill(0);
          context.cancel();
        },
      },
      handoverItem: {
        credentialId: item.credentialId,
        providerId: item.providerId,
      },
    };
  } catch (error) {
    context.cancel();
    keys.handover.fill(0);
    keys.report.fill(0);
    if (error instanceof HandoverOpenError)
      throw new Diagnostic(
        "worker.handover.decryption_failed",
        "worker: credential handover could not be decrypted.",
      );
    throw error;
  }
}
