import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { Octokit, RequestError } from "octokit";
import { z } from "zod";
import { ResultClass, type ResultClassValue } from "../intake/contract.ts";
import type { CallerIdentity } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { isString, ValueType } from "../kernel/values.ts";

export const GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_RESULT_CODE_PREFIX = "repository.platform.github.";
export const READ_RETRY_DELAY_MS = 250;
export const READ_ATTEMPT_LIMIT = 240;
export const MERGEABILITY_READ_LIMIT = 3;
export const MERGEABILITY_RETRY_DELAY_MS = 2000;
export const REVIEW_COMMENT_LIMIT_DEFAULT = 100;
export const REVIEW_COMMENT_LIMIT_MIN = 1;
export const REVIEW_COMMENT_LIMIT_MAX = 100;
export const CURSOR_PAGE_SIZE_MISMATCH_CODE =
  "repository.platform.github.cursor_page_size_mismatch";
export const CURSOR_INVALID_CODE = "system.pagination.cursor_invalid";
const FIRST_PAGE = 1;
const NEXT_PAGE_STEP = 1;
const CURSOR_ENCODING = "base64url";
const TEXT_ENCODING = "utf8";
const PULL_REQUEST_STATE_OPEN = "open";
const MERGEABLE_STATE_CONFLICT = "dirty";
const MIN_PULL_REQUEST_NUMBER = 1;
const NEXT_LINK_PATTERN = /<[^>]*>\s*;\s*rel="next"/;
const API_VERSION_HEADER = "x-github-api-version";
const RATE_LIMIT_REMAINING_HEADER = "x-ratelimit-remaining";
const RATE_LIMIT_RESET_HEADER = "x-ratelimit-reset";
const RETRY_AFTER_HEADER = "retry-after";
const POLL_INTERVAL_HEADER = "x-poll-interval";
const RATE_LIMIT_EXHAUSTED = "0";
const SECONDARY_RATE_LIMIT_PATTERN = /secondary rate limit/i;
const SECONDS_PATTERN = /^(0|[1-9][0-9]*)$/;
const MS_PER_SECOND = 1000;
const IF_NONE_MATCH_HEADER = "if-none-match";
const NOT_MODIFIED_STATUS = 304;
const EVENT_PAGE_SIZE = 100;
const CLOSED_PULL_REQUEST_PAGE_SIZE = 100;
const CLOSED_PULL_REQUEST_EVENT_TYPE = "pull_request_closed";
const ISSUE_COMMENT_PAGE_SIZE = 100;
const ISSUE_COMMENT_LISTED_EVENT_TYPE = "issue_comment_listed";
const ISSUE_COMMENT_KEY_PREFIX = "issue_comment:";
const MIN_POSITIVE_ID = 1;
const LAST_LINK_PATTERN =
  /<[^>]*[?&]page=([1-9][0-9]*)(?:&[^>]*)?>\s*;\s*rel="last"/;
const REVIEW_PAGE_SIZE = 100;
const REVIEW_PAGE_LIMIT = 30;
const NO_CHANGE_REQUESTS = 0;
const NO_REQUIRED_CHECKS = 0;
const NO_FAILED_CHECKS = 0;
const NO_PENDING_CHECKS = 0;
const CHECK_RUN_PAGE_SIZE = 100;
const BRANCH_RULES_ROUTE = "GET /repos/{owner}/{repo}/rules/branches/{branch}";
const CHECK_RUNS_ROUTE = "GET /repos/{owner}/{repo}/commits/{ref}/check-runs";
const COMMIT_STATUSES_ROUTE =
  "GET /repos/{owner}/{repo}/commits/{ref}/statuses";
const ISSUE_COMMENTS_ROUTE =
  "GET /repos/{owner}/{repo}/issues/{issue_number}/comments";
const REQUIRED_STATUS_CHECKS_RULE = "required_status_checks";
const EVENT_ID_PATTERN = /^(0|[1-9][0-9]*)$/;
const MIN_JSON_LENGTH = 1;
const CAUSE_DEPTH_LIMIT = 4;
const NO_TIME_LEFT_MS = 0;
const MIN_SEGMENT_LENGTH = 1;
const MIN_TOKEN_LENGTH = 1;
const BINDING_ADDRESS_PATTERN =
  /^git@[A-Za-z0-9][A-Za-z0-9.-]*:([^/\s:]+)\/([^/\s:]+)\.git(?![\s\S])/;
const INBOUND_RESOURCE_PATTERN = /^([^/\s:]+)\/([^/\s:]+)(?![\s\S])/;
const EVENT_HEADER = "x-github-event";
const DELIVERY_HEADER = "x-github-delivery";
const PING_EVENT = "ping";
const singleHeaderValueSchema = z.string().regex(/^[^,]+$/);
const BEFORE_DISPATCH_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "UND_ERR_CONNECT_TIMEOUT",
]);

export const GitHubTargetKind = {
  Binding: "binding",
  Inbound: "inbound",
} as const;

export const CallKind = {
  Read: "read",
  Write: "write",
} as const;
export type CallKind = (typeof CallKind)[keyof typeof CallKind];

export const DispatchPhase = {
  BeforeDispatch: "before_dispatch",
  AfterDispatch: "after_dispatch",
} as const;
export type DispatchPhase = (typeof DispatchPhase)[keyof typeof DispatchPhase];

export const DeliveryKind = {
  Handshake: "handshake",
  Event: "event",
  Invalid: "invalid",
} as const;

export type DeliveryClassification =
  | { kind: typeof DeliveryKind.Handshake; status: typeof HttpStatus.NoContent }
  | {
      kind: typeof DeliveryKind.Event;
      event_id: string;
      metadata: { event: string };
    }
  | { kind: typeof DeliveryKind.Invalid };

export interface GitHubCall {
  token: string;
  requester: CallerIdentity;
  signal: AbortSignal;
  deadlineAt: number;
}

export type GitHubTarget =
  | { kind: typeof GitHubTargetKind.Binding; address: string }
  | { kind: typeof GitHubTargetKind.Inbound; resource: string };

export interface GitHubRepository {
  owner: string;
  repo: string;
}

export interface GitHubRateLimit {
  wait_ms: number | null;
}

export interface GitHubFailure {
  ok: false;
  class: ResultClassValue;
  code: string;
  status: number | null;
  message: string;
  rate_limit?: GitHubRateLimit;
}

export type GitHubAnswer<T> = { ok: true; value: T } | GitHubFailure;

export interface GitHubRequest {
  kind: CallKind;
  route: string;
  parameters: Record<string, unknown>;
  headers?: Record<string, string>;
}

export const githubCheckpointSchema = z.object({
  etag: z.string().nullable(),
  pulls_etag: z.string().nullable().default(null),
});
export type GitHubCheckpoint = z.infer<typeof githubCheckpointSchema>;

export const githubConversationCheckpointSchema = z.object({
  comments_etag: z.string().nullable().default(null),
});
export type GitHubConversationCheckpoint = z.infer<
  typeof githubConversationCheckpointSchema
>;

export interface GitHubEvent {
  id: string;
  type: string;
  body: Uint8Array;
}

export type GitHubEventsAnswer =
  | { notModified: true; poll_interval_ms?: number }
  | {
      notModified: false;
      etag: string | null;
      events: GitHubEvent[];
      poll_interval_ms?: number;
    };

export interface GitHubEventsQuery {
  owner: string;
  repo: string;
  etag: string | null;
}

export const CheckEndState = {
  Expected: "expected",
  Other: "other",
  None: "none",
  Conflict: "conflict",
  ChecksFailed: "checks_failed",
  ChecksPending: "checks_pending",
} as const;
export type CheckEndState = (typeof CheckEndState)[keyof typeof CheckEndState];

export const ReviewState = {
  Approved: "APPROVED",
  ChangesRequested: "CHANGES_REQUESTED",
  Dismissed: "DISMISSED",
} as const;
const DECISIVE_REVIEW_STATES: ReadonlySet<string> = new Set(
  Object.values(ReviewState),
);

const CHECK_RUN_COMPLETED = "completed";
const CheckRunConclusion = {
  Success: "success",
  Neutral: "neutral",
  Skipped: "skipped",
} as const;
const PASSING_CONCLUSIONS: ReadonlySet<string> = new Set(
  Object.values(CheckRunConclusion),
);

const CommitStatusState = {
  Success: "success",
  Pending: "pending",
  Failure: "failure",
  Error: "error",
} as const;
const commitStatusStateSchema = z.enum(CommitStatusState);

