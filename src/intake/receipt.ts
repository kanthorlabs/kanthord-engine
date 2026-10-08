import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { identitySchema } from "../kernel/identity.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import { classifyDelivery, DeliveryKind } from "../repository/github.ts";
import {
  INBOUND_ID_PREFIX,
  InboundKind,
  InboundPlatform,
  IntakeErrorCode,
} from "./contract.ts";
import {
  findEvent,
  insertEvent,
  pendingCount,
  type NewInboundEvent,
} from "./event-store.ts";
import { readInbound } from "./inbound-store.ts";
import { webhookSecret } from "./webhook-secret.ts";

const SIGNATURE_HEADER = "x-hub-signature-256";
const SIGNATURE_PREFIX = "sha256=";
const SIGNATURE_DIGEST_PATTERN = /^[0-9a-fA-F]{64}$/;
const SIGNATURE_ALGORITHM = "sha256";
const DIGEST_ENCODING = "hex";
const DIGEST_BYTES = 32;
const VALIDATION_FAILED_CODE = "gateway.request.validation_failed";
const HEADER_VALUE_SEPARATOR = ",";
const NO_LENGTH = 0;
const NO_EVENTS = 0;

const receiptParamsSchema = z.strictObject({
  inbound_id: identitySchema(INBOUND_ID_PREFIX),
});

export interface ReceiptDependencies {
  store: Store;
  masterKey: string;
  pendingEventLimit: number;
  wake(): void;
}

function inboundNotFound(): OperationError {
  return new OperationError(
    HttpStatus.NotFound,
    IntakeErrorCode.InboundNotFound,
    "Inbound not found.",
  );
}

function webhookInboundOf(store: Store, params: unknown): string {
  const parsed = receiptParamsSchema.safeParse(params);
  if (!parsed.success) throw inboundNotFound();
  const inboundId = parsed.data.inbound_id;
  const row = store.transaction((tx) => readInbound(tx, inboundId));
  if (row === null || row.kind !== InboundKind.Webhook) throw inboundNotFound();
  assert.equal(row.platform, InboundPlatform.GitHub);
  return inboundId;
}

function claimedDigest(headers: Headers): Buffer | null {
  const value = headers.get(SIGNATURE_HEADER);
  if (value === null || value.includes(HEADER_VALUE_SEPARATOR)) return null;
  if (!value.startsWith(SIGNATURE_PREFIX)) return null;
  const digest = value.slice(SIGNATURE_PREFIX.length);
  if (!SIGNATURE_DIGEST_PATTERN.test(digest)) return null;
  const bytes = Buffer.from(digest, DIGEST_ENCODING);
  assert.equal(bytes.length, DIGEST_BYTES);
  return bytes;
}

function verifySignature(
  secret: string,
  bytes: Uint8Array,
  headers: Headers,
): void {
  assert.ok(secret.length > NO_LENGTH, "A verification secret is required.");
  const claimed = claimedDigest(headers);
  const computed = createHmac(SIGNATURE_ALGORITHM, secret)
    .update(bytes)
    .digest();
  assert.equal(computed.length, DIGEST_BYTES);
  if (claimed === null || !timingSafeEqual(claimed, computed))
    throw new OperationError(
      HttpStatus.Unauthorized,
      IntakeErrorCode.InboundEventSignatureInvalid,
      "Delivery signature is invalid.",
    );
}

function storeEvent(
  tx: Transaction,
  pendingEventLimit: number,
  event: NewInboundEvent,
): null {
  assert.ok(
    Number.isSafeInteger(pendingEventLimit) && pendingEventLimit > NO_EVENTS,
  );
  if (findEvent(tx, event.inbound_id, event.event_id) !== null) return null;
  if (pendingCount(tx) >= pendingEventLimit)
    throw new OperationError(
      HttpStatus.ServiceUnavailable,
      IntakeErrorCode.InboundEventCapacityExceeded,
      "Pending inbound events reached their bound.",
    );
  insertEvent(tx, event);
  return null;
}

export function receiveEvent(
  dependencies: ReceiptDependencies,
  caller: CallerContext,
  params: unknown,
): Response {
  const delivery = caller.delivery;
  assert.ok(delivery, "A receipt requires the exact delivery bytes.");
  assert.equal(caller.identity, undefined);
  const inboundId = webhookInboundOf(dependencies.store, params);
  const bytes = new Uint8Array(delivery.bytes);
  verifySignature(
    webhookSecret(dependencies.masterKey, inboundId),
    bytes,
    delivery.headers,
  );
  const classification = classifyDelivery(delivery.headers);
  if (classification.kind === DeliveryKind.Handshake)
    return new Response(null, { status: classification.status });
  if (classification.kind === DeliveryKind.Invalid)
    throw new OperationError(
      HttpStatus.BadRequest,
      VALIDATION_FAILED_CODE,
      "Delivery headers are invalid.",
    );
  caller.commit((tx) =>
    storeEvent(tx, dependencies.pendingEventLimit, {
      inbound_id: inboundId,
      event_id: classification.event_id,
      event: bytes,
      metadata: classification.metadata,
      created_at: Date.now(),
    }),
  );
  dependencies.wake();
  return new Response(null, { status: HttpStatus.Accepted });
}
