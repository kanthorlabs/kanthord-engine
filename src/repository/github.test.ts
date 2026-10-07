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
import {
  CallKind,
  DispatchPhase,
  GITHUB_API_VERSION,
  GitHubPlatform,
  GitHubTargetKind,
  classify,
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
}

async function platform(t: TestContext, handler: Handler): Promise<Platform> {
  const requests: IncomingMessage[] = [];
  const server = createServer((request, response) => {
    requests.push(request);
    request.resume();
    request.once("end", () => handler(request, response, requests.length));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
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
