import assert from "node:assert/strict";
import { z } from "zod";
import { apiKeySecretSchema } from "../custody/contract.ts";
import { ExternalLinkKind } from "../kernel/external-link.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import { isObject, isString } from "../kernel/values.ts";
import { ResultClass, type ResultClassValue } from "./contract.ts";

export const JIRA_GATEWAY_ORIGIN = "https://api.atlassian.com/ex/jira";
export const JIRA_MYSELF_PATH = "/rest/api/3/myself";
export const JIRA_SIGNATURE_HEADER = "x-hub-signature";

const IDENTIFIER_HEADER = "x-atlassian-webhook-identifier";
const COMMENT_CREATED_EVENT = "comment_created";
export const JIRA_LISTED_EVENT = "comment_listed";
const COMMENT_EVENTS: ReadonlySet<string> = new Set([
  COMMENT_CREATED_EVENT,
  JIRA_LISTED_EVENT,
]);
const NEWEST_FIRST = "-created";
const COMMENT_PAGE_SIZE = 100;
const NO_TIME_LEFT_MS = 0;
const CONTENT_TYPE_JSON = "application/json";
const ADF_VERSION = 1;
const ADF_DOCUMENT = "doc";
const ADF_PARAGRAPH = "paragraph";
const PARAGRAPH_SEPARATOR = "\n";
const APP_ACCOUNT_TYPE = "app";
const UPDATE_KEY_PREFIX = "jira_comment:";
const UPDATE_KEY_SEPARATOR = ":";
const KEY_SEPARATOR = "-";
const LINE_BREAK = "\n";
const EMPTY_TEXT = "";
const TEXT_ENCODING = "utf-8";
const OFFSET_COLON = ":";
const OFFSET_HOUR_LENGTH = 3;
const UTC_DESIGNATOR = "Z";
const RESOURCE_PATTERN = /^([^/\s:]+)\/([A-Z][A-Z0-9_]{1,9})$/;
const CONVERSATION_IDENTITY_PREFIX = "conversation:jira:";
const ISSUE_NUMBER_PATTERN = /^[1-9][0-9]*$/;
const COMMENT_TIME_PATTERN =
  /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?)(Z|[+-]\d{2}:?\d{2})$/;

const AdfNodeType = {
  Text: "text",
  HardBreak: "hardBreak",
  Mention: "mention",
  Emoji: "emoji",
  InlineCard: "inlineCard",
  Status: "status",
  Date: "date",
  MediaInline: "mediaInline",
} as const;
const INLINE_NODE_TYPES: ReadonlySet<unknown> = new Set(
  Object.values(AdfNodeType),
);

export function jiraApiUrl(cloudId: string, path: string): string {
  return `${JIRA_GATEWAY_ORIGIN}/${cloudId}${path}`;
}

export function jiraBasicAuthorization(email: string, token: string): string {
  return `Basic ${Buffer.from(`${email}:${token}`).toString("base64")}`;
}

export interface JiraDelivery {
  event_id: string;
  metadata: { event: string };
}

export interface DecodedJiraLink {
  kind: typeof ExternalLinkKind.JiraIssue;
  resource_identity: string;
  key: string;
}

export interface DecodedJiraLinkUpdate {
  external_link: DecodedJiraLink;
  update_key: string;
  actor_id: string | null;
  actor_automated: boolean;
  occurred_at: number;
  mentions: string[];
}

export interface DescribedJiraEvent {
  author: string;
  body: string;
  url: string;
  occurred_at: number;
}

const eventNameSchema = z.looseObject({ webhookEvent: z.string().min(1) });
const commentWebhookSchema = z.looseObject({
  webhookEvent: z.string().optional(),
  issue: z.looseObject({
    key: z.string().min(1),
    fields: z
      .looseObject({
        project: z.looseObject({ key: z.string().min(1) }).optional(),
      })
      .optional(),
  }),
  comment: z.looseObject({
    id: z.union([z.string().min(1), z.int()]),
    author: z
      .looseObject({
        accountId: z.string().min(1).optional(),
        accountType: z.string().optional(),
        displayName: z.string().optional(),
      })
      .nullish(),
    body: z.unknown(),
    created: z.string(),
  }),
});
const metadataSchema = z.looseObject({ event: z.string() });

