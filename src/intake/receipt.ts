import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { apiKeySecretSchema, InboundOperation } from "../custody/contract.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { identitySchema } from "../kernel/identity.ts";
import type { CallerContext } from "../kernel/operation.ts";
import type { Store, Transaction } from "../kernel/store.ts";
import {
  classifyDelivery,
  type DeliveryClassification,
  DeliveryKind,
} from "../repository/github.ts";
import {
  INBOUND_ID_PREFIX,
  InboundKind,
  InboundPlatform,
  type InboundPlatformValue,
  IntakeErrorCode,
} from "./contract.ts";
import { configurationSchemaOf } from "./configuration.ts";
import { Platform } from "./credential-platform.ts";
import {
  findEvent,
  insertEvent,
  type NewInboundEvent,
  pendingCount,
} from "./event-store.ts";
import { readInbound } from "./inbound-store.ts";
import { classifyJiraDelivery, JIRA_SIGNATURE_HEADER } from "./jira.ts";
import { type PollReleaseDependencies, releaseInboundGrant } from "./poll.ts";
import {
  classifySlackDelivery,
  SlackDeliveryKind,
  slackSignatureValid,
} from "./slack.ts";
import { webhookSecret } from "./webhook-secret.ts";

const GITHUB_SIGNATURE_HEADER = "x-hub-signature-256";
type DerivedSecretPlatform = Exclude<
  InboundPlatformValue,
  typeof InboundPlatform.Slack
>;
const SIGNATURE_HEADERS: Readonly<Record<DerivedSecretPlatform, string>> = {
  [InboundPlatform.GitHub]: GITHUB_SIGNATURE_HEADER,
  [InboundPlatform.Jira]: JIRA_SIGNATURE_HEADER,
};
const SIGNATURE_PREFIX = "sha256=";
const SIGNATURE_DIGEST_PATTERN = /^[0-9a-fA-F]{64}$/;
const SIGNATURE_ALGORITHM = "sha256";
const DIGEST_ENCODING = "hex";
const DIGEST_BYTES = 32;
const VALIDATION_FAILED_CODE = "gateway.request.validation_failed";
const HEADER_VALUE_SEPARATOR = ",";
const EMPTY_TEXT_LENGTH = 0;
const PENDING_LIMIT_FLOOR = 0;

const receiptParamsSchema = z.strictObject({
  inbound_id: identitySchema(INBOUND_ID_PREFIX),
});

