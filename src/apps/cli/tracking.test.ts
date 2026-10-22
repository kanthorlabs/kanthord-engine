import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { HttpMethod } from "../../kernel/http.ts";
import { temporary } from "../../kernel/test-support.ts";
import { TRACE_QUERY_MAX_CHARACTERS } from "../../tracking/contract.ts";
import { ExitCode } from "./constants.ts";
import { runKanthord } from "./test-support.ts";

const PROJECT_ID = "project_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NODE_ID = "node_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const TRACE_LIST_PATH = "/api/tracking/trace";
const FACET_GET_PATH = "/api/tracking/facet";
const LIST_ANSWER = { items: [], next_cursor: null };
const FACET_ANSWER = {
  worker_names: ["worker-one"],
  agent_names: ["coder"],
  models: ["qwen"],
  error_types: [],
};
const NO_REQUESTS = 0;
const ONE_REQUEST = 1;
const LIMIT_LISTED = "10";
const LIMIT_TOO_LARGE = "1001";
const LIMIT_NOT_NUMBER = "many";

interface Seen {
  method: string | undefined;
  url: string | undefined;
}

async function fakeServer(
  t: TestContext,
  answer: unknown,
): Promise<{ endpoint: string; seen: Seen[] }> {
  const seen: Seen[] = [];
  const server = createServer((request, response) => {
    seen.push({ method: request.method, url: request.url });
    request.resume();
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify(answer));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => server.close());
  return {
    endpoint: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    seen,
  };
}

async function run(t: TestContext, args: string[], endpoint: string) {
  const directory = temporary(t);
  return runKanthord(
    ["tracking", ...args, "--endpoint", endpoint, "--token", "human"],
    {
      ...process.env,
      XDG_CONFIG_HOME: directory,
      XDG_DATA_HOME: join(directory, "data"),
      XDG_STATE_HOME: join(directory, "state"),
      KANTHORD_ENDPOINT: undefined,
      KANTHORD_TOKEN: undefined,
    },
    t.signal,
  );
}

test("trace list sends its filters as query fields and writes the answer", async (t) => {
  const { endpoint, seen } = await fakeServer(t, LIST_ANSWER);
  const result = await run(
    t,
    [
      "trace",
      "list",
      "--project",
      PROJECT_ID,
      "--node",
      NODE_ID,
      "--state",
      "open",
      "--query",
      "qwen",
      "--sort",
      "cost_usd",
      "--limit",
      LIMIT_LISTED,
      "--cursor",
      "opaque",
    ],
    endpoint,
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(seen.length, ONE_REQUEST);
  assert.equal(seen[0]?.method, HttpMethod.Get);
  const url = new URL(seen[0]?.url ?? "", endpoint);
  assert.equal(url.pathname, TRACE_LIST_PATH);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    project_id: PROJECT_ID,
    node_id: NODE_ID,
    state: "open",
    q: "qwen",
    sort: "cost_usd",
    limit: LIMIT_LISTED,
    cursor: "opaque",
  });
  assert.deepEqual(JSON.parse(result.stdout), LIST_ANSWER);
});

test("trace list without an option sends the default sort and limit", async (t) => {
  const { endpoint, seen } = await fakeServer(t, LIST_ANSWER);
  const result = await run(t, ["trace", "list"], endpoint);
  assert.equal(result.code, ExitCode.Success, result.stderr);
  const url = new URL(seen[0]?.url ?? "", endpoint);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    sort: "started_at",
    limit: "100",
  });
});

const INVALID_LIST_OPTIONS: readonly (readonly [string[], string])[] = [
  [["--project", "invalid"], "cli.tracking.trace.list.invalid_project_id"],
  [["--node", "invalid"], "cli.tracking.trace.list.invalid_node_id"],
  [["--state", "unknown"], "cli.tracking.trace.list.invalid_state"],
  [["--sort", "unknown"], "cli.tracking.trace.list.invalid_sort"],
  [["--query", ""], "cli.tracking.trace.list.invalid_query"],
  [
    ["--query", "x".repeat(TRACE_QUERY_MAX_CHARACTERS + 1)],
    "cli.tracking.trace.list.invalid_query",
  ],
  [["--limit", LIMIT_NOT_NUMBER], "cli.pagination.limit_invalid"],
  [["--limit", LIMIT_TOO_LARGE], "cli.pagination.limit_out_of_range"],
];

for (const [options, code] of INVALID_LIST_OPTIONS)
  test(`trace list ${options.join(" ")} exits with ${code} before any request`, async (t) => {
    const { endpoint, seen } = await fakeServer(t, LIST_ANSWER);
    const result = await run(t, ["trace", "list", ...options], endpoint);
    assert.equal(result.code, ExitCode.Failure);
    assert.ok(result.stderr.includes(code), result.stderr);
    assert.equal(seen.length, NO_REQUESTS);
  });