const RequiredCheckOutcome = {
  Passed: "passed",
  Pending: "pending",
  Failed: "failed",
} as const;
type RequiredCheckOutcome =
  (typeof RequiredCheckOutcome)[keyof typeof RequiredCheckOutcome];

export const MergeMethod = {
  Merge: "merge",
  Squash: "squash",
  Rebase: "rebase",
} as const;
export type MergeMethod = (typeof MergeMethod)[keyof typeof MergeMethod];

export const ExpectedEndState = {
  PullRequestMerged: "pull_request_merged",
  BaseBranchPushed: "base_branch_pushed",
} as const;
export type ExpectedEndState =
  (typeof ExpectedEndState)[keyof typeof ExpectedEndState];

export interface CheckFold {
  end_state: CheckEndState;
  landed_commits: string[];
}

export interface ChangeRequest {
  review_id: number;
  reviewer: string;
  body: string;
  submitted_at: string | null;
  commit_id: string;
  comments: { path: string; line: number | null; body: string }[];
}

export interface ChangeRequestRead {
  head_commit: string;
  change_requests: ChangeRequest[];
}

export interface RequiredCheckRead {
  head_commit: string;
  base_branch: string;
  pending: string[];
  failed: string[];
}

export interface ReviewCommentPage {
  body: unknown;
  next_cursor: string | null;
}

export interface ReviewCommentQuery {
  number: number;
  limit?: number;
  cursor?: string;
}

const cursorSchema = z.strictObject({
  page: z.int().min(FIRST_PAGE).max(Number.MAX_SAFE_INTEGER),
  per_page: z.int().min(REVIEW_COMMENT_LIMIT_MIN).max(REVIEW_COMMENT_LIMIT_MAX),
});
type Cursor = z.infer<typeof cursorSchema>;

const eventListSchema = z.array(
  z.looseObject({ id: z.string().regex(EVENT_ID_PATTERN), type: z.string() }),
);

const closedPullRequestListSchema = z.array(
  z.looseObject({
    number: z.int().min(MIN_PULL_REQUEST_NUMBER),
    closed_at: z.string().min(MIN_JSON_LENGTH),
  }),
);

const listedIssueCommentListSchema = z.array(
  z.looseObject({
    id: z.int().min(MIN_POSITIVE_ID),
    issue_url: z.string(),
  }),
);
const postedIssueCommentSchema = z.looseObject({
  id: z.int().min(MIN_POSITIVE_ID),
  user: z.looseObject({ id: z.int() }).nullish(),
});
const tokenAccountSchema = z.looseObject({ id: z.int().min(MIN_POSITIVE_ID) });

const createdPullRequestSchema = z.looseObject({ number: z.int() });
const pullRequestListSchema = z.array(z.looseObject({ number: z.int() }));
const repositorySettingsSchema = z.looseObject({
  allow_merge_commit: z.boolean().optional(),
  allow_squash_merge: z.boolean().optional(),
  allow_rebase_merge: z.boolean().optional(),
});
const pullRequestStateSchema = z
  .looseObject({
    state: z.string(),
    merged: z.boolean(),
    merge_commit_sha: z.string().nullable(),
    mergeable_state: z.string().optional(),
  })
  .superRefine((pullRequest, context) => {
    if (pullRequest.merged && pullRequest.merge_commit_sha === null)
      context.addIssue({
        code: "custom",
        path: ["merge_commit_sha"],
        message: "A merged pull request names its merge commit.",
      });
  });

const mergeabilityStateSchema = z.looseObject({
  state: z.string(),
  merged: z.boolean().optional(),
  mergeable: z.boolean().nullable().optional(),
});

const pullRequestHeadSchema = z.looseObject({
  head: z.looseObject({ sha: z.string().min(MIN_SEGMENT_LENGTH) }),
});
const requiredCheckPullRequestSchema = z.looseObject({
  head: z.looseObject({ sha: z.string().min(MIN_SEGMENT_LENGTH) }),
  base: z.looseObject({ ref: z.string().min(MIN_SEGMENT_LENGTH) }),
});
const branchRuleListSchema = z.array(
  z.looseObject({ type: z.string(), parameters: z.unknown().optional() }),
);
const requiredStatusChecksParametersSchema = z.looseObject({
  required_status_checks: z.array(
    z.looseObject({ context: z.string().min(MIN_SEGMENT_LENGTH) }),
  ),
});
const checkRunsBodySchema = z.looseObject({
  check_runs: z.array(
    z.looseObject({
      id: z.int(),
      name: z.string(),
      status: z.string(),
      conclusion: z.string().nullable().optional(),
    }),
  ),
});
const commitStatusListSchema = z.array(
  z.looseObject({ context: z.string(), state: commitStatusStateSchema }),
);
const reviewListSchema = z.array(
  z.looseObject({
    user: z
      .looseObject({ id: z.int(), type: z.string().optional() })
      .nullable(),
    state: z.string(),
    commit_id: z.string().nullable().optional(),
  }),
);
type Review = z.infer<typeof reviewListSchema>[number];
const changeRequestReviewListSchema = z.array(
  z.looseObject({
    id: z.int(),
    user: z
      .looseObject({
        id: z.int(),
        login: z.string(),
        type: z.string().optional(),
      })
      .nullable(),
    state: z.string(),
    commit_id: z.string().nullable().optional(),
    body: z.string().nullable().optional(),
    submitted_at: z.string().nullable().optional(),
  }),
);
const reviewCommentListSchema = z.array(
  z.looseObject({
    path: z.string(),
    line: z.int().nullable().optional(),
    body: z.string(),
  }),
);

export interface GitHubOptions {
  baseUrl?: string;
  mergeabilityRetryDelayMs?: number;
}

interface Exchange {
  data: unknown;
  link: string | null;
  etag: string | null;
  pollIntervalMs: number | null;
  notModified: boolean;
}

type Attempt =
  | { ok: true; value: Exchange }
  | { ok: false; error: unknown; phase: DispatchPhase };

export function repositoryOf(target: GitHubTarget): GitHubRepository {
  const match =
    target.kind === GitHubTargetKind.Binding
      ? BINDING_ADDRESS_PATTERN.exec(target.address)
      : INBOUND_RESOURCE_PATTERN.exec(target.resource);
  if (match === null) {
    throw new Error(`invalid GitHub target of kind ${target.kind}`);
  }
  const [, owner, repo] = match;
  assert.ok(owner !== undefined && owner.length >= MIN_SEGMENT_LENGTH);
  assert.ok(repo !== undefined && repo.length >= MIN_SEGMENT_LENGTH);
  return { owner, repo };
}

export function classify(
  error: unknown,
  phase: DispatchPhase,
  kind: CallKind,
): GitHubFailure {
  assert.ok(Object.values(DispatchPhase).includes(phase));
  assert.ok(Object.values(CallKind).includes(kind));
  const message = error instanceof Error ? error.message : String(error);
  if (!(error instanceof RequestError) || error.response === undefined) {
    return failure(transportClass(phase, kind), null, message);
  }
  const rateLimit = rateLimitOf(error.status, error.response.headers, message);
  return failure(
    statusClass(error.status, rateLimit !== undefined, kind),
    error.status,
    message,
    rateLimit,
  );
}

function secondsOf(value: unknown): number | null {
  if (!isString(value) || !SECONDS_PATTERN.test(value)) return null;
  const seconds = Number(value);
  return Number.isSafeInteger(seconds) ? seconds : null;
}

function rateLimitOf(
  status: number,
  headers: Record<string, unknown>,
  message: string,
): GitHubRateLimit | undefined {
  assert.ok(Number.isInteger(status));
  const exhausted =
    String(headers[RATE_LIMIT_REMAINING_HEADER]) === RATE_LIMIT_EXHAUSTED;
  const limited =
    status === HttpStatus.TooManyRequests ||
    (status === HttpStatus.Forbidden &&
      (exhausted || SECONDARY_RATE_LIMIT_PATTERN.test(message)));
  if (!limited) return undefined;
  const retryAfter = secondsOf(headers[RETRY_AFTER_HEADER]);
  if (retryAfter !== null) return { wait_ms: retryAfter * MS_PER_SECOND };
  const reset = secondsOf(headers[RATE_LIMIT_RESET_HEADER]);
  if (exhausted && reset !== null)
    return {
      wait_ms: Math.max(NO_TIME_LEFT_MS, reset * MS_PER_SECOND - Date.now()),
    };
  return { wait_ms: null };
}

