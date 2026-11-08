import assert from "node:assert/strict";
import { createHmac, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { Context } from "../kernel/context.ts";
import {
  type ExternalLink,
  ExternalLinkKind,
  externalLinkSchema,
} from "../kernel/external-link.ts";
import {
  ResourceFailureReason,
  type ResourceObserver,
  ResourceStatus,
  type ResourceStatusValue,
} from "../kernel/health.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import {
  AUTHORIZATION_HEADER,
  failureReasonOfStatus,
  headerSecrets,
  thrownFailureReason,
  thrownReason,
} from "../kernel/probe.ts";

export const SLACK_AUTH_TEST_URL = "https://slack.com/api/auth.test";

const SIGNATURE_HEADER = "x-slack-signature";
const TIMESTAMP_HEADER = "x-slack-request-timestamp";
const SIGNATURE_VERSION = "v0";
const SIGNATURE_PREFIX = `${SIGNATURE_VERSION}=`;
const SIGNATURE_BASE_SEPARATOR = ":";
const SIGNATURE_DIGEST_PATTERN = /^[0-9a-fA-F]{64}$/;
const SIGNATURE_ALGORITHM = "sha256";
const DIGEST_ENCODING = "hex";
const TIMESTAMP_PATTERN = /^[0-9]+$/;
const TIMESTAMP_WINDOW_SECONDS = 300;
const MS_PER_SECOND = 1000;
const MICROS_PER_MS = 1000;
const HEADER_VALUE_SEPARATOR = ",";
const EMPTY_LENGTH = 0;
const EMPTY_TEXT = "";
const TEXT_ENCODING = "utf-8";
const MESSAGE_TS_PATTERN = /^([0-9]+)\.([0-9]{6})$/;
const CONVERSATION_IDENTITY_PREFIX = "conversation:slack:";
const UPDATE_KEY_PREFIX = "slack_message:";
const UPDATE_KEY_SEPARATOR = ":";
const PERMALINK_ORIGIN = "https://slack.com/archives";

const BodyType = {
  UrlVerification: "url_verification",
  EventCallback: "event_callback",
} as const;
const MESSAGE_EVENT = "message";
const IGNORED_SUBTYPES: ReadonlySet<string> = new Set([
  "message_changed",
  "message_deleted",
]);
const HUMAN_SUBTYPES: ReadonlySet<string> = new Set([
  "thread_broadcast",
  "file_share",
]);

export const SlackDeliveryKind = {
  Challenge: "challenge",
  Event: "event",
} as const;

export type SlackDelivery =
  | { kind: typeof SlackDeliveryKind.Challenge; challenge: string }
  | {
      kind: typeof SlackDeliveryKind.Event;
      event_id: string;
      metadata: { event: string };
    };

export type DecodedSlackLink = Extract<
  ExternalLink,
  { kind: typeof ExternalLinkKind.SlackThread }
>;

export interface DecodedSlackLinkUpdate {
  external_link: DecodedSlackLink;
  update_key: string;
  actor_id: string | null;
  actor_automated: boolean;
  occurred_at: number;
  mentions: string[];
}

export interface DescribedSlackEvent {
  author: string;
  body: string;
  url: string;
  occurred_at: number;
}

const authTestAnswerSchema = z.looseObject({ ok: z.boolean() });
const deliverySchema = z.discriminatedUnion("type", [
  z.looseObject({
    type: z.literal(BodyType.UrlVerification),
    challenge: z.string(),
  }),
  z.looseObject({
    type: z.literal(BodyType.EventCallback),
    event_id: z.string().min(1),
    event: z.looseObject({ type: z.string().min(1) }),
  }),
]);
const messageBodySchema = z.looseObject({
  type: z.literal(BodyType.EventCallback),
  team_id: z.string(),
  event: z.looseObject({
    type: z.literal(MESSAGE_EVENT),
    subtype: z.string().optional(),
    channel: z.string(),
    user: z.string().min(1).nullish(),
    text: z.string().optional(),
    ts: z.string().regex(MESSAGE_TS_PATTERN),
    thread_ts: z.string(),
    bot_id: z.unknown().optional(),
    app_id: z.unknown().optional(),
  }),
});

type MessageEvent = z.infer<typeof messageBodySchema>["event"];

interface ThreadReply {
  event: MessageEvent;
  link: DecodedSlackLink;
  seconds: string;
  micros: string;
}

function bodyOf(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(
      new TextDecoder(TEXT_ENCODING, { fatal: true }).decode(bytes),
    );
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return null;
    throw error;
  }
}

function singleHeader(headers: Headers, name: string): string | null {
  const value = headers.get(name);
  if (value === null || value.includes(HEADER_VALUE_SEPARATOR)) return null;
  return value;
}

export function slackSignatureValid(input: {
  secret: string;
  headers: Headers;
  bytes: Uint8Array;
  now: number;
}): boolean {
  assert.ok(
    input.secret.length > EMPTY_LENGTH,
    "A verification secret is required.",
  );
  const signature = singleHeader(input.headers, SIGNATURE_HEADER);
  const timestamp = singleHeader(input.headers, TIMESTAMP_HEADER);
  if (signature === null || timestamp === null) return false;
  if (!TIMESTAMP_PATTERN.test(timestamp)) return false;
  const age = Math.floor(input.now / MS_PER_SECOND) - Number(timestamp);
  if (Math.abs(age) > TIMESTAMP_WINDOW_SECONDS) return false;
  if (!signature.startsWith(SIGNATURE_PREFIX)) return false;
  const digest = signature.slice(SIGNATURE_PREFIX.length);
  if (!SIGNATURE_DIGEST_PATTERN.test(digest)) return false;
  const computed = createHmac(SIGNATURE_ALGORITHM, input.secret)
    .update(
      [SIGNATURE_VERSION, timestamp, EMPTY_TEXT].join(SIGNATURE_BASE_SEPARATOR),
    )
    .update(input.bytes)
    .digest();
  return timingSafeEqual(Buffer.from(digest, DIGEST_ENCODING), computed);
}

