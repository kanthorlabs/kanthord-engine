import assert from "node:assert/strict";
import type { Context } from "../../kernel/context.ts";
import {
  deriveSshSignKeys,
  handoverAad,
  openEnvelope,
  sealEnvelope,
} from "../../kernel/handover.ts";
import {
  sshSignAnswerSchema,
  type SshSignRequest,
} from "../../custody/contract.ts";
import type { SshSigner } from "../../repository/contract.ts";
import type { ExecutionRecord } from "../../scheduler/contract.ts";
import { retryIndeterminate } from "./api.ts";
import { completed } from "./handover.ts";
import type { WorkerTransport } from "./transport.ts";

export interface RelaySignerInput {
  api: WorkerTransport;
  claim: ExecutionRecord;
  clientSecret: string;
  bindingId: string;
}

export function relaySigner(input: RelaySignerInput): SshSigner {
  const { api, claim, bindingId } = input;
  assert.ok(claim.execution_id);
  assert.ok(input.clientSecret);
  assert.ok(bindingId);
  const aad = handoverAad(claim.execution_id, claim.claimant.runtime_identity);
  return async (data: Buffer, flags: number, context: Context) => {
    const keys = deriveSshSignKeys(input.clientSecret);
    try {
      const request: SshSignRequest = {
        binding_id: bindingId,
        data: data.toString("base64"),
        flags,
      };
      const sealed = sealEnvelope(keys.request, aad, request);
      const answer = completed(
        await retryIndeterminate(
          (key) =>
            api.worker["ssh.sign"](
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
      const opened = sshSignAnswerSchema.parse(
        openEnvelope(keys.answer, aad, answer),
      );
      return Buffer.from(opened.signature, "base64");
    } finally {
      keys.request.fill(0);
      keys.answer.fill(0);
    }
  };
}
