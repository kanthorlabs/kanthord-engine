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
import { ResultClass, type ResultClassValue } from "./contract.ts";

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

interface MessageTime {
  seconds: string;
  micros: string;
}

interface ThreadReply extends MessageTime {
  event: MessageEvent;
  link: DecodedSlackLink;
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

function threadLinkOf(
  teamId: string,
  event: MessageEvent,
): DecodedSlackLink | null {
  const link = externalLinkSchema.safeParse({
    kind: ExternalLinkKind.SlackThread,
    resource_identity: `${CONVERSATION_IDENTITY_PREFIX}${teamId}`,
    channel: event.channel,
    thread_ts: event.thread_ts,
  });
  if (!link.success || link.data.kind !== ExternalLinkKind.SlackThread)
    return null;
  return link.data;
}

function messageTimeOf(ts: string): MessageTime | null {
  const match = MESSAGE_TS_PATTERN.exec(ts);
  const seconds = match?.[1];
  const micros = match?.[2];
  if (seconds === undefined || micros === undefined) return null;
  return { seconds, micros };
}

function isIgnoredSubtype(event: MessageEvent): boolean {
  return event.subtype !== undefined && IGNORED_SUBTYPES.has(event.subtype);
}

function threadReplyOf(bytes: Uint8Array, teamId: string): ThreadReply | null {
  const parsed = messageBodySchema.safeParse(bodyOf(bytes));
  if (!parsed.success || parsed.data.team_id !== teamId) return null;
  const { event } = parsed.data;
  if (isIgnoredSubtype(event)) return null;
  if (event.thread_ts === event.ts) return null;
  const link = threadLinkOf(teamId, event);
  const time = messageTimeOf(event.ts);
  if (link === null || time === null) return null;
  return { event, link, ...time };
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
    update_key: updateKeyOf(teamId, link.channel, event.ts),
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

async function refusedStatusResult(
  response: Response,
  observe?: ResourceObserver,
): Promise<ResourceStatusValue> {
  await response.body?.cancel();
  observe?.(
    `status=${response.status}`,
    failureReasonOfStatus(response.status),
  );
  return response.status === HttpStatus.Forbidden
    ? ResourceStatus.Unknown
    : ResourceStatus.Unhealthy;
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
    if (response.status !== HttpStatus.OK)
      return await refusedStatusResult(response, observe);
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

export interface SlackCall {
  token: string;
  signal: AbortSignal;
  deadlineAt: number;
}

export interface SlackTarget {
  team_id: string;
  channel: string;
  thread_ts: string;
}

export interface SlackFailure {
  ok: false;
  class: ResultClassValue;
  status: number | null;
  message: string;
}

export type SlackAnswer<T> = { ok: true; value: T } | SlackFailure;

export interface ListedSlackReply {
  id: string;
  type: string;
  body: Uint8Array;
}

const SlackCallKind = { Read: "read", Write: "write" } as const;
type SlackCallKind = (typeof SlackCallKind)[keyof typeof SlackCallKind];

const API_ORIGIN = "https://slack.com/api";
const REPLIES_METHOD = "conversations.replies";
const POST_MESSAGE_METHOD = "chat.postMessage";
const REPLIES_LIMIT = "200";
const CONTENT_TYPE_JSON = "application/json; charset=utf-8";
const NO_TIME_LEFT_MS = 0;
const REPLY_LISTED_EVENT = "reply_listed";
const ERROR_CODE_PATTERN = /^[a-z0-9_]+$/;
const RATE_LIMITED_ERROR = "ratelimited";
const SERVER_ERRORS: ReadonlySet<string> = new Set([
  "fatal_error",
  "internal_error",
  "service_unavailable",
  "request_timeout",
]);

const answerSchema = z.looseObject({
  ok: z.boolean(),
  error: z.string().optional(),
});
const repliesSchema = z.looseObject({
  messages: z.array(z.looseObject({ ts: z.string().min(1) })),
});
const accountSchema = z.looseObject({ user_id: z.string().min(1) });
const postedSchema = z.looseObject({
  ts: z.string().min(1),
  message: z.looseObject({ user: z.string().min(1).nullish() }).nullish(),
});

function failure(
  resultClass: ResultClassValue,
  status: number | null,
  message: string,
): SlackFailure {
  return { ok: false, class: resultClass, status, message };
}

function transportClass(kind: SlackCallKind): ResultClassValue {
  return kind === SlackCallKind.Read
    ? ResultClass.RetryableRefusal
    : ResultClass.UnknownOutcome;
}

function statusClass(status: number, kind: SlackCallKind): ResultClassValue {
  if (status >= HttpStatus.InternalServerError) return transportClass(kind);
  if (
    status === HttpStatus.TooManyRequests ||
    status === HttpStatus.RequestTimeout
  )
    return ResultClass.RetryableRefusal;
  return ResultClass.FinalRefusal;
}

function errorClass(error: string, kind: SlackCallKind): ResultClassValue {
  if (error === RATE_LIMITED_ERROR) return ResultClass.RetryableRefusal;
  if (SERVER_ERRORS.has(error)) return transportClass(kind);
  return ResultClass.FinalRefusal;
}

function unreadable(kind: SlackCallKind): SlackFailure {
  return failure(
    transportClass(kind),
    null,
    "the Slack answer holds an unexpected body",
  );
}

interface SlackRequest {
  kind: SlackCallKind;
  method: string;
  url: string;
  body?: unknown;
}

interface SlackReply {
  status: number;
  accepted: boolean;
  text: string;
}

function expiredFailure(kind: SlackCallKind): SlackFailure {
  return failure(
    kind === SlackCallKind.Read
      ? ResultClass.RetryableRefusal
      : ResultClass.ConfirmedFailure,
    null,
    "the deadline of the Slack call passed before dispatch",
  );
}

function requestInit(
  call: SlackCall,
  request: SlackRequest,
  signal: AbortSignal,
): RequestInit {
  return {
    method: request.method,
    headers: {
      [AUTHORIZATION_HEADER]: `Bearer ${call.token}`,
      ...(request.body === undefined
        ? {}
        : { "Content-Type": CONTENT_TYPE_JSON }),
    },
    ...(request.body === undefined
      ? {}
      : { body: JSON.stringify(request.body) }),
    signal,
    redirect: "manual",
  };
}

async function fetchReply(url: string, init: RequestInit): Promise<SlackReply> {
  const response = await globalThis.fetch(url, init);
  return {
    status: response.status,
    accepted: response.ok,
    text: await response.text(),
  };
}

function refusalOf(
  error: string | undefined,
  kind: SlackCallKind,
): SlackFailure {
  const code =
    error !== undefined && ERROR_CODE_PATTERN.test(error) ? error : null;
  return failure(
    code === null ? ResultClass.FinalRefusal : errorClass(code, kind),
    null,
    code === null
      ? "the Slack answer refuses the call"
      : `the Slack answer refuses the call: ${code}`,
  );
}

function answeredBody(
  body: unknown,
  kind: SlackCallKind,
): SlackAnswer<unknown> {
  const answer = answerSchema.safeParse(body);
  if (!answer.success) return unreadable(kind);
  if (answer.data.ok) return { ok: true, value: body };
  return refusalOf(answer.data.error, kind);
}

function answerOf(
  reply: SlackReply,
  kind: SlackCallKind,
): SlackAnswer<unknown> {
  if (!reply.accepted)
    return failure(
      statusClass(reply.status, kind),
      reply.status,
      "the Slack answer refuses the call",
    );
  let body: unknown;
  try {
    body = JSON.parse(reply.text);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return unreadable(kind);
  }
  return answeredBody(body, kind);
}

async function exchange(
  call: SlackCall,
  request: SlackRequest,
): Promise<SlackAnswer<unknown>> {
  const remaining = call.deadlineAt - Date.now();
  if (call.signal.aborted || remaining <= NO_TIME_LEFT_MS)
    return expiredFailure(request.kind);
  const signal = AbortSignal.any([call.signal, AbortSignal.timeout(remaining)]);
  let reply: SlackReply;
  try {
    reply = await fetchReply(request.url, requestInit(call, request, signal));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return failure(
      transportClass(request.kind),
      null,
      "the Slack call ended before an answer",
    );
  }
  return answerOf(reply, request.kind);
}

function updateKeyOf(teamId: string, channel: string, ts: string): string {
  return [`${UPDATE_KEY_PREFIX}${teamId}`, channel, ts].join(
    UPDATE_KEY_SEPARATOR,
  );
}

export async function listSlackReplies(
  call: SlackCall,
  target: SlackTarget,
): Promise<SlackAnswer<ListedSlackReply[]>> {
  const query = new URLSearchParams({
    channel: target.channel,
    ts: target.thread_ts,
    limit: REPLIES_LIMIT,
  });
  const answer = await exchange(call, {
    kind: SlackCallKind.Read,
    method: HttpMethod.Get,
    url: `${API_ORIGIN}/${REPLIES_METHOD}?${query.toString()}`,
  });
  if (!answer.ok) return answer;
  const page = repliesSchema.safeParse(answer.value);
  if (!page.success) return unreadable(SlackCallKind.Read);
  return {
    ok: true,
    value: page.data.messages
      .filter((message) => message.ts !== target.thread_ts)
      .map((message) => ({
        id: updateKeyOf(target.team_id, target.channel, message.ts),
        type: REPLY_LISTED_EVENT,
        body: new Uint8Array(
          Buffer.from(
            JSON.stringify({
              type: BodyType.EventCallback,
              team_id: target.team_id,
              event: {
                ...message,
                type: MESSAGE_EVENT,
                channel: target.channel,
              },
            }),
          ),
        ),
      })),
  };
}

export async function readSlackAccount(
  call: SlackCall,
): Promise<SlackAnswer<string>> {
  const answer = await exchange(call, {
    kind: SlackCallKind.Read,
    method: HttpMethod.Post,
    url: SLACK_AUTH_TEST_URL,
  });
  if (!answer.ok) return answer;
  const account = accountSchema.safeParse(answer.value);
  return account.success
    ? { ok: true, value: account.data.user_id }
    : unreadable(SlackCallKind.Read);
}

export async function postSlackReply(
  call: SlackCall,
  target: SlackTarget,
  text: string,
): Promise<SlackAnswer<{ update_key: string; actor_id: string | null }>> {
  const answer = await exchange(call, {
    kind: SlackCallKind.Write,
    method: HttpMethod.Post,
    url: `${API_ORIGIN}/${POST_MESSAGE_METHOD}`,
    body: { channel: target.channel, thread_ts: target.thread_ts, text },
  });
  if (!answer.ok) return answer;
  const posted = postedSchema.safeParse(answer.value);
  if (!posted.success) return unreadable(SlackCallKind.Write);
  return {
    ok: true,
    value: {
      update_key: updateKeyOf(target.team_id, target.channel, posted.data.ts),
      actor_id: posted.data.message?.user ?? null,
    },
  };
}
