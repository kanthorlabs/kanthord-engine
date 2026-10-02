import assert from "node:assert/strict";
import { z } from "zod";
import { ulid } from "ulid";
import { executionCredentialStore } from "../../custody/client.ts";
import {
  handoverPayloadSchema,
  EXECUTION_CREDENTIAL_MAX_BYTES,
} from "../../custody/contract.ts";
import { httpClient } from "../../gateway/client.ts";
import {
  deriveHandoverKeys,
  handoverAad,
  openEnvelope,
  sealEnvelope,
} from "../../kernel/handover.ts";
import { canonicalJSON } from "../../kernel/json.ts";
import { OperationResultType } from "../../kernel/operation.ts";
import { workerOperations } from "../../worker/contract.ts";

const options = z
  .strictObject({
    endpoint: z.url(),
    token: z.string(),
    clientSecret: z.string(),
    executionId: z.string(),
    runtimeIdentity: z.string(),
  })
  .parse(JSON.parse(process.argv[2]!));
const client = httpClient(workerOperations, options.endpoint, options.token);
const keys = deriveHandoverKeys(options.clientSecret);
const aad = handoverAad(options.executionId, options.runtimeIdentity);
try {
  const handover = await client.handover(
    { params: {}, query: {}, body: { executionId: options.executionId } },
    { idempotencyKey: ulid() },
  );
  assert.ok(handover.type === OperationResultType.Completed);
  const payload = handoverPayloadSchema.parse(
    openEnvelope(keys.handover, aad, handover.data),
  );
  assert.equal(
    Buffer.byteLength(canonicalJSON(payload.items[0]!.credential)),
    EXECUTION_CREDENTIAL_MAX_BYTES,
  );
  let reportBytes: number | undefined;
  const view = executionCredentialStore(payload, async (report) => {
    const body = {
      executionId: options.executionId,
      ...sealEnvelope(keys.report, aad, report),
    };
    reportBytes = Buffer.byteLength(JSON.stringify(body));
    const result = await client.credential(
      { params: {}, query: {}, body },
      { idempotencyKey: ulid() },
    );
    assert.ok(result.type === OperationResultType.Completed);
    assert.equal(result.data, null);
  });
  try {
    await view.release();
    process.stdout.write(
      `${JSON.stringify({ reportBytes, released: true })}\n`,
    );
  } finally {
    view.discard();
  }
} finally {
  keys.handover.fill(0);
  keys.report.fill(0);
}