type CommentWebhook = z.infer<typeof commentWebhookSchema>;

interface ParsedComment {
  webhook: CommentWebhook;
  occurred_at: number;
}

function bodyOf(event: Uint8Array): unknown {
  try {
    return JSON.parse(
      new TextDecoder(TEXT_ENCODING, { fatal: true }).decode(event),
    );
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) return null;
    throw error;
  }
}

export function classifyJiraDelivery(
  headers: Headers,
  bytes: Uint8Array,
): JiraDelivery | null {
  const eventId = headers.get(IDENTIFIER_HEADER);
  if (eventId === null || eventId.trim() === EMPTY_TEXT) return null;
  const named = eventNameSchema.safeParse(bodyOf(bytes));
  if (!named.success) return null;
  return { event_id: eventId, metadata: { event: named.data.webhookEvent } };
}

function commentTimeOf(created: string): number | null {
  const match = COMMENT_TIME_PATTERN.exec(created);
  const base = match?.[1];
  const offset = match?.[2];
  if (base === undefined || offset === undefined) return null;
  const normalized =
    offset === UTC_DESIGNATOR || offset.includes(OFFSET_COLON)
      ? offset
      : `${offset.slice(0, OFFSET_HOUR_LENGTH)}${OFFSET_COLON}${offset.slice(OFFSET_HOUR_LENGTH)}`;
  const time = Date.parse(`${base}${normalized}`);
  return Number.isNaN(time) ? null : time;
}

function isKeyOfProject(key: string, projectKey: string): boolean {
  const prefix = `${projectKey}${KEY_SEPARATOR}`;
  return (
    key.startsWith(prefix) &&
    ISSUE_NUMBER_PATTERN.test(key.slice(prefix.length))
  );
}

function parsedComment(
  input: { event: Uint8Array; metadata: unknown },
  projectKey: string,
): ParsedComment | null {
  const metadata = metadataSchema.safeParse(input.metadata);
  if (!metadata.success || !COMMENT_EVENTS.has(metadata.data.event))
    return null;
  const parsed = commentWebhookSchema.safeParse(bodyOf(input.event));
  if (!parsed.success) return null;
  if (
    metadata.data.event === COMMENT_CREATED_EVENT &&
    parsed.data.webhookEvent !== COMMENT_CREATED_EVENT
  )
    return null;
  const { issue, comment } = parsed.data;
  const issueProject = issue.fields?.project?.key;
  if (issueProject !== undefined && issueProject !== projectKey) return null;
  if (!isKeyOfProject(issue.key, projectKey)) return null;
  const occurredAt = commentTimeOf(comment.created);
  if (occurredAt === null) return null;
  return { webhook: parsed.data, occurred_at: occurredAt };
}

export function decodeJiraLinkUpdate(input: {
  resource_identity: string;
  event: Uint8Array;
  metadata: unknown;
}): DecodedJiraLinkUpdate | null {
  if (!input.resource_identity.startsWith(CONVERSATION_IDENTITY_PREFIX))
    return null;
  const resource = input.resource_identity.slice(
    CONVERSATION_IDENTITY_PREFIX.length,
  );
  const match = RESOURCE_PATTERN.exec(resource);
  const site = match?.[1];
  const projectKey = match?.[2];
  if (site === undefined || projectKey === undefined) return null;
  const parsed = parsedComment(input, projectKey);
  if (parsed === null) return null;
  const { issue, comment } = parsed.webhook;
  return {
    external_link: {
      kind: ExternalLinkKind.JiraIssue,
      resource_identity: input.resource_identity,
      key: issue.key,
    },
    update_key: `${UPDATE_KEY_PREFIX}${site}${UPDATE_KEY_SEPARATOR}${comment.id}`,
    actor_id: comment.author?.accountId ?? null,
    actor_automated: comment.author?.accountType === APP_ACCOUNT_TYPE,
    occurred_at: parsed.occurred_at,
    mentions: [],
  };
}

function adfText(node: unknown): string {
  if (!isObject(node)) return "";
  const { type, text, content } = node as Record<string, unknown>;
  if (type === AdfNodeType.Text) return isString(text) ? text : "";
  if (type === AdfNodeType.HardBreak) return LINE_BREAK;
  const children: unknown[] = Array.isArray(content) ? content : [];
  const inline = children.every(
    (child) =>
      isObject(child) &&
      INLINE_NODE_TYPES.has((child as Record<string, unknown>).type),
  );
  return children.map(adfText).join(inline ? "" : LINE_BREAK);
}

