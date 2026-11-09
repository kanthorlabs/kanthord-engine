import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { setImmediate as turn } from "node:timers/promises";
import { ResultClass, type ResultClassValue } from "../intake/contract.ts";
import type { ServiceIdentity } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import {
  CallKind,
  CheckEndState,
  classifyDelivery,
  CURSOR_INVALID_CODE,
  CURSOR_PAGE_SIZE_MISMATCH_CODE,
  decodeCursor,
  decodeGitHubEvent,
  decodeGitHubLinkUpdate,
  DeliveryKind,
  describeGitHubEvent,
  encodeCursor,
  ExpectedEndState,
  foldRequiredChecks,
  GITHUB_API_VERSION,
  type GitHubCall,
  GitHubPlatform,
  type GitHubRequest,
  type GitHubTarget,
  GitHubTargetKind,
  repositoryOf,
  ReviewState,
} from "./github.ts";
import {
  COMMENT_CREATED_AT_MS,
  COMMENT_ID,
  COMMENT_LOGIN,
  COMMENT_NUMBER,
  COMMENT_RESOURCE_IDENTITY,
  COMMENT_UPDATE_KEY,
  COMMENT_URL,
  COMMENT_USER_ID,
  commentBytes,
  commentUser,
  LISTED_EVENT,
  listedComment,
  WEBHOOK_EVENT,
  webhookComment,
} from "./github-comment-test-support.ts";
import { stopAfter } from "../kernel/stop-test-support.ts";

const TOKEN = "ghp_secret_token_value";
const CALL_DEADLINE_MS = 10_000;
const SHORT_DEADLINE_MS = 700;
const HOLD_MS = 5_000;
const ABORT_AFTER_MS = 100;
const DISPATCHED_DEADLINE_MS = 1000;
const NO_REQUEST = 0;
const SINGLE_REQUEST = 1;
const RETRIED_REQUESTS = 3;
const BAD_GATEWAY = 502;
const SERVICE_UNAVAILABLE = 503;
const PULL_REQUEST_PATH = "/repos/octo/widgets/pulls/7";
const REQUESTER = { kind: "service", service: "intake" } as ServiceIdentity;
const TARGET: GitHubTarget = {
  kind: GitHubTargetKind.Binding,
  address: "git@github.com:octo/widgets.git",
};
const WRITE: GitHubRequest = {
  kind: CallKind.Write,
  route: "POST /repos/{owner}/{repo}/pulls",
  parameters: { head: "kanthord/node", base: "main", title: "change" },
};
const READ: GitHubRequest = {
  kind: CallKind.Read,
  route: "GET /repos/{owner}/{repo}/pulls/{pull_number}",
  parameters: { pull_number: 7 },
};

type Handler = (
  request: IncomingMessage,
  response: ServerResponse,
  count: number,
) => void;

interface Platform {
  baseUrl: string;
  requests: IncomingMessage[];
  bodies: string[];
}

async function platform(t: TestContext, handler: Handler): Promise<Platform> {
  const requests: IncomingMessage[] = [];
  const bodies: string[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.once("end", () => {
      bodies.push(Buffer.concat(chunks).toString("utf8"));
      handler(request, response, requests.length);
    });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  stopAfter(t, () => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests, bodies };
}

function answer(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): Handler {
  return (_request, response) => {
    response.writeHead(status, {
      "content-type": "application/json",
      ...headers,
    });
    response.end(JSON.stringify(body));
  };
}

const lose: Handler = (request) => {
  request.socket.destroy();
};

const hold: Handler = (_request, response) => {
  setTimeout(() => response.destroy(), HOLD_MS).unref();
};

function call(overrides: Partial<GitHubCall> = {}): GitHubCall {
  return {
    token: TOKEN,
    requester: REQUESTER,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + CALL_DEADLINE_MS,
    ...overrides,
  };
}

async function closedPort(): Promise<string> {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  server.close();
  await once(server, "close");
  return `http://127.0.0.1:${port}`;
}

test("the target alone gives the owner and the repository", () => {
  assert.deepEqual(repositoryOf(TARGET), { owner: "octo", repo: "widgets" });
  assert.deepEqual(
    repositoryOf({ kind: GitHubTargetKind.Inbound, resource: "octo/gadgets" }),
    { owner: "octo", repo: "gadgets" },
  );
  assert.throws(() =>
    repositoryOf({
      kind: GitHubTargetKind.Binding,
      address: "https://github.com/octo/widgets",
    }),
  );
  assert.throws(() =>
    repositoryOf({ kind: GitHubTargetKind.Inbound, resource: "octo" }),
  );
});

test("a call sends the token, the API version and the target path", async (t) => {
  const server = await platform(t, answer(200, { number: 7 }));
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.send(call(), TARGET, READ);
  assert.deepEqual(result, { ok: true, value: { number: 7 } });
  assert.equal(server.requests.length, SINGLE_REQUEST);
  const [request] = server.requests;
  assert.equal(request?.url, PULL_REQUEST_PATH);
  assert.match(String(request?.headers.authorization), new RegExp(TOKEN));
  assert.equal(request?.headers["x-github-api-version"], GITHUB_API_VERSION);
});

test("a write sends one request for a 429", async (t) => {
  const server = await platform(
    t,
    answer(HttpStatus.TooManyRequests, { message: "slow down" }),
  );
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.send(call(), TARGET, WRITE);
  assert.equal(server.requests.length, SINGLE_REQUEST);
  assert.ok(!result.ok);
  assert.equal(result.class, ResultClass.RetryableRefusal);
  assert.equal(
    result.code,
    `repository.platform.github.${ResultClass.RetryableRefusal}`,
  );
  assert.equal(result.status, HttpStatus.TooManyRequests);
  assert.deepEqual(result.rate_limit, { wait_ms: null });
});

test("a write sends one request for a 502 and answers unknown_outcome", async (t) => {
  const server = await platform(
    t,
    answer(BAD_GATEWAY, { message: "bad gateway" }),
  );
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.send(call(), TARGET, WRITE);
  assert.equal(server.requests.length, SINGLE_REQUEST);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.class, ResultClass.UnknownOutcome);
  assert.equal(!result.ok && result.status, BAD_GATEWAY);
});

test("a write sends one request for a lost response and answers a null status", async (t) => {
  const server = await platform(t, lose);
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.send(call(), TARGET, WRITE);
  assert.equal(server.requests.length, SINGLE_REQUEST);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.class, ResultClass.UnknownOutcome);
  assert.equal(
    !result.ok && result.code,
    `repository.platform.github.${ResultClass.UnknownOutcome}`,
  );
  assert.equal(!result.ok && result.status, null);
});

test("a read retries a closed connection inside its deadline", async (t) => {
  const server = await platform(t, (request, response, count) => {
    if (count < RETRIED_REQUESTS) {
      lose(request, response, count);
      return;
    }
    answer(200, { number: 7 })(request, response, count);
  });
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.send(call(), TARGET, READ);
  assert.equal(server.requests.length, RETRIED_REQUESTS);
  assert.deepEqual(result, { ok: true, value: { number: 7 } });
});

test("a read stops at its deadline and answers retryable_refusal", async (t) => {
  const server = await platform(t, lose);
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const started = Date.now();
  const result = await github.send(
    call({ deadlineAt: started + SHORT_DEADLINE_MS }),
    TARGET,
    READ,
  );
  const elapsed = Date.now() - started;
  assert.ok(server.requests.length > SINGLE_REQUEST);
  assert.ok(elapsed >= SHORT_DEADLINE_MS - ABORT_AFTER_MS);
  assert.ok(elapsed < SHORT_DEADLINE_MS + HOLD_MS);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.class, ResultClass.RetryableRefusal);
  assert.equal(!result.ok && result.status, null);
});

test("a read answers retryable_refusal for a 5xx with no retry", async (t) => {
  const server = await platform(
    t,
    answer(SERVICE_UNAVAILABLE, { message: "unavailable" }),
  );
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.send(call(), TARGET, READ);
  assert.equal(server.requests.length, SINGLE_REQUEST);
  assert.equal(!result.ok && result.class, ResultClass.RetryableRefusal);
  assert.equal(!result.ok && result.status, SERVICE_UNAVAILABLE);
});

test("each status answers its class", async (t) => {
  const cases: {
    status: number;
    headers: Record<string, string>;
    class: ResultClassValue;
    rateLimited?: boolean;
  }[] = [
    { status: 408, headers: {}, class: ResultClass.RetryableRefusal },
    {
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
      class: ResultClass.RetryableRefusal,
      rateLimited: true,
    },
    {
      status: 403,
      headers: { "x-ratelimit-remaining": "12" },
      class: ResultClass.FinalRefusal,
    },
    { status: 401, headers: {}, class: ResultClass.FinalRefusal },
  ];
  for (const expected of cases) {
    const server = await platform(
      t,
      answer(expected.status, { message: "refused" }, expected.headers),
    );
    const github = new GitHubPlatform({ baseUrl: server.baseUrl });
    const result = await github.send(call(), TARGET, WRITE);
    assert.equal(server.requests.length, SINGLE_REQUEST);
    assert.ok(!result.ok);
    assert.equal(result.class, expected.class);
    assert.equal(result.code, `repository.platform.github.${expected.class}`);
    assert.equal(result.status, expected.status);
    assert.deepEqual(
      result.rate_limit,
      expected.rateLimited ? { wait_ms: null } : undefined,
    );
  }
});

const RESET_NOW_MS = 1_700_000_000_000;
const POLL_INTERVAL_MS = 90_000;
const MS_PER_SECOND = 1000;
const SECONDARY_LIMIT_MESSAGE =
  "You have exceeded a secondary rate limit. Please wait a few minutes before you try again.";

function rateLimitOf(result: { ok: boolean }) {
  assert.ok(!result.ok);
  return (result as { rate_limit?: { wait_ms: number | null } }).rate_limit;
}

