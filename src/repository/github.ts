import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { Octokit, RequestError } from "octokit";
import { z } from "zod";
import { ResultClass, type ResultClassValue } from "../intake/contract.ts";
import type { CallerIdentity } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpStatus } from "../kernel/http.ts";
import { canonicalJSON } from "../kernel/json.ts";
import { ValueType, isString } from "../kernel/values.ts";

export const GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_RESULT_CODE_PREFIX = "repository.platform.github.";
export const READ_RETRY_DELAY_MS = 250;
export const READ_ATTEMPT_LIMIT = 240;
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
const MIN_PULL_REQUEST_NUMBER = 1;
const NEXT_LINK_PATTERN = /<[^>]*>\s*;\s*rel="next"/;
const API_VERSION_HEADER = "x-github-api-version";
const RATE_LIMIT_REMAINING_HEADER = "x-ratelimit-remaining";
const RATE_LIMIT_EXHAUSTED = "0";
const IF_NONE_MATCH_HEADER = "if-none-match";
const NOT_MODIFIED_STATUS = 304;
const EVENT_PAGE_SIZE = 100;
const EVENT_ID_PATTERN = /^(0|[1-9][0-9]*)$/;
const SAME_ORDER = 0;
const BEFORE_ORDER = -1;
const AFTER_ORDER = 1;
const MIN_JSON_LENGTH = 1;
const REQUEST_TIMEOUT_STATUS = 408;
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

export interface GitHubFailure {
  ok: false;
  class: ResultClassValue;
  code: string;
  status: number | null;
  message: string;
}

export type GitHubAnswer<T> = { ok: true; value: T } | GitHubFailure;

export interface GitHubRequest {
  kind: CallKind;
  route: string;
  parameters: Record<string, unknown>;
  headers?: Record<string, string>;
}

export const githubCheckpointSchema = z.strictObject({
  etag: z.string().nullable(),
  newest_event_id: z.string().regex(EVENT_ID_PATTERN).nullable(),
});
export type GitHubCheckpoint = z.infer<typeof githubCheckpointSchema>;

export interface GitHubEvent {
  id: string;
  type: string;
  body: Uint8Array;
}

export type GitHubEventsAnswer =
  | { notModified: true }
  | { notModified: false; etag: string | null; events: GitHubEvent[] };

export interface GitHubEventsQuery {
  owner: string;
  repo: string;
  etag: string | null;
}

export const CheckEndState = {
  Expected: "expected",
  Other: "other",
  None: "none",
} as const;
export type CheckEndState = (typeof CheckEndState)[keyof typeof CheckEndState];

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

const createdPullRequestSchema = z.looseObject({ number: z.int() });
const pullRequestListSchema = z.array(z.looseObject({ number: z.int() }));
const pullRequestStateSchema = z
  .looseObject({
    state: z.string(),
    merged: z.boolean(),
    merge_commit_sha: z.string().nullable(),
  })
  .superRefine((pullRequest, context) => {
    if (pullRequest.merged && pullRequest.merge_commit_sha === null)
      context.addIssue({
        code: "custom",
        path: ["merge_commit_sha"],
        message: "A merged pull request names its merge commit.",
      });
  });

export interface GitHubOptions {
  baseUrl?: string;
}

interface Exchange {
  data: unknown;
  link: string | null;
  etag: string | null;
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
  const rateLimitRemaining =
    error.response.headers[RATE_LIMIT_REMAINING_HEADER];
  return failure(
    statusClass(error.status, rateLimitRemaining, kind),
    error.status,
    message,
  );
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
  rateLimitRemaining: unknown,
  kind: CallKind,
): ResultClassValue {
  assert.ok(Number.isInteger(status));
  if (status >= HttpStatus.InternalServerError) {
    return kind === CallKind.Read
      ? ResultClass.RetryableRefusal
      : ResultClass.UnknownOutcome;
  }
  const exhausted =
    status === HttpStatus.Forbidden &&
    String(rateLimitRemaining) === RATE_LIMIT_EXHAUSTED;
  if (
    status === HttpStatus.TooManyRequests ||
    status === REQUEST_TIMEOUT_STATUS ||
    exhausted
  ) {
    return ResultClass.RetryableRefusal;
  }
  return ResultClass.FinalRefusal;
}

function failure(
  resultClass: ResultClassValue,
  status: number | null,
  message: string,
): GitHubFailure {
  assert.ok(Object.values(ResultClass).includes(resultClass));
  assert.ok(status === null || Number.isInteger(status));
  return {
    ok: false,
    class: resultClass,
    code: GITHUB_RESULT_CODE_PREFIX + resultClass,
    status,
    message,
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
  const exchange = {
    data: notModified ? null : response.data,
    link: isString(link) ? link : null,
    etag: isString(etag) ? etag : null,
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

function compareEventIds(left: string, right: string): number {
  assert.ok(EVENT_ID_PATTERN.test(left));
  assert.ok(EVENT_ID_PATTERN.test(right));
  if (left.length !== right.length) {
    return left.length - right.length;
  }
  if (left === right) {
    return SAME_ORDER;
  }
  return left < right ? BEFORE_ORDER : AFTER_ORDER;
}

export function newerEvents<E extends { id: string }>(
  events: readonly E[],
  newest: string | null,
): E[] {
  assert.ok(Array.isArray(events));
  assert.ok(newest === null || EVENT_ID_PATTERN.test(newest));
  const kept = events.filter(
    (event) =>
      newest === null || compareEventIds(event.id, newest) > SAME_ORDER,
  );
  return kept.sort((left, right) => compareEventIds(left.id, right.id));
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

export function hasNextLink(link: string | null): boolean {
  assert.ok(link === null || isString(link));
  return (
    link !== null &&
    link.split(",").some((part) => NEXT_LINK_PATTERN.test(part))
  );
}

export class GitHubPlatform {
  readonly #baseUrl: string;

  constructor(options: GitHubOptions = {}) {
    this.#baseUrl = options.baseUrl ?? GITHUB_API_BASE_URL;
    assert.ok(URL.canParse(this.#baseUrl));
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
    pullRequest: { head: string; base: string; title: string },
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
    if (!answer.ok) {
      return answer;
    }
    if (answer.value.notModified) {
      return { ok: true, value: { notModified: true } };
    }
    const events = eventsOf(answer.value.data);
    return events === null
      ? unreadableBody(CallKind.Read)
      : {
          ok: true,
          value: { notModified: false, etag: answer.value.etag, events },
        };
  }

  foldPullRequest(
    body: unknown,
    expectedEndState: ExpectedEndState,
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
    return {
      end_state:
        pullRequest.state === PULL_REQUEST_STATE_OPEN
          ? CheckEndState.None
          : CheckEndState.Other,
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
    repository: GitHubRepository,
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
    repository: GitHubRepository,
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
} as const;

const RESOURCE_IDENTITY_PREFIX = "repository:github:";
const ZERO_COMMIT = "0".repeat(40);
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