function plainTextOf(body: unknown): string | null {
  if (body === undefined) return "";
  if (isString(body)) return body;
  if (isObject(body) && !Array.isArray(body)) return adfText(body);
  return null;
}

export function describeJiraEvent(input: {
  resource: string;
  event: Uint8Array;
  metadata: unknown;
}): DescribedJiraEvent | null {
  const match = RESOURCE_PATTERN.exec(input.resource);
  const site = match?.[1];
  const projectKey = match?.[2];
  if (site === undefined || projectKey === undefined) return null;
  const parsed = parsedComment(input, projectKey);
  if (parsed === null) return null;
  const { issue, comment } = parsed.webhook;
  const author = comment.author?.displayName;
  const body = plainTextOf(comment.body);
  if (author === undefined || body === null) return null;
  return {
    author,
    body,
    url: `https://${site}/browse/${issue.key}`,
    occurred_at: parsed.occurred_at,
  };
}

export interface JiraCredentials {
  cloud_id: string;
  email: string;
  token: string;
}

export interface JiraCall {
  credentials: JiraCredentials;
  signal: AbortSignal;
  deadlineAt: number;
}

export interface JiraTarget {
  site: string;
  key: string;
}

export interface JiraFailure {
  ok: false;
  class: ResultClassValue;
  status: number | null;
  message: string;
}

export type JiraAnswer<T> = { ok: true; value: T } | JiraFailure;

export interface ListedJiraComment {
  id: string;
  type: string;
  body: Uint8Array;
}

const JiraCallKind = { Read: "read", Write: "write" } as const;
type JiraCallKind = (typeof JiraCallKind)[keyof typeof JiraCallKind];

const accountMetadataSchema = z.looseObject({
  cloud_id: z.string().min(1),
  email: z.string().min(1),
});
const listedPageSchema = z.looseObject({
  comments: z.array(
    z.looseObject({ id: z.union([z.string().min(1), z.int()]) }),
  ),
});
const accountSchema = z.looseObject({ accountId: z.string().min(1) });
const postedCommentSchema = z.looseObject({
  id: z.union([z.string().min(1), z.int()]),
  author: z.looseObject({ accountId: z.string().min(1).optional() }).nullish(),
});

export function jiraSiteOf(resource: string): string {
  const site = RESOURCE_PATTERN.exec(resource)?.[1];
  assert.ok(site !== undefined, "A Jira resource names its site.");
  return site;
}

export function jiraCredentialsOf(
  metadata: unknown,
  secret: unknown,
): JiraCredentials {
  const { cloud_id, email } = accountMetadataSchema.parse(metadata);
  return { cloud_id, email, token: apiKeySecretSchema.parse(secret).key };
}

function failure(
  resultClass: ResultClassValue,
  status: number | null,
  message: string,
): JiraFailure {
  return { ok: false, class: resultClass, status, message };
}

function transportClass(kind: JiraCallKind): ResultClassValue {
  return kind === JiraCallKind.Read
    ? ResultClass.RetryableRefusal
    : ResultClass.UnknownOutcome;
}

function statusClass(status: number, kind: JiraCallKind): ResultClassValue {
  if (status >= HttpStatus.InternalServerError) return transportClass(kind);
  if (
    status === HttpStatus.TooManyRequests ||
    status === HttpStatus.RequestTimeout
  )
    return ResultClass.RetryableRefusal;
  return ResultClass.FinalRefusal;
}