test("a 403 with no remaining requests names the wait until x-ratelimit-reset", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: RESET_NOW_MS });
  const resetSeconds = RESET_NOW_MS / 1000 + 90;
  const server = await platform(
    t,
    answer(
      403,
      { message: "API rate limit exceeded" },
      {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(resetSeconds),
      },
    ),
  );
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.listEvents(call(), {
    ...EVENTS_QUERY,
    etag: null,
  });
  assert.equal(!result.ok && result.class, ResultClass.RetryableRefusal);
  assert.deepEqual(rateLimitOf(result), { wait_ms: 90_000 });
});

test("x-ratelimit-reset in the past names a wait of zero", async (t) => {
  t.mock.timers.enable({ apis: ["Date"], now: RESET_NOW_MS });
  const server = await platform(
    t,
    answer(
      403,
      { message: "API rate limit exceeded" },
      {
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": String(RESET_NOW_MS / 1000 - 5),
      },
    ),
  );
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.listEvents(call(), {
    ...EVENTS_QUERY,
    etag: null,
  });
  assert.deepEqual(rateLimitOf(result), { wait_ms: 0 });
});

test("a 429 names the wait of Retry-After in milliseconds and it wins over x-ratelimit-reset", async (t) => {
  const server = await platform(
    t,
    answer(
      429,
      { message: "slow down" },
      {
        "retry-after": "7",
        "x-ratelimit-remaining": "0",
        "x-ratelimit-reset": "4102444800",
      },
    ),
  );
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.listEvents(call(), {
    ...EVENTS_QUERY,
    etag: null,
  });
  assert.equal(!result.ok && result.class, ResultClass.RetryableRefusal);
  assert.deepEqual(rateLimitOf(result), { wait_ms: 7000 });
});

test("a 403 that names a secondary rate limit is a retryable_refusal with a named wait only from Retry-After", async (t) => {
  const bare = await platform(
    t,
    answer(403, { message: SECONDARY_LIMIT_MESSAGE }),
  );
  const bareResult = await new GitHubPlatform({
    baseUrl: bare.baseUrl,
  }).listEvents(call(), { ...EVENTS_QUERY, etag: null });
  assert.equal(
    !bareResult.ok && bareResult.class,
    ResultClass.RetryableRefusal,
  );
  assert.deepEqual(rateLimitOf(bareResult), { wait_ms: null });
  const waiting = await platform(
    t,
    answer(403, { message: SECONDARY_LIMIT_MESSAGE }, { "retry-after": "60" }),
  );
  const waitingResult = await new GitHubPlatform({
    baseUrl: waiting.baseUrl,
  }).listEvents(call(), { ...EVENTS_QUERY, etag: null });
  assert.deepEqual(rateLimitOf(waitingResult), { wait_ms: 60_000 });
});

test("a refusal that is no rate limit names no rate limit even with Retry-After", async (t) => {
  const server = await platform(
    t,
    answer(
      SERVICE_UNAVAILABLE,
      { message: "unavailable" },
      { "retry-after": "30" },
    ),
  );
  const result = await new GitHubPlatform({
    baseUrl: server.baseUrl,
  }).listEvents(call(), { ...EVENTS_QUERY, etag: null });
  assert.equal(!result.ok && result.class, ResultClass.RetryableRefusal);
  assert.equal(rateLimitOf(result), undefined);
});

test("listEvents answers the wait of X-Poll-Interval in milliseconds for a 200 and a 304", async (t) => {
  const modified = await platform(
    t,
    answer(200, [PUSH_EVENT], {
      etag: FIRST_ETAG,
      "x-poll-interval": String(POLL_INTERVAL_MS / MS_PER_SECOND),
    }),
  );
  const first = await new GitHubPlatform({
    baseUrl: modified.baseUrl,
  }).listEvents(call(), { ...EVENTS_QUERY, etag: null });
  assert.ok(first.ok && !first.value.notModified);
  assert.equal(first.value.poll_interval_ms, POLL_INTERVAL_MS);
  const unchanged = await platform(t, (_request, response) => {
    response.writeHead(NOT_MODIFIED, {
      etag: FIRST_ETAG,
      "x-poll-interval": "75",
    });
    response.end();
  });
  const second = await new GitHubPlatform({
    baseUrl: unchanged.baseUrl,
  }).listEvents(call(), { ...EVENTS_QUERY, etag: FIRST_ETAG });
  assert.deepEqual(second, {
    ok: true,
    value: { notModified: true, poll_interval_ms: 75_000 },
  });
});

test("a write refused before dispatch answers confirmed_failure", async () => {
  const github = new GitHubPlatform({ baseUrl: await closedPort() });
  const result = await github.send(call(), TARGET, WRITE);
  assert.equal(result.ok, false);
  assert.equal(!result.ok && result.class, ResultClass.ConfirmedFailure);
  assert.equal(!result.ok && result.status, null);
});

test("an abort of a dispatched write answers unknown_outcome", async (t) => {
  const server = await platform(t, hold);
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const controller = new AbortController();
  const sending = github.send(
    call({ signal: controller.signal }),
    TARGET,
    WRITE,
  );
  while (server.requests.length < SINGLE_REQUEST)
    await turn(undefined, { signal: t.signal });
  controller.abort();
  const result = await sending;
  assert.equal(server.requests.length, SINGLE_REQUEST);
  assert.equal(!result.ok && result.class, ResultClass.UnknownOutcome);
  assert.equal(!result.ok && result.status, null);
});

test("the deadline of a dispatched write answers unknown_outcome", async (t) => {
  const server = await platform(t, hold);
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.send(
    call({ deadlineAt: Date.now() + DISPATCHED_DEADLINE_MS }),
    TARGET,
    WRITE,
  );
  assert.equal(server.requests.length, SINGLE_REQUEST);
  assert.equal(!result.ok && result.class, ResultClass.UnknownOutcome);
  assert.equal(!result.ok && result.status, null);
});

test("an aborted read answers retryable_refusal with no request", async (t) => {
  const server = await platform(t, answer(200, {}));
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const controller = new AbortController();
  controller.abort();
  const result = await github.send(
    call({ signal: controller.signal }),
    TARGET,
    READ,
  );
  assert.equal(server.requests.length, NO_REQUEST);
  assert.equal(!result.ok && result.class, ResultClass.RetryableRefusal);
});

test("classifyDelivery answers invalid for a missing header", () => {
  assert.deepEqual(
    classifyDelivery(new Headers({ "X-GitHub-Event": "push" })),
    { kind: DeliveryKind.Invalid },
  );
  assert.deepEqual(
    classifyDelivery(new Headers({ "X-GitHub-Delivery": "d-1" })),
    { kind: DeliveryKind.Invalid },
  );
  assert.deepEqual(
    classifyDelivery(
      new Headers({ "X-GitHub-Event": "push", "X-GitHub-Delivery": "" }),
    ),
    { kind: DeliveryKind.Invalid },
  );
});

test("classifyDelivery answers invalid for a repeated header", () => {
  const repeated = (name: string, other: [string, string]) =>
    classifyDelivery(new Headers([[name, "a"], [name, "b"], other]));
  assert.deepEqual(repeated("X-GitHub-Delivery", ["X-GitHub-Event", "push"]), {
    kind: DeliveryKind.Invalid,
  });
  assert.deepEqual(repeated("X-GitHub-Event", ["X-GitHub-Delivery", "d-1"]), {
    kind: DeliveryKind.Invalid,
  });
  assert.deepEqual(
    classifyDelivery(
      new Headers([
        ["X-GitHub-Event", "ping"],
        ["X-GitHub-Event", "ping"],
      ]),
    ),
    { kind: DeliveryKind.Invalid },
  );
});

test("the token reaches no failure and no log record", async (t) => {
  const records: unknown[] = [];
  for (const level of ["log", "info", "warn", "error", "debug"] as const) {
    t.mock.method(console, level, (...values: unknown[]) => {
      records.push(values);
    });
  }
  const outcomes = [
    answer(401, { message: "Bad credentials" }),
    answer(BAD_GATEWAY, { message: "bad gateway" }),
    lose,
  ];
  for (const handler of outcomes) {
    const server = await platform(t, handler);
    const github = new GitHubPlatform({ baseUrl: server.baseUrl });
    const result = await github.send(call(), TARGET, WRITE);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(result).includes(TOKEN), false);
    assert.equal(String(!result.ok && result.message).includes(TOKEN), false);
  }
  assert.equal(JSON.stringify(records).includes(TOKEN), false);
});

const HEAD_SHA = "89abcdef0123456789abcdef0123456789abcdef";
const OLDER_SHA = "fedcba9876543210fedcba9876543210fedcba98";
const NO_REVIEWS: unknown[] = [];
const NO_TRUSTED: string[] = [];
const TRUSTED_REVIEWERS = ["1", "2", "3"];
const NO_CHECKS = { head_commit: HEAD_SHA, pending: [], failed: [] };
const FAILED_AT_HEAD = {
  head_commit: HEAD_SHA,
  pending: [],
  failed: ["check"],
};
const FAILED_AT_OLDER = {
  head_commit: OLDER_SHA,
  pending: [],
  failed: ["check"],
};
const PENDING_AT_HEAD = {
  head_commit: HEAD_SHA,
  pending: ["check"],
  failed: [],
};
const FAILED_AND_PENDING_AT_HEAD = {
  head_commit: HEAD_SHA,
  pending: ["other"],
  failed: ["check"],
};
const PULL_REQUEST_BODY = {
  number: 7,
  state: "open",
  merged: false,
  merge_commit_sha: null,
  head: { ref: "kanthord/node", sha: HEAD_SHA },
  labels: [{ name: "kept" }],
};
const REVIEW_COMMENTS = [
  { id: 1, body: "first", path: "a.ts" },
  { id: 2, body: "second", path: "b.ts" },
];
const NEXT_LINK =
  '<https://api.github.com/repositories/1/pulls/7/comments?page=2>; rel="next", <https://api.github.com/repositories/1/pulls/7/comments?page=3>; rel="last"';