function singleHeaderValue(headers: Headers, name: string): string | null {
  assert.ok(headers instanceof Headers);
  assert.ok(name.length >= MIN_SEGMENT_LENGTH);
  const parsed = singleHeaderValueSchema.safeParse(headers.get(name));
  return parsed.success ? parsed.data : null;
}

export function classifyDelivery(headers: Headers): DeliveryClassification {
  assert.ok(headers instanceof Headers);
  const event = singleHeaderValue(headers, EVENT_HEADER);
  if (event === null) {
    return { kind: DeliveryKind.Invalid };
  }
  if (event === PING_EVENT) {
    return { kind: DeliveryKind.Handshake, status: HttpStatus.NoContent };
  }
  const eventId = singleHeaderValue(headers, DELIVERY_HEADER);
  if (eventId === null) {
    return { kind: DeliveryKind.Invalid };
  }
  assert.ok(event.length >= MIN_SEGMENT_LENGTH);
  return { kind: DeliveryKind.Event, event_id: eventId, metadata: { event } };
}

function transportClass(phase: DispatchPhase, kind: CallKind) {
  if (kind === CallKind.Read) {
    return ResultClass.RetryableRefusal;
  }
  return phase === DispatchPhase.BeforeDispatch
    ? ResultClass.ConfirmedFailure
    : ResultClass.UnknownOutcome;
}

function statusClass(
  status: number,
  rateLimited: boolean,
  kind: CallKind,
): ResultClassValue {
  assert.ok(Number.isInteger(status));
  if (status >= HttpStatus.InternalServerError) {
    return kind === CallKind.Read
      ? ResultClass.RetryableRefusal
      : ResultClass.UnknownOutcome;
  }
  if (rateLimited || status === HttpStatus.RequestTimeout) {
    return ResultClass.RetryableRefusal;
  }
  return ResultClass.FinalRefusal;
}

function failure(
  resultClass: ResultClassValue,
  status: number | null,
  message: string,
  rateLimit?: GitHubRateLimit,
): GitHubFailure {
  assert.ok(Object.values(ResultClass).includes(resultClass));
  assert.ok(status === null || Number.isInteger(status));
  return {
    ok: false,
    class: resultClass,
    code: GITHUB_RESULT_CODE_PREFIX + resultClass,
    status,
    message,
    ...(rateLimit === undefined ? {} : { rate_limit: rateLimit }),
  };
}

function dispatchPhaseOf(error: unknown): DispatchPhase {
  let cause: unknown = error;
  for (let depth = 0; depth < CAUSE_DEPTH_LIMIT; depth += 1) {
    if (!(cause instanceof Error)) {
      return DispatchPhase.AfterDispatch;
    }
    const code = (cause as { code?: unknown }).code;
    if (isString(code) && BEFORE_DISPATCH_CODES.has(code)) {
      return DispatchPhase.BeforeDispatch;
    }
    cause = cause.cause;
  }
  return DispatchPhase.AfterDispatch;
}

function deadlineError(): Error {
  return new Error("the deadline of the GitHub call passed before dispatch");
}

function isTransportError(error: unknown): boolean {
  return !(error instanceof RequestError) || error.response === undefined;
}

function unreadableBody(kind: CallKind): GitHubFailure {
  assert.ok(Object.values(CallKind).includes(kind));
  const answer = failure(
    transportClass(DispatchPhase.AfterDispatch, kind),
    null,
    "the GitHub answer holds an unexpected body",
  );
  assert.ok(!answer.ok);
  return answer;
}

function exchangeOf(
  response: { data: unknown; headers: Record<string, unknown> },
  notModified: boolean,
): Exchange {
  assert.ok(typeof notModified === ValueType.Boolean);
  const { link, etag } = response.headers;
  const pollSeconds = secondsOf(response.headers[POLL_INTERVAL_HEADER]);
  const exchange = {
    data: notModified ? null : response.data,
    link: isString(link) ? link : null,
    etag: isString(etag) ? etag : null,
    pollIntervalMs: pollSeconds === null ? null : pollSeconds * MS_PER_SECOND,
    notModified,
  };
  assert.ok(!exchange.notModified || exchange.data === null);
  return exchange;
}

function invalidCursor(): never {
  throw new OperationError(
    HttpStatus.BadRequest,
    CURSOR_INVALID_CODE,
    "Cursor is invalid.",
  );
}

export function encodeCursor(cursor: Cursor): string {
  assert.ok(cursorSchema.safeParse(cursor).success);
  const encoded = Buffer.from(canonicalJSON(cursor), TEXT_ENCODING).toString(
    CURSOR_ENCODING,
  );
  assert.deepEqual(decodeCursor(encoded), cursor);
  return encoded;
}

export function decodeCursor(cursor: string): Cursor {
  const text = Buffer.from(cursor, CURSOR_ENCODING).toString(TEXT_ENCODING);
  if (Buffer.from(text, TEXT_ENCODING).toString(CURSOR_ENCODING) !== cursor) {
    invalidCursor();
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    invalidCursor();
  }
  const parsed = cursorSchema.safeParse(value);
  if (!parsed.success || canonicalJSON(parsed.data) !== text) {
    invalidCursor();
  }
  return parsed.data;
}

export function reviewCommentPage(query: ReviewCommentQuery): Cursor {
  assert.ok(Number.isInteger(query.number));
  assert.ok(
    query.limit === undefined ||
      (Number.isInteger(query.limit) &&
        query.limit >= REVIEW_COMMENT_LIMIT_MIN &&
        query.limit <= REVIEW_COMMENT_LIMIT_MAX),
  );
  if (query.cursor === undefined) {
    return {
      page: FIRST_PAGE,
      per_page: query.limit ?? REVIEW_COMMENT_LIMIT_DEFAULT,
    };
  }
  const cursor = decodeCursor(query.cursor);
  if (query.limit !== undefined && query.limit !== cursor.per_page) {
    throw new OperationError(
      HttpStatus.BadRequest,
      CURSOR_PAGE_SIZE_MISMATCH_CODE,
      "The limit differs from the page size of the cursor.",
      { limit: query.limit, per_page: cursor.per_page },
    );
  }
  return cursor;
}

function eventsOf(data: unknown): GitHubEvent[] | null {
  const listed = eventListSchema.safeParse(data);
  if (!listed.success) {
    return null;
  }
  const events: GitHubEvent[] = [];
  for (const event of listed.data) {
    const body = canonicalEventBody(event);
    if (body === null) {
      return null;
    }
    events.push({ id: event.id, type: event.type, body });
  }
  assert.equal(events.length, listed.data.length);
  return events;
}

function closedPullRequestsOf(data: unknown): GitHubEvent[] | null {
  const listed = closedPullRequestListSchema.safeParse(data);
  if (!listed.success) {
    return null;
  }
  const events: GitHubEvent[] = [];
  for (const item of listed.data) {
    const body = canonicalEventBody(item);
    if (body === null) {
      return null;
    }
    events.push({
      id: `pull_request:${item.number}:${item.closed_at}`,
      type: CLOSED_PULL_REQUEST_EVENT_TYPE,
      body,
    });
  }
  assert.equal(events.length, listed.data.length);
  return events;
}

function batchAnswerOf(
  exchange: Exchange,
  itemsOf: (data: unknown) => GitHubEvent[] | null,
): GitHubAnswer<GitHubEventsAnswer> {
  const poll =
    exchange.pollIntervalMs === null
      ? {}
      : { poll_interval_ms: exchange.pollIntervalMs };
  if (exchange.notModified) {
    return { ok: true, value: { notModified: true, ...poll } };
  }
  const events = itemsOf(exchange.data);
  return events === null
    ? unreadableBody(CallKind.Read)
    : {
        ok: true,
        value: { notModified: false, etag: exchange.etag, events, ...poll },
      };
}

