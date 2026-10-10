import assert from "node:assert/strict";
import { once } from "node:events";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo } from "node:net";
import { test, type TestContext } from "node:test";
import { ResultClass, type ResultClassValue } from "../intake/contract.ts";
import type { ServiceIdentity } from "../kernel/caller.ts";
import { OperationError } from "../kernel/errors.ts";
import { HttpMethod, HttpStatus } from "../kernel/http.ts";
import {
  CURSOR_INVALID_CODE,
  CURSOR_PAGE_SIZE_MISMATCH_CODE,
  CallKind,
  CheckEndState,
  DeliveryKind,
  DispatchPhase,
  GITHUB_API_VERSION,
  GitHubPlatform,
  GitHubTargetKind,
  ExpectedEndState,
  classify,
  classifyDelivery,
  decodeCursor,
  decodeGitHubEvent,
  encodeCursor,
  githubCheckpointSchema,
  newerEvents,
  repositoryOf,
  type GitHubCall,
  type GitHubRequest,
  type GitHubTarget,
} from "./github.ts";
import { platformImplementations } from "./index.ts";

const TOKEN = "ghp_secret_token_value";
const CALL_DEADLINE_MS = 10_000;
const SHORT_DEADLINE_MS = 700;
const HOLD_MS = 5_000;
const ABORT_AFTER_MS = 100;
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
  t.after(() => {
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

test("the registry holds the GitHub implementation under its platform value", () => {
  assert.equal(platformImplementations.github, GitHubPlatform);
});

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
  const server = await platform(t, answer(429, { message: "slow down" }));
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.send(call(), TARGET, WRITE);
  assert.equal(server.requests.length, SINGLE_REQUEST);
  assert.deepEqual(result, {
    ok: false,
    class: ResultClass.RetryableRefusal,
    code: "repository.platform.github.retryable_refusal",
    status: 429,
    message: "slow down",
  });
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
  }[] = [
    { status: 408, headers: {}, class: ResultClass.RetryableRefusal },
    {
      status: 403,
      headers: { "x-ratelimit-remaining": "0" },
      class: ResultClass.RetryableRefusal,
    },
    {
      status: 403,
      headers: { "x-ratelimit-remaining": "12" },
      class: ResultClass.FinalRefusal,
    },
    { status: 401, headers: {}, class: ResultClass.FinalRefusal },
    { status: 404, headers: {}, class: ResultClass.FinalRefusal },
    { status: 422, headers: {}, class: ResultClass.FinalRefusal },
  ];
  for (const expected of cases) {
    const server = await platform(
      t,
      answer(expected.status, { message: "refused" }, expected.headers),
    );
    const github = new GitHubPlatform({ baseUrl: server.baseUrl });
    const result = await github.send(call(), TARGET, WRITE);
    assert.equal(server.requests.length, SINGLE_REQUEST);
    assert.deepEqual(result, {
      ok: false,
      class: expected.class,
      code: `repository.platform.github.${expected.class}`,
      status: expected.status,
      message: "refused",
    });
  }
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
  setTimeout(() => controller.abort(), ABORT_AFTER_MS).unref();
  const result = await github.send(
    call({ signal: controller.signal }),
    TARGET,
    WRITE,
  );
  assert.equal(server.requests.length, SINGLE_REQUEST);
  assert.equal(!result.ok && result.class, ResultClass.UnknownOutcome);
  assert.equal(!result.ok && result.status, null);
});

