import { z } from "zod";
import { ExternalLinkKind } from "../kernel/external-link.ts";
import { isObject, isString } from "../kernel/values.ts";

export const JIRA_GATEWAY_ORIGIN = "https://api.atlassian.com/ex/jira";
export const JIRA_MYSELF_PATH = "/rest/api/3/myself";
export const JIRA_SIGNATURE_HEADER = "x-hub-signature";

const IDENTIFIER_HEADER = "x-atlassian-webhook-identifier";
const COMMENT_CREATED_EVENT = "comment_created";
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
  webhookEvent: z.literal(COMMENT_CREATED_EVENT),
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
  if (!metadata.success || metadata.data.event !== COMMENT_CREATED_EVENT)
    return null;
  const parsed = commentWebhookSchema.safeParse(bodyOf(input.event));
  if (!parsed.success) return null;
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