function canonicalEventBody(event: object): Uint8Array | null {
  assert.ok(typeof event === ValueType.Object && event !== null);
  try {
    const text = canonicalJSON(event);
    assert.ok(text.length >= MIN_JSON_LENGTH);
    return new Uint8Array(Buffer.from(text, TEXT_ENCODING));
  } catch (error) {
    if (error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}

function issueCommentEventsOf(data: unknown): GitHubEvent[] | null {
  const listed = listedIssueCommentListSchema.safeParse(data);
  if (!listed.success) {
    return null;
  }
  const events: GitHubEvent[] = [];
  for (const item of listed.data) {
    const body = canonicalEventBody(item);
    if (body === null) {
      return null;
    }
    events.push({
      id: ISSUE_COMMENT_KEY_PREFIX + item.id,
      type: ISSUE_COMMENT_LISTED_EVENT_TYPE,
      body,
    });
  }
  assert.equal(events.length, listed.data.length);
  return events;
}

function lastPageOf(link: string | null): number | null {
  assert.ok(link === null || isString(link));
  if (link === null) return null;
  for (const part of link.split(",")) {
    const page = LAST_LINK_PATTERN.exec(part)?.[1];
    if (page !== undefined) return Number(page);
  }
  return null;
}

function currentChangeRequests<R extends Review>(
  reviews: readonly R[],
  head: string,
  trustedActorIds: readonly string[],
): R[] {
  assert.ok(head.length >= MIN_SEGMENT_LENGTH);
  const latest = new Map<number, R>();
  for (const review of reviews) {
    if (
      review.user !== null &&
      review.user.type === USER_ACCOUNT_TYPE &&
      trustedActorIds.includes(String(review.user.id)) &&
      DECISIVE_REVIEW_STATES.has(review.state)
    )
      latest.set(review.user.id, review);
  }
  return [...latest.values()].filter(
    (review) =>
      review.state === ReviewState.ChangesRequested &&
      review.commit_id === head,
  );
}

function requiredContextsOf(rules: unknown): string[] {
  const contexts = new Set<string>();
  for (const rule of branchRuleListSchema.parse(rules)) {
    if (rule.type !== REQUIRED_STATUS_CHECKS_RULE) continue;
    const parameters = requiredStatusChecksParametersSchema.parse(
      rule.parameters,
    );
    for (const check of parameters.required_status_checks)
      contexts.add(check.context);
  }
  return [...contexts];
}

function outcomeOfRun(run: {
  status: string;
  conclusion?: string | null;
}): RequiredCheckOutcome {
  if (run.status !== CHECK_RUN_COMPLETED) return RequiredCheckOutcome.Pending;
  return run.conclusion != null && PASSING_CONCLUSIONS.has(run.conclusion)
    ? RequiredCheckOutcome.Passed
    : RequiredCheckOutcome.Failed;
}

function outcomeOfStatus(
  state: z.infer<typeof commitStatusStateSchema>,
): RequiredCheckOutcome {
  if (state === CommitStatusState.Success) return RequiredCheckOutcome.Passed;
  return state === CommitStatusState.Pending
    ? RequiredCheckOutcome.Pending
    : RequiredCheckOutcome.Failed;
}

function newestRunsOf(
  checkRuns: unknown,
): Map<string, z.infer<typeof checkRunsBodySchema>["check_runs"][number]> {
  const newestRuns = new Map<
    string,
    z.infer<typeof checkRunsBodySchema>["check_runs"][number]
  >();
  for (const run of checkRunsBodySchema.parse(checkRuns).check_runs) {
    const known = newestRuns.get(run.name);
    if (known === undefined || run.id > known.id) newestRuns.set(run.name, run);
  }
  return newestRuns;
}

function newestStatesOf(
  statuses: unknown,
): Map<string, z.infer<typeof commitStatusStateSchema>> {
  const newestStates = new Map<
    string,
    z.infer<typeof commitStatusStateSchema>
  >();
  for (const status of commitStatusListSchema.parse(statuses)) {
    if (!newestStates.has(status.context))
      newestStates.set(status.context, status.state);
  }
  return newestStates;
}

function outcomeOfCheck(
  run: z.infer<typeof checkRunsBodySchema>["check_runs"][number] | undefined,
  state: z.infer<typeof commitStatusStateSchema> | undefined,
): RequiredCheckOutcome {
  if (run !== undefined) return outcomeOfRun(run);
  if (state !== undefined) return outcomeOfStatus(state);
  return RequiredCheckOutcome.Pending;
}

export function foldRequiredChecks(
  required: readonly string[],
  checkRuns: unknown,
  statuses: unknown,
): { pending: string[]; failed: string[] } {
  const newestRuns = newestRunsOf(checkRuns);
  const newestStates = newestStatesOf(statuses);
  const pending: string[] = [];
  const failed: string[] = [];
  for (const name of new Set(required)) {
    const run = newestRuns.get(name);
    const state = newestStates.get(name);
    const outcome = outcomeOfCheck(run, state);
    if (outcome === RequiredCheckOutcome.Pending) pending.push(name);
    if (outcome === RequiredCheckOutcome.Failed) failed.push(name);
  }
  return { pending: pending.sort(), failed: failed.sort() };
}

export function hasNextLink(link: string | null): boolean {
  assert.ok(link === null || isString(link));
  return (
    link !== null &&
    link.split(",").some((part) => NEXT_LINK_PATTERN.test(part))
  );
}

function mergeabilityPending(body: unknown): boolean {
  const parsed = mergeabilityStateSchema.safeParse(body);
  return (
    parsed.success &&
    parsed.data.state === PULL_REQUEST_STATE_OPEN &&
    parsed.data.merged !== true &&
    parsed.data.mergeable === null
  );
}

function openEndState(
  pullRequest: z.infer<typeof pullRequestStateSchema>,
  reviews: unknown,
  checks: Pick<RequiredCheckRead, "head_commit" | "pending" | "failed">,
  headCommit: string,
  trustedActorIds: readonly string[],
): CheckEndState {
  if (
    currentChangeRequests(
      reviewListSchema.parse(reviews),
      headCommit,
      trustedActorIds,
    ).length > NO_CHANGE_REQUESTS
  )
    return CheckEndState.Other;
  if (pullRequest.mergeable_state === MERGEABLE_STATE_CONFLICT)
    return CheckEndState.Conflict;
  if (
    checks.head_commit === headCommit &&
    checks.failed.length > NO_FAILED_CHECKS
  )
    return CheckEndState.ChecksFailed;
  if (
    checks.head_commit !== headCommit ||
    checks.pending.length > NO_PENDING_CHECKS
  )
    return CheckEndState.ChecksPending;
  return CheckEndState.None;
}

function attemptOfError(error: unknown, signal: AbortSignal): Attempt {
  if (
    error instanceof RequestError &&
    error.status === NOT_MODIFIED_STATUS &&
    error.response !== undefined
  ) {
    return { ok: true, value: exchangeOf(error.response, true) };
  }
  if (!(error instanceof RequestError) && !signal.aborted) {
    throw error;
  }
  const phase = signal.aborted
    ? DispatchPhase.AfterDispatch
    : dispatchPhaseOf(error);
  return { ok: false, error, phase };
}

export class GitHubPlatform {
  readonly #baseUrl: string;
  readonly #mergeabilityRetryDelayMs: number;

  constructor(options: GitHubOptions = {}) {
    this.#baseUrl = options.baseUrl ?? GITHUB_API_BASE_URL;
    assert.ok(URL.canParse(this.#baseUrl));
    this.#mergeabilityRetryDelayMs =
      options.mergeabilityRetryDelayMs ?? MERGEABILITY_RETRY_DELAY_MS;
    assert.ok(Number.isSafeInteger(this.#mergeabilityRetryDelayMs));
    assert.ok(this.#mergeabilityRetryDelayMs >= NO_TIME_LEFT_MS);
  }

  async send(
    call: GitHubCall,
    target: GitHubTarget,
    request: GitHubRequest,
  ): Promise<GitHubAnswer<unknown>> {
    const answer = await this.#exchange(call, target, request);
    return answer.ok ? { ok: true, value: answer.value.data } : answer;
  }

  async createPullRequest(
    call: GitHubCall,
    target: GitHubTarget,
    pullRequest: { head: string; base: string; title: string; body?: string },
  ): Promise<GitHubAnswer<{ number: number }>> {
    assert.ok(pullRequest.head.length >= MIN_SEGMENT_LENGTH);
    assert.ok(pullRequest.base.length >= MIN_SEGMENT_LENGTH);
    const answer = await this.send(call, target, {
      kind: CallKind.Write,
      route: "POST /repos/{owner}/{repo}/pulls",
      parameters: { ...pullRequest },
    });
    if (!answer.ok) {
      return answer;
    }
    const created = createdPullRequestSchema.safeParse(answer.value);
    return created.success
      ? { ok: true, value: { number: created.data.number } }
      : unreadableBody(CallKind.Write);
  }

  async openPullRequests(
    call: GitHubCall,
    target: GitHubTarget,
    branches: { head: string; base: string },
  ): Promise<GitHubAnswer<number[]>> {
    assert.ok(branches.head.length >= MIN_SEGMENT_LENGTH);
    assert.ok(branches.base.length >= MIN_SEGMENT_LENGTH);
    const { owner } = repositoryOf(target);
    const answer = await this.send(call, target, {
      kind: CallKind.Read,
      route: "GET /repos/{owner}/{repo}/pulls",
      parameters: {
        state: PULL_REQUEST_STATE_OPEN,
        head: `${owner}:${branches.head}`,
        base: branches.base,
      },
    });
    if (!answer.ok) {
      return answer;
    }
    const listed = pullRequestListSchema.safeParse(answer.value);
    return listed.success
      ? {
          ok: true,
          value: listed.data.map((pullRequest) => pullRequest.number),
        }
      : unreadableBody(CallKind.Read);
  }

  async mergeMethodOf(
    call: GitHubCall,
    target: GitHubTarget,
  ): Promise<GitHubAnswer<MergeMethod | null>> {
    const answer = await this.send(call, target, {
      kind: CallKind.Read,
      route: "GET /repos/{owner}/{repo}",
      parameters: {},
    });
    if (!answer.ok) {
      return answer;
    }
    const settings = repositorySettingsSchema.safeParse(answer.value);
    if (!settings.success) {
      return unreadableBody(CallKind.Read);
    }
    const allowed = [
      settings.data.allow_merge_commit === true && MergeMethod.Merge,
      settings.data.allow_squash_merge === true && MergeMethod.Squash,
      settings.data.allow_rebase_merge === true && MergeMethod.Rebase,
    ].find((method) => method !== false);
    return { ok: true, value: allowed ?? null };
  }

  async mergePullRequest(
    call: GitHubCall,
    target: GitHubTarget,
    merge: { number: number; sha: string; merge_method: MergeMethod },
  ): Promise<GitHubAnswer<unknown>> {
    assert.ok(merge.number >= MIN_PULL_REQUEST_NUMBER);
    assert.ok(merge.sha.length >= MIN_SEGMENT_LENGTH);
    assert.ok(Object.values(MergeMethod).includes(merge.merge_method));
    return this.send(call, target, {
      kind: CallKind.Write,
      route: "PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge",
      parameters: {
        pull_number: merge.number,
        sha: merge.sha,
        merge_method: merge.merge_method,
      },
    });
  }

  async getPullRequest(
    call: GitHubCall,
    target: GitHubTarget,
    pullRequest: { number: number },
  ): Promise<GitHubAnswer<unknown>> {
    assert.ok(Number.isInteger(pullRequest.number));
    assert.ok(pullRequest.number >= MIN_PULL_REQUEST_NUMBER);
    return this.send(call, target, {
      kind: CallKind.Read,
      route: "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      parameters: { pull_number: pullRequest.number },
    });
  }

  async pullRequestMergedAt(
    call: GitHubCall,
    target: GitHubTarget,
    input: { number: number; sha: string },
  ): Promise<GitHubAnswer<boolean>> {
    assert.ok(Number.isInteger(input.number));
    assert.ok(input.number >= MIN_PULL_REQUEST_NUMBER);
    assert.ok(input.sha.length >= MIN_SEGMENT_LENGTH);
    const answer = await this.send(call, target, {
      kind: CallKind.Read,
      route: "GET /repos/{owner}/{repo}/pulls/{pull_number}",
      parameters: { pull_number: input.number },
    });
    if (!answer.ok) return answer;
    const parsed = z
      .looseObject({
        merged: z.boolean(),
        head: z.looseObject({ sha: z.string().min(MIN_SEGMENT_LENGTH) }),
      })
      .safeParse(answer.value);
    if (!parsed.success) return unreadableBody(CallKind.Read);
    return {
      ok: true,
      value: parsed.data.merged && parsed.data.head.sha === input.sha,
    };
  }

  async getSettledPullRequest(
    call: GitHubCall,
    target: GitHubTarget,
    pullRequest: { number: number },
  ): Promise<GitHubAnswer<unknown>> {
    let answer = await this.getPullRequest(call, target, pullRequest);
    for (let read = 1; read < MERGEABILITY_READ_LIMIT; read += 1) {
      if (!answer.ok || !mergeabilityPending(answer.value)) break;
      const remaining = call.deadlineAt - Date.now();
      if (call.signal.aborted || remaining <= this.#mergeabilityRetryDelayMs)
        break;
      await sleep(this.#mergeabilityRetryDelayMs);
      answer = await this.getPullRequest(call, target, pullRequest);
    }
    return answer;
  }

  async listReviewComments(
    call: GitHubCall,
    target: GitHubTarget,
    query: ReviewCommentQuery,
  ): Promise<GitHubAnswer<ReviewCommentPage>> {
    assert.ok(query.number >= MIN_PULL_REQUEST_NUMBER);
    const page = reviewCommentPage(query);
    const answer = await this.#exchange(call, target, {
      kind: CallKind.Read,
      route: "GET /repos/{owner}/{repo}/pulls/{pull_number}/comments",
      parameters: {
        pull_number: query.number,
        per_page: page.per_page,
        page: page.page,
      },
    });
    if (!answer.ok) {
      return answer;
    }
    const next = hasNextLink(answer.value.link)
      ? encodeCursor({ ...page, page: page.page + NEXT_PAGE_STEP })
      : null;
    return { ok: true, value: { body: answer.value.data, next_cursor: next } };
  }

  async listReviews(
    call: GitHubCall,
    target: GitHubTarget,
    pullRequest: { number: number },
  ): Promise<GitHubAnswer<unknown[]>> {
    assert.ok(Number.isInteger(pullRequest.number));
    assert.ok(pullRequest.number >= MIN_PULL_REQUEST_NUMBER);
    return this.#listPages(
      call,
      target,
      "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews",
      { pull_number: pullRequest.number },
    );
  }

  async getChangeRequests(
    call: GitHubCall,
    target: GitHubTarget,
    pullRequest: { number: number },
    trustedActorIds: readonly string[],
  ): Promise<GitHubAnswer<ChangeRequestRead>> {
    assert.ok(Number.isInteger(pullRequest.number));
    assert.ok(pullRequest.number >= MIN_PULL_REQUEST_NUMBER);
    const body = await this.getPullRequest(call, target, pullRequest);
    if (!body.ok) return body;
    const head = pullRequestHeadSchema.safeParse(body.value);
    if (!head.success) return unreadableBody(CallKind.Read);
    const listed = await this.listReviews(call, target, pullRequest);
    if (!listed.ok) return listed;
    const reviews = changeRequestReviewListSchema.safeParse(listed.value);
    if (!reviews.success) return unreadableBody(CallKind.Read);
    const changeRequests: ChangeRequest[] = [];
    for (const review of currentChangeRequests(
      reviews.data,
      head.data.head.sha,
      trustedActorIds,
    )) {
      const comments = await this.#listPages(
        call,
        target,
        "GET /repos/{owner}/{repo}/pulls/{pull_number}/reviews/{review_id}/comments",
        { pull_number: pullRequest.number, review_id: review.id },
      );
      if (!comments.ok) return comments;
      const parsed = reviewCommentListSchema.safeParse(comments.value);
      if (!parsed.success) return unreadableBody(CallKind.Read);
      assert.ok(review.user !== null);
      changeRequests.push({
        review_id: review.id,
        reviewer: review.user.login,
        body: review.body ?? "",
        submitted_at: review.submitted_at ?? null,
        commit_id: head.data.head.sha,
        comments: parsed.data.map((comment) => ({
          path: comment.path,
          line: comment.line ?? null,
          body: comment.body,
        })),
      });
    }
    return {
      ok: true,
      value: {
        head_commit: head.data.head.sha,
        change_requests: changeRequests,
      },
    };
  }

  async getRequiredChecks(
    call: GitHubCall,
    target: GitHubTarget,
    pullRequest: { number: number },
  ): Promise<GitHubAnswer<RequiredCheckRead>> {
    const body = await this.getPullRequest(call, target, pullRequest);
    if (!body.ok) return body;
    const parsed = requiredCheckPullRequestSchema.safeParse(body.value);
    if (!parsed.success) return unreadableBody(CallKind.Read);
    const head = parsed.data.head.sha;
    const base = parsed.data.base.ref;
    const rules = await this.#listPages(call, target, BRANCH_RULES_ROUTE, {
      branch: base,
    });
    if (!rules.ok) return rules;
    const read = (checks: { pending: string[]; failed: string[] }) => ({
      ok: true as const,
      value: { head_commit: head, base_branch: base, ...checks },
    });
    try {
      const required = requiredContextsOf(rules.value);
      if (required.length === NO_REQUIRED_CHECKS)
        return read({ pending: [], failed: [] });
      const checkRuns = await this.#exchange(call, target, {
        kind: CallKind.Read,
        route: CHECK_RUNS_ROUTE,
        parameters: { ref: head, per_page: CHECK_RUN_PAGE_SIZE },
      });
      if (!checkRuns.ok) return checkRuns;
      const statuses = await this.#listPages(
        call,
        target,
        COMMIT_STATUSES_ROUTE,
        { ref: head },
      );
      if (!statuses.ok) return statuses;
      return read(
        foldRequiredChecks(required, checkRuns.value.data, statuses.value),
      );
    } catch (error) {
      if (error instanceof z.ZodError) return unreadableBody(CallKind.Read);
      throw error;
    }
  }

  async #listPages(
    call: GitHubCall,
    target: GitHubTarget,
    route: string,
    parameters: Record<string, unknown>,
  ): Promise<GitHubAnswer<unknown[]>> {
    const items: unknown[] = [];
    for (let page = FIRST_PAGE; page <= REVIEW_PAGE_LIMIT; page += 1) {
      const answer = await this.#exchange(call, target, {
        kind: CallKind.Read,
        route,
        parameters: { ...parameters, per_page: REVIEW_PAGE_SIZE, page },
      });
      if (!answer.ok) return answer;
      if (!Array.isArray(answer.value.data))
        return unreadableBody(CallKind.Read);
      items.push(...(answer.value.data as unknown[]));
      if (!hasNextLink(answer.value.link)) return { ok: true, value: items };
    }
    return unreadableBody(CallKind.Read);
  }

  async listEvents(
    call: GitHubCall,
    query: GitHubEventsQuery,
  ): Promise<GitHubAnswer<GitHubEventsAnswer>> {
    assert.ok(call.token.length >= MIN_TOKEN_LENGTH);
    assert.ok(query.owner.length >= MIN_SEGMENT_LENGTH);
    assert.ok(query.repo.length >= MIN_SEGMENT_LENGTH);
    assert.ok(Number.isFinite(call.deadlineAt));
    const answer = await this.#read(
      call,
      { owner: query.owner, repo: query.repo },
      {
        kind: CallKind.Read,
        route: "GET /repos/{owner}/{repo}/events",
        parameters: { per_page: EVENT_PAGE_SIZE },
        headers:
          query.etag === null ? {} : { [IF_NONE_MATCH_HEADER]: query.etag },
      },
    );
    return answer.ok ? batchAnswerOf(answer.value, eventsOf) : answer;
  }

  async listClosedPullRequests(
    call: GitHubCall,
    query: GitHubEventsQuery,
  ): Promise<GitHubAnswer<GitHubEventsAnswer>> {
    assert.ok(call.token.length >= MIN_TOKEN_LENGTH);
    assert.ok(query.owner.length >= MIN_SEGMENT_LENGTH);
    assert.ok(query.repo.length >= MIN_SEGMENT_LENGTH);
    assert.ok(Number.isFinite(call.deadlineAt));
    const answer = await this.#read(
      call,
      { owner: query.owner, repo: query.repo },
      {
        kind: CallKind.Read,
        route: "GET /repos/{owner}/{repo}/pulls",
        parameters: {
          state: "closed",
          sort: "updated",
          direction: "desc",
          per_page: CLOSED_PULL_REQUEST_PAGE_SIZE,
        },
        headers:
          query.etag === null ? {} : { [IF_NONE_MATCH_HEADER]: query.etag },
      },
    );
    return answer.ok
      ? batchAnswerOf(answer.value, closedPullRequestsOf)
      : answer;
  }

  async listIssueComments(
    call: GitHubCall,
    target: GitHubTarget,
    query: { etag: string | null },
  ): Promise<GitHubAnswer<GitHubEventsAnswer>> {
    assert.ok(call.token.length >= MIN_TOKEN_LENGTH);
    assert.ok(Number.isFinite(call.deadlineAt));
    const answer = await this.#exchange(call, target, {
      kind: CallKind.Read,
      route: "GET /repos/{owner}/{repo}/issues/comments",
      parameters: {
        sort: "updated",
        direction: "desc",
        per_page: ISSUE_COMMENT_PAGE_SIZE,
      },
      headers:
        query.etag === null ? {} : { [IF_NONE_MATCH_HEADER]: query.etag },
    });
    return answer.ok
      ? batchAnswerOf(answer.value, issueCommentEventsOf)
      : answer;
  }

  async listIssueCommentsOf(
    call: GitHubCall,
    target: GitHubTarget,
    number: number,
  ): Promise<GitHubAnswer<GitHubEvent[]>> {
    assert.ok(
      Number.isSafeInteger(number) && number >= MIN_PULL_REQUEST_NUMBER,
    );
    const read = (page: number) =>
      this.#exchange(call, target, {
        kind: CallKind.Read,
        route: ISSUE_COMMENTS_ROUTE,
        parameters: {
          issue_number: number,
          per_page: ISSUE_COMMENT_PAGE_SIZE,
          ...(page === FIRST_PAGE ? {} : { page }),
        },
      });
    const first = await read(FIRST_PAGE);
    if (!first.ok) return first;
    const last = lastPageOf(first.value.link);
    const second =
      last === null || last <= FIRST_PAGE ? null : await read(last);
    if (second !== null && !second.ok) return second;
    const pages = [first.value, ...(second === null ? [] : [second.value])];
    if (!pages.every((page) => Array.isArray(page.data)))
      return unreadableBody(CallKind.Read);
    const events = issueCommentEventsOf(
      pages.flatMap((page) => page.data as unknown[]),
    );
    return events === null
      ? unreadableBody(CallKind.Read)
      : { ok: true, value: events };
  }

  async postIssueComment(
    call: GitHubCall,
    target: GitHubTarget,
    number: number,
    body: string,
  ): Promise<GitHubAnswer<{ update_key: string; actor_id: string | null }>> {
    assert.ok(
      Number.isSafeInteger(number) && number >= MIN_PULL_REQUEST_NUMBER,
    );
    const answer = await this.send(call, target, {
      kind: CallKind.Write,
      route: "POST /repos/{owner}/{repo}/issues/{issue_number}/comments",
      parameters: { issue_number: number, body },
    });
    if (!answer.ok) return answer;
    const posted = postedIssueCommentSchema.safeParse(answer.value);
    if (!posted.success) return unreadableBody(CallKind.Write);
    const actor = posted.data.user?.id;
    return {
      ok: true,
      value: {
        update_key: ISSUE_COMMENT_KEY_PREFIX + posted.data.id,
        actor_id: actor === undefined ? null : String(actor),
      },
    };
  }

  async readTokenAccount(call: GitHubCall): Promise<GitHubAnswer<string>> {
    assert.ok(call.token.length >= MIN_TOKEN_LENGTH);
    assert.ok(Number.isFinite(call.deadlineAt));
    const answer = await this.#read(call, null, {
      kind: CallKind.Read,
      route: "GET /user",
      parameters: {},
    });
    if (!answer.ok) return answer;
    const account = tokenAccountSchema.safeParse(answer.value.data);
    return account.success
      ? { ok: true, value: String(account.data.id) }
      : unreadableBody(CallKind.Read);
  }

  foldPullRequest(
    body: unknown,
    reviews: unknown,
    checks: Pick<RequiredCheckRead, "head_commit" | "pending" | "failed">,
    expectedEndState: ExpectedEndState,
    trustedActorIds: readonly string[],
  ): CheckFold {
    assert.equal(expectedEndState, ExpectedEndState.PullRequestMerged);
    const pullRequest = pullRequestStateSchema.parse(body);
    if (pullRequest.merged) {
      assert.ok(pullRequest.merge_commit_sha !== null);
      return {
        end_state: CheckEndState.Expected,
        landed_commits: [pullRequest.merge_commit_sha],
      };
    }
    if (pullRequest.state !== PULL_REQUEST_STATE_OPEN)
      return { end_state: CheckEndState.Other, landed_commits: [] };
    const { head } = pullRequestHeadSchema.parse(body);
    return {
      end_state: openEndState(
        pullRequest,
        reviews,
        checks,
        head.sha,
        trustedActorIds,
      ),
      landed_commits: [],
    };
  }

  async #exchange(
    call: GitHubCall,
    target: GitHubTarget,
    request: GitHubRequest,
  ): Promise<GitHubAnswer<Exchange>> {
    assert.ok(call.token.length >= MIN_TOKEN_LENGTH);
    assert.ok(Number.isFinite(call.deadlineAt));
    const repository = repositoryOf(target);
    if (request.kind === CallKind.Write) {
      const attempt = await this.#attempt(call, repository, request);
      return attempt.ok
        ? attempt
        : classify(attempt.error, attempt.phase, CallKind.Write);
    }
    return this.#read(call, repository, request);
  }

  async #read(
    call: GitHubCall,
    repository: GitHubRepository | null,
    request: GitHubRequest,
  ): Promise<GitHubAnswer<Exchange>> {
    let attempt: Attempt = await this.#attempt(call, repository, request);
    for (let count = 1; count < READ_ATTEMPT_LIMIT; count += 1) {
      if (attempt.ok || !isTransportError(attempt.error)) {
        break;
      }
      const remaining = call.deadlineAt - Date.now();
      if (call.signal.aborted || remaining <= NO_TIME_LEFT_MS) {
        break;
      }
      await sleep(Math.min(READ_RETRY_DELAY_MS, remaining));
      attempt = await this.#attempt(call, repository, request);
    }
    return attempt.ok
      ? attempt
      : classify(attempt.error, attempt.phase, CallKind.Read);
  }

  async #attempt(
    call: GitHubCall,
    repository: GitHubRepository | null,
    request: GitHubRequest,
  ): Promise<Attempt> {
    const remaining = call.deadlineAt - Date.now();
    if (call.signal.aborted || remaining <= NO_TIME_LEFT_MS) {
      return {
        ok: false,
        error: call.signal.aborted ? call.signal.reason : deadlineError(),
        phase: DispatchPhase.BeforeDispatch,
      };
    }
    const signal = AbortSignal.any([
      call.signal,
      AbortSignal.timeout(remaining),
    ]);
    const client = new Octokit({
      auth: call.token,
      baseUrl: this.#baseUrl,
      retry: { enabled: false },
      throttle: { enabled: false },
    });
    try {
      const response = await client.request(request.route, {
        ...request.parameters,
        ...repository,
        headers: {
          ...request.headers,
          [API_VERSION_HEADER]: GITHUB_API_VERSION,
        },
        request: { signal },
      });
      return { ok: true, value: exchangeOf(response, false) };
    } catch (error) {
      return attemptOfError(error, signal);
    }
  }
}