const PREVIOUS_LINK =
  '<https://api.github.com/repositories/1/pulls/7/comments?page=1>; rel="prev"';
const PULL_REQUESTS_PATH = "/repos/octo/widgets/pulls";
const REVIEW_COMMENTS_PATH = "/repos/octo/widgets/pulls/7/comments";
const REVIEWS_PATH = "/repos/octo/widgets/pulls/7/reviews";
const REVIEW_PAGE_LIMIT = 30;
const HEAD_BRANCH = "kanthord/node";
const BASE_BRANCH = "main";
const QUALIFIED_HEAD = "octo:kanthord/node";
const OPEN_STATE = "open";
const FIRST_PAGE = 1;
const CREATE_AND_LIST_REQUESTS = 2;
const MERGE_COMMIT = "0123456789abcdef0123456789abcdef01234567";
const COMMENT_LIMIT = 50;
const OTHER_COMMENT_LIMIT = 20;
const SECOND_PAGE = 2;
const DEFAULT_PAGE_SIZE = 100;

function query(request: IncomingMessage | undefined): URLSearchParams {
  return new URL(String(request?.url), "http://localhost").searchParams;
}

test("createPullRequest posts head, base and title and answers the number", async (t) => {
  const server = await platform(t, answer(201, { number: 12, id: 99 }));
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.createPullRequest(call(), TARGET, {
    head: HEAD_BRANCH,
    base: BASE_BRANCH,
    title: "change",
  });
  assert.deepEqual(result, { ok: true, value: { number: 12 } });
  assert.equal(server.requests.length, SINGLE_REQUEST);
  assert.equal(server.requests[0]?.method, HttpMethod.Post);
  assert.equal(server.requests[0]?.url, PULL_REQUESTS_PATH);
  assert.deepEqual(JSON.parse(String(server.bodies[0])), {
    head: HEAD_BRANCH,
    base: BASE_BRANCH,
    title: "change",
  });
});

test("openPullRequests lists the open pull requests of the head into the base", async (t) => {
  const server = await platform(
    t,
    answer(200, [{ number: 7, title: "a" }, { number: 9 }]),
  );
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.openPullRequests(call(), TARGET, {
    head: HEAD_BRANCH,
    base: BASE_BRANCH,
  });
  assert.deepEqual(result, { ok: true, value: [7, 9] });
  const [request] = server.requests;
  assert.equal(request?.method, HttpMethod.Get);
  assert.equal(
    new URL(String(request?.url), "http://localhost").pathname,
    PULL_REQUESTS_PATH,
  );
  const parameters = query(request);
  assert.equal(parameters.get("state"), OPEN_STATE);
  assert.equal(parameters.get("head"), QUALIFIED_HEAD);
  assert.equal(parameters.get("base"), BASE_BRANCH);
});

test("pullRequestMergedAt answers false when the pull request merged at another head", async (t) => {
  const server = await platform(
    t,
    answer(200, { merged: true, head: { sha: OLDER_SHA } }),
  );
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.pullRequestMergedAt(call(), TARGET, {
    number: 7,
    sha: HEAD_SHA,
  });
  assert.deepEqual(result, { ok: true, value: false });
});

test("listReviewComments answers the body unchanged and a next cursor from the Link header", async (t) => {
  const server = await platform(t, (request, response, count) => {
    const headers: Record<string, string> =
      count === SINGLE_REQUEST ? { link: NEXT_LINK } : { link: PREVIOUS_LINK };
    answer(200, REVIEW_COMMENTS, headers)(request, response, count);
  });
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const first = await github.listReviewComments(call(), TARGET, { number: 7 });
  assert.equal(first.ok, true);
  assert.deepEqual(first.ok && first.value.body, REVIEW_COMMENTS);
  const nextCursor = first.ok ? first.value.next_cursor : null;
  assert.ok(nextCursor !== null);
  assert.deepEqual(decodeCursor(nextCursor), {
    page: SECOND_PAGE,
    per_page: DEFAULT_PAGE_SIZE,
  });
  assert.equal(
    query(server.requests[0]).get("per_page"),
    String(DEFAULT_PAGE_SIZE),
  );
  assert.equal(query(server.requests[0]).get("page"), String(FIRST_PAGE));
  assert.equal(
    new URL(String(server.requests[0]?.url), "http://localhost").pathname,
    REVIEW_COMMENTS_PATH,
  );
  const second = await github.listReviewComments(call(), TARGET, {
    number: 7,
    cursor: nextCursor,
  });
  assert.deepEqual(second, {
    ok: true,
    value: { body: REVIEW_COMMENTS, next_cursor: null },
  });
  assert.equal(query(server.requests[1]).get("page"), String(SECOND_PAGE));
});

test("listReviewComments refuses a limit that differs from its cursor", async (t) => {
  const server = await platform(t, answer(200, []));
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const cursor = encodeCursor({ page: SECOND_PAGE, per_page: COMMENT_LIMIT });
  await assert.rejects(
    github.listReviewComments(call(), TARGET, {
      number: 7,
      limit: OTHER_COMMENT_LIMIT,
      cursor,
    }),
    (error: unknown) =>
      error instanceof OperationError &&
      error.status === HttpStatus.BadRequest &&
      error.code === CURSOR_PAGE_SIZE_MISMATCH_CODE,
  );
  assert.equal(server.requests.length, NO_REQUEST);
  const same = await github.listReviewComments(call(), TARGET, {
    number: 7,
    limit: COMMENT_LIMIT,
    cursor,
  });
  assert.equal(same.ok, true);
  assert.equal(server.requests.length, SINGLE_REQUEST);
});

test("listReviewComments refuses a malformed cursor", async (t) => {
  const server = await platform(t, answer(200, []));
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const malformed = [
    "not a cursor",
    Buffer.from('{"page":0,"per_page":10}', "utf8").toString("base64url"),
  ];
  for (const cursor of malformed) {
    await assert.rejects(
      github.listReviewComments(call(), TARGET, { number: 7, cursor }),
      (error: unknown) =>
        error instanceof OperationError &&
        error.status === HttpStatus.BadRequest &&
        error.code === CURSOR_INVALID_CODE,
    );
  }
  assert.equal(server.requests.length, NO_REQUEST);
});

test("foldPullRequest folds the three states of a pull request", () => {
  const github = new GitHubPlatform();
  const merged = ExpectedEndState.PullRequestMerged;
  assert.deepEqual(
    github.foldPullRequest(
      {
        ...PULL_REQUEST_BODY,
        state: "closed",
        merged: true,
        merge_commit_sha: MERGE_COMMIT,
      },
      NO_REVIEWS,
      NO_CHECKS,
      merged,
      NO_TRUSTED,
    ),
    { end_state: CheckEndState.Expected, landed_commits: [MERGE_COMMIT] },
  );
  assert.deepEqual(
    github.foldPullRequest(
      { ...PULL_REQUEST_BODY, state: "closed", merge_commit_sha: MERGE_COMMIT },
      NO_REVIEWS,
      NO_CHECKS,
      merged,
      NO_TRUSTED,
    ),
    { end_state: CheckEndState.Other, landed_commits: [] },
  );
  assert.deepEqual(
    github.foldPullRequest(
      PULL_REQUEST_BODY,
      NO_REVIEWS,
      NO_CHECKS,
      merged,
      NO_TRUSTED,
    ),
    {
      end_state: CheckEndState.None,
      landed_commits: [],
    },
  );
  assert.throws(() =>
    github.foldPullRequest(
      PULL_REQUEST_BODY,
      NO_REVIEWS,
      NO_CHECKS,
      ExpectedEndState.BaseBranchPushed,
      NO_TRUSTED,
    ),
  );
  assert.throws(() =>
    github.foldPullRequest(
      { number: 7 },
      NO_REVIEWS,
      NO_CHECKS,
      merged,
      NO_TRUSTED,
    ),
  );
  assert.throws(
    () =>
      github.foldPullRequest(
        { ...PULL_REQUEST_BODY, state: "closed", merged: true },
        NO_REVIEWS,
        NO_CHECKS,
        merged,
        NO_TRUSTED,
      ),
    { name: "ZodError" },
  );
});

test("an unexpected success body answers the class of a lost answer", async (t) => {
  const server = await platform(t, answer(201, { id: 99 }));
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const created = await github.createPullRequest(call(), TARGET, {
    head: HEAD_BRANCH,
    base: BASE_BRANCH,
    title: "change",
  });
  assert.equal(!created.ok && created.class, ResultClass.UnknownOutcome);
  assert.equal(!created.ok && created.status, null);
  const listed = await github.openPullRequests(call(), TARGET, {
    head: HEAD_BRANCH,
    base: BASE_BRANCH,
  });
  assert.equal(!listed.ok && listed.class, ResultClass.RetryableRefusal);
  assert.equal(server.requests.length, CREATE_AND_LIST_REQUESTS);
});

const EVENTS_PATH = "/repos/octo/widgets/events?per_page=100";
const EVENTS_QUERY = { owner: "octo", repo: "widgets" };
const FIRST_ETAG = '"etag-first"';
const SECOND_ETAG = '"etag-second"';
const NOT_MODIFIED = 304;
const PUSH_EVENT = {
  id: "41",
  type: "PushEvent",
  payload: { ref: "refs/heads/main" },
  actor: { login: "octo" },
};
const PUSH_EVENT_BODY =
  '{"actor":{"login":"octo"},"id":"41","payload":{"ref":"refs/heads/main"},"type":"PushEvent"}';
const ISSUE_EVENT = { id: "42", type: "IssuesEvent", payload: {} };

function bodyText(body: Uint8Array): string {
  return Buffer.from(body).toString("utf8");
}