test("the deadline of a dispatched write answers unknown_outcome", async (t) => {
  const server = await platform(t, hold);
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.send(
    call({ deadlineAt: Date.now() + ABORT_AFTER_MS }),
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

test("classify maps a transport error by phase and kind", () => {
  const error = new Error("socket hang up");
  const classOf = (phase: DispatchPhase, kind: CallKind) =>
    classify(error, phase, kind).class;
  assert.equal(
    classOf(DispatchPhase.BeforeDispatch, CallKind.Write),
    ResultClass.ConfirmedFailure,
  );
  assert.equal(
    classOf(DispatchPhase.AfterDispatch, CallKind.Write),
    ResultClass.UnknownOutcome,
  );
  assert.equal(
    classOf(DispatchPhase.BeforeDispatch, CallKind.Read),
    ResultClass.RetryableRefusal,
  );
  assert.equal(
    classify(error, DispatchPhase.AfterDispatch, CallKind.Read).status,
    null,
  );
});

test("classifyDelivery answers a ping as a handshake with status 204", () => {
  assert.deepEqual(
    classifyDelivery(new Headers({ "X-GitHub-Event": "ping" })),
    { kind: DeliveryKind.Handshake, status: HttpStatus.NoContent },
  );
});

test("classifyDelivery answers a push as an event with its delivery and metadata", () => {
  assert.deepEqual(
    classifyDelivery(
      new Headers({ "X-GitHub-Event": "push", "X-GitHub-Delivery": "d-1" }),
    ),
    { kind: DeliveryKind.Event, event_id: "d-1", metadata: { event: "push" } },
  );
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

const PULL_REQUEST_BODY = {
  number: 7,
  state: "open",
  merged: false,
  merge_commit_sha: null,
  head: { ref: "kanthord/node" },
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

test("createPullRequest answers the class of a refused write", async (t) => {
  const server = await platform(t, answer(422, { message: "exists" }));
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.createPullRequest(call(), TARGET, {
    head: HEAD_BRANCH,
    base: BASE_BRANCH,
    title: "change",
  });
  assert.equal(server.requests.length, SINGLE_REQUEST);
  assert.equal(!result.ok && result.class, ResultClass.FinalRefusal);
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

test("getPullRequest answers the body unchanged", async (t) => {
  const server = await platform(t, answer(200, PULL_REQUEST_BODY));
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.getPullRequest(call(), TARGET, { number: 7 });
  assert.deepEqual(result, { ok: true, value: PULL_REQUEST_BODY });
  assert.equal(server.requests[0]?.url, PULL_REQUEST_PATH);
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

test("listReviewComments maps limit to per_page and keeps it in the cursor", async (t) => {
  const server = await platform(t, answer(200, [], { link: NEXT_LINK }));
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.listReviewComments(call(), TARGET, {
    number: 7,
    limit: COMMENT_LIMIT,
  });
  assert.equal(
    query(server.requests[0]).get("per_page"),
    String(COMMENT_LIMIT),
  );
  assert.ok(result.ok && result.value.next_cursor !== null);
  assert.deepEqual(decodeCursor(result.value.next_cursor), {
    page: SECOND_PAGE,
    per_page: COMMENT_LIMIT,
  });
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
    Buffer.from("{", "utf8").toString("base64url"),
    Buffer.from('{"page":0,"per_page":10}', "utf8").toString("base64url"),
    Buffer.from('{"per_page":10,"page":1}', "utf8").toString("base64url"),
    Buffer.from('{"page":1,"per_page":101}', "utf8").toString("base64url"),
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
      merged,
    ),
    { end_state: CheckEndState.Expected, landed_commits: [MERGE_COMMIT] },
  );
  assert.deepEqual(
    github.foldPullRequest(
      { ...PULL_REQUEST_BODY, state: "closed", merge_commit_sha: MERGE_COMMIT },
      merged,
    ),
    { end_state: CheckEndState.Other, landed_commits: [] },
  );
  assert.deepEqual(github.foldPullRequest(PULL_REQUEST_BODY, merged), {
    end_state: CheckEndState.None,
    landed_commits: [],
  });
  assert.throws(() =>
    github.foldPullRequest(
      PULL_REQUEST_BODY,
      ExpectedEndState.BaseBranchPushed,
    ),
  );
  assert.throws(() => github.foldPullRequest({ number: 7 }, merged));
  assert.throws(
    () =>
      github.foldPullRequest(
        { ...PULL_REQUEST_BODY, state: "closed", merged: true },
        merged,
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
const INTERNAL_SERVER_ERROR = 500;
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

test("listEvents answers notModified for a 304", async (t) => {
  const server = await platform(t, (_request, response) => {
    response.writeHead(NOT_MODIFIED, { etag: FIRST_ETAG });
    response.end();
  });
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.listEvents(call(), {
    ...EVENTS_QUERY,
    etag: FIRST_ETAG,
  });
  assert.deepEqual(result, { ok: true, value: { notModified: true } });
  assert.equal(server.requests.length, SINGLE_REQUEST);
  assert.equal(server.requests[0]?.headers["if-none-match"], FIRST_ETAG);
});

test("listEvents answers retryable_refusal for a 500 after one request", async (t) => {
  const server = await platform(
    t,
    answer(INTERNAL_SERVER_ERROR, { message: "broken" }),
  );
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.listEvents(call(), {
    ...EVENTS_QUERY,
    etag: null,
  });
  assert.equal(server.requests.length, SINGLE_REQUEST);
  assert.equal(!result.ok && result.class, ResultClass.RetryableRefusal);
  assert.equal(!result.ok && result.status, INTERNAL_SERVER_ERROR);
});

test("listEvents retries a closed connection inside its deadline", async (t) => {
  const server = await platform(t, (request, response, count) => {
    if (count < RETRIED_REQUESTS) {
      lose(request, response, count);
      return;
    }
    answer(200, [PUSH_EVENT], { etag: FIRST_ETAG })(request, response, count);
  });
  const github = new GitHubPlatform({ baseUrl: server.baseUrl });
  const result = await github.listEvents(call(), {
    ...EVENTS_QUERY,
    etag: null,
  });
  assert.equal(server.requests.length, RETRIED_REQUESTS);
  assert.ok(result.ok && !result.value.notModified);
  assert.equal(result.value.etag, FIRST_ETAG);
  assert.equal(result.value.events.length, SINGLE_REQUEST);
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

test("newerEvents keeps every event for a null checkpoint in ascending order", () => {
  const events = [{ id: "12" }, { id: "9" }, { id: "100" }];
  assert.deepEqual(
    newerEvents(events, null).map((event) => event.id),
    ["9", "12", "100"],
  );
});

test("newerEvents drops the event equal to the checkpoint and older ones", () => {
  const events = [{ id: "43" }, { id: "42" }, { id: "41" }];
  assert.deepEqual(
    newerEvents(events, "42").map((event) => event.id),
    ["43"],
  );
});

test("newerEvents compares identities of different length by number", () => {
  const events = [{ id: "100" }, { id: "99" }, { id: "1000" }, { id: "8" }];
  assert.deepEqual(
    newerEvents(events, "99").map((event) => event.id),
    ["100", "1000"],
  );
});

test("githubCheckpointSchema admits the checkpoint fields and refuses others", () => {
  assert.ok(
    githubCheckpointSchema.safeParse({ etag: null, newest_event_id: null })
      .success,
  );
  assert.ok(
    githubCheckpointSchema.safeParse({
      etag: FIRST_ETAG,
      newest_event_id: "41",
    }).success,
  );
  assert.ok(
    !githubCheckpointSchema.safeParse({ etag: null, newest_event_id: "4a" })
      .success,
  );
  assert.ok(
    !githubCheckpointSchema.safeParse({ etag: null, newest_event_id: "0101" })
      .success,
  );
  assert.ok(
    !githubCheckpointSchema.safeParse({
      etag: null,
      newest_event_id: null,
      extra: 1,
    }).success,
  );
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

test("decodeGitHubEvent answers null for a zero, a negative or a fractional number", () => {
  for (const number of [0, -1, 1.5, "7"]) {
    assert.equal(
      decoded("pull_request", { number, repository: webhookRepository }),
      null,
    );
  }
});

test("decodeGitHubEvent answers null for metadata of another shape", () => {
  const event = eventBytes(JSON.stringify(closedPullRequest(true)));
  for (const metadata of [
    null,
    "pull_request",
    {},
    { event: "" },
    { event: 1 },
    { event: "pull_request", delivery: "d" },
  ]) {
    assert.equal(
      decodeGitHubEvent({ resource: EVENT_RESOURCE, event, metadata }),
      null,
    );
  }
});

test("an open pull request with merge conflicts folds to the conflict end state", () => {
  const github = new GitHubPlatform({ baseUrl: "http://127.0.0.1:1" });
  const open = { state: "open", merged: false, merge_commit_sha: null };
  assert.equal(
    github.foldPullRequest(
      { ...open, mergeable_state: "dirty" },
      ExpectedEndState.PullRequestMerged,
    ).end_state,
    CheckEndState.Conflict,
  );
  assert.equal(
    github.foldPullRequest(
      { ...open, mergeable_state: "clean" },
      ExpectedEndState.PullRequestMerged,
    ).end_state,
    CheckEndState.None,
  );
  assert.equal(
    github.foldPullRequest(open, ExpectedEndState.PullRequestMerged).end_state,
    CheckEndState.None,
  );
});