export const DecodedAddressKind = {
  PullRequest: "pull_request",
  BranchPush: "branch_push",
} as const;

export type DecodedAddress =
  | {
      kind: typeof DecodedAddressKind.PullRequest;
      resource_identity: string;
      number: number;
    }
  | {
      kind: typeof DecodedAddressKind.BranchPush;
      resource_identity: string;
      branch: string;
      commit: string;
    };

export interface GitHubEventInput {
  resource: string;
  event: Uint8Array;
  metadata: unknown;
}

const GitHubEventType = {
  PullRequest: "pull_request",
  Push: "push",
  PolledPullRequest: "PullRequestEvent",
  PolledPush: "PushEvent",
  ClosedPullRequest: CLOSED_PULL_REQUEST_EVENT_TYPE,
} as const;

const RESOURCE_IDENTITY_PREFIX = "repository:github:";
const COMMIT_HEX_LENGTH = 40;
const ZERO_COMMIT = "0".repeat(COMMIT_HEX_LENGTH);
const BRANCH_REF_PREFIX = "refs/heads/";
const BRANCH_REF_PATTERN = /^refs\/heads\/[^\n]+$/;

const eventMetadataSchema = z.strictObject({ event: z.string().min(1) });
const eventNumberSchema = z.int().min(MIN_PULL_REQUEST_NUMBER);
const eventCommitSchema = z
  .string()
  .regex(/^[0-9a-f]{40}$/)
  .refine((commit) => commit !== ZERO_COMMIT);