async function exchange(
  call: JiraCall,
  request: {
    kind: JiraCallKind;
    method: string;
    path: string;
    query?: Record<string, string>;
    body?: unknown;
  },
): Promise<JiraAnswer<unknown>> {
  const remaining = call.deadlineAt - Date.now();
  if (call.signal.aborted || remaining <= NO_TIME_LEFT_MS)
    return failure(
      request.kind === JiraCallKind.Read
        ? ResultClass.RetryableRefusal
        : ResultClass.ConfirmedFailure,
      null,
      "the deadline of the Jira call passed before dispatch",
    );
  const query =
    request.query === undefined
      ? ""
      : `?${new URLSearchParams(request.query).toString()}`;
  const signal = AbortSignal.any([call.signal, AbortSignal.timeout(remaining)]);
  let status: number;
  let accepted: boolean;
  let text: string;
  try {
    const response = await globalThis.fetch(
      `${jiraApiUrl(call.credentials.cloud_id, request.path)}${query}`,
      {
        method: request.method,
        headers: {
          Authorization: jiraBasicAuthorization(
            call.credentials.email,
            call.credentials.token,
          ),
          Accept: CONTENT_TYPE_JSON,
          ...(request.body === undefined
            ? {}
            : { "Content-Type": CONTENT_TYPE_JSON }),
        },
        ...(request.body === undefined
          ? {}
          : { body: JSON.stringify(request.body) }),
        signal,
        redirect: "manual",
      },
    );
    status = response.status;
    accepted = response.ok;
    text = await response.text();
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return failure(
      transportClass(request.kind),
      null,
      "the Jira call ended before an answer",
    );
  }
  if (!accepted)
    return failure(
      statusClass(status, request.kind),
      status,
      "the Jira answer refuses the call",
    );
  try {
    return { ok: true, value: JSON.parse(text) };
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return unreadable(request.kind);
  }
}

function unreadable(kind: JiraCallKind): JiraFailure {
  return failure(
    transportClass(kind),
    null,
    "the Jira answer holds an unexpected body",
  );
}

function issuePath(key: string): string {
  return `/rest/api/3/issue/${encodeURIComponent(key)}/comment`;
}

function updateKeyOf(site: string, id: string | number): string {
  return `${UPDATE_KEY_PREFIX}${site}${UPDATE_KEY_SEPARATOR}${id}`;
}

export async function listJiraComments(
  call: JiraCall,
  target: JiraTarget,
): Promise<JiraAnswer<ListedJiraComment[]>> {
  const answer = await exchange(call, {
    kind: JiraCallKind.Read,
    method: HttpMethod.Get,
    path: issuePath(target.key),
    query: { orderBy: NEWEST_FIRST, maxResults: String(COMMENT_PAGE_SIZE) },
  });
  if (!answer.ok) return answer;
  const page = listedPageSchema.safeParse(answer.value);
  if (!page.success) return unreadable(JiraCallKind.Read);
  return {
    ok: true,
    value: page.data.comments.map((comment) => ({
      id: updateKeyOf(target.site, comment.id),
      type: JIRA_LISTED_EVENT,
      body: new Uint8Array(
        Buffer.from(JSON.stringify({ issue: { key: target.key }, comment })),
      ),
    })),
  };
}

export async function readJiraAccount(
  call: JiraCall,
): Promise<JiraAnswer<string>> {
  const answer = await exchange(call, {
    kind: JiraCallKind.Read,
    method: HttpMethod.Get,
    path: JIRA_MYSELF_PATH,
  });
  if (!answer.ok) return answer;
  const account = accountSchema.safeParse(answer.value);
  return account.success
    ? { ok: true, value: account.data.accountId }
    : unreadable(JiraCallKind.Read);
}

function adfOf(text: string): object {
  return {
    type: ADF_DOCUMENT,
    version: ADF_VERSION,
    content: text.split(PARAGRAPH_SEPARATOR).map((line) => ({
      type: ADF_PARAGRAPH,
      content:
        line === EMPTY_TEXT ? [] : [{ type: AdfNodeType.Text, text: line }],
    })),
  };
}

export async function postJiraComment(
  call: JiraCall,
  target: JiraTarget,
  text: string,
): Promise<JiraAnswer<{ update_key: string; actor_id: string | null }>> {
  const answer = await exchange(call, {
    kind: JiraCallKind.Write,
    method: HttpMethod.Post,
    path: issuePath(target.key),
    body: { body: adfOf(text) },
  });
  if (!answer.ok) return answer;
  const posted = postedCommentSchema.safeParse(answer.value);
  if (!posted.success) return unreadable(JiraCallKind.Write);
  return {
    ok: true,
    value: {
      update_key: updateKeyOf(target.site, posted.data.id),
      actor_id: posted.data.author?.accountId ?? null,
    },
  };
}