test("listEvents sends the ETag back and answers the ETag of each answer", async (t) => {
  const server = await platform(t, (request, response, count) => {
    const etag = count === SINGLE_REQUEST ? FIRST_ETAG : SECOND_ETAG;
    answer(200, [ISSUE_EVENT, PUSH_EVENT], { etag })(request, response, count);
  });
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const first = await github.listEvents(call(), {
    ...EVENTS_QUERY,
    etag: null,
  });
  assert.ok(first.ok && !first.value.notModified);
  assert.equal(first.value.etag, FIRST_ETAG);
  assert.deepEqual(
    first.value.events.map((event) => [event.id, event.type]),
    [
      ["42", "IssuesEvent"],
      ["41", "PushEvent"],
    ],
  );
  assert.equal(
    bodyText(first.value.events[1]?.body ?? new Uint8Array()),
    PUSH_EVENT_BODY,
  );
  const second = await github.listEvents(call(), {
    ...EVENTS_QUERY,
    etag: first.value.etag,
  });
  assert.ok(second.ok && !second.value.notModified);
  assert.equal(second.value.etag, SECOND_ETAG);
  assert.equal(server.requests[0]?.url, EVENTS_PATH);
  assert.equal(server.requests[0]?.headers["if-none-match"], undefined);
  assert.equal(server.requests[1]?.headers["if-none-match"], FIRST_ETAG);
  assert.equal(server.requests[1]?.headers.authorization, `token ${TOKEN}`);
});

test("listEvents refuses a malformed body as a lost read", async (t) => {
  const bodies: unknown[] = [
    [{ id: 41, type: "PushEvent" }],
    [{ id: "41", type: "PushEvent", payload: { text: "\ud800" } }],
    [{ id: "0101", type: "PushEvent" }],
  ];
  const server = await platform(t, (request, response, count) => {
    answer(200, bodies[count - SINGLE_REQUEST])(request, response, count);
  });
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  for (let index = 0; index < bodies.length; index += 1) {
    const result = await github.listEvents(call(), {
      ...EVENTS_QUERY,
      etag: null,
    });
    assert.equal(!result.ok && result.class, ResultClass.RetryableRefusal);
    assert.equal(!result.ok && result.status, null);
  }
  assert.equal(server.requests.length, bodies.length);
});

const CLOSED_PULLS_PATH = "/repos/octo/widgets/pulls";
const CLOSED_AT = "2026-10-15T03:57:51Z";
const MERGED_PULL = {
  number: 41,
  state: "closed",
  closed_at: CLOSED_AT,
  merged_at: CLOSED_AT,
  merge_commit_sha: "c".repeat(40),
  base: { ref: "main", repo: { full_name: "octo/widgets" } },
};
const UNMERGED_PULL = {
  number: 40,
  state: "closed",
  closed_at: "2026-10-15T03:50:00Z",
  merged_at: null,
  merge_commit_sha: null,
  base: { ref: "main", repo: { full_name: "octo/widgets" } },
};
const MERGED_PULL_BODY =
  '{"base":{"ref":"main","repo":{"full_name":"octo/widgets"}},"closed_at":"2026-10-15T03:57:51Z","merge_commit_sha":"cccccccccccccccccccccccccccccccccccccccc","merged_at":"2026-10-15T03:57:51Z","number":41,"state":"closed"}';

test("listClosedPullRequests reads one page of the closed pull requests by update time and follows no next link", async (t) => {
  const server = await platform(
    t,
    answer(200, [MERGED_PULL, UNMERGED_PULL], {
      etag: FIRST_ETAG,
      link: '<http://127.0.0.1/repos/octo/widgets/pulls?page=2>; rel="next"',
    }),
  );
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.listClosedPullRequests(call(), {
    ...EVENTS_QUERY,
    etag: null,
  });
  assert.equal(server.requests.length, SINGLE_REQUEST);
  const url = new URL(server.requests[0]?.url ?? "", "http://127.0.0.1");
  assert.equal(url.pathname, CLOSED_PULLS_PATH);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    state: "closed",
    sort: "updated",
    direction: "desc",
    per_page: "100",
  });
  assert.equal(server.requests[0]?.headers["if-none-match"], undefined);
  assert.equal(server.requests[0]?.headers.authorization, `token ${TOKEN}`);
  assert.ok(result.ok && !result.value.notModified);
  assert.equal(result.value.etag, FIRST_ETAG);
  assert.deepEqual(
    result.value.events.map((event) => [event.id, event.type]),
    [
      [`pull_request:41:${CLOSED_AT}`, "pull_request_closed"],
      ["pull_request:40:2026-10-15T03:50:00Z", "pull_request_closed"],
    ],
  );
  assert.equal(
    bodyText(result.value.events[0]?.body ?? new Uint8Array()),
    MERGED_PULL_BODY,
  );
});

test("listClosedPullRequests answers an empty page with no event", async (t) => {
  const server = await platform(t, answer(200, [], { etag: FIRST_ETAG }));
  const result = await new GitHubPlatform({
    baseUrl: server.baseUrl,
  }).listClosedPullRequests(call(), { ...EVENTS_QUERY, etag: null });
  assert.ok(result.ok && !result.value.notModified);
  assert.deepEqual(result.value.events, []);
  assert.equal(result.value.etag, FIRST_ETAG);
});

const EVENT_RESOURCE = "owner/gated";
const EVENT_RESOURCE_IDENTITY = "repository:github:owner/gated";
const EVENT_COMMIT = "e".repeat(40);
const webhookRepository = { full_name: EVENT_RESOURCE };
const polledRepository = { id: 1, name: EVENT_RESOURCE };

function eventBytes(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf8"));
}

function decoded(event: string, body: unknown): unknown {
  return decodeGitHubEvent({
    resource: EVENT_RESOURCE,
    event: eventBytes(JSON.stringify(body)),
    metadata: { event },
  });
}

function closedPullRequest(merged: boolean): unknown {
  return {
    action: "closed",
    number: 7,
    pull_request: { merged },
    repository: webhookRepository,
  };
}

function pushTo(ref: string, after: string): unknown {
  return { ref, after, repository: webhookRepository };
}

test("decodeGitHubEvent answers the pull request of a merged and a closed pull request", () => {
  const address = {
    kind: "pull_request",
    resource_identity: EVENT_RESOURCE_IDENTITY,
    number: 7,
  };
  assert.deepEqual(decoded("pull_request", closedPullRequest(true)), address);
  assert.deepEqual(decoded("pull_request", closedPullRequest(false)), address);
});

test("decodeGitHubEvent answers the branch push of a push to main", () => {
  assert.deepEqual(decoded("push", pushTo("refs/heads/main", EVENT_COMMIT)), {
    kind: "branch_push",
    resource_identity: EVENT_RESOURCE_IDENTITY,
    branch: "main",
    commit: EVENT_COMMIT,
  });
});

test("decodeGitHubEvent answers null for a branch delete, a tag push and an upper-case commit", () => {
  assert.equal(
    decoded("push", pushTo("refs/heads/main", "0".repeat(40))),
    null,
  );
  assert.equal(decoded("push", pushTo("refs/tags/v1", EVENT_COMMIT)), null);
  assert.equal(decoded("push", pushTo("refs/heads/", EVENT_COMMIT)), null);
  assert.equal(
    decoded("push", pushTo("refs/heads/main", "E".repeat(40))),
    null,
  );
});

test("decodeGitHubEvent answers null for a ping and another event type", () => {
  assert.equal(decoded("ping", { zen: "z", hook_id: 1 }), null);
  assert.equal(
    decoded("issues", {
      action: "opened",
      issue: { number: 3 },
      repository: webhookRepository,
    }),
    null,
  );
  assert.equal(decoded("constructor", closedPullRequest(true)), null);
});

test("decodeGitHubEvent answers null for another repository", () => {
  const other = { full_name: "owner/other" };
  assert.equal(decoded("pull_request", { number: 7, repository: other }), null);
  assert.equal(
    decoded("push", {
      ref: "refs/heads/main",
      after: EVENT_COMMIT,
      repository: other,
    }),
    null,
  );
  assert.equal(
    decoded("PullRequestEvent", {
      repo: { name: "owner/other" },
      payload: { number: 7 },
    }),
    null,
  );
});

test("decodeGitHubEvent answers the address of the two polled types", () => {
  assert.deepEqual(
    decoded("PullRequestEvent", {
      id: "1",
      type: "PullRequestEvent",
      repo: polledRepository,
      payload: { action: "closed", number: 7 },
    }),
    {
      kind: "pull_request",
      resource_identity: EVENT_RESOURCE_IDENTITY,
      number: 7,
    },
  );
  assert.deepEqual(
    decoded("PushEvent", {
      id: "2",
      type: "PushEvent",
      repo: polledRepository,
      payload: { ref: "refs/heads/feature/x", head: EVENT_COMMIT },
    }),
    {
      kind: "branch_push",
      resource_identity: EVENT_RESOURCE_IDENTITY,
      branch: "feature/x",
      commit: EVENT_COMMIT,
    },
  );
});

const closedPullRequestItem = (merged: boolean, overrides = {}) => ({
  number: 7,
  state: "closed",
  closed_at: "2026-10-15T03:57:51Z",
  merged_at: merged ? "2026-10-15T03:57:51Z" : null,
  merge_commit_sha: merged ? EVENT_COMMIT : null,
  base: { ref: "main", repo: { full_name: EVENT_RESOURCE } },
  ...overrides,
});

test("decodeGitHubEvent answers the branch push of a merged closed pull request item and the pull request of an unmerged item", () => {
  assert.deepEqual(
    decoded("pull_request_closed", closedPullRequestItem(true)),
    {
      kind: "branch_push",
      resource_identity: EVENT_RESOURCE_IDENTITY,
      branch: "main",
      commit: EVENT_COMMIT,
    },
  );
  assert.deepEqual(
    decoded("pull_request_closed", closedPullRequestItem(false)),
    {
      kind: "pull_request",
      resource_identity: EVENT_RESOURCE_IDENTITY,
      number: 7,
    },
  );
});

