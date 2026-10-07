import assert from "node:assert/strict";
import { setTimeout as sleep } from "node:timers/promises";
import { Octokit, RequestError } from "octokit";
import { ResultClass, type ResultClassValue } from "../intake/contract.ts";
import type { CallerIdentity } from "../kernel/caller.ts";
import { HttpStatus } from "../kernel/http.ts";
import { isString } from "../kernel/values.ts";

export const GITHUB_API_BASE_URL = "https://api.github.com";
export const GITHUB_API_VERSION = "2022-11-28";
export const GITHUB_RESULT_CODE_PREFIX = "repository.platform.github.";
export const READ_RETRY_DELAY_MS = 250;
export const READ_ATTEMPT_LIMIT = 240;
const API_VERSION_HEADER = "x-github-api-version";
const RATE_LIMIT_REMAINING_HEADER = "x-ratelimit-remaining";
const RATE_LIMIT_EXHAUSTED = "0";
const REQUEST_TIMEOUT_STATUS = 408;
const CAUSE_DEPTH_LIMIT = 4;
const NO_TIME_LEFT_MS = 0;
const MIN_SEGMENT_LENGTH = 1;
const MIN_TOKEN_LENGTH = 1;
const BINDING_ADDRESS_PATTERN =
  /^git@[A-Za-z0-9][A-Za-z0-9.-]*:([^/\s:]+)\/([^/\s:]+)\.git(?![\s\S])/;
const INBOUND_RESOURCE_PATTERN = /^([^/\s:]+)\/([^/\s:]+)(?![\s\S])/;
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
}

export interface GitHubOptions {
  baseUrl?: string;
}

type Attempt =
  | { ok: true; value: unknown }
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
  ): Promise<GitHubAnswer<unknown>> {
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
        headers: { [API_VERSION_HEADER]: GITHUB_API_VERSION },
        request: { signal },
      });
      return { ok: true, value: response.data };
    } catch (error) {
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