const eventBranchSchema = z
  .string()
  .regex(BRANCH_REF_PATTERN)
  .transform((ref) => ref.slice(BRANCH_REF_PREFIX.length));
const webhookRepositorySchema = z.looseObject({ full_name: z.string() });
const polledRepositorySchema = z.looseObject({ name: z.string() });
const pullRequestWebhookSchema = z.looseObject({
  number: eventNumberSchema,
  repository: webhookRepositorySchema,
});
const pushWebhookSchema = z.looseObject({
  ref: eventBranchSchema,
  after: eventCommitSchema,
  repository: webhookRepositorySchema,
});
const pullRequestPolledSchema = z.looseObject({
  repo: polledRepositorySchema,
  payload: z.looseObject({ number: eventNumberSchema }),
});
const pushPolledSchema = z.looseObject({
  repo: polledRepositorySchema,
  payload: z.looseObject({ ref: eventBranchSchema, head: eventCommitSchema }),
});

const closedPullRequestSchema = z.looseObject({
  number: eventNumberSchema,
  merged_at: z.string().nullable().optional(),
  merge_commit_sha: z.string().nullable().optional(),
  base: z.looseObject({
    ref: z.string().min(MIN_SEGMENT_LENGTH),
    repo: webhookRepositorySchema,
  }),
});

