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
import {
  handoverPayloadSchema,
  type HandoverPayload,
  type SealedHandoverItem,
  type WireReport,
} from "../../custody/contract.ts";
import {
  executionCredentialStore,
  openSealedCopy,
  sealedCopyReporter,
  type InstanceCopyKey,
  type OpenedCopy,
} from "../../custody/client.ts";
import { isLlmPlatform, LLM_PLATFORMS } from "../../llm/platforms.ts";
import type { ExecutionRecord } from "../../scheduler/contract.ts";
import { retryIndeterminate } from "./api.ts";
import type { WorkerTransport } from "./transport.ts";

export class HandoverRefused extends Diagnostic {
  readonly status: number;
  readonly result?: Extract<OperationResult<never>, { type: "failure" }>;
  constructor(
    code: string,
    message: string,
    status: number,
    result?: Extract<OperationResult<never>, { type: "failure" }>,
  ) {
    super(code, message);
    this.status = status;
    this.result = result;
  }
}

export function completed<T>(result: OperationResult<T>): T {
  if (result.type === OperationResultType.Completed) return result.data;
  if (result.type === OperationResultType.Failure)
    throw new HandoverRefused(
      result.error.error.code,
      result.error.error.message,
      result.status,
      result,
    );
  throw new HandoverRefused(
    "gateway.invocation.timeout",
    "worker: operation answer is indeterminate.",
    504,
  );
}

function sealedRefused(): Diagnostic {
  return new Diagnostic(
    "worker.handover.sealed_unopened",
    "worker: the sealed credential copy cannot be opened with the instance key.",
  );
}

async function openSealedItem(
  item: SealedHandoverItem,
  key: InstanceCopyKey | undefined,
): Promise<OpenedCopy> {
  if (key === undefined || !isLlmPlatform(item.platform)) throw sealedRefused();
  const opened = await openSealedCopy(
    item,
    LLM_PLATFORMS[item.platform].secret_shape,
    key,
  );
  if (opened === null) throw sealedRefused();
  return opened;
}

async function executionItems(
  items: HandoverPayload["items"],
  key: InstanceCopyKey | undefined,
  send: (report: WireReport) => Promise<void>,
) {
  const views = [];
  for (const item of items) {
    if ("credential" in item) {
      views.push({
        item,
        view: executionCredentialStore({ items: [item] }, send),
      });
      continue;
    }
    const opened = await openSealedItem(item, key);
    assert.ok(key);
    const plain = {
      credential_id: item.credential_id,
      provider_id: item.provider_id,
      credential: opened.credential,
    };
    views.push({
      item: plain,
      view: executionCredentialStore(
        { items: [plain] },
        sealedCopyReporter(item, opened, key, send),
      ),
    });
  }
  return views;
}

export async function takeHandover(input: {
  api: WorkerTransport;
  claim: ExecutionRecord;
  clientSecret: string;
  instanceKey?: InstanceCopyKey;
  context: Context;
}) {
  const { api, claim } = input;
  assert.ok(claim.execution_id);
  assert.ok(input.clientSecret);
  const context = new CancellationContext(input.context, claim.expired_at);
  const keys = deriveHandoverKeys(input.clientSecret);
  const aad = handoverAad(claim.execution_id, claim.claimant.runtime_identity);
  try {
    const envelope = completed(
      await retryIndeterminate(
        (key) =>
          api.worker.handover(
            {
              params: {},
              query: {},
              body: { execution_id: claim.execution_id },
            },
            { context, idempotencyKey: key },
          ),
        claim.expired_at,
        context,
      ),
    );
    const payload = handoverPayloadSchema.parse(
      openEnvelope(keys.handover, aad, envelope),
    );
    const report = async (refresh: WireReport) => {
      const sealed = sealEnvelope(keys.report, aad, refresh);
      completed(
        await retryIndeterminate(
          (key) =>
            api.worker.credential(
              {
                params: {},
                query: {},
                body: { execution_id: claim.execution_id, ...sealed },
              },
              { context, idempotencyKey: key },
            ),
          claim.expired_at,
          context,
        ),
      );
    };
    keys.handover.fill(0);
    const views = await executionItems(
      payload.items,
      input.instanceKey,
      report,
    );
    const sshIdentities = payload.ssh_identities;
    return {
      sshIdentities,
      credentials: {
        items: views.map(({ item, view }) => ({
          credential_id: item.credential_id,
          provider_id: item.provider_id,
          store: view.store,
        })),
        release: async () => {
          for (const { view } of views) await view.release();
        },
        discard() {
          for (const { view } of views) view.discard();
          sshIdentities.length = 0;
          keys.report.fill(0);
          context.cancel();
        },
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