test("decodeGitHubEvent takes the branch of a merged item from base.ref and ignores the commit of an unmerged item", () => {
  assert.deepEqual(
    decoded(
      "pull_request_closed",
      closedPullRequestItem(true, {
        base: { ref: "release/1.x", repo: { full_name: EVENT_RESOURCE } },
      }),
    ),
    {
      kind: "branch_push",
      resource_identity: EVENT_RESOURCE_IDENTITY,
      branch: "release/1.x",
      commit: EVENT_COMMIT,
    },
  );
  assert.deepEqual(
    decoded(
      "pull_request_closed",
      closedPullRequestItem(false, { merge_commit_sha: "not a commit" }),
    ),
    {
      kind: "pull_request",
      resource_identity: EVENT_RESOURCE_IDENTITY,
      number: 7,
    },
  );
});

test("decodeGitHubEvent answers null for a closed pull request item of another repository or of a bad shape", () => {
  const other = { ref: "main", repo: { full_name: "owner/other" } };
  assert.equal(
    decoded(
      "pull_request_closed",
      closedPullRequestItem(true, { base: other }),
    ),
    null,
  );
  assert.equal(
    decoded("pull_request_closed", closedPullRequestItem(true, { number: 0 })),
    null,
  );
  assert.equal(
    decoded("pull_request_closed", closedPullRequestItem(true, { base: {} })),
    null,
  );
  assert.equal(
    decoded(
      "pull_request_closed",
      closedPullRequestItem(true, {
        base: { ref: "", repo: { full_name: EVENT_RESOURCE } },
      }),
    ),
    null,
  );
  assert.equal(
    decoded("pull_request_closed", [closedPullRequestItem(true)]),
    null,
  );
});

test("decodeGitHubEvent answers null for bytes that do not decode", () => {
  const decode = (event: Uint8Array) =>
    decodeGitHubEvent({
      resource: EVENT_RESOURCE,
      event,
      metadata: { event: "pull_request" },
    });
  assert.equal(decode(eventBytes("{not json")), null);
  assert.equal(decode(new Uint8Array([0xff, 0xfe, 0x7b])), null);
  assert.equal(decode(new Uint8Array()), null);
  assert.equal(decoded("pull_request", null), null);
  assert.equal(decoded("pull_request", [closedPullRequest(true)]), null);
  assert.equal(decoded("pull_request", { number: 7 }), null);
  assert.equal(decoded("PushEvent", { repo: polledRepository }), null);
});

test("an open pull request with merge conflicts folds to the conflict end state", () => {
  const github = new GitHubPlatform({ baseUrl: "http://127.0.0.1:1" });
  const open = {
    state: "open",
    merged: false,
    merge_commit_sha: null,
    head: { sha: HEAD_SHA },
  };
  assert.equal(
    github.foldPullRequest(
      { ...open, mergeable_state: "dirty" },
      NO_REVIEWS,
      NO_CHECKS,
      ExpectedEndState.PullRequestMerged,
      NO_TRUSTED,
    ).end_state,
    CheckEndState.Conflict,
  );
  assert.equal(
    github.foldPullRequest(
      { ...open, mergeable_state: "clean" },
      NO_REVIEWS,
      NO_CHECKS,
      ExpectedEndState.PullRequestMerged,
      NO_TRUSTED,
    ).end_state,
    CheckEndState.None,
  );
  assert.equal(
    github.foldPullRequest(
      open,
      NO_REVIEWS,
      NO_CHECKS,
      ExpectedEndState.PullRequestMerged,
      NO_TRUSTED,
    ).end_state,
    CheckEndState.None,
  );
});

const PENDING_MERGEABILITY = {
  ...PULL_REQUEST_BODY,
  mergeable: null,
  mergeable_state: "unknown",
};
const CONFLICTING_MERGEABILITY = {
  ...PULL_REQUEST_BODY,
  mergeable: false,
  mergeable_state: "dirty",
};
const MERGEABILITY_DELAY_MS = 5;
const MERGEABILITY_READ_COUNT = 3;
const SECOND_READ = 2;

function bodiesInOrder(bodies: unknown[]): Handler {
  return (request, response, count) =>
    answer(200, bodies[Math.min(count, bodies.length) - 1])(
      request,
      response,
      count,
    );
}

function settled(github: GitHubPlatform, deadlineAt?: number) {
  return github.getSettledPullRequest(
    call(deadlineAt === undefined ? {} : { deadlineAt }),
    TARGET,
    { number: 7 },
  );
}

test("a pull request whose first read holds a null mergeable and whose second read holds dirty folds to conflict", async (t) => {
  const server = await platform(
    t,
    bodiesInOrder([PENDING_MERGEABILITY, CONFLICTING_MERGEABILITY]),
  );
  const github = new GitHubPlatform({
    baseUrl: server.baseUrl,
    mergeabilityRetryDelayMs: MERGEABILITY_DELAY_MS,
  });
  const result = await settled(github);
  assert.ok(result.ok);
  assert.equal(server.requests.length, SECOND_READ);
  assert.equal(
    github.foldPullRequest(
      result.value,
      NO_REVIEWS,
      NO_CHECKS,
      ExpectedEndState.PullRequestMerged,
      NO_TRUSTED,
    ).end_state,
    CheckEndState.Conflict,
  );
});

test("a null mergeable after the third read folds to none", async (t) => {
  const server = await platform(t, answer(200, PENDING_MERGEABILITY));
  const github = new GitHubPlatform({
    baseUrl: server.baseUrl,
    mergeabilityRetryDelayMs: MERGEABILITY_DELAY_MS,
  });
  const result = await settled(github);
  assert.ok(result.ok);
  assert.equal(server.requests.length, MERGEABILITY_READ_COUNT);
  assert.equal(
    github.foldPullRequest(
      result.value,
      NO_REVIEWS,
      NO_CHECKS,
      ExpectedEndState.PullRequestMerged,
      NO_TRUSTED,
    ).end_state,
    CheckEndState.None,
  );
});

test("a known mergeable, a closed pull request and a failed read end the reads at once", async (t) => {
  for (const [status, body] of [
    [200, { ...PULL_REQUEST_BODY, mergeable: true }],
    [200, { ...PENDING_MERGEABILITY, state: "closed", merged: false }],
    [200, PULL_REQUEST_BODY],
    [SERVICE_UNAVAILABLE, { message: "unavailable" }],
  ] as const) {
    const server = await platform(t, answer(status, body));
    const github = new GitHubPlatform({
      baseUrl: server.baseUrl,
      mergeabilityRetryDelayMs: MERGEABILITY_DELAY_MS,
    });
    await settled(github);
    assert.equal(server.requests.length, SINGLE_REQUEST);
  }
});

test("a deadline that leaves less time than the delay ends the reads", async (t) => {
  const server = await platform(t, answer(200, PENDING_MERGEABILITY));
  const github = new GitHubPlatform({
    baseUrl: server.baseUrl,
    mergeabilityRetryDelayMs: SHORT_DEADLINE_MS,
  });
  const result = await settled(github, Date.now() + SHORT_DEADLINE_MS);
  assert.ok(result.ok);
  assert.equal(server.requests.length, SINGLE_REQUEST);
});

function review(reviewer: number, state: string, commit = HEAD_SHA) {
  return {
    id: reviewer,
    user: { id: reviewer, type: "User" },
    state,
    commit_id: commit,
  };
}

function decision(reviews: unknown[], body: object = PULL_REQUEST_BODY) {
  return new GitHubPlatform().foldPullRequest(
    body,
    reviews,
    NO_CHECKS,
    ExpectedEndState.PullRequestMerged,
    TRUSTED_REVIEWERS,
  ).end_state;
}

function foldWithChecks(
  checks: { head_commit: string; pending: string[]; failed: string[] },
  reviews: unknown[] = NO_REVIEWS,
  body: object = PULL_REQUEST_BODY,
) {
  return new GitHubPlatform().foldPullRequest(
    body,
    reviews,
    checks,
    ExpectedEndState.PullRequestMerged,
    TRUSTED_REVIEWERS,
  ).end_state;
}

test("a pending required check at the head folds to checks_pending", () => {
  assert.equal(foldWithChecks(PENDING_AT_HEAD), CheckEndState.ChecksPending);
});

test("a failed required check wins over a pending required check", () => {
  assert.equal(
    foldWithChecks(FAILED_AND_PENDING_AT_HEAD),
    CheckEndState.ChecksFailed,
  );
});

test("checks of another head fold to checks_pending", () => {
  assert.equal(foldWithChecks(FAILED_AT_OLDER), CheckEndState.ChecksPending);
  assert.equal(
    foldWithChecks({ head_commit: OLDER_SHA, pending: [], failed: [] }),
    CheckEndState.ChecksPending,
  );
});

test("a conflict or a current change request wins over a failed required check", () => {
  assert.equal(
    foldWithChecks(FAILED_AT_HEAD, NO_REVIEWS, {
      ...PULL_REQUEST_BODY,
      mergeable_state: "dirty",
    }),
    CheckEndState.Conflict,
  );
  assert.equal(
    foldWithChecks(FAILED_AT_HEAD, [review(1, ReviewState.ChangesRequested)]),
    CheckEndState.Other,
  );
});

test("a current change request on an open pull request folds to other", () => {
  const changes = review(1, ReviewState.ChangesRequested);
  assert.equal(decision([changes]), CheckEndState.Other);
  assert.equal(
    decision([review(2, ReviewState.Approved), changes]),
    CheckEndState.Other,
  );
  assert.equal(
    decision([changes], { ...PULL_REQUEST_BODY, mergeable_state: "dirty" }),
    CheckEndState.Other,
  );
});