type EventAddressDecoder = (
  resource: string,
  body: unknown,
) => DecodedAddress | null;

const EVENT_ADDRESS_DECODERS: ReadonlyMap<string, EventAddressDecoder> =
  new Map<string, EventAddressDecoder>([
    [GitHubEventType.PullRequest, pullRequestWebhookAddress],
    [GitHubEventType.Push, pushWebhookAddress],
    [GitHubEventType.PolledPullRequest, pullRequestPolledAddress],
    [GitHubEventType.PolledPush, pushPolledAddress],
    [GitHubEventType.ClosedPullRequest, closedPullRequestAddress],
  ]);

export function decodeGitHubEvent(
  input: GitHubEventInput,
): DecodedAddress | null {
  assert.ok(
    isString(input.resource) && input.resource.length >= MIN_SEGMENT_LENGTH,
  );
  assert.ok(input.event instanceof Uint8Array);
  const metadata = eventMetadataSchema.safeParse(input.metadata);
  if (!metadata.success) {
    return null;
  }
  const decoder = EVENT_ADDRESS_DECODERS.get(metadata.data.event);
  const body = decoder === undefined ? null : eventBodyOf(input.event);
  if (decoder === undefined || body === null) {
    return null;
  }
  const address = decoder(input.resource, body.value);
  assert.ok(
    address === null ||
      address.resource_identity === RESOURCE_IDENTITY_PREFIX + input.resource,
  );
  return address;
}

function eventBodyOf(event: Uint8Array): { value: unknown } | null {
  assert.ok(event instanceof Uint8Array);
  try {
    const text = new TextDecoder(TEXT_ENCODING, { fatal: true }).decode(event);
    return { value: JSON.parse(text) };
  } catch (error) {
    if (error instanceof SyntaxError || error instanceof TypeError) {
      return null;
    }
    throw error;
  }
}

function pullRequestWebhookAddress(
  resource: string,
  body: unknown,
): DecodedAddress | null {
  assert.ok(isString(resource));
  const parsed = pullRequestWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.repository.full_name !== resource) {
    return null;
  }
  return pullRequestAddress(resource, parsed.data.number);
}

function pushWebhookAddress(
  resource: string,
  body: unknown,
): DecodedAddress | null {
  assert.ok(isString(resource));
  const parsed = pushWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.repository.full_name !== resource) {
    return null;
  }
  return branchPushAddress(resource, parsed.data.ref, parsed.data.after);
}

function pullRequestPolledAddress(
  resource: string,
  body: unknown,
): DecodedAddress | null {
  assert.ok(isString(resource));
  const parsed = pullRequestPolledSchema.safeParse(body);
  if (!parsed.success || parsed.data.repo.name !== resource) {
    return null;
  }
  return pullRequestAddress(resource, parsed.data.payload.number);
}

function pushPolledAddress(
  resource: string,
  body: unknown,
): DecodedAddress | null {
  assert.ok(isString(resource));
  const parsed = pushPolledSchema.safeParse(body);
  if (!parsed.success || parsed.data.repo.name !== resource) {
    return null;
  }
  const { ref, head } = parsed.data.payload;
  return branchPushAddress(resource, ref, head);
}

function closedPullRequestAddress(
  resource: string,
  body: unknown,
): DecodedAddress | null {
  assert.ok(isString(resource));
  const parsed = closedPullRequestSchema.safeParse(body);
  if (!parsed.success || parsed.data.base.repo.full_name !== resource) {
    return null;
  }
  const { number, merged_at, merge_commit_sha, base } = parsed.data;
  if (!isString(merged_at)) {
    return pullRequestAddress(resource, number);
  }
  const commit = eventCommitSchema.safeParse(merge_commit_sha);
  return commit.success
    ? branchPushAddress(resource, base.ref, commit.data)
    : null;
}