test("facet get sends the project and writes the answer", async (t) => {
  const { endpoint, seen } = await fakeServer(t, FACET_ANSWER);
  const result = await run(
    t,
    ["facet", "get", "--project", PROJECT_ID],
    endpoint,
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(seen.length, ONE_REQUEST);
  assert.equal(seen[0]?.method, HttpMethod.Get);
  assert.equal(
    seen[0]?.url,
    `${FACET_GET_PATH}?project_id=${encodeURIComponent(PROJECT_ID)}`,
  );
  assert.deepEqual(JSON.parse(result.stdout), FACET_ANSWER);
});

test("facet get with an invalid project exits before any request", async (t) => {
  const { endpoint, seen } = await fakeServer(t, FACET_ANSWER);
  const result = await run(
    t,
    ["facet", "get", "--project", "invalid"],
    endpoint,
  );
  assert.equal(result.code, ExitCode.Failure);
  assert.ok(
    result.stderr.includes("cli.tracking.facet.get.invalid_project_id"),
    result.stderr,
  );
  assert.equal(seen.length, NO_REQUESTS);
});

const TRACE_ID = "a".repeat(32);
const SESSION_ID = "2".repeat(16);
const ENTRY_ID = "e1";
const ENTRY_LIST_PATH = `/api/tracking/trace/${TRACE_ID}/session/${SESSION_ID}/entry`;
const ENTRY_GET_PATH = `${ENTRY_LIST_PATH}/${ENTRY_ID}`;
const ENTRY_ANSWER = {
  trace_id: TRACE_ID,
  session_id: SESSION_ID,
  entry_id: ENTRY_ID,
  parent_entry_id: null,
  sequence: 1,
  entry_type: "message",
  entry_time: 1000,
  tool_call_id: null,
  truncated: false,
  entry: { role: "user" },
  created_at: 1000,
};
const TOOL_CALL = "call_1";
const LIMIT_FIVE = "5";

test("session entry list sends its filters as query fields and writes the answer", async (t) => {
  const { endpoint, seen } = await fakeServer(t, LIST_ANSWER);
  const result = await run(
    t,
    [
      "session",
      "entry",
      "list",
      TRACE_ID,
      SESSION_ID,
      "--tool-call",
      TOOL_CALL,
      "--limit",
      LIMIT_FIVE,
    ],
    endpoint,
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(seen.length, ONE_REQUEST);
  assert.equal(seen[0]?.method, HttpMethod.Get);
  const url = new URL(seen[0]?.url ?? "", endpoint);
  assert.equal(url.pathname, ENTRY_LIST_PATH);
  assert.deepEqual(Object.fromEntries(url.searchParams), {
    tool_call_id: TOOL_CALL,
    limit: LIMIT_FIVE,
  });
  assert.deepEqual(JSON.parse(result.stdout), LIST_ANSWER);
});

test("session entry get sends the entry path and writes the answer", async (t) => {
  const { endpoint, seen } = await fakeServer(t, ENTRY_ANSWER);
  const result = await run(
    t,
    ["session", "entry", "get", TRACE_ID, SESSION_ID, ENTRY_ID],
    endpoint,
  );
  assert.equal(result.code, ExitCode.Success, result.stderr);
  assert.equal(seen.length, ONE_REQUEST);
  assert.equal(seen[0]?.method, HttpMethod.Get);
  assert.equal(seen[0]?.url, ENTRY_GET_PATH);
  assert.deepEqual(JSON.parse(result.stdout), ENTRY_ANSWER);
});

const INVALID_ENTRY_ARGUMENTS: readonly (readonly [string[], string])[] = [
  [
    ["list", "invalid", SESSION_ID],
    "cli.tracking.session.entry.list.invalid_trace_id",
  ],
  [
    ["list", TRACE_ID, "invalid"],
    "cli.tracking.session.entry.list.invalid_session_id",
  ],
  [
    ["list", TRACE_ID, SESSION_ID, "--limit", LIMIT_NOT_NUMBER],
    "cli.pagination.limit_invalid",
  ],
  [
    ["list", TRACE_ID, SESSION_ID, "--limit", LIMIT_TOO_LARGE],
    "cli.pagination.limit_out_of_range",
  ],
  [
    ["get", "invalid", SESSION_ID, ENTRY_ID],
    "cli.tracking.session.entry.get.invalid_trace_id",
  ],
  [
    ["get", TRACE_ID, "invalid", ENTRY_ID],
    "cli.tracking.session.entry.get.invalid_session_id",
  ],
  [
    ["get", TRACE_ID, SESSION_ID, "Invalid_Entry"],
    "cli.tracking.session.entry.get.invalid_entry_id",
  ],
];

for (const [args, code] of INVALID_ENTRY_ARGUMENTS)
  test(`session entry ${args.join(" ")} exits with ${code} before any request`, async (t) => {
    const { endpoint, seen } = await fakeServer(t, LIST_ANSWER);
    const result = await run(t, ["session", "entry", ...args], endpoint);
    assert.equal(result.code, ExitCode.Failure);
    assert.ok(result.stderr.includes(code), result.stderr);
    assert.equal(seen.length, NO_REQUESTS);
  });