test("a change request that a later decisive review replaces folds to none", () => {
  const changes = review(1, ReviewState.ChangesRequested);
  assert.equal(
    decision([changes, review(1, ReviewState.Approved)]),
    CheckEndState.None,
  );
  assert.equal(
    decision([{ ...changes, state: ReviewState.Dismissed }]),
    CheckEndState.None,
  );
  assert.equal(
    decision([changes, review(1, "COMMENTED"), review(1, "PENDING")]),
    CheckEndState.Other,
  );
  assert.equal(
    decision([review(1, "COMMENTED"), review(2, "PENDING")]),
    CheckEndState.None,
  );
  assert.equal(
    decision([review(1, ReviewState.ChangesRequested, OLDER_SHA)]),
    CheckEndState.None,
  );
  assert.equal(decision([{ ...changes, user: null }]), CheckEndState.None);
});

test("a merged or closed pull request ignores the change requests", () => {
  const changes = [review(1, ReviewState.ChangesRequested)];
  assert.equal(
    decision(changes, {
      ...PULL_REQUEST_BODY,
      state: "closed",
      merged: true,
      merge_commit_sha: MERGE_COMMIT,
    }),
    CheckEndState.Expected,
  );
  assert.equal(
    decision(changes, { ...PULL_REQUEST_BODY, state: "closed" }),
    CheckEndState.Other,
  );
  assert.equal(
    decision([{ state: 1 }], { ...PULL_REQUEST_BODY, state: "closed" }),
    CheckEndState.Other,
  );
});

test("listReviews reads every page of the reviews", async (t) => {
  const server = await platform(t, (request, response, count) => {
    const headers: Record<string, string> =
      count === SINGLE_REQUEST ? { link: NEXT_LINK } : { link: PREVIOUS_LINK };
    answer(200, [review(count, ReviewState.Approved)], headers)(
      request,
      response,
      count,
    );
  });
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.listReviews(call(), TARGET, { number: 7 });
  assert.deepEqual(result, {
    ok: true,
    value: [
      review(1, ReviewState.Approved),
      review(SECOND_PAGE, ReviewState.Approved),
    ],
  });
  assert.equal(server.requests.length, SECOND_PAGE);
  for (const [index, request] of server.requests.entries()) {
    assert.equal(request.method, HttpMethod.Get);
    assert.equal(
      new URL(String(request.url), "http://localhost").pathname,
      REVIEWS_PATH,
    );
    assert.equal(query(request).get("per_page"), String(DEFAULT_PAGE_SIZE));
    assert.equal(query(request).get("page"), String(index + 1));
  }
});

test("listReviews answers a failure for a failed page or a body that is not a list", async (t) => {
  const failing = await platform(
    t,
    answer(401, { message: "Bad credentials" }),
  );
  const refused = await new GitHubPlatform({
    baseUrl: failing.baseUrl,
  }).listReviews(call(), TARGET, { number: 7 });
  assert.equal(!refused.ok && refused.class, ResultClass.FinalRefusal);
  const unexpected = await platform(t, answer(200, { id: 1 }));
  const unread = await new GitHubPlatform({
    baseUrl: unexpected.baseUrl,
  }).listReviews(call(), TARGET, { number: 7 });
  assert.equal(unread.ok, false);
  const endless = await platform(t, answer(200, [], { link: NEXT_LINK }));
  const bounded = await new GitHubPlatform({
    baseUrl: endless.baseUrl,
  }).listReviews(call(), TARGET, { number: 7 });
  assert.equal(bounded.ok, false);
  assert.equal(endless.requests.length, REVIEW_PAGE_LIMIT);
});

function changeRequestServer(
  reviews: unknown[],
  comments: Record<string, unknown>,
): Handler {
  return (request, response, count) => {
    const path = new URL(String(request.url), "http://localhost").pathname;
    if (path === PULL_REQUEST_PATH)
      return answer(200, PULL_REQUEST_BODY)(request, response, count);
    if (path === REVIEWS_PATH)
      return answer(200, reviews)(request, response, count);
    const body = comments[path];
    return body === undefined
      ? answer(404, { message: "Not Found" })(request, response, count)
      : answer(200, body)(request, response, count);
  };
}

test("getChangeRequests answers the current change requests with their review comments", async (t) => {
  const login = (reviewer: number) => ({
    ...review(reviewer, ReviewState.ChangesRequested),
    user: { id: reviewer, login: `reviewer-${reviewer}`, type: "User" },
    body: `fix ${reviewer}`,
    submitted_at: "2026-10-12T00:00:00Z",
  });
  const server = await platform(
    t,
    changeRequestServer(
      [
        login(1),
        { ...login(2), commit_id: OLDER_SHA },
        login(3),
        { ...login(3), id: 4, state: ReviewState.Approved },
      ],
      {
        [`${REVIEWS_PATH}/1/comments`]: [
          { path: "src/a.ts", line: 3, body: "rename", id: 9 },
          { path: "src/b.ts", line: null, body: "drop" },
        ],
      },
    ),
  );
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.getChangeRequests(
    call(),
    TARGET,
    { number: 7 },
    TRUSTED_REVIEWERS,
  );
  assert.deepEqual(result, {
    ok: true,
    value: {
      head_commit: HEAD_SHA,
      change_requests: [
        {
          review_id: 1,
          reviewer: "reviewer-1",
          body: "fix 1",
          submitted_at: "2026-10-12T00:00:00Z",
          commit_id: HEAD_SHA,
          comments: [
            { path: "src/a.ts", line: 3, body: "rename" },
            { path: "src/b.ts", line: null, body: "drop" },
          ],
        },
      ],
    },
  });
  assert.deepEqual(
    server.requests.map(
      (request) => new URL(String(request.url), "http://localhost").pathname,
    ),
    [PULL_REQUEST_PATH, REVIEWS_PATH, `${REVIEWS_PATH}/1/comments`],
  );
});

const RULES_PATH = "/repos/octo/widgets/rules/branches/main";
const CHECK_RUNS_PATH = `/repos/octo/widgets/commits/${HEAD_SHA}/check-runs`;
const STATUSES_PATH = `/repos/octo/widgets/commits/${HEAD_SHA}/statuses`;
const CHECK_PULL_REQUEST = {
  ...PULL_REQUEST_BODY,
  base: { ref: BASE_BRANCH },
};
const requiredRule = (...contexts: string[]) => ({
  type: "required_status_checks",
  parameters: {
    required_status_checks: contexts.map((context) => ({
      context,
      integration_id: 15368,
    })),
  },
});
const run = (
  id: number,
  name: string,
  status: string,
  conclusion: string | null,
) => ({ id, name, status, conclusion });
const pathOf = (request: IncomingMessage) =>
  new URL(String(request.url), "http://localhost").pathname;

function checkServer(routes: Record<string, [number, unknown]>): Handler {
  return (request, response, count) => {
    const route = routes[pathOf(request)];
    return route === undefined
      ? answer(404, { message: "Not Found" })(request, response, count)
      : answer(route[0], route[1])(request, response, count);
  };
}

test("foldRequiredChecks splits the required checks by the run conclusion", () => {
  const checkRuns = {
    total_count: 9,
    check_runs: [
      run(1, "queued", "queued", null),
      run(2, "working", "in_progress", null),
      run(3, "green", "completed", "success"),
      run(4, "grey", "completed", "neutral"),
      run(5, "skip", "completed", "skipped"),
      run(6, "red", "completed", "failure"),
      run(7, "slow", "completed", "timed_out"),
      run(8, "stopped", "completed", "cancelled"),
      run(9, "manual", "completed", "action_required"),
      run(10, "unrequired", "completed", "failure"),
    ],
  };
  assert.deepEqual(
    foldRequiredChecks(
      [
        "working",
        "queued",
        "green",
        "grey",
        "skip",
        "stopped",
        "red",
        "slow",
        "manual",
      ],
      checkRuns,
      [],
    ),
    {
      pending: ["queued", "working"],
      failed: ["manual", "red", "slow", "stopped"],
    },
  );
});

test("foldRequiredChecks lets the run with the highest id decide", () => {
  const checkRuns = {
    total_count: 4,
    check_runs: [
      run(5, "retried", "completed", "success"),
      run(2, "retried", "completed", "failure"),
      run(3, "restarted", "completed", "success"),
      run(8, "restarted", "in_progress", null),
    ],
  };
  assert.deepEqual(
    foldRequiredChecks(["retried", "restarted"], checkRuns, []),
    { pending: ["restarted"], failed: [] },
  );
});

test("foldRequiredChecks lets the newest status decide a name with no run", () => {
  const statuses = [
    { context: "ci/a", state: "success" },
    { context: "ci/a", state: "failure" },
    { context: "ci/b", state: "pending" },
    { context: "ci/c", state: "error" },
    { context: "ci/d", state: "failure" },
    { context: "ci/d", state: "success" },
  ];
  assert.deepEqual(
    foldRequiredChecks(
      ["ci/a", "ci/b", "ci/c", "ci/d", "ci/none"],
      { total_count: 0, check_runs: [] },
      statuses,
    ),
    { pending: ["ci/b", "ci/none"], failed: ["ci/c", "ci/d"] },
  );
});

test("foldRequiredChecks lets a run win over a status of the same name", () => {
  assert.deepEqual(
    foldRequiredChecks(
      ["check"],
      { total_count: 1, check_runs: [run(1, "check", "completed", "success")] },
      [{ context: "check", state: "failure" }],
    ),
    { pending: [], failed: [] },
  );
});