export interface ReceiptDependencies extends PollReleaseDependencies {
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

interface WebhookInbound {
  id: string;
  project_id: string;
  platform: InboundPlatformValue;
  credential: string | null;
  resource: string;
}

function webhookInboundOf(store: Store, params: unknown): WebhookInbound {
  const parsed = receiptParamsSchema.safeParse(params);
  if (!parsed.success) throw inboundNotFound();
  const inboundId = parsed.data.inbound_id;
  const row = store.transaction((tx) => readInbound(tx, inboundId));
  if (row === null || row.kind !== InboundKind.Webhook) throw inboundNotFound();
  return {
    id: inboundId,
    project_id: row.project_id,
    platform: row.platform,
    credential: row.credential,
    resource: configurationSchemaOf(row.kind, row.platform).parse(
      JSON.parse(row.configuration),
    ).resource,
  };
}

function claimedDigest(headers: Headers, header: string): Buffer | null {
  const value = headers.get(header);
  if (value === null || value.includes(HEADER_VALUE_SEPARATOR)) return null;
  if (!value.startsWith(SIGNATURE_PREFIX)) return null;
  const digest = value.slice(SIGNATURE_PREFIX.length);
  if (!SIGNATURE_DIGEST_PATTERN.test(digest)) return null;
  const bytes = Buffer.from(digest, DIGEST_ENCODING);
  assert.equal(bytes.length, DIGEST_BYTES);
  return bytes;
}

function signatureInvalid(): OperationError {
  return new OperationError(
    HttpStatus.Unauthorized,
    IntakeErrorCode.InboundEventSignatureInvalid,
    "Delivery signature is invalid.",
  );
}

function verifySignature(
  secret: string,
  bytes: Uint8Array,
  headers: Headers,
  header: string,
): void {
  assert.ok(
    secret.length > EMPTY_TEXT_LENGTH,
    "A verification secret is required.",
  );
  const claimed = claimedDigest(headers, header);
  const computed = createHmac(SIGNATURE_ALGORITHM, secret)
    .update(bytes)
    .digest();
  assert.equal(computed.length, DIGEST_BYTES);
  if (claimed === null || !timingSafeEqual(claimed, computed))
    throw signatureInvalid();
}

function invalidDelivery(): OperationError {
  return new OperationError(
    HttpStatus.BadRequest,
    VALIDATION_FAILED_CODE,
    "Delivery headers are invalid.",
  );
}

function storeEvent(
  tx: Transaction,
  pendingEventLimit: number,
  event: NewInboundEvent,
): null {
  assert.ok(
    Number.isSafeInteger(pendingEventLimit) &&
      pendingEventLimit > PENDING_LIMIT_FLOOR,
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

function classifyOf(
  platform: DerivedSecretPlatform,
  headers: Headers,
  bytes: Uint8Array,
): DeliveryClassification {
  if (platform === InboundPlatform.GitHub) return classifyDelivery(headers);
  const jira = classifyJiraDelivery(headers, bytes);
  return jira === null
    ? { kind: DeliveryKind.Invalid }
    : { kind: DeliveryKind.Event, ...jira };
}

function receiveSlackEvent(
  dependencies: ReceiptDependencies,
  caller: CallerContext,
  inbound: WebhookInbound,
  delivery: { bytes: Uint8Array; headers: Headers },
): Response {
  const { credential } = inbound;
  assert.ok(credential !== null, "A Slack webhook inbound names a credential.");
  const material = dependencies.store.transaction((tx) =>
    releaseInboundGrant(
      dependencies,
      tx,
      {
        inboundId: inbound.id,
        projectId: inbound.project_id,
        credential,
        platform: Platform.SlackSigningSecret,
        resource: inbound.resource,
      },
      InboundOperation.Receipt,
    ),
  );
  try {
    const verified = slackSignatureValid({
      secret: apiKeySecretSchema.parse(material.value()).key,
      headers: delivery.headers,
      bytes: delivery.bytes,
      now: Date.now(),
    });
    if (!verified) throw signatureInvalid();
    const slack = classifySlackDelivery(delivery.bytes);
    if (slack === null) throw invalidDelivery();
    if (slack.kind === SlackDeliveryKind.Challenge)
      return Response.json({ challenge: slack.challenge });
    caller.commit((tx) =>
      storeEvent(tx, dependencies.pendingEventLimit, {
        inbound_id: inbound.id,
        event_id: slack.event_id,
        event: delivery.bytes,
        metadata: slack.metadata,
        created_at: Date.now(),
      }),
    );
    dependencies.wake();
    return new Response(null, { status: HttpStatus.Accepted });
  } finally {
    material.drop();
  }
}

export function receiveEvent(
  dependencies: ReceiptDependencies,
  caller: CallerContext,
  params: unknown,
): Response {
  const delivery = caller.delivery;
  assert.ok(delivery, "A receipt requires the exact delivery bytes.");
  assert.equal(caller.identity, undefined);
  const inbound = webhookInboundOf(dependencies.store, params);
  const bytes = new Uint8Array(delivery.bytes);
  if (inbound.platform === InboundPlatform.Slack)
    return receiveSlackEvent(dependencies, caller, inbound, {
      bytes,
      headers: delivery.headers,
    });
  verifySignature(
    webhookSecret(dependencies.masterKey, inbound.id),
    bytes,
    delivery.headers,
    SIGNATURE_HEADERS[inbound.platform],
  );
  const classification = classifyOf(inbound.platform, delivery.headers, bytes);
  if (classification.kind === DeliveryKind.Handshake)
    return new Response(null, { status: classification.status });
  if (classification.kind === DeliveryKind.Invalid) throw invalidDelivery();
  caller.commit((tx) =>
    storeEvent(tx, dependencies.pendingEventLimit, {
      inbound_id: inbound.id,
      event_id: classification.event_id,
      event: bytes,
      metadata: classification.metadata,
      created_at: Date.now(),
    }),
  );
  dependencies.wake();
  return new Response(null, { status: HttpStatus.Accepted });
}