function pullRequestAddress(resource: string, number: number): DecodedAddress {
  assert.ok(isString(resource) && resource.length >= MIN_SEGMENT_LENGTH);
  assert.ok(Number.isSafeInteger(number) && number >= MIN_PULL_REQUEST_NUMBER);
  return {
    kind: DecodedAddressKind.PullRequest,
    resource_identity: RESOURCE_IDENTITY_PREFIX + resource,
    number,
  };
}

function branchPushAddress(
  resource: string,
  branch: string,
  commit: string,
): DecodedAddress {
  assert.ok(isString(resource) && resource.length >= MIN_SEGMENT_LENGTH);
  assert.ok(branch.length >= MIN_SEGMENT_LENGTH && commit !== ZERO_COMMIT);
  return {
    kind: DecodedAddressKind.BranchPush,
    resource_identity: RESOURCE_IDENTITY_PREFIX + resource,
    branch,
    commit,
  };
}

export const DecodedLinkKind = {
  GitHubIssue: "github_issue",
} as const;

export interface DecodedExternalLink {
  kind: typeof DecodedLinkKind.GitHubIssue;
  resource_identity: string;
  number: number;
}

export interface DecodedLinkUpdate {
  external_link: DecodedExternalLink;
  update_key: string;
  actor_id: string | null;
  actor_automated: boolean;
  occurred_at: number;
  mentions: string[];
}

export interface DescribedGitHubEvent {
  author: string;
  body: string;
  url: string;
  occurred_at: number;
}

export interface GitHubLinkUpdateInput {
  resource_identity: string;
  event: Uint8Array;
  metadata: unknown;
}

const CONVERSATION_IDENTITY_PREFIX = "conversation:github:";
const ISSUE_COMMENT_CREATED_ACTION = "created";
const USER_ACCOUNT_TYPE = "User";
const BOT_LOGIN_SUFFIX = "[bot]";
const MENTION_LIMIT = 50;
const ISSUE_URL_PATH_PATTERN =
  /^\/repos\/([^/]+\/[^/]+)\/issues\/([1-9][0-9]*)(?![\s\S])/;
const MENTION_PATTERN =
  /(?<![A-Za-z0-9_])@([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))(?![A-Za-z0-9_-])/g;
const FENCE_PATTERN = /^ {0,3}(`{3,}|~{3,})/;
const CODE_SPAN_PATTERN = /(`+)(?:(?!\1)[\s\S])*?(?<!`)\1(?!`)/g;
const LINE_BREAK = "\n";

const IssueCommentEventType = {
  Webhook: "issue_comment",
  Listed: ISSUE_COMMENT_LISTED_EVENT_TYPE,
} as const;

const issueCommentSchema = z.looseObject({
  id: z.int().min(MIN_POSITIVE_ID),
  user: z
    .looseObject({
      id: z.int().nullish(),
      login: z.string().optional(),
      type: z.string().optional(),
    })
    .nullish(),
  body: z.string().nullish(),
  created_at: z.iso.datetime({ offset: true }),
  html_url: z.string().optional(),
  performed_via_github_app: z.unknown(),
});
type IssueComment = z.infer<typeof issueCommentSchema>;

const issueCommentWebhookSchema = z.looseObject({
  action: z.string(),
  issue: z.looseObject({ number: z.int().min(MIN_POSITIVE_ID) }),
  comment: issueCommentSchema,
  repository: webhookRepositorySchema,
});
const listedIssueCommentSchema = issueCommentSchema.extend({
  issue_url: z.string(),
});

interface ParsedIssueComment {
  repository: string;
  number: number;
  comment: IssueComment;
}

function issueOfUrl(
  url: string,
): { repository: string; number: number } | null {
  assert.ok(isString(url));
  if (!URL.canParse(url)) return null;
  const match = ISSUE_URL_PATH_PATTERN.exec(new URL(url).pathname);
  const repository = match?.[1];
  const number = Number(match?.[2]);
  if (repository === undefined || !Number.isSafeInteger(number)) return null;
  return { repository, number };
}

function webhookIssueComment(body: unknown): ParsedIssueComment | null {
  const parsed = issueCommentWebhookSchema.safeParse(body);
  if (!parsed.success || parsed.data.action !== ISSUE_COMMENT_CREATED_ACTION) {
    return null;
  }
  return {
    repository: parsed.data.repository.full_name,
    number: parsed.data.issue.number,
    comment: parsed.data.comment,
  };
}

function listedIssueComment(body: unknown): ParsedIssueComment | null {
  const parsed = listedIssueCommentSchema.safeParse(body);
  if (!parsed.success) return null;
  const issue = issueOfUrl(parsed.data.issue_url);
  return issue === null ? null : { ...issue, comment: parsed.data };
}

const ISSUE_COMMENT_DECODERS: ReadonlyMap<
  string,
  (body: unknown) => ParsedIssueComment | null
> = new Map([
  [IssueCommentEventType.Webhook, webhookIssueComment],
  [IssueCommentEventType.Listed, listedIssueComment],
]);

function parsedIssueCommentOf(
  event: Uint8Array,
  metadata: unknown,
): ParsedIssueComment | null {
  assert.ok(event instanceof Uint8Array);
  const parsedMetadata = eventMetadataSchema.safeParse(metadata);
  if (!parsedMetadata.success) return null;
  const decoder = ISSUE_COMMENT_DECODERS.get(parsedMetadata.data.event);
  const body = decoder === undefined ? null : eventBodyOf(event);
  if (decoder === undefined || body === null) return null;
  return decoder(body.value);
}

function withoutFencedBlocks(text: string): string {
  const kept: string[] = [];
  let fence: string | null = null;
  for (const line of text.split(LINE_BREAK)) {
    const marker = FENCE_PATTERN.exec(line)?.[1];
    if (fence === null) {
      if (marker === undefined) kept.push(line);
      else fence = marker;
      continue;
    }
    const closes =
      marker !== undefined &&
      marker.startsWith(fence.charAt(0)) &&
      marker.length >= fence.length;
    if (closes) fence = null;
  }
  return kept.join(LINE_BREAK);
}

function mentionsOf(body: string): string[] {
  assert.ok(isString(body));
  const prose = withoutFencedBlocks(body).replace(CODE_SPAN_PATTERN, " ");
  const logins = new Set<string>();
  for (const match of prose.matchAll(MENTION_PATTERN)) {
    if (logins.size >= MENTION_LIMIT) break;
    logins.add((match[1] ?? "").toLowerCase());
  }
  return [...logins];
}

function isAutomated(comment: IssueComment): boolean {
  const { user } = comment;
  return (
    user?.type !== USER_ACCOUNT_TYPE ||
    (user.login ?? "").endsWith(BOT_LOGIN_SUFFIX) ||
    (comment.performed_via_github_app ?? null) !== null
  );
}

export function decodeGitHubLinkUpdate(
  input: GitHubLinkUpdateInput,
): DecodedLinkUpdate | null {
  assert.ok(isString(input.resource_identity));
  if (!input.resource_identity.startsWith(CONVERSATION_IDENTITY_PREFIX))
    return null;
  const resource = input.resource_identity.slice(
    CONVERSATION_IDENTITY_PREFIX.length,
  );
  const parsed = parsedIssueCommentOf(input.event, input.metadata);
  if (parsed === null || parsed.repository !== resource) return null;
  const { comment } = parsed;
  const actor = comment.user?.id;
  return {
    external_link: {
      kind: DecodedLinkKind.GitHubIssue,
      resource_identity: input.resource_identity,
      number: parsed.number,
    },
    update_key: ISSUE_COMMENT_KEY_PREFIX + comment.id,
    actor_id: actor == null ? null : String(actor),
    actor_automated: isAutomated(comment),
    occurred_at: Date.parse(comment.created_at),
    mentions: mentionsOf(comment.body ?? ""),
  };
}

export function describeGitHubEvent(input: {
  event: Uint8Array;
  metadata: unknown;
}): DescribedGitHubEvent | null {
  const parsed = parsedIssueCommentOf(input.event, input.metadata);
  const author = parsed?.comment.user?.login;
  const url = parsed?.comment.html_url;
  if (parsed === null || author === undefined || url === undefined) return null;
  return {
    author,
    body: parsed.comment.body ?? "",
    url,
    occurred_at: Date.parse(parsed.comment.created_at),
  };
}