export function classifySlackDelivery(bytes: Uint8Array): SlackDelivery | null {
  const parsed = deliverySchema.safeParse(bodyOf(bytes));
  if (!parsed.success) return null;
  if (parsed.data.type === BodyType.UrlVerification)
    return {
      kind: SlackDeliveryKind.Challenge,
      challenge: parsed.data.challenge,
    };
  return {
    kind: SlackDeliveryKind.Event,
    event_id: parsed.data.event_id,
    metadata: { event: parsed.data.event.type },
  };
}

function threadReplyOf(bytes: Uint8Array, teamId: string): ThreadReply | null {
  const parsed = messageBodySchema.safeParse(bodyOf(bytes));
  if (!parsed.success || parsed.data.team_id !== teamId) return null;
  const { event } = parsed.data;
  if (event.subtype !== undefined && IGNORED_SUBTYPES.has(event.subtype))
    return null;
  if (event.thread_ts === event.ts) return null;
  const link = externalLinkSchema.safeParse({
    kind: ExternalLinkKind.SlackThread,
    resource_identity: `${CONVERSATION_IDENTITY_PREFIX}${teamId}`,
    channel: event.channel,
    thread_ts: event.thread_ts,
  });
  const match = MESSAGE_TS_PATTERN.exec(event.ts);
  const seconds = match?.[1];
  const micros = match?.[2];
  if (!link.success || link.data.kind !== ExternalLinkKind.SlackThread)
    return null;
  if (seconds === undefined || micros === undefined) return null;
  return { event, link: link.data, seconds, micros };
}

function occurredAtOf(reply: ThreadReply): number {
  return (
    Number(reply.seconds) * MS_PER_SECOND +
    Math.floor(Number(reply.micros) / MICROS_PER_MS)
  );
}

function isAutomated(event: MessageEvent): boolean {
  if (event.bot_id !== undefined || event.app_id !== undefined) return true;
  return event.subtype !== undefined && !HUMAN_SUBTYPES.has(event.subtype);
}

export function decodeSlackLinkUpdate(input: {
  resource_identity: string;
  event: Uint8Array;
  metadata: unknown;
}): DecodedSlackLinkUpdate | null {
  if (!input.resource_identity.startsWith(CONVERSATION_IDENTITY_PREFIX))
    return null;
  const teamId = input.resource_identity.slice(
    CONVERSATION_IDENTITY_PREFIX.length,
  );
  const reply = threadReplyOf(input.event, teamId);
  if (reply === null) return null;
  const { event, link } = reply;
  return {
    external_link: link,
    update_key: [`${UPDATE_KEY_PREFIX}${teamId}`, link.channel, event.ts].join(
      UPDATE_KEY_SEPARATOR,
    ),
    actor_id: event.user ?? null,
    actor_automated: isAutomated(event),
    occurred_at: occurredAtOf(reply),
    mentions: [],
  };
}

export function describeSlackEvent(input: {
  resource: string;
  event: Uint8Array;
  metadata: unknown;
}): DescribedSlackEvent | null {
  const reply = threadReplyOf(input.event, input.resource);
  if (reply === null) return null;
  const { event, link } = reply;
  if (event.user === undefined || event.user === null) return null;
  return {
    author: event.user,
    body: event.text ?? EMPTY_TEXT,
    url: `${PERMALINK_ORIGIN}/${link.channel}/p${reply.seconds}${reply.micros}?thread_ts=${link.thread_ts}&cid=${link.channel}`,
    occurred_at: occurredAtOf(reply),
  };
}

export async function probeSlackToken(
  token: string,
  context: Context,
  observe?: ResourceObserver,
): Promise<ResourceStatusValue> {
  const headers = { [AUTHORIZATION_HEADER]: `Bearer ${token}` };
  try {
    const { signal } = context;
    if (signal.aborted) return ResourceStatus.Unknown;
    const response = await globalThis.fetch(SLACK_AUTH_TEST_URL, {
      method: HttpMethod.Post,
      headers,
      signal,
      redirect: "manual",
    });
    if (response.status !== HttpStatus.OK) {
      await response.body?.cancel();
      observe?.(
        `status=${response.status}`,
        failureReasonOfStatus(response.status),
      );
      return response.status === HttpStatus.Forbidden
        ? ResourceStatus.Unknown
        : ResourceStatus.Unhealthy;
    }
    const answer = authTestAnswerSchema.parse(await response.json());
    if (signal.aborted) return ResourceStatus.Unknown;
    if (answer.ok) return ResourceStatus.Healthy;
    observe?.("ok=false", ResourceFailureReason.Unauthorized);
    return ResourceStatus.Unhealthy;
  } catch (error) {
    observe?.(
      thrownReason(error, headerSecrets(headers)),
      thrownFailureReason(context),
    );
    return ResourceStatus.Unknown;
  }
}