test("getRequiredChecks folds the required checks of the head commit", async (t) => {
  const server = await platform(
    t,
    checkServer({
      [PULL_REQUEST_PATH]: [200, CHECK_PULL_REQUEST],
      [RULES_PATH]: [
        200,
        [
          { type: "pull_request", parameters: {} },
          requiredRule("check", "lint"),
          requiredRule("check", "deploy"),
        ],
      ],
      [CHECK_RUNS_PATH]: [
        200,
        {
          total_count: 2,
          check_runs: [
            run(1, "check", "completed", "failure"),
            run(2, "lint", "queued", null),
          ],
        },
      ],
      [STATUSES_PATH]: [200, [{ context: "deploy", state: "pending" }]],
    }),
  );
  const result = await new GitHubPlatform({
    baseUrl: server.baseUrl,
  }).getRequiredChecks(call(), TARGET, { number: 7 });
  assert.deepEqual(result, {
    ok: true,
    value: {
      head_commit: HEAD_SHA,
      base_branch: BASE_BRANCH,
      pending: ["deploy", "lint"],
      failed: ["check"],
    },
  });
  assert.deepEqual(server.requests.map(pathOf), [
    PULL_REQUEST_PATH,
    RULES_PATH,
    CHECK_RUNS_PATH,
    STATUSES_PATH,
  ]);
  assert.equal(
    new URL(
      String(server.requests[2]?.url),
      "http://localhost",
    ).searchParams.get("per_page"),
    String(DEFAULT_PAGE_SIZE),
  );
});

test("getRequiredChecks reads no check run when the rules require no check", async (t) => {
  const server = await platform(
    t,
    checkServer({
      [PULL_REQUEST_PATH]: [200, CHECK_PULL_REQUEST],
      [RULES_PATH]: [200, [{ type: "pull_request", parameters: {} }]],
    }),
  );
  const result = await new GitHubPlatform({
    baseUrl: server.baseUrl,
  }).getRequiredChecks(call(), TARGET, { number: 7 });
  assert.deepEqual(result, {
    ok: true,
    value: {
      head_commit: HEAD_SHA,
      base_branch: BASE_BRANCH,
      pending: [],
      failed: [],
    },
  });
  assert.deepEqual(server.requests.map(pathOf), [
    PULL_REQUEST_PATH,
    RULES_PATH,
  ]);
});

test("getRequiredChecks reads a rule that holds no parameters", async (t) => {
  const server = await platform(
    t,
    checkServer({
      [PULL_REQUEST_PATH]: [200, CHECK_PULL_REQUEST],
      [RULES_PATH]: [
        200,
        [
          { type: "deletion" },
          { type: "non_fast_forward" },
          requiredRule("check"),
        ],
      ],
      [CHECK_RUNS_PATH]: [
        200,
        {
          total_count: 1,
          check_runs: [run(1, "check", "completed", "success")],
        },
      ],
      [STATUSES_PATH]: [200, []],
    }),
  );
  const result = await new GitHubPlatform({
    baseUrl: server.baseUrl,
  }).getRequiredChecks(call(), TARGET, { number: 7 });
  assert.deepEqual(result, {
    ok: true,
    value: {
      head_commit: HEAD_SHA,
      base_branch: BASE_BRANCH,
      pending: [],
      failed: [],
    },
  });
});

test("getRequiredChecks answers a failed read unchanged", async (t) => {
  const server = await platform(
    t,
    checkServer({
      [PULL_REQUEST_PATH]: [200, CHECK_PULL_REQUEST],
    }),
  );
  const result = await new GitHubPlatform({
    baseUrl: server.baseUrl,
  }).getRequiredChecks(call(), TARGET, { number: 7 });
  assert.equal(!result.ok && result.class, ResultClass.FinalRefusal);
  assert.equal(!result.ok && result.status, HttpStatus.NotFound);
});

interface LinkInput {
  resource_identity?: string;
  event: Uint8Array;
  metadata: unknown;
}

function linkOf(input: LinkInput): unknown {
  return decodeGitHubLinkUpdate({
    resource_identity: COMMENT_RESOURCE_IDENTITY,
    ...input,
  });
}

function webhookLink(body: unknown): unknown {
  return linkOf({
    event: commentBytes(body),
    metadata: { event: WEBHOOK_EVENT },
  });
}

function listedLink(body: unknown): unknown {
  return linkOf({
    event: commentBytes(body),
    metadata: { event: LISTED_EVENT },
  });
}

const EXPECTED_LINK = {
  kind: "github_issue",
  resource_identity: COMMENT_RESOURCE_IDENTITY,
  number: COMMENT_NUMBER,
};
const EXPECTED_UPDATE = {
  external_link: EXPECTED_LINK,
  update_key: COMMENT_UPDATE_KEY,
  actor_id: String(COMMENT_USER_ID),
  actor_automated: false,
  occurred_at: COMMENT_CREATED_AT_MS,
  mentions: [],
};
const MENTION_LIMIT = 50;
const FIRST_MENTION = "user0";
const USER_PATH = "/user";
const ISSUE_COMMENT_PAGE_SIZE = 100;
const EXCESS_MENTIONS = 60;

function mentionsIn(body: string): unknown {
  const update = webhookLink(webhookComment({ body })) as {
    mentions: string[];
  };
  return update.mentions;
}

test("decodeGitHubLinkUpdate decodes a created webhook comment and a listed comment to the same link, key and facts", () => {
  assert.deepEqual(webhookLink(webhookComment()), EXPECTED_UPDATE);
  assert.deepEqual(listedLink(listedComment()), EXPECTED_UPDATE);
});

test("decodeGitHubLinkUpdate answers null for an edited and a deleted comment, a closed issue and a broken body", () => {
  assert.equal(webhookLink(webhookComment({}, { action: "edited" })), null);
  assert.equal(webhookLink(webhookComment({}, { action: "deleted" })), null);
  assert.equal(
    linkOf({
      event: commentBytes(webhookComment({}, { action: "closed" })),
      metadata: { event: "issues" },
    }),
    null,
  );
  assert.equal(
    linkOf({
      event: commentBytes(listedComment()),
      metadata: { event: "IssueCommentEvent" },
    }),
    null,
  );
  assert.equal(
    linkOf({
      event: new Uint8Array(Buffer.from("{broken", "utf8")),
      metadata: { event: WEBHOOK_EVENT },
    }),
    null,
  );
  assert.equal(webhookLink(webhookComment({ id: 0 })), null);
  assert.equal(webhookLink(webhookComment({ created_at: "yesterday" })), null);
  assert.equal(webhookLink(webhookComment({ created_at: undefined })), null);
  assert.equal(listedLink(listedComment({ created_at: undefined })), null);
});

test("decodeGitHubLinkUpdate answers null for another repository and for a repository resource", () => {
  assert.equal(
    webhookLink(
      webhookComment({}, { repository: { full_name: "octo/other" } }),
    ),
    null,
  );
  assert.equal(
    listedLink(
      listedComment({
        issue_url: "https://api.github.com/repos/octo/other/issues/7",
      }),
    ),
    null,
  );
  assert.equal(
    listedLink(listedComment({ issue_url: "https://api.github.com/user" })),
    null,
  );
  assert.equal(
    linkOf({
      resource_identity: "repository:github:octo/widgets",
      event: commentBytes(webhookComment()),
      metadata: { event: WEBHOOK_EVENT },
    }),
    null,
  );
});

test("decodeGitHubLinkUpdate marks a Bot user, a [bot] login and an app comment as automated", () => {
  const automated = [
    { user: commentUser({ type: "Bot" }) },
    { user: commentUser({ login: "dependabot[bot]" }) },
    { performed_via_github_app: { id: 5 } },
  ];
  for (const comment of automated) {
    const update = webhookLink(webhookComment(comment)) as {
      actor_automated: boolean;
    };
    assert.equal(update.actor_automated, true);
  }
});

test("decodeGitHubLinkUpdate answers the lower-case distinct logins of the mentions", () => {
  assert.deepEqual(mentionsIn("hi @Ulrich and @octo-cat"), [
    "ulrich",
    "octo-cat",
  ]);
  assert.deepEqual(mentionsIn("@ulrich @Ulrich @ULRICH"), ["ulrich"]);
  assert.deepEqual(mentionsIn("mail me at a@example.com"), []);
  assert.deepEqual(mentionsIn(`@${"a".repeat(40)}`), []);
});

test("decodeGitHubLinkUpdate ignores a mention inside a code span and a fenced block", () => {
  assert.deepEqual(mentionsIn("run `@ulrich` now"), []);
  assert.deepEqual(mentionsIn("run ``a ` @ulrich`` now"), []);
  assert.deepEqual(mentionsIn("```\n@ulrich\n```"), []);
  assert.deepEqual(mentionsIn("~~~sh\n@ulrich\n~~~\n@octo"), ["octo"]);
  assert.deepEqual(mentionsIn("```\n@ulrich"), []);
  assert.deepEqual(mentionsIn("`code` @ulrich"), ["ulrich"]);
});

test("decodeGitHubLinkUpdate keeps at most 50 mentions", () => {
  const body = Array.from(
    { length: EXCESS_MENTIONS },
    (_, index) => `@user${index}`,
  ).join(" ");
  const mentions = mentionsIn(body) as string[];
  assert.equal(mentions.length, MENTION_LIMIT);
  assert.equal(mentions[0], FIRST_MENTION);
});

test("describeGitHubEvent answers the author, the whole body, the URL and the time of a comment of each source", () => {
  const body = "x".repeat(3000);
  const expected = {
    author: COMMENT_LOGIN,
    body,
    url: COMMENT_URL,
    occurred_at: COMMENT_CREATED_AT_MS,
  };
  assert.deepEqual(
    describeGitHubEvent({
      event: commentBytes(webhookComment({ body })),
      metadata: { event: WEBHOOK_EVENT },
    }),
    expected,
  );
  assert.deepEqual(
    describeGitHubEvent({
      event: commentBytes(listedComment({ body })),
      metadata: { event: LISTED_EVENT },
    }),
    expected,
  );
});

test("describeGitHubEvent answers null for an edited comment, another event and a broken body", () => {
  assert.equal(
    describeGitHubEvent({
      event: commentBytes(webhookComment({}, { action: "edited" })),
      metadata: { event: WEBHOOK_EVENT },
    }),
    null,
  );
  assert.equal(
    describeGitHubEvent({
      event: commentBytes(webhookComment()),
      metadata: { event: "issues" },
    }),
    null,
  );
  assert.equal(
    describeGitHubEvent({
      event: new Uint8Array(Buffer.from("{broken", "utf8")),
      metadata: { event: LISTED_EVENT },
    }),
    null,
  );
});

const COMMENTS_PATH = "/repos/octo/widgets/issues/comments";
const ISSUE_COMMENTS_PATH = "/repos/octo/widgets/issues/7/comments";
const POST_ID = 5005;
const LAST_PAGE = 3;
const TWO_REQUESTS = 2;

test("listIssueComments sends the query and the ETag, reads one page and answers the items and the ETag", async (t) => {
  const server = await platform(
    t,
    answer(200, [listedComment(), listedComment({ id: COMMENT_ID + 1 })], {
      etag: SECOND_ETAG,
      link: '<http://127.0.0.1/repos/octo/widgets/issues/comments?page=2>; rel="next"',
    }),
  );
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.listIssueComments(call(), TARGET, {
    etag: FIRST_ETAG,
  });
  assert.equal(server.requests.length, SINGLE_REQUEST);
  const request = server.requests[0];
  assert.equal(request?.method, HttpMethod.Get);
  assert.equal(request?.headers["if-none-match"], FIRST_ETAG);
  assert.equal(request?.headers.authorization, `token ${TOKEN}`);
  const url = new URL(request?.url ?? "", "http://127.0.0.1");
  assert.equal(url.pathname, COMMENTS_PATH);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    sort: "updated",
    direction: "desc",
    per_page: "100",
  });
  assert.ok(result.ok && !result.value.notModified);
  assert.equal(result.value.etag, SECOND_ETAG);
  assert.deepEqual(
    result.value.events.map((event) => [event.id, event.type]),
    [
      [COMMENT_UPDATE_KEY, LISTED_EVENT],
      ["issue_comment:1002", LISTED_EVENT],
    ],
  );
  assert.deepEqual(
    JSON.parse(bodyText(result.value.events[0]?.body ?? new Uint8Array())),
    listedComment(),
  );
});

test("listIssueCommentsOf reads one page when the answer holds no last link", async (t) => {
  const server = await platform(
    t,
    answer(200, [listedComment(), listedComment({ id: COMMENT_ID + 1 })]),
  );
  const result = await new GitHubPlatform({
    baseUrl: server.baseUrl,
  }).listIssueCommentsOf(call(), TARGET, COMMENT_NUMBER);
  assert.equal(server.requests.length, SINGLE_REQUEST);
  const url = new URL(server.requests[0]?.url ?? "", "http://127.0.0.1");
  assert.equal(url.pathname, ISSUE_COMMENTS_PATH);
  assert.deepEqual(Object.fromEntries(url.searchParams), { per_page: "100" });
  assert.ok(result.ok);
  assert.deepEqual(
    result.value.map((event) => [event.id, event.type]),
    [
      [COMMENT_UPDATE_KEY, LISTED_EVENT],
      ["issue_comment:1002", LISTED_EVENT],
    ],
  );
});

test("listIssueCommentsOf reads the last page too and makes at most two requests", async (t) => {
  const server = await platform(t, (request, response, count) => {
    const first = count === SINGLE_REQUEST;
    answer(
      200,
      [listedComment({ id: first ? COMMENT_ID : POST_ID })],
      first
        ? {
            link: `<http://127.0.0.1/repositories/1/issues/7/comments?per_page=100&page=2>; rel="next", <http://127.0.0.1/repositories/1/issues/7/comments?per_page=100&page=${LAST_PAGE}>; rel="last"`,
          }
        : {},
    )(request, response, count);
  });
  const result = await new GitHubPlatform({
    baseUrl: server.baseUrl,
  }).listIssueCommentsOf(call(), TARGET, COMMENT_NUMBER);
  assert.equal(server.requests.length, TWO_REQUESTS);
  assert.equal(query(server.requests[1]).get("page"), String(LAST_PAGE));
  assert.equal(
    query(server.requests[1]).get("per_page"),
    String(ISSUE_COMMENT_PAGE_SIZE),
  );
  assert.ok(result.ok);
  assert.deepEqual(
    result.value.map((event) => event.id),
    [COMMENT_UPDATE_KEY, `issue_comment:${POST_ID}`],
  );
});

test("postIssueComment posts the body and answers the update key and the actor id", async (t) => {
  const server = await platform(
    t,
    answer(201, { id: POST_ID, user: { id: COMMENT_USER_ID }, body: "ok" }),
  );
  const result = await new GitHubPlatform({
    baseUrl: server.baseUrl,
  }).postIssueComment(call(), TARGET, COMMENT_NUMBER, "thanks");
  assert.equal(server.requests.length, SINGLE_REQUEST);
  assert.equal(server.requests[0]?.method, HttpMethod.Post);
  assert.equal(server.requests[0]?.url, ISSUE_COMMENTS_PATH);
  assert.deepEqual(JSON.parse(server.bodies[0] ?? ""), { body: "thanks" });
  assert.deepEqual(result, {
    ok: true,
    value: {
      update_key: `issue_comment:${POST_ID}`,
      actor_id: String(COMMENT_USER_ID),
    },
  });
});

test("postIssueComment answers an unknown outcome for an answer without an id and a final refusal for a 404", async (t) => {
  const unreadable = await platform(t, answer(201, { body: "ok" }));
  const unreadableResult = await new GitHubPlatform({
    baseUrl: unreadable.baseUrl,
  }).postIssueComment(call(), TARGET, COMMENT_NUMBER, "thanks");
  assert.equal(
    !unreadableResult.ok && unreadableResult.class,
    ResultClass.UnknownOutcome,
  );
  const missing = await platform(t, answer(404, { message: "Not Found" }));
  const missingResult = await new GitHubPlatform({
    baseUrl: missing.baseUrl,
  }).postIssueComment(call(), TARGET, COMMENT_NUMBER, "thanks");
  assert.equal(
    !missingResult.ok && missingResult.class,
    ResultClass.FinalRefusal,
  );
});

test("readTokenAccount reads the user and answers the decimal text of its id", async (t) => {
  const server = await platform(
    t,
    answer(200, { id: COMMENT_USER_ID, login: COMMENT_LOGIN }),
  );
  const result = await new GitHubPlatform({
    baseUrl: server.baseUrl,
  }).readTokenAccount(call());
  assert.equal(server.requests.length, SINGLE_REQUEST);
  assert.equal(server.requests[0]?.method, HttpMethod.Get);
  assert.equal(server.requests[0]?.url, USER_PATH);
  assert.deepEqual(result, { ok: true, value: String(COMMENT_USER_ID) });
});

const TRUSTED_ID = 9;
const UNTRUSTED_ID = 7;
const BOT_ID = 5;
const TRUSTED_ONLY = [String(TRUSTED_ID)];
const USER_TYPE = "User";
const BOT_TYPE = "Bot";

function reviewOf(reviewer: number, type: string) {
  return {
    ...review(reviewer, ReviewState.ChangesRequested),
    user: { id: reviewer, login: `user-${reviewer}`, type },
    body: `fix ${reviewer}`,
    submitted_at: "2026-10-12T00:00:00Z",
  };
}

async function reviewersOf(
  t: TestContext,
  reviews: object[],
  trusted: string[],
) {
  const server = await platform(
    t,
    changeRequestServer(reviews, {
      [`${REVIEWS_PATH}/${TRUSTED_ID}/comments`]: [],
    }),
  );
  const result = await new GitHubPlatform({
    baseUrl: server.baseUrl,
  }).getChangeRequests(call(), TARGET, { number: 7 }, trusted);
  assert.ok(result.ok);
  return result.value.change_requests.map((item) => item.reviewer);
}

test("getChangeRequests keeps the change request of a trusted user and drops an untrusted user and a bot", async (t) => {
  assert.deepEqual(
    await reviewersOf(
      t,
      [
        reviewOf(TRUSTED_ID, USER_TYPE),
        reviewOf(UNTRUSTED_ID, USER_TYPE),
        reviewOf(BOT_ID, BOT_TYPE),
      ],
      TRUSTED_ONLY,
    ),
    [`user-${TRUSTED_ID}`],
  );
});

test("getChangeRequests drops a bot review of a trusted id and trusts nobody without link_trust", async (t) => {
  assert.deepEqual(
    await reviewersOf(t, [reviewOf(TRUSTED_ID, BOT_TYPE)], TRUSTED_ONLY),
    [],
  );
  assert.deepEqual(
    await reviewersOf(t, [reviewOf(TRUSTED_ID, USER_TYPE)], NO_TRUSTED),
    [],
  );
});

test("foldPullRequest counts the change request of a trusted user and ignores an untrusted user and a bot", () => {
  const github = new GitHubPlatform();
  const fold = (reviews: unknown[], trusted: string[]) =>
    github.foldPullRequest(
      PULL_REQUEST_BODY,
      reviews,
      NO_CHECKS,
      ExpectedEndState.PullRequestMerged,
      trusted,
    ).end_state;
  assert.equal(
    fold([reviewOf(TRUSTED_ID, USER_TYPE)], TRUSTED_ONLY),
    CheckEndState.Other,
  );
  assert.equal(
    fold([reviewOf(UNTRUSTED_ID, USER_TYPE)], TRUSTED_ONLY),
    CheckEndState.None,
  );
  assert.equal(
    fold([reviewOf(TRUSTED_ID, BOT_TYPE)], TRUSTED_ONLY),
    CheckEndState.None,
  );
  assert.equal(
    fold([reviewOf(TRUSTED_ID, USER_TYPE)], NO_TRUSTED),
    CheckEndState.None,
  );
});
